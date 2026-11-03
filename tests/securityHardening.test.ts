import { describe, expect, it, vi } from "vitest";
import type { EmailService } from "../src/services/EmailService.js";
import {
  dryRunSieve,
  globMatch,
  MAX_BODY_MATCH,
  SieveBudgetExceeded,
  SieveInterpreter,
  type SieveMessage,
} from "../src/services/sieve/SieveInterpreter.js";
import {
  MAX_NESTING,
  parseSieve,
  SieveSyntaxError,
} from "../src/services/sieve/SieveParser.js";
import {
  buildSieveMessage,
  DRY_RUN_TOTAL_BUDGET_MS,
  handleAnalysisTool,
  htmlToText,
  MAX_HEADER_OUTPUT_CHARS,
} from "../src/tools/analysisTools.js";
import {
  extractAddress,
  extractAddresses,
  MAX_HEADER_VALUE,
  parseHeaders,
  summarizeHeaders,
} from "../src/utils/headers.js";
import {
  testSieveScriptSchema,
  validateInput,
} from "../src/validation/schemas.js";

function message(headers: string, text = ""): SieveMessage {
  const raw = `${headers.trim()}\r\n\r\n${text}`;
  return {
    headers: parseHeaders(raw),
    text,
    rawBody: text,
    size: Buffer.byteLength(raw),
  };
}

const timed = <T>(fn: () => T): { result: T; ms: number } => {
  const start = performance.now();
  const result = fn();
  return { result, ms: performance.now() - start };
};

describe("B3: linear address parsing", () => {
  it("parses addresses with display names, comments and groups", () => {
    expect(
      extractAddresses(
        '"Muster, Erika" <erika@a.example>, max@b.example (Max), Group: c@d.example;',
      ),
    ).toEqual(["erika@a.example", "max@b.example", "c@d.example"]);
    expect(extractAddress("Name <x@y.example>")).toBe("x@y.example");
    expect(extractAddress("no address here")).toBeUndefined();
  });

  it("handles a 200 KB From value without '@' quickly", () => {
    const huge = "a".repeat(200_000);
    const { ms } = timed(() => extractAddresses(huge));
    expect(ms).toBeLessThan(200);
  });

  it("caps header values and notes it in the dry run", () => {
    const longValue = "x".repeat(MAX_HEADER_VALUE * 4);
    const headers = parseHeaders(`From: ${longValue}\r\nSubject: s\r\n\r\n`);
    const from = headers.find(h => h.name === "From");
    expect(from?.truncated).toBe(true);
    expect(from?.raw.length).toBe(MAX_HEADER_VALUE);
    const { ms } = timed(() => summarizeHeaders(headers));
    expect(ms).toBeLessThan(100);

    const result = dryRunSieve(
      'if address :contains "from" "x" { keep; }',
      message(`From: ${longValue}\r\nSubject: s`),
    );
    expect(result.warnings.join(" ")).toMatch(/16 KB were cut/);
  });
});

