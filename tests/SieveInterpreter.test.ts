import { describe, expect, it } from "vitest";
import {
  dryRunSieve,
  SieveInterpreter,
  type SieveMessage,
} from "../src/services/sieve/SieveInterpreter.js";
import {
  parseSieve,
  SieveSyntaxError,
} from "../src/services/sieve/SieveParser.js";
import { parseHeaders } from "../src/utils/headers.js";

function message(
  headers: string,
  text = "",
  extra: Partial<SieveMessage> = {},
): SieveMessage {
  const raw = `${headers.trim()}\r\n\r\n${text}`;
  return {
    headers: parseHeaders(raw),
    text,
    rawBody: text,
    size: Buffer.byteLength(raw),
    ...extra,
  };
}

const recruiterMail = message(
  `From: Erika Muster <erika.muster@jobvermittlung-beispiel.example>
To: user@example.org
Subject: Gärtner - CVs anonymisiert`,
  "Hallo Herr M., drei Gärtner aus dem Raum Musterstadt sind seit dieser Woche bei uns. 3+ Jahre Berufserfahrung, sofort verfügbar. Darf ich Ihnen die Lebensläufe unverbindlich zeigen?",
);

describe("SieveParser", () => {
  it("parses commands, tests, lists and blocks", () => {
    const ast = parseSieve(`require ["fileinto", "regex"];
# rule label
if anyof (header :contains "subject" "a", not exists "x-foo") {
  fileinto "Folder";
  stop;
} elsif true { keep; } else { discard; }`);
    expect(ast.map(c => c.name)).toEqual(["require", "if", "elsif", "else"]);
    expect(ast[1].comment).toBe("rule label");
    expect(ast[1].tests[0].name).toBe("anyof");
    expect(ast[1].tests[0].tests.map(t => t.name)).toEqual(["header", "not"]);
    expect(ast[1].block?.map(c => c.name)).toEqual(["fileinto", "stop"]);
  });

  it("parses numbers with quantifiers and multi-line strings", () => {
    const ast = parseSieve(`if size :over 1M { set "x" text:
line one
..dot
.
; }`);
    const size = ast[0].tests[0].args.find(a => a.type === "number");
    expect(size).toEqual({ type: "number", value: 1024 * 1024 });
    const setArgs = ast[0].block?.[0].args ?? [];
    expect(setArgs[1]).toEqual({
      type: "string",
      value: "line one\r\n.dot\r\n",
    });
  });

  it("reports syntax errors with line numbers", () => {
    expect(() => parseSieve('if true {\n fileinto "x"\n}')).toThrow(
      SieveSyntaxError,
    );
    try {
      parseSieve('if true {\n fileinto "x"\n}');
    } catch (error) {
      expect((error as SieveSyntaxError).line).toBe(3);
    }
  });
});

