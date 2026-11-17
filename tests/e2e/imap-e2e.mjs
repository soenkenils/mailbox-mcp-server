/**
 * End-to-end check of the built MCP server against a real IMAP/SMTP server.
 *
 * The unit tests mock imapflow entirely, so they cannot catch protocol-level
 * regressions: a method that resolves `false` instead of throwing, a search
 * criterion a server ignores, a library upgrade that changes envelope shapes.
 * This drives `dist/main.js` over stdio against GreenMail, which keeps its
 * mailboxes in memory and holds no real mail. README → End-to-end checks has
 * the commands to start GreenMail with a test certificate for 127.0.0.1;
 * E2E_CA_FILE names that certificate.
 *
 *   bun run build && E2E_CA_FILE=/path/to/cert.pem bun run test:e2e
 *
 * Set E2E_IMAP_PORT=3993 E2E_IMAP_SECURE=true to run the same scenario over
 * IMAPS.
 *
 * Every host the server is given points at this machine; the script refuses
 * to run otherwise, so it can never touch a real mailbox.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { createInterface } from "node:readline";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

const HOST = process.env.E2E_IMAP_HOST ?? "127.0.0.1";
const IMAP_PORT = Number(process.env.E2E_IMAP_PORT ?? 3143);
const IMAP_SECURE = process.env.E2E_IMAP_SECURE === "true";
// The server never sends credentials over unencrypted SMTP and always
// verifies the certificate, so mail goes out over GreenMail's SMTPS port with
// a test certificate for 127.0.0.1 whose PEM file E2E_CA_FILE names.
const SMTP_PORT = Number(process.env.E2E_SMTP_PORT ?? 3465);
const CA_FILE = process.env.E2E_CA_FILE;
const USER = "e2e@example.com";
const PASS = "e2epass";
const SERVER = process.env.E2E_SERVER ?? "./dist/main.js";

// Calendar and Sieve are out of scope; point them somewhere that cannot
// answer rather than leaving the mailbox.org defaults in place.
const SERVER_ENV = {
  MAILBOX_EMAIL: USER,
  MAILBOX_PASSWORD: PASS,
  MAILBOX_IMAP_HOST: HOST,
  MAILBOX_IMAP_PORT: String(IMAP_PORT),
  MAILBOX_IMAP_SECURE: String(IMAP_SECURE),
  MAILBOX_SMTP_HOST: HOST,
  MAILBOX_SMTP_PORT: String(SMTP_PORT),
  MAILBOX_SMTP_SECURE: "true",
  MAILBOX_CALDAV_URL: "http://127.0.0.1:1/",
  MAILBOX_SIEVE_HOST: "127.0.0.1",
  MAILBOX_SIEVE_PORT: "1",
};

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);
const nonLocal = [
  ["MAILBOX_IMAP_HOST", SERVER_ENV.MAILBOX_IMAP_HOST],
  ["MAILBOX_SMTP_HOST", SERVER_ENV.MAILBOX_SMTP_HOST],
  ["MAILBOX_SIEVE_HOST", SERVER_ENV.MAILBOX_SIEVE_HOST],
  ["MAILBOX_CALDAV_URL", new URL(SERVER_ENV.MAILBOX_CALDAV_URL).hostname],
].filter(([, host]) => !LOCAL_HOSTS.has(host));
if (nonLocal.length > 0) {
  console.error(
    `Refusing to run: ${nonLocal.map(([name, host]) => `${name}=${host}`).join(", ")} is not localhost/127.0.0.1. This check sends, moves and deletes mail; run it only against a local test server.`,
  );
  process.exit(1);
}

const stamp = Date.now();
const subject = `e2e ${stamp}`;
const folder = `E2E${stamp}`;
const rootId = `<root-${stamp}@example.com>`;
const replyId = `<reply-${stamp}@example.com>`;

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const reachable = port =>
  new Promise(resolve => {
    const socket = createConnection({ host: HOST, port })
      .on("connect", () => {
        socket.end();
        resolve(true);
      })
      .on("error", () => resolve(false));
    socket.setTimeout(3000, () => {
      socket.destroy();
      resolve(false);
    });
  });

const startServer = async () => {
  const server = spawn("node", [SERVER], {
    // Only what the server needs: no MAILBOX_* from the caller's shell.
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      ...SERVER_ENV,
      // Trust the test certificate GreenMail was started with, without
      // turning off certificate checks.
      NODE_EXTRA_CA_CERTS: CA_FILE,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const stderr = [];
  server.stderr.on("data", chunk => stderr.push(chunk.toString()));

  const pending = new Map();
  createInterface({ input: server.stdout }).on("line", line => {
    const message = JSON.parse(line);
    pending.get(message.id)?.(message);
  });

  let nextId = 1;
  const rpc = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(
        () => reject(new Error(`${method} timed out`)),
        20000,
      );
      pending.set(id, message => {
        clearTimeout(timer);
        resolve(message);
      });
      server.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      );
    });

  await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "imap-e2e", version: "0" },
  });
  server.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
  );

  // Returns the text rendering and, where the tool declares an output schema,
  // its structuredContent, so UIDs need not be scraped from prose.
  const call = async (name, args = {}) => {
    const message = await rpc("tools/call", { name, arguments: args });
    if (message.error) {
      throw new Error(`${name}: ${JSON.stringify(message.error)}`);
    }
    return {
      text: message.result?.content?.map(part => part.text).join("\n") ?? "",
      data: message.result?.structuredContent,
      isError: message.result?.isError === true,
    };
  };

  return { call, stderr, stop: () => server.kill("SIGTERM") };
};

const connectImap = async () => {
  const client = new ImapFlow({
    host: HOST,
    port: IMAP_PORT,
    secure: IMAP_SECURE,
    auth: { user: USER, pass: PASS },
    logger: false,
    tls: { ca: readFileSync(CA_FILE) },
  });
  await client.connect();
  return client;
};

const withImap = async fn => {
  const client = await connectImap();
  try {
    return await fn(client);
  } finally {
    await client.logout();
  }
};

// Reads a message back off the server, so a check sees what was actually
// stored rather than how the server's tools render it.
const fetchStored = (mailbox, uid) =>
  withImap(async client => {
    const lock = await client.getMailboxLock(mailbox);
    try {
      const message = await client.fetchOne(
        String(uid),
        { source: true, flags: true },
        { uid: true },
      );
      return message
        ? { source: message.source, flags: [...(message.flags ?? [])] }
        : undefined;
    } finally {
      lock.release();
    }
  });

// mark_email echoes the flags it was asked to set, so the only way to tell
// whether they were applied is to read them back off the server.
const flagsOf = async (mailbox, uid) =>
  (await fetchStored(mailbox, uid))?.flags ?? [];

// Appends a message directly, which is the only way to control headers such as
// References that SMTP delivery through send_email cannot set.
const appendRaw = ({ id, subject: messageSubject, date, headers = [] }) =>
  withImap(client =>
    client.append(
      "INBOX",
      Buffer.from(
        [
          `From: "Alice Example" <alice@example.com>`,
          `To: "E2E Test" <${USER}>`,
          `Subject: ${messageSubject}`,
          `Message-ID: ${id}`,
          `Date: ${date}`,
          ...headers,
          "",
          "body text",
          "",
        ].join("\r\n"),
      ),
    ),
  );

// GreenMail keeps mailboxes for the container's lifetime, and it cannot
// delete a folder another (even closed) session had selected, so a Trash
// folder from an earlier run stays. The no-trash case then cannot be checked.
const hasTrash = () =>
  withImap(async client => (await client.list()).some(f => f.path === "Trash"));

if (!CA_FILE || !existsSync(CA_FILE)) {
  console.error(
    "Set E2E_CA_FILE to the PEM certificate GreenMail was started with (see README → End-to-end checks).",
  );
  process.exit(1);
}

if (!existsSync(SERVER)) {
  console.error(`No build at ${SERVER}. Run \`bun run build\` first.`);
  process.exit(1);
}

if (!(await reachable(IMAP_PORT))) {
  console.error(
    `No IMAP server on ${HOST}:${IMAP_PORT}. Start GreenMail first (see the header of this file).`,
  );
  process.exit(1);
}

let session;
try {
  const trashFromEarlierRun = await hasTrash();
  session = await startServer();
  const { call } = session;

  // Folder cache is primed before the folder exists, so a stale cache would
  // hide the new folder.
  await call("get_folders");
  await call("create_directory", { name: folder });
  const folderPaths = (await call("get_folders")).data?.folders?.map(
    f => f.path,
  );
  check(
    "new folder appears immediately",
    folderPaths?.includes(folder) ?? false,
  );

  // parentPath nests the folder with the server's own delimiter.
  await call("create_directory", { name: "Sub", parentPath: folder });
  const nested = (await call("get_folders")).data?.folders?.find(
    f => f.name === "Sub" && f.path.startsWith(folder),
  );
  check(
    "create_directory nests under parentPath",
    nested !== undefined && nested.path !== "Sub",
    `path: ${nested?.path ?? "(missing)"}`,
  );

  // GreenMail has no Drafts folder, so the draft goes to the test folder. Its
  // subject avoids `subject`, which the move and delete checks count on.
  const draftSubject = `Draft ${stamp}`;
  const saved = await call("create_draft", {
    to: [{ name: "Joe Example", address: "joe@example.com" }],
    bcc: [{ address: "hidden@example.com" }],
    subject: draftSubject,
    text: "line 1\nline 2",
    folder,
  });
  const draftUid = Number(saved.text.match(/\*\*UID:\*\*\s*(\d+)/)?.[1]);
  const stored = await fetchStored(folder, draftUid);
  const draft = await simpleParser(stored?.source ?? "");
  check(
    "draft is stored with the \\Draft flag",
    stored?.flags.includes("\\Draft") ?? false,
    `flags: ${stored?.flags.join(" ") || "(none)"}`,
  );
  check(
    "draft keeps subject, recipient and Bcc",
    draft.subject === draftSubject &&
      draft.to?.value[0]?.address === "joe@example.com" &&
      draft.bcc?.text === "hidden@example.com",
    `Subject: ${draft.subject}`,
  );

  await call("send_email", {
    to: [{ name: "E2E Test", address: USER }],
    subject,
    text: "hello from the e2e check",
  });
  await new Promise(resolve => setTimeout(resolve, 1500));

  const found = (
    await call("search_emails", { folder: "INBOX", query: subject })
  ).data;
  check(
    "sent email is searchable",
    found?.total === 1,
    `found ${found?.total}`,
  );
  const uid = found?.messages?.[0]?.uid;

  const email = (await call("get_email", { uid, folder: "INBOX" })).data
    ?.message;
  check(
    "get_email reports the sender",
    email?.from?.[0]?.address === USER,
    `from: ${JSON.stringify(email?.from)}`,
  );
  check(
    "get_email reports the recipient and body",
    email?.to?.[0]?.address === USER &&
      (email?.body ?? "").includes("hello from the e2e check"),
    `to: ${JSON.stringify(email?.to)}`,
  );

  await call("mark_email", {
    uid,
    folder: "INBOX",
    flags: ["\\Flagged"],
    action: "add",
  });
  const flagsAfterAdd = await flagsOf("INBOX", uid);
  check(
    "mark_email add sets the flag on the server",
    flagsAfterAdd.includes("\\Flagged"),
    `flags: ${flagsAfterAdd.join(", ") || "(none)"}`,
  );

  // The flag filters must reach the server's SEARCH: the flagged message is
  // in one result set and not the other.
  const flaggedUids = (
    await call("search_emails", { folder: "INBOX", flagged: true })
  ).data?.messages?.map(m => m.uid);
  const unflaggedUids = (
    await call("search_emails", { folder: "INBOX", flagged: false })
  ).data?.messages?.map(m => m.uid);
  check(
    "flag filters separate flagged from unflagged",
    (flaggedUids?.includes(uid) ?? false) &&
      !(unflaggedUids?.includes(uid) ?? true),
    `flagged: [${flaggedUids}], unflagged: [${unflaggedUids}]`,
  );

  await call("mark_email", {
    uid,
    folder: "INBOX",
    flags: ["\\Flagged"],
    action: "remove",
  });
  const flagsAfterRemove = await flagsOf("INBOX", uid);
  check(
    "mark_email remove clears the flag on the server",
    !flagsAfterRemove.includes("\\Flagged"),
    `flags: ${flagsAfterRemove.join(", ") || "(none)"}`,
  );

  // A thread needs a reply that references the root by header. The reply is
  // appended first, so arrival order and date order disagree.
  await appendRaw({
    id: replyId,
    subject: `Re: Thread ${stamp}`,
    date: "Tue, 15 Sep 2026 11:00:00 +0000",
    headers: [`In-Reply-To: ${rootId}`, `References: ${rootId}`],
  });
  await appendRaw({
    id: rootId,
    subject: `Thread ${stamp}`,
    date: "Tue, 15 Sep 2026 10:00:00 +0000",
  });

  const threadSearch = (
    await call("search_emails", {
      folder: "INBOX",
      query: `Thread ${stamp}`,
    })
  ).data?.messages?.map(m => m.subject);
  check(
    "search returns the newest message first",
    threadSearch?.[0] === `Re: Thread ${stamp}` &&
      threadSearch?.[1] === `Thread ${stamp}`,
    `order: ${JSON.stringify(threadSearch)}`,
  );

  const thread = (
    await call("get_email_thread", { messageId: rootId, folder: "INBOX" })
  ).text;
  check(
    "thread is found by Message-ID header",
    /\*\*Messages:\*\*\s*2\b/.test(thread),
    thread.match(/\*\*Messages:\*\*\s*\d+/)?.[0] ?? "no count",
  );
  check(
    "thread subject comes from the root message",
    thread.includes(`**Thread:** Thread ${stamp}`),
  );

  await call("move_email", { uid, fromFolder: "INBOX", toFolder: folder });
  const moved = (await call("search_emails", { folder, query: subject })).data;
  check("email moves between folders", moved?.total === 1);

  await call("delete_email", {
    uid: moved?.messages?.[0]?.uid,
    folder,
    permanent: true,
  });
  session.stop();

  // A second process starts with an empty cache, so this reflects the server.
  session = await startServer();
  const afterDelete = (
    await session.call("search_emails", { folder, query: subject })
  ).data?.total;
  check(
    "permanent delete really expunges",
    afterDelete === 0,
    `${afterDelete} left`,
  );

  // A fresh GreenMail has no trash folder, so a soft delete can only flag the
  // message and must say so rather than claiming a move. A positive assertion
  // on the message this case produces: the absence of "moved to trash" would
  // pass for any unrelated wording.
  if (trashFromEarlierRun) {
    console.log(
      "skip soft delete without a trash folder — Trash is left from an earlier run; restart GreenMail to cover it",
    );
  } else {
    const rootUid = (
      await session.call("search_emails", {
        folder: "INBOX",
        query: `Thread ${stamp}`,
      })
    ).data?.messages?.find(m => m.subject === `Thread ${stamp}`)?.uid;
    const softDelete = await session.call("delete_email", {
      uid: rootUid,
      folder: "INBOX",
    });
    const rootFlags = await flagsOf("INBOX", rootUid);
    check(
      "soft delete without a trash folder flags the message and says so",
      softDelete.text.includes("no trash folder found") &&
        rootFlags.includes("\\Deleted"),
      `flags: ${rootFlags.join(", ") || "(none)"}`,
    );

    await session.call("create_directory", { name: "Trash" });
  }

  // With a Trash folder, the same call moves the message there.
  const replyUid = (
    await session.call("search_emails", {
      folder: "INBOX",
      query: `Re: Thread ${stamp}`,
    })
  ).data?.messages?.[0]?.uid;
  const toTrash = await session.call("delete_email", {
    uid: replyUid,
    folder: "INBOX",
  });
  const inTrash = (
    await session.call("search_emails", {
      folder: "Trash",
      query: `Re: Thread ${stamp}`,
    })
  ).data;
  check(
    "soft delete moves the message to Trash",
    toTrash.text.includes('moved to trash folder "Trash"') &&
      inTrash?.total === 1,
    toTrash.text.match(/\*\*Result:\*\*.*/)?.[0] ?? toTrash.text.slice(0, 80),
  );

  // Deleting from the trash without permanent would do nothing; it must say so.
  const again = await session.call("delete_email", {
    uid: inTrash?.messages?.[0]?.uid,
    folder: "Trash",
  });
  check(
    "soft delete from the trash is refused",
    again.isError && again.text.includes("already in the trash folder"),
    again.text.slice(0, 120),
  );
} catch (error) {
  check(`unexpected error: ${error.message}`, false);
} finally {
  session?.stop();
  const problems = (session?.stderr ?? [])
    .join("")
    .split("\n")
    .filter(line => /\[ERROR\]/.test(line));
  for (const line of problems.slice(0, 5)) {
    console.log(`     server error: ${line.slice(0, 200)}`);
  }

  const failed = results.filter(result => !result.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed === 0 ? 0 : 1);
}