describe("S4: linear-time matching", () => {
  it("does not backtrack catastrophically on a nested-quantifier regex", () => {
    const mail = message(`Subject: ${"a".repeat(40)}!`);
    const { result, ms } = timed(() =>
      dryRunSieve(
        'require ["regex","fileinto"]; if header :regex "subject" "^(a+)+$" { fileinto "X"; }',
        mail,
      ),
    );
    expect(result.deliveredTo).toEqual(["INBOX"]);
    expect(ms).toBeLessThan(200);
  });

  it("matches :matches globs on large bodies in bounded time", () => {
    const body = "x".repeat(32_000);
    const mail = message("Subject: s", body);
    const { result, ms } = timed(() =>
      dryRunSieve(
        'require ["body","fileinto"]; if body :text :matches "*a*b*c*d*" { fileinto "X"; }',
        mail,
      ),
    );
    expect(result.deliveredTo).toEqual(["INBOX"]);
    expect(ms).toBeLessThan(500);
  });

  it("rejects lookaround and backreferences like the server does", () => {
    for (const pattern of ["(?!x)a", "(l)\\\\1"]) {
      const interpreter = new SieveInterpreter(
        `require ["regex"]; if header :regex "subject" "${pattern}" { keep; }`,
      );
      expect(interpreter.errors()).toHaveLength(1);
    }
  });

  it("keeps byte semantics with RE2 (bracket bug and alternation)", () => {
    const mail = message("Subject: Lebensläufe");
    expect(
      dryRunSieve(
        'require ["regex","fileinto"]; if header :regex "subject" "lebensl[äa]uf" { fileinto "X"; }',
        mail,
      ).deliveredTo,
    ).toEqual(["INBOX"]);
    expect(
      dryRunSieve(
        'require ["regex","fileinto"]; if header :regex "subject" "lebensl(ä|a)uf" { fileinto "X"; }',
        mail,
      ).deliveredTo,
    ).toEqual(["X"]);
  });

  it("returns RE2 capture groups as match variables", () => {
    const result = dryRunSieve(
      `require ["regex","variables","fileinto"];
if header :regex "subject" "^re: (.+)$" { fileinto "Re/\${1}"; }`,
      message("Subject: Re: Termin"),
    );
    expect(result.deliveredTo).toEqual(["Re/Termin"]);
  });

  it("folds only ASCII in :matches (6a)", () => {
    expect(globMatch("Hällo Welt", "HÄLLO*", true)).toBeNull();
    expect(globMatch("Hallo Welt", "HALLO*", true)).toEqual([
      "Hallo Welt",
      " Welt",
    ]);
  });

  it("computes glob captures leftmost-shortest", () => {
    expect(globMatch("a@b@c", "*@*", true)).toEqual(["a@b@c", "a", "b@c"]);
    expect(globMatch("abc", "a?c", true)).toEqual(["abc", "b"]);
    expect(globMatch("a*c", "a\\*c", true)).toEqual(["a*c"]);
    expect(globMatch("abd", "a?c", true)).toBeNull();
  });

  it("cuts very large bodies and notes it", async () => {
    const raw = Buffer.from(
      `From: a@b.example\r\nSubject: s\r\nContent-Type: text/plain\r\n\r\n${"y".repeat(MAX_BODY_MATCH + 10)}`,
    );
    const msg = await buildSieveMessage(raw);
    expect(msg.bodyTruncated).toBe(true);
    const result = new SieveInterpreter("keep;").run(msg);
    expect(msg.text.length).toBe(MAX_BODY_MATCH);
    expect(result.warnings.join(" ")).toMatch(/256 KB was cut/);
  });
});

function serviceWith(checked: Record<number, unknown>): EmailService {
  return {
    listMessageUids: vi.fn(async () => Object.keys(checked).map(Number)),
    getRawEmailChecked: vi.fn(async (uid: number) => checked[uid]),
  } as unknown as EmailService;
}

const OK_MAIL = Buffer.from(
  "From: a@b.example\r\nSubject: hello\r\n\r\nbody\r\n",
);

describe("S5: size limit and fetch status", () => {
  it("reports too large, not found and failed messages", async () => {
    const service = serviceWith({
      3: { status: "too_large", size: 25 * 1024 * 1024 },
      2: { status: "not_found" },
      1: { status: "failed" },
      4: { status: "ok", source: OK_MAIL },
    });
    const result = await handleAnalysisTool(
      "test_sieve_script",
      { script: "keep;" },
      service,
    );
    const text = result.content[0].text as string;
    expect(text).toContain("UID 3: skipped: too large (25.0 MB");
    expect(text).toContain("UID 2: not found");
    expect(text).toContain("UID 1: could not be fetched");
    expect(text).toContain("3 message(s) skipped");
    expect(text).toContain("1 message(s) tested");
  });
});