describe("SieveInterpreter", () => {
  it("applies implicit keep when nothing matches", () => {
    const result = dryRunSieve(
      'require ["fileinto"]; if header :contains "subject" "nope" { fileinto "X"; }',
      recruiterMail,
    );
    expect(result.deliveredTo).toEqual(["INBOX"]);
    expect(result.implicitKeep).toBe(true);
    expect(result.matched).toEqual([]);
  });

  it("files into a folder and stops", () => {
    const result = dryRunSieve(
      `require ["fileinto", "mailbox"];
## Flag: |UniqueId:1|Rulename: Recruiter
if address :domain :contains "from" "jobvermittlung" {
  fileinto :create "INBOX/Recruiter-Spam";
  stop;
}
fileinto "Never";`,
      recruiterMail,
    );
    expect(result.deliveredTo).toEqual(["INBOX/Recruiter-Spam"]);
    expect(result.stopped).toBe(true);
    expect(result.matched[0].rule).toContain("Rulename: Recruiter");
    expect(result.actions[0]).toMatchObject({
      type: "fileinto",
      target: "INBOX/Recruiter-Spam",
      create: true,
    });
  });

  it("keeps a :copy delivery in addition to INBOX", () => {
    const result = dryRunSieve(
      `require ["fileinto", "copy"];
if true { fileinto :copy "Spam"; }`,
      recruiterMail,
    );
    expect(result.deliveredTo).toEqual(["Spam", "INBOX"]);
  });

  it("reproduces Dovecot byte semantics: [äa] does NOT match ä", () => {
    const script = `require ["regex", "body", "fileinto"];
if body :text :regex "g[äa]rtner" { fileinto "Hit"; }`;
    const result = dryRunSieve(script, recruiterMail);
    expect(result.deliveredTo).toEqual(["INBOX"]);
    expect(result.lint.join(" ")).toMatch(/non-ASCII/);
  });

  it("matches umlauts written as alternation (ä|a|ae)", () => {
    const script = `require ["regex", "body", "fileinto"];
if body :text :regex "g(ä|a|ae)rtner" { fileinto "Hit"; }`;
    const result = dryRunSieve(script, recruiterMail);
    expect(result.deliveredTo).toEqual(["Hit"]);
    expect(result.lint).toEqual([]);
  });

  it("is case-insensitive for ASCII with the default comparator", () => {
    const result = dryRunSieve(
      `require ["fileinto"];
if header :contains "Subject" "CVS ANONYMISIERT" { fileinto "Hit"; }`,
      recruiterMail,
    );
    expect(result.deliveredTo).toEqual(["Hit"]);
  });

  it("supports :matches and match variables", () => {
    const result = dryRunSieve(
      `require ["fileinto", "variables"];
if address :matches :domain "from" "*" { set "dom" "\${1}"; }
if string :is "\${dom}" "jobvermittlung-beispiel.example" { fileinto "Domain/\${dom}"; }`,
      recruiterMail,
    );
    expect(result.deliveredTo).toEqual([
      "Domain/jobvermittlung-beispiel.example",
    ]);
  });

  it("evaluates the Reply-To/List-Unsubscribe sequencer rule", () => {
    const mail = message(
      `From: Max <max@personaldienst-beispiel.example>
Reply-To: max@other-domain.example
Subject: Fachkräfte`,
      "Unsere Fachkräfte",
    );
    const script = `require ["fileinto", "variables", "regex", "body"];
if address :matches :domain "from" "*" { set "fromdom" "\${1}"; }
if allof (
  exists "reply-to",
  not address :is :domain "reply-to" "\${fromdom}",
  not exists "list-unsubscribe",
  body :text :regex "fachkr(ä|a|ae)ft"
) { fileinto "Seq"; }`;
    expect(dryRunSieve(script, mail).deliveredTo).toEqual(["Seq"]);

    const withUnsub = message(
      `From: Max <max@personaldienst-beispiel.example>
Reply-To: max@other-domain.example
List-Unsubscribe: <mailto:u@x>
Subject: Fachkräfte`,
      "Unsere Fachkräfte",
    );
    expect(dryRunSieve(script, withUnsub).deliveredTo).toEqual(["INBOX"]);
  });

  it("handles elsif/else chains", () => {
    const script = `require ["fileinto"];
if header :is "subject" "x" { fileinto "A"; }
elsif header :contains "subject" "CVs" { fileinto "B"; }
else { fileinto "C"; }`;
    const result = dryRunSieve(script, recruiterMail);
    expect(result.deliveredTo).toEqual(["B"]);
    expect(result.matched.map(m => m.command)).toEqual(["elsif"]);
  });

  it("tracks flags from addflag and hasflag", () => {
    const script = `require ["imap4flags", "fileinto"];
addflag "\\\\Seen";
if hasflag :is "\\\\Seen" { fileinto "Read"; }`;
    const result = dryRunSieve(script, recruiterMail);
    expect(result.flags).toEqual(["\\Seen"]);
    expect(result.deliveredTo).toEqual(["Read"]);
  });

  it("decodes RFC 2047 encoded headers before matching", () => {
    const mail = message(
      `From: a@b.example
Subject: =?UTF-8?Q?G=C3=A4rtner?= gesucht`,
    );
    const result = dryRunSieve(
      `require ["fileinto"]; if header :contains "subject" "Gärtner" { fileinto "Hit"; }`,
      mail,
    );
    expect(result.deliveredTo).toEqual(["Hit"]);
  });

  it("supports currentdate with variables (invoice-per-year rule)", () => {
    const script = `require ["fileinto", "date", "variables", "relational"];
if currentdate :matches "year" "*" { set "yyyy" "\${1}"; }
fileinto "Invoices/\${yyyy}";`;
    const result = dryRunSieve(script, {
      ...recruiterMail,
      now: new Date("2026-11-03T00:00:00Z"),
    });
    expect(result.deliveredTo).toEqual(["Invoices/2026"]);
  });

  it("warns about commands it does not simulate", () => {
    const result = dryRunSieve(
      `require ["vacation"]; vacation :days 7 "away";`,
      recruiterMail,
    );
    expect(result.warnings.join(" ")).toMatch(/vacation/);
    expect(result.deliveredTo).toEqual(["INBOX"]);
  });

  it("exposes lint independently of a message", () => {
    const interpreter = new SieveInterpreter(
      'require ["regex"]; if header :regex "subject" "[üu]ber" { keep; }',
    );
    expect(interpreter.lint()).toHaveLength(1);
  });

  it("supports size and :count", () => {
    const script = `require ["fileinto", "relational", "comparator-i;ascii-numeric"];
if size :under 10K { fileinto "Small"; }
if header :count "ge" :comparator "i;ascii-numeric" "to" "1" { fileinto "HasTo"; }`;
    expect(dryRunSieve(script, recruiterMail).deliveredTo).toEqual([
      "Small",
      "HasTo",
    ]);
  });
});