describe("S6: correct reporting and strict validation", () => {
  it("marks rejected messages (6b)", async () => {
    const result = await handleAnalysisTool(
      "test_sieve_script",
      { script: 'require ["reject"]; reject "no";' },
      serviceWith({ 1: { status: "ok", source: OK_MAIL } }),
    );
    expect(result.content[0].text).toContain("→ REJECTED");
  });

  it.each([
    ["if true;", /needs a block/],
    ["else { keep; }", /without preceding 'if'/],
    ["if true { keep; } stop; else { keep; }", /without preceding 'if'/],
    ["fileinto;", /expects 1 argument/],
    ['keep "x";', /expects 0 argument/],
    ["stop { keep; }", /takes no block/],
  ])("rejects invalid structure: %s (6c)", (script, message) => {
    expect(() => parseSieve(script)).toThrow(message);
  });

  it("returns a tool error for scripts the server would reject", async () => {
    const result = await handleAnalysisTool(
      "test_sieve_script",
      { script: "if true;" },
      serviceWith({}),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/needs a block/);

    const regexError = await handleAnalysisTool(
      "test_sieve_script",
      {
        script:
          'require ["regex"]; if header :regex "subject" "(?=x)" { keep; }',
      },
      serviceWith({}),
    );
    expect(regexError.isError).toBe(true);
    expect(regexError.content[0].text).toMatch(/server would reject/);
  });

  it("treats INBOX case-insensitively, also for expectFolder (6d)", async () => {
    const result = await handleAnalysisTool(
      "test_sieve_script",
      {
        script: 'require ["fileinto"]; fileinto "inbox/Sub";',
        expectFolder: "Inbox/Sub",
      },
      serviceWith({ 1: { status: "ok", source: OK_MAIL } }),
    );
    expect(result.content[0].text).toContain(
      "All tested messages would land in INBOX/Sub",
    );
    expect(
      dryRunSieve(
        'require ["fileinto"]; fileinto "inbox";',
        message("Subject: s"),
      ).deliveredTo,
    ).toEqual(["INBOX"]);
  });

  it("shows per-action :flags (6e)", async () => {
    const result = await handleAnalysisTool(
      "test_sieve_script",
      {
        script:
          'require ["fileinto","imap4flags"]; fileinto :flags "\\\\Seen" "Read";',
      },
      serviceWith({ 1: { status: "ok", source: OK_MAIL } }),
    );
    expect(result.content[0].text).toContain("Read (flags: \\Seen)");
  });
});

describe("N8: robustness against crafted scripts", () => {
  it("does not throw on invalid unicode code points", () => {
    const result = dryRunSieve(
      `require ["encoded-character","variables","fileinto"];
fileinto "\${unicode:110000}";`,
      message("Subject: s"),
    );
    expect(result.deliveredTo).toEqual(["�"]);
    expect(result.warnings.join(" ")).toMatch(/not a valid code point/);
  });

  it("limits nesting depth with a clear error", () => {
    const deep = `${"if true { ".repeat(MAX_NESTING + 5)}keep;${" }".repeat(MAX_NESTING + 5)}`;
    expect(() => parseSieve(deep)).toThrow(SieveSyntaxError);
    expect(() => parseSieve(deep)).toThrow(/nesting deeper than/);
    const deepTests = `if ${"not ".repeat(5000)}true { keep; }`;
    expect(() => parseSieve(deepTests)).toThrow(/nesting deeper than/);
  });
});

describe("scriptName validation (ManageSieve injection)", () => {
  it.each(['x"\r\nDELETESCRIPT "victim', "a\\b", 'q"', "a\u0001b"])(
    "rejects %j",
    name => {
      expect(() =>
        validateInput(testSieveScriptSchema, { scriptName: name }),
      ).toThrow("Validation failed");
    },
  );

  it("accepts normal names", () => {
    expect(
      validateInput(testSieveScriptSchema, { scriptName: "Filter v5 (2026)" })
        .scriptName,
    ).toBe("Filter v5 (2026)");
  });
});

describe("second review: budgets, isolation and output caps", () => {
  it("matches a long glob against a large body quickly", () => {
    const body = "a".repeat(256 * 1024);
    const start = performance.now();
    expect(globMatch(body, `*${"a".repeat(49)}b`, true)).toBeNull();
    expect(globMatch(body, `*${"a".repeat(49)}`, true)).not.toBeNull();
    expect(performance.now() - start).toBeLessThan(500);
  });

  it("keeps :matches captures and minimal earlier stars", () => {
    expect(globMatch("x-a-b-c", "*-*-?", true)).toEqual([
      "x-a-b-c",
      "x",
      "a-b",
      "c",
    ]);
    expect(globMatch("Abc", "a?C", true)).toEqual(["Abc", "b"]);
    expect(globMatch("abc", "a?C", false)).toBeNull();
    expect(globMatch("", "*", true)).toEqual(["", ""]);
    expect(globMatch("ab", "a*b*", true)).toEqual(["ab", "", ""]);
  });

  it("aborts a run whose deadline has passed", () => {
    const interpreter = new SieveInterpreter(
      'require ["fileinto"]; if header :contains "subject" "x" { fileinto "A"; }',
    );
    expect(() =>
      interpreter.run(message("Subject: x"), {
        deadline: performance.now() - 1,
      }),
    ).toThrow(SieveBudgetExceeded);
  });

  it("stops the dry run when the total budget is exhausted", async () => {
    let calls = 0;
    const spy = vi
      .spyOn(performance, "now")
      .mockImplementation(() =>
        calls++ === 0 ? 0 : DRY_RUN_TOTAL_BUDGET_MS + 1,
      );
    try {
      const result = await handleAnalysisTool(
        "test_sieve_script",
        { script: "keep;" },
        serviceWith({
          1: { status: "ok", source: Buffer.from("Subject: a\r\n\r\nx") },
          2: { status: "ok", source: Buffer.from("Subject: b\r\n\r\nx") },
        }),
      );
      const text = String(result.content[0].text);
      expect(text).toContain("budget exhausted after 0 message(s)");
      expect(text).toContain("result is partial");
    } finally {
      spy.mockRestore();
    }
  });

  it("skips one unparseable message and keeps going", async () => {
    const hugeHeaders = Buffer.from(
      `${"X-Pad: y\r\n".repeat(150_000)}\r\nbody`,
    );
    const result = await handleAnalysisTool(
      "test_sieve_script",
      { script: "keep;" },
      serviceWith({
        2: { status: "ok", source: hugeHeaders },
        1: { status: "ok", source: Buffer.from("Subject: ok\r\n\r\nx") },
      }),
    );
    const text = String(result.content[0].text);
    expect(result.isError).toBeUndefined();
    expect(text).toContain("UID 2: skipped: unparseable");
    expect(text).toContain("1 message(s) tested");
  });

  it("reports messages of unknown size as skipped", async () => {
    const result = await handleAnalysisTool(
      "test_sieve_script",
      { script: "keep;" },
      serviceWith({ 3: { status: "size_unknown" } }),
    );
    expect(String(result.content[0].text)).toContain(
      "UID 3: skipped: size unknown",
    );
  });

  it("caps get_email_headers output and marks it untrusted", async () => {
    const headers = Array.from({ length: 500 }, (_, i) => ({
      name: `X-Field-${i}`,
      raw: "v",
      value: "v".repeat(5000),
    }));
    const service = {
      getEmailHeaders: vi.fn(async () => ({
        uid: 9,
        folder: "INBOX",
        headers,
        summary: summarizeHeaders(headers),
        headersTruncated: true,
      })),
    } as unknown as EmailService;
    const result = await handleAnalysisTool(
      "get_email_headers",
      { uid: 9 },
      service,
    );
    const text = String(result.content[0].text);
    expect(text.length).toBeLessThanOrEqual(MAX_HEADER_OUTPUT_CHARS + 500);
    expect(text).toContain("untrusted");
    expect(text).toMatch(/…\[cut: \d+ more field\(s\) not shown/);
    expect(text).toContain("header block larger than 1 MB");
  });

  it("maps invalid numeric HTML entities to U+FFFD", () => {
    expect(htmlToText("<p>&#99999999; &#65;</p>")).toContain("\uFFFD A");
  });
});

describe("variable size limits", () => {
  it("caps exponential variable growth instead of exhausting memory", async () => {
    const { dryRunSieve, MAX_VARIABLE_SIZE } = await import(
      "../src/services/sieve/SieveInterpreter.js"
    );
    const { parseHeaders } = await import("../src/utils/headers.js");
    const doubling = Array.from(
      { length: 40 },
      () => 'set "a" "${a}${a}";',
    ).join("\n");
    const script = `require ["variables", "fileinto"];\nset "a" "xxxxxxxxxx";\n${doubling}\nif string :matches "\${a}" "*" { fileinto "Done"; }`;
    const raw = "From: a@b.example\r\nSubject: s\r\n\r\nbody";
    const started = Date.now();
    const result = dryRunSieve(script, {
      headers: parseHeaders(raw),
      text: "body",
      rawBody: "body",
      size: raw.length,
    });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(result.deliveredTo).toEqual(["Done"]);
    expect(result.warnings.join(" ")).toMatch(
      new RegExp(`truncated to ${MAX_VARIABLE_SIZE}`),
    );
  });
});