describe("rule labels", () => {
  it("joins consecutive comment lines and keeps the first line first", () => {
    const ast = parseSieve(`# === Block v5 ===
# second line
# third line
if true { keep; }

# unrelated

# (c) own label
if false { keep; }`);
    expect(ast[0].comment).toBe("=== Block v5 === second line third line");
    expect(ast[1].comment).toBe("(c) own label");
  });

  it("strips leading hashes of OX '## Flag' comments", () => {
    const ast = parseSieve(`## Flag: |UniqueId:7|Rulename: Example
if true { keep; }`);
    expect(ast[0].comment).toBe("Flag: |UniqueId:7|Rulename: Example");
  });
});

describe("effective rules vs. helper conditions", () => {
  const script = `require ["fileinto", "variables", "regex", "body", "copy"];
# === Recruiter block ===
if not address :domain :is "from" ["partner.example"] {
  set "hit" "";
  # (a) domain
  if address :domain :regex "from" "jobvermittl" { set "hit" "a"; }
  # (b) text
  if body :text :regex "zzz-never" { set "hit" "b"; }
  if not string :is "\${hit}" "" {
    fileinto :copy "Spam";
    fileinto "INBOX/Recruiter-Spam";
    stop;
  }
}`;

  it("marks the acting rule effective and helpers as plain conditions", () => {
    const result = dryRunSieve(script, recruiterMail);
    expect(result.deliveredTo).toEqual(["Spam", "INBOX/Recruiter-Spam"]);
    const effective = result.matched.filter(m => m.effective);
    const helpers = result.matched.filter(m => !m.effective);
    expect(effective.map(m => m.rule)).toEqual([
      "=== Recruiter block ===",
      "=== Recruiter block ===",
    ]);
    expect(helpers.map(m => m.rule)).toEqual(["(a) domain"]);
  });

  it("does not treat a partner-exclusion wrapper as a hit", () => {
    const normal = message(
      "From: Amt <x@stadt-beispiel.example>\r\nSubject: Termin",
      "Hallo",
    );
    const result = dryRunSieve(script, normal);
    expect(result.deliveredTo).toEqual(["INBOX"]);
    expect(result.actions).toEqual([]);
    expect(result.matched.every(m => !m.effective)).toBe(true);
  });
});
