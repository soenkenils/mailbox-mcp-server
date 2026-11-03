/**
 * Sieve dry-run interpreter.
 *
 * Evaluates a Sieve script against a single message WITHOUT touching the
 * server and reports which rules fire and where the message would end up.
 *
 * Semantics follow Dovecot Pigeonhole (as used by mailbox.org) where it
 * matters in practice:
 *  - `i;ascii-casemap` (default comparator) folds ASCII letters only.
 *  - `:regex` works on UTF-8 BYTES, not characters (POSIX regcomp). A bracket
 *    expression like `[äa]` therefore matches single bytes and will NOT match
 *    "ä" (two bytes). The interpreter reproduces this and emits a warning,
 *    because it is an easy-to-miss filter bug.
 *
 * Supported: require, if/elsif/else, stop, keep, discard, fileinto (:copy,
 * :create, :flags), redirect (:copy), reject/ereject, addflag/setflag/
 * removeflag, set (with modifiers); tests: true, false, not, allof, anyof,
 * header, address, envelope (approximated from headers), exists, size, body,
 * string, hasflag, currentdate, date; match types :is :contains :matches
 * :regex :value :count; comparators i;ascii-casemap, i;octet,
 * i;ascii-numeric; variables incl. match variables ${0}..${9}.
 *
 * Not simulated (reported as warnings): vacation, notify, include, duplicate,
 * mime-related tags and anything unknown.
 */

import { RE2JS } from "re2js";
import type { HeaderField } from "../../utils/headers.js";
import { extractAddresses, getHeaderValues } from "../../utils/headers.js";
import {
  parseSieve,
  type SieveArgument,
  type SieveCommand,
  type SieveTest,
} from "./SieveParser.js";

export interface SieveMessage {
  headers: HeaderField[];
  /** Decoded text body (text/plain, or text/html converted to text) */
  text: string;
  /** Raw (undecoded) body as it appears after the header block */
  rawBody: string;
  /** Message size in bytes */
  size: number;
  /** Optional envelope; if missing it is approximated from headers */
  envelope?: { from?: string; to?: string };
  /** Reference time for currentdate (default: now) */
  now?: Date;
  /** Set when the message body was cut to MAX_BODY_MATCH bytes */
  bodyTruncated?: boolean;
}

/** Bodies longer than this are cut before matching (see buildSieveMessage) */
export const MAX_BODY_MATCH = 256 * 1024;
/** Max length of a variable or match variable (Dovecot default: 4 KB) */
export const MAX_VARIABLE_SIZE = 4096;
/** Max length of a string after variable expansion */
export const MAX_EXPANDED_SIZE = 64 * 1024;

/**
 * Thrown when evaluating a script exceeds its time budget (see
 * `SieveRunOptions.deadline`). Keeps a crafted message or script from
 * blocking the event loop of the MCP server.
 */
export class SieveBudgetExceeded extends Error {
  constructor() {
    super("evaluation budget exceeded");
    this.name = "SieveBudgetExceeded";
  }
}

export interface SieveRunOptions {
  /** Absolute deadline as `performance.now()` value */
  deadline?: number;
}

/** Budget shared by the matchers of one run */
interface MatchBudget {
  deadline?: number;
}

function checkDeadline(budget?: MatchBudget) {
  if (budget?.deadline !== undefined && performance.now() > budget.deadline) {
    throw new SieveBudgetExceeded();
  }
}

export interface SieveLintIssue {
  severity: "error" | "warning";
  line: number;
  message: string;
}

export type SieveActionType =
  | "keep"
  | "fileinto"
  | "redirect"
  | "discard"
  | "reject"
  | "addflag"
  | "setflag"
  | "removeflag"
  | "unsupported";

export interface SieveAction {
  type: SieveActionType;
  target?: string;
  copy?: boolean;
  create?: boolean;
  flags?: string[];
  line: number;
  rule?: string;
}

export interface SieveTraceEntry {
  line: number;
  command: "if" | "elsif" | "else";
  result: boolean;
  rule?: string;
  /** True if the block of this condition produced an action or a stop */
  effective: boolean;
}

export interface SieveDryRunResult {
  actions: SieveAction[];
  /** True if the implicit keep (delivery to INBOX) still applies */
  implicitKeep: boolean;
  /** Folders the message ends up in (INBOX if implicit keep) */
  deliveredTo: string[];
  redirectedTo: string[];
  discarded: boolean;
  /** True if the message would be rejected (reject/ereject) */
  rejected: boolean;
  /** Flags set on delivery */
  flags: string[];
  /** Conditions that evaluated to true, in order */
  matched: SieveTraceEntry[];
  /** Whether a `stop` was executed */
  stopped: boolean;
  /** Line where `stop` was executed */
  stoppedAt?: number;
  warnings: string[];
}

interface TestOptions {
  comparator: string;
  matchType: "is" | "contains" | "matches" | "regex" | "value" | "count";
  relational?: string;
  addressPart: "all" | "localpart" | "domain" | "user" | "detail";
  bodyTransform: "text" | "raw" | "content";
  sizeOp?: "over" | "under";
  zone?: string;
  positional: SieveArgument[];
}

const MATCH_TYPES = new Set([
  "is",
  "contains",
  "matches",
  "regex",
  "value",
  "count",
]);
const ADDRESS_PARTS = new Set(["all", "localpart", "domain", "user", "detail"]);

const POSIX_CLASSES: Record<string, string> = {
  alpha: "A-Za-z",
  digit: "0-9",
  alnum: "A-Za-z0-9",
  upper: "A-Z",
  lower: "a-z",
  space: " \\t\\r\\n\\f\\v",
  blank: " \\t",
  punct: "!-\\/:-@\\[-`{-~",
  xdigit: "0-9A-Fa-f",
  cntrl: "\\x00-\\x1f\\x7f",
  print: "\\x20-\\x7e",
  graph: "\\x21-\\x7e",
};

function foldAscii(value: string): string {
  return value.replace(/[A-Z]/g, c => c.toLowerCase());
}

/** UTF-8 string -> "binary" string (one JS char per byte) */
function toBytes(value: string): string {
  return Buffer.from(value, "utf8").toString("latin1");
}

/** "binary" string -> UTF-8 string */
function fromBytes(value: string): string {
  return Buffer.from(value, "latin1").toString("utf8");
}

/**
 * "INBOX" is case-insensitive in IMAP (RFC 3501), also as hierarchy prefix.
 */
export function normalizeMailbox(name: string): string {
  if (name.toUpperCase() === "INBOX") {
    return "INBOX";
  }
  if (/^inbox[/.]/i.test(name)) {
    return `INBOX${name.slice(5)}`;
  }
  return name;
}

type GlobToken =
  | { type: "lit"; ch: string }
  | { type: "any" }
  | { type: "star" };

function tokenizeGlob(glob: string): GlobToken[] {
  const tokens: GlobToken[] = [];
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "\\" && i + 1 < glob.length) {
      tokens.push({ type: "lit", ch: glob[i + 1] });
      i++;
    } else if (ch === "*") {
      tokens.push({ type: "star" });
    } else if (ch === "?") {
      tokens.push({ type: "any" });
    } else {
      tokens.push({ type: "lit", ch });
    }
  }
  return tokens;
}

/**
 * Sieve :matches without RegExp. The glob is split at "*" into segments
 * (literals and "?"). The first segment is anchored at the start, the last
 * at the end, and every middle segment is placed at its leftmost
 * occurrence, which is sufficient for a match and makes earlier "*" match
 * as little as possible, like Pigeonhole. Segments without "?" are located
 * with the native `indexOf`, so typical globs run in near-linear time even
 * on large bodies; segments with "?" use a step-counted scan that honours
 * the run budget.
 *
 * Returns the match variables (${0} = whole value, ${1}.. = one per
 * wildcard, "*" and "?") or null if the value does not match.
 */
export function globMatch(
  value: string,
  glob: string,
  foldCase: boolean,
  budget?: MatchBudget,
): string[] | null {
  const tokens = tokenizeGlob(glob);
  const text = foldCase ? foldAscii(value) : value;

  interface Segment {
    /** Folded literal chars, or null for "?" */
    chars: Array<string | null>;
    /** Plain literal string if the segment has no "?" */
    literal: string | null;
    /** Index of the segment's first token in `tokens` */
    firstToken: number;
  }
  const segments: Segment[] = [];
  let current: Segment = { chars: [], literal: null, firstToken: 0 };
  tokens.forEach((token, idx) => {
    if (token.type === "star") {
      segments.push(current);
      current = { chars: [], literal: null, firstToken: idx + 1 };
    } else {
      current.chars.push(
        token.type === "any" ? null : foldCase ? foldAscii(token.ch) : token.ch,
      );
    }
  });
  segments.push(current);
  for (const seg of segments) {
    seg.literal = seg.chars.every(c => c !== null) ? seg.chars.join("") : null;
  }

  let steps = 0;
  const matchesAt = (seg: Segment, pos: number): boolean => {
    if (pos < 0 || pos + seg.chars.length > text.length) {
      return false;
    }
    for (let k = 0; k < seg.chars.length; k++) {
      if (++steps % 65536 === 0) checkDeadline(budget);
      const c = seg.chars[k];
      if (c !== null && c !== text[pos + k]) {
        return false;
      }
    }
    return true;
  };
  const find = (seg: Segment, from: number): number => {
    if (seg.literal !== null) {
      checkDeadline(budget);
      return text.indexOf(seg.literal, from);
    }
    for (let pos = from; pos + seg.chars.length <= text.length; pos++) {
      if (matchesAt(seg, pos)) {
        return pos;
      }
    }
    return -1;
  };

  const starts: number[] = new Array(segments.length).fill(0);
  const last = segments.length - 1;
  if (last === 0) {
    if (
      segments[0].chars.length !== text.length ||
      !matchesAt(segments[0], 0)
    ) {
      return null;
    }
  } else {
    if (!matchesAt(segments[0], 0)) {
      return null;
    }
    let pos = segments[0].chars.length;
    for (let i = 1; i < last; i++) {
      const found = find(segments[i], pos);
      if (found < 0) {
        return null;
      }
      starts[i] = found;
      pos = found + segments[i].chars.length;
    }
    const tailStart = text.length - segments[last].chars.length;
    if (tailStart < pos || !matchesAt(segments[last], tailStart)) {
      return null;
    }
    starts[last] = tailStart;
  }

  // Build match variables in token order
  const vars = [value];
  let segIndex = 0;
  for (let idx = 0; idx < tokens.length; idx++) {
    const token = tokens[idx];
    if (token.type === "star") {
      const from = starts[segIndex] + segments[segIndex].chars.length;
      vars.push(value.slice(from, starts[segIndex + 1]));
      segIndex++;
    } else if (token.type === "any") {
      const offset = idx - segments[segIndex].firstToken;
      vars.push(value.charAt(starts[segIndex] + offset));
    }
  }
  return vars;
}

/** Translate POSIX bracket classes like [[:alpha:]] to JS ranges */
function translatePosixRegex(pattern: string): string {
  return pattern.replace(
    /\[:([a-z]+):\]/g,
    (match, name: string) => POSIX_CLASSES[name] ?? match,
  );
}

function addressPart(address: string, part: TestOptions["addressPart"]) {
  const at = address.lastIndexOf("@");
  const local = at >= 0 ? address.slice(0, at) : address;
  const domain = at >= 0 ? address.slice(at + 1) : "";
  switch (part) {
    case "localpart":
      return local;
    case "domain":
      return domain;
    case "user":
      return local.split("+")[0];
    case "detail": {
      const plus = local.indexOf("+");
      return plus >= 0 ? local.slice(plus + 1) : "";
    }
    default:
      return address;
  }
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, "0");
}

function datePart(date: Date, part: string, zone?: string): string | null {
  // Shift date into requested zone (format "+0100"/"-0500"); default UTC
  let offsetMinutes = 0;
  if (zone && /^[+-]\d{4}$/.test(zone)) {
    const sign = zone.startsWith("-") ? -1 : 1;
    offsetMinutes =
      sign *
      (Number.parseInt(zone.slice(1, 3), 10) * 60 +
        Number.parseInt(zone.slice(3, 5), 10));
  }
  const d = new Date(date.getTime() + offsetMinutes * 60000);
  const zoneStr = zone && /^[+-]\d{4}$/.test(zone) ? zone : "+0000";
  switch (part) {
    case "year":
      return String(d.getUTCFullYear());
    case "month":
      return pad(d.getUTCMonth() + 1);
    case "day":
      return pad(d.getUTCDate());
    case "date":
      return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    case "hour":
      return pad(d.getUTCHours());
    case "minute":
      return pad(d.getUTCMinutes());
    case "second":
      return pad(d.getUTCSeconds());
    case "time":
      return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
    case "weekday":
      return String(d.getUTCDay());
    case "zone":
      return zoneStr;
    case "iso8601":
      return `${d.toISOString().slice(0, 19)}${zoneStr.slice(0, 3)}:${zoneStr.slice(3)}`;
    case "julian":
      return String(Math.floor(d.getTime() / 86400000 + 40587));
    default:
      return null;
  }
}

const regexCache = new Map<string, RE2JS | Error>();
const REGEX_CACHE_LIMIT = 500;

/**
 * Compile a Sieve :regex key with RE2 (linear time, no backtracking).
 * Like Dovecot's POSIX regcomp, it works on UTF-8 bytes and rejects
 * constructs such as lookaround and backreferences.
 */
export function compileSieveRegex(
  pattern: string,
  comparator = "i;ascii-casemap",
): RE2JS | Error {
  const caseInsensitive = comparator !== "i;octet";
  const cacheKey = `${caseInsensitive ? "i" : "o"}:${pattern}`;
  const cached = regexCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  let compiled: RE2JS | Error;
  try {
    compiled = RE2JS.compile(
      toBytes(translatePosixRegex(pattern)),
      RE2JS.DOTALL | (caseInsensitive ? RE2JS.CASE_INSENSITIVE : 0),
    );
  } catch (error) {
    compiled = new Error(
      error instanceof Error ? error.message : String(error),
    );
  }
  if (regexCache.size >= REGEX_CACHE_LIMIT) {
    regexCache.clear();
  }
  regexCache.set(cacheKey, compiled);
  return compiled;
}

export class SieveInterpreter {
  private readonly commands: SieveCommand[];
  private requires = new Set<string>();

  constructor(script: string) {
    this.commands = parseSieve(script);
    this.collectRequires(this.commands);
  }

  private collectRequires(commands: SieveCommand[]) {
    for (const cmd of commands) {
      if (cmd.name === "require") {
        for (const arg of cmd.args) {
          if (arg.type === "string") {
            this.requires.add(arg.value.toLowerCase());
          } else if (arg.type === "list") {
            for (const v of arg.values) {
              this.requires.add(v.toLowerCase());
            }
          }
        }
      }
      if (cmd.block) {
        this.collectRequires(cmd.block);
      }
    }
  }

  /**
   * Static checks that do not need a message, e.g. the UTF-8 bracket bug.
   */
  /**
   * Static checks that need no message: regex syntax the server would
   * reject (lookaround, backreferences, ...) and the UTF-8 bracket bug.
   */
  issues(): SieveLintIssue[] {
    const issues: SieveLintIssue[] = [];
    const checkRegex = (value: string, line: number, comparator: string) => {
      if (this.requires.has("variables") && value.includes("${")) {
        return; // depends on runtime values
      }
      const compiled = compileSieveRegex(value, comparator);
      if (compiled instanceof Error) {
        issues.push({
          severity: "error",
          line,
          message: `:regex "${value.slice(0, 60)}" is not valid POSIX/RE2 syntax (${compiled.message}); the server would reject the script`,
        });
        return;
      }
      const brackets = value.match(/\[[^\]]*\]/g) ?? [];
      const nonAscii = brackets.some(b =>
        [...b].some(ch => (ch.codePointAt(0) ?? 0) > 0x7f),
      );
      if (nonAscii) {
        issues.push({
          severity: "warning",
          line,
          message: `:regex bracket expression with non-ASCII characters (${value.slice(0, 40)}). Dovecot matches bytes, so e.g. [äa] never matches "ä". Use (ä|a) instead.`,
        });
      }
    };
    const visitTests = (tests: SieveTest[]) => {
      for (const t of tests) {
        const isRegex = t.args.some(
          a => a.type === "tag" && a.value === "regex",
        );
        if (isRegex) {
          const cmpIndex = t.args.findIndex(
            a => a.type === "tag" && a.value === "comparator",
          );
          const cmpArg = cmpIndex >= 0 ? t.args[cmpIndex + 1] : undefined;
          const comparator =
            cmpArg?.type === "string"
              ? cmpArg.value.toLowerCase()
              : "i;ascii-casemap";
          // the key list is the last string/list argument
          const keyArg = [...t.args]
            .reverse()
            .find(a => a.type === "string" || a.type === "list");
          const keys =
            keyArg?.type === "string"
              ? [keyArg.value]
              : keyArg?.type === "list"
                ? keyArg.values
                : [];
          for (const key of keys) {
            checkRegex(key, t.line, comparator);
          }
        }
        visitTests(t.tests);
      }
    };
    const visitCommands = (cmds: SieveCommand[]) => {
      for (const c of cmds) {
        visitTests(c.tests);
        if (c.block) {
          visitCommands(c.block);
        }
      }
    };
    visitCommands(this.commands);
    return issues;
  }

  /** Warning messages of issues(), formatted "Line N: ..." */
  lint(): string[] {
    return this.issues()
      .filter(i => i.severity === "warning")
      .map(i => `Line ${i.line}: ${i.message}`);
  }

  /** Error messages of issues(): the server would not load the script */
  errors(): string[] {
    return this.issues()
      .filter(i => i.severity === "error")
      .map(i => `Line ${i.line}: ${i.message}`);
  }

  run(message: SieveMessage, options: SieveRunOptions = {}): SieveDryRunResult {
    const state = new RunState(message, this.requires, {
      deadline: options.deadline,
    });
    state.noteTruncation();
    try {
      state.execBlock(this.commands);
    } catch (error) {
      if (!(error instanceof StopSignal)) {
        throw error;
      }
    }
    return state.result();
  }
}

class StopSignal {}

class RunState {
  private variables = new Map<string, string>();
  private matchVars: string[] = [];
  private actions: SieveAction[] = [];
  private matched: SieveTraceEntry[] = [];
  private warnings = new Set<string>();
  private implicitKeep = true;
  private stopped = false;
  private stoppedAt?: number;
  private currentRule?: string;

  constructor(
    private readonly message: SieveMessage,
    private readonly requires: Set<string>,
    private readonly budget: MatchBudget = {},
  ) {}

  private warn(text: string) {
    this.warnings.add(text);
  }

  noteTruncation() {
    if (this.message.headers.some(h => h.truncated)) {
      this.warn("header values longer than 16 KB were cut before matching");
    }
    if (this.message.bodyTruncated) {
      this.warn(
        `message body longer than ${MAX_BODY_MATCH / 1024} KB was cut before matching`,
      );
    }
  }

  // ---------------------------------------------------------------- strings

  /** Truncate a variable value like Dovecot does (with a note) */
  private capVariable(value: string): string {
    if (value.length <= MAX_VARIABLE_SIZE) {
      return value;
    }
    this.warn(
      `variable value truncated to ${MAX_VARIABLE_SIZE} characters (server limit)`,
    );
    return value.slice(0, MAX_VARIABLE_SIZE);
  }

  private expand(value: string): string {
    const expanded = this.expandUncapped(value);
    if (expanded.length <= MAX_EXPANDED_SIZE) {
      return expanded;
    }
    this.warn(`expanded string truncated to ${MAX_EXPANDED_SIZE} characters`);
    return expanded.slice(0, MAX_EXPANDED_SIZE);
  }

  private expandUncapped(value: string): string {
    let out = value;
    if (this.requires.has("encoded-character")) {
      out = out.replace(/\$\{hex:([0-9a-fA-F\s]+)\}/gi, (_m, hex: string) =>
        Buffer.from(hex.replace(/\s+/g, ""), "hex").toString("utf8"),
      );
      out = out.replace(
        /\$\{unicode:([0-9a-fA-F\s]+)\}/gi,
        (_m, codes: string) =>
          codes
            .trim()
            .split(/\s+/)
            .map(c => {
              const cp = Number.parseInt(c, 16);
              if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
                this.warn(`\${unicode:${c}} is not a valid code point`);
                return "\uFFFD";
              }
              return String.fromCodePoint(cp);
            })
            .join(""),
      );
    }
    if (!this.requires.has("variables")) {
      return out;
    }
    return out.replace(/\$\{([^}]*)\}/g, (match, name: string) => {
      const trimmed = name.trim();
      if (/^\d+$/.test(trimmed)) {
        return this.matchVars[Number.parseInt(trimmed, 10)] ?? "";
      }
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) {
        return this.variables.get(trimmed.toLowerCase()) ?? "";
      }
      return match;
    });
  }

  private strings(arg: SieveArgument | undefined): string[] {
    if (!arg) {
      return [];
    }
    if (arg.type === "string") {
      return [this.expand(arg.value)];
    }
    if (arg.type === "list") {
      return arg.values.map(v => this.expand(v));
    }
    if (arg.type === "number") {
      return [String(arg.value)];
    }
    return [];
  }

  // -------------------------------------------------------------- commands

  execBlock(commands: SieveCommand[]) {
    let chainDone = true;
    for (const cmd of commands) {
      if (this.stopped) {
        return;
      }
      switch (cmd.name) {
        case "if": {
          const ruleBefore = this.currentRule;
          const result = this.evalTop(cmd);
          chainDone = result;
          if (result) {
            this.runMatchedBlock(this.trace(cmd, "if"), cmd.block);
          }
          this.currentRule = ruleBefore;
          break;
        }
        case "elsif": {
          if (chainDone) {
            break;
          }
          const result = this.evalTop(cmd);
          chainDone = result;
          if (result) {
            this.runMatchedBlock(this.trace(cmd, "elsif"), cmd.block);
          }
          break;
        }
        case "else": {
          if (!chainDone) {
            chainDone = true;
            this.runMatchedBlock(this.trace(cmd, "else"), cmd.block);
          }
          break;
        }
        default:
          chainDone = true;
          this.execCommand(cmd);
      }
    }
  }

  /** Run a matched block and mark the trace entry as effective if it acted */
  private runMatchedBlock(entry: SieveTraceEntry, block?: SieveCommand[]) {
    const before = this.actions.length;
    try {
      if (block) {
        this.execBlock(block);
      }
    } finally {
      entry.effective = this.actions.length > before || this.stopped;
    }
  }

  private evalTop(cmd: SieveCommand): boolean {
    const previousRule = this.currentRule;
    if (cmd.comment) {
      this.currentRule = cmd.comment;
    }
    const test = cmd.tests[0];
    if (!test) {
      this.warn(`Line ${cmd.line}: '${cmd.name}' without test`);
      return false;
    }
    const result = this.evalTest(test);
    if (!result) {
      this.currentRule = previousRule;
    }
    return result;
  }

  private trace(
    cmd: SieveCommand,
    command: SieveTraceEntry["command"],
  ): SieveTraceEntry {
    const entry: SieveTraceEntry = {
      line: cmd.line,
      command,
      result: true,
      effective: false,
      ...(this.currentRule ? { rule: this.currentRule } : {}),
    };
    this.matched.push(entry);
    return entry;
  }

  private addAction(action: Omit<SieveAction, "rule">) {
    this.actions.push({
      ...action,
      ...(this.currentRule ? { rule: this.currentRule } : {}),
    });
  }

  private execCommand(cmd: SieveCommand) {
    checkDeadline(this.budget);
    const tags = cmd.args
      .filter(a => a.type === "tag")
      .map(a => (a as { value: string }).value);
    const positional = cmd.args.filter(a => a.type !== "tag");

    switch (cmd.name) {
      case "require":
        return;
      case "stop":
        this.stopped = true;
        this.stoppedAt = cmd.line;
        throw new StopSignal();
      case "keep":
        this.addAction({ type: "keep", target: "INBOX", line: cmd.line });
        this.implicitKeep = false;
        return;
      case "discard":
        this.addAction({ type: "discard", line: cmd.line });
        this.implicitKeep = false;
        return;
      case "fileinto": {
        const flagsIndex = cmd.args.findIndex(
          a => a.type === "tag" && a.value === "flags",
        );
        const flags =
          flagsIndex >= 0 ? this.strings(cmd.args[flagsIndex + 1]) : undefined;
        // skip the argument that belongs to :flags
        const folderArg = positional.filter(
          arg => !(flagsIndex >= 0 && cmd.args.indexOf(arg) === flagsIndex + 1),
        );
        const target = this.strings(folderArg[folderArg.length - 1])[0] ?? "";
        const copy = tags.includes("copy");
        this.addAction({
          type: "fileinto",
          target,
          copy,
          create: tags.includes("create"),
          ...(flags ? { flags } : {}),
          line: cmd.line,
        });
        if (!copy) {
          this.implicitKeep = false;
        }
        return;
      }
      case "redirect": {
        const target = this.strings(positional[positional.length - 1])[0] ?? "";
        const copy = tags.includes("copy");
        this.addAction({ type: "redirect", target, copy, line: cmd.line });
        if (!copy) {
          this.implicitKeep = false;
        }
        return;
      }
      case "reject":
      case "ereject":
        this.addAction({ type: "reject", line: cmd.line });
        this.implicitKeep = false;
        return;
      case "addflag":
      case "setflag":
      case "removeflag": {
        const values = positional.flatMap(a => this.strings(a));
        // Optional first argument is a variable name (imap4flags)
        const varName =
          positional.length > 1 ? (values.shift() ?? "") : "__flags__";
        const current = new Set(
          (this.variables.get(varName.toLowerCase()) ?? "")
            .split(/\s+/)
            .filter(Boolean),
        );
        const flags = values.flatMap(v => v.split(/\s+/)).filter(Boolean);
        if (cmd.name === "setflag") {
          current.clear();
        }
        for (const flag of flags) {
          if (cmd.name === "removeflag") {
            current.delete(flag);
          } else {
            current.add(flag);
          }
        }
        this.variables.set(varName.toLowerCase(), [...current].join(" "));
        this.addAction({ type: cmd.name, flags, line: cmd.line });
        return;
      }
      case "set": {
        const values = positional.flatMap(a => this.strings(a));
        if (values.length < 2) {
          this.warn(`Line ${cmd.line}: set needs name and value`);
          return;
        }
        const name = values[0];
        let value = values[1];
        for (const mod of tags) {
          switch (mod) {
            case "lower":
              value = value.toLowerCase();
              break;
            case "upper":
              value = value.toUpperCase();
              break;
            case "lowerfirst":
              value = value.charAt(0).toLowerCase() + value.slice(1);
              break;
            case "upperfirst":
              value = value.charAt(0).toUpperCase() + value.slice(1);
              break;
            case "quotewildcard":
              value = value.replace(/[*?\\]/g, "\\$&");
              break;
            case "length":
              value = String([...value].length);
              break;
          }
        }
        this.variables.set(name.toLowerCase(), this.capVariable(value));
        return;
      }
      default:
        this.addAction({
          type: "unsupported",
          target: cmd.name,
          line: cmd.line,
        });
        this.warn(
          `Line ${cmd.line}: command '${cmd.name}' is not simulated in the dry run`,
        );
    }
  }

  // ----------------------------------------------------------------- tests

  private parseOptions(args: SieveArgument[]): TestOptions {
    const opts: TestOptions = {
      comparator: "i;ascii-casemap",
      matchType: "is",
      addressPart: "all",
      bodyTransform: "text",
      positional: [],
    };
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg.type !== "tag") {
        opts.positional.push(arg);
        continue;
      }
      const tag = arg.value;
      if (tag === "comparator") {
        opts.comparator = (this.strings(args[++i])[0] ?? "").toLowerCase();
      } else if (MATCH_TYPES.has(tag)) {
        opts.matchType = tag as TestOptions["matchType"];
        if (tag === "value" || tag === "count") {
          opts.relational = (this.strings(args[++i])[0] ?? "eq").toLowerCase();
        }
      } else if (ADDRESS_PARTS.has(tag)) {
        opts.addressPart = tag as TestOptions["addressPart"];
      } else if (tag === "raw" || tag === "text") {
        opts.bodyTransform = tag;
      } else if (tag === "content") {
        opts.bodyTransform = "content";
        i++; // content type list
      } else if (tag === "over" || tag === "under") {
        opts.sizeOp = tag;
      } else if (tag === "zone") {
        opts.zone = this.strings(args[++i])[0];
      } else if (tag === "originalzone") {
        // keep zone of the header date - approximated as UTC
      } else {
        this.warn(`Tag ':${tag}' is ignored in the dry run`);
      }
    }
    return opts;
  }

  private compare(a: string, b: string, comparator: string): number {
    if (comparator === "i;ascii-numeric") {
      const na = /^\d+/.exec(a);
      const nb = /^\d+/.exec(b);
      if (!na && !nb) return 0;
      if (!na) return 1; // non-numbers are "infinity"
      if (!nb) return -1;
      return Number(na[0]) - Number(nb[0]);
    }
    const x = comparator === "i;octet" ? a : foldAscii(a);
    const y = comparator === "i;octet" ? b : foldAscii(b);
    return x < y ? -1 : x > y ? 1 : 0;
  }

  private relational(cmp: number, rel: string | undefined): boolean {
    switch (rel) {
      case "gt":
        return cmp > 0;
      case "ge":
        return cmp >= 0;
      case "lt":
        return cmp < 0;
      case "le":
        return cmp <= 0;
      case "ne":
        return cmp !== 0;
      default:
        return cmp === 0;
    }
  }

  /** Core string matching; sets match variables on success */
  private match(values: string[], keys: string[], opts: TestOptions): boolean {
    const { matchType, comparator } = opts;

    if (matchType === "count") {
      const count = String(values.length);
      return keys.some(k =>
        this.relational(
          this.compare(count, k, "i;ascii-numeric"),
          opts.relational,
        ),
      );
    }

    for (const value of values) {
      for (const key of keys) {
        checkDeadline(this.budget);
        switch (matchType) {
          case "is":
            if (this.compare(value, key, comparator) === 0) return true;
            break;
          case "contains": {
            const v = comparator === "i;octet" ? value : foldAscii(value);
            const k = comparator === "i;octet" ? key : foldAscii(key);
            if (v.includes(k)) return true;
            break;
          }
          case "value":
            if (
              this.relational(
                this.compare(value, key, comparator),
                opts.relational,
              )
            ) {
              return true;
            }
            break;
          case "matches": {
            const vars = globMatch(
              value,
              key,
              comparator !== "i;octet",
              this.budget,
            );
            if (vars) {
              this.matchVars = vars.map(v => this.capVariable(v));
              return true;
            }
            break;
          }
          case "regex": {
            const compiled = compileSieveRegex(key, comparator);
            if (compiled instanceof Error) {
              this.warn(
                `Invalid regex '${key.slice(0, 60)}': ${compiled.message}`,
              );
              break;
            }
            const m = compiled.matcher(toBytes(value));
            if (m.find()) {
              const vars: string[] = [];
              for (let g = 0; g <= m.groupCount(); g++) {
                const group = m.group(g);
                vars.push(group === null ? "" : fromBytes(group));
              }
              this.matchVars = vars.map(v => this.capVariable(v));
              return true;
            }
            break;
          }
        }
      }
    }
    return false;
  }

  private headerNames(arg: SieveArgument | undefined): string[] {
    return this.strings(arg);
  }

  private envelopeValues(part: string): string[] {
    const env = this.message.envelope;
    const lower = part.toLowerCase();
    if (lower === "from") {
      if (env?.from !== undefined) return [env.from];
      this.warn('envelope "from" approximated from the Return-Path header');
      return getHeaderValues(this.message.headers, "Return-Path").flatMap(
        extractAddresses,
      );
    }
    if (lower === "to") {
      if (env?.to !== undefined) return [env.to];
      this.warn(
        'envelope "to" approximated from Delivered-To/X-Original-To/To headers',
      );
      for (const name of ["Delivered-To", "X-Original-To", "To"]) {
        const values = getHeaderValues(this.message.headers, name).flatMap(
          extractAddresses,
        );
        if (values.length) return values;
      }
    }
    return [];
  }

  private evalTest(test: SieveTest): boolean {
    checkDeadline(this.budget);
    switch (test.name) {
      case "true":
        return true;
      case "false":
        return false;
      case "not":
        return test.tests[0] ? !this.evalTest(test.tests[0]) : true;
      case "allof":
        return test.tests.every(t => this.evalTest(t));
      case "anyof":
        return test.tests.some(t => this.evalTest(t));
      case "header": {
        const opts = this.parseOptions(test.args);
        const names = this.headerNames(opts.positional[0]);
        const keys = this.strings(opts.positional[1]);
        const values = names.flatMap(n =>
          getHeaderValues(this.message.headers, n),
        );
        return this.match(values, keys, opts);
      }
      case "address": {
        const opts = this.parseOptions(test.args);
        const names = this.headerNames(opts.positional[0]);
        const keys = this.strings(opts.positional[1]);
        const values = names
          .flatMap(n => getHeaderValues(this.message.headers, n))
          .flatMap(extractAddresses)
          .map(a => addressPart(a, opts.addressPart));
        return this.match(values, keys, opts);
      }
      case "envelope": {
        const opts = this.parseOptions(test.args);
        const parts = this.strings(opts.positional[0]);
        const keys = this.strings(opts.positional[1]);
        const values = parts
          .flatMap(p => this.envelopeValues(p))
          .map(a => addressPart(a, opts.addressPart));
        return this.match(values, keys, opts);
      }
      case "exists": {
        const names = this.strings(test.args.find(a => a.type !== "tag"));
        return names.every(
          n => getHeaderValues(this.message.headers, n).length > 0,
        );
      }
      case "size": {
        const opts = this.parseOptions(test.args);
        const limit =
          opts.positional[0]?.type === "number" ? opts.positional[0].value : 0;
        return opts.sizeOp === "under"
          ? this.message.size < limit
          : this.message.size > limit;
      }
      case "body": {
        const opts = this.parseOptions(test.args);
        if (opts.bodyTransform === "content") {
          this.warn("body :content is approximated with the decoded text body");
        }
        const keys = this.strings(opts.positional[0]);
        const value =
          opts.bodyTransform === "raw"
            ? this.message.rawBody
            : this.message.text;
        return this.match([value], keys, opts);
      }
      case "string": {
        const opts = this.parseOptions(test.args);
        const sources = this.strings(opts.positional[0]);
        const keys = this.strings(opts.positional[1]);
        // RFC 5229: empty strings don't count for :count
        const values =
          opts.matchType === "count" ? sources.filter(s => s !== "") : sources;
        return this.match(values, keys, opts);
      }
      case "hasflag": {
        const opts = this.parseOptions(test.args);
        const varNames =
          opts.positional.length > 1
            ? this.strings(opts.positional[0])
            : ["__flags__"];
        const keys = this.strings(opts.positional[opts.positional.length - 1]);
        const flags = varNames.flatMap(v =>
          (this.variables.get(v.toLowerCase()) ?? "")
            .split(/\s+/)
            .filter(Boolean),
        );
        return this.match(flags, keys, opts);
      }
      case "currentdate": {
        const opts = this.parseOptions(test.args);
        const part = this.strings(opts.positional[0])[0] ?? "";
        const keys = this.strings(opts.positional[1]);
        const value = datePart(this.message.now ?? new Date(), part, opts.zone);
        if (value === null) {
          this.warn(`currentdate: date-part '${part}' is not supported`);
          return false;
        }
        return this.match([value], keys, opts);
      }
      case "date": {
        const opts = this.parseOptions(test.args);
        const header = this.strings(opts.positional[0])[0] ?? "";
        const part = this.strings(opts.positional[1])[0] ?? "";
        const keys = this.strings(opts.positional[2]);
        const raw = getHeaderValues(this.message.headers, header)[0];
        const parsed = raw ? new Date(raw) : null;
        if (!parsed || Number.isNaN(parsed.getTime())) {
          return false;
        }
        const value = datePart(parsed, part, opts.zone);
        return value === null ? false : this.match([value], keys, opts);
      }
      case "duplicate":
        this.warn("test 'duplicate' is not simulated (always false)");
        return false;
      default:
        this.warn(
          `Line ${test.line}: test '${test.name}' is not simulated (treated as false)`,
        );
        return false;
    }
  }

  result(): SieveDryRunResult {
    const deliveredTo: string[] = [];
    const redirectedTo: string[] = [];
    let discarded = false;
    let rejected = false;
    for (const action of this.actions) {
      if (action.type === "fileinto" && action.target) {
        deliveredTo.push(normalizeMailbox(action.target));
      } else if (action.type === "keep") {
        deliveredTo.push("INBOX");
      } else if (action.type === "redirect" && action.target) {
        redirectedTo.push(action.target);
      } else if (action.type === "discard") {
        discarded = true;
      } else if (action.type === "reject") {
        rejected = true;
      }
    }
    if (this.implicitKeep) {
      deliveredTo.push("INBOX");
    }
    const flags = (this.variables.get("__flags__") ?? "")
      .split(/\s+/)
      .filter(Boolean);
    return {
      actions: this.actions,
      implicitKeep: this.implicitKeep,
      deliveredTo: [...new Set(deliveredTo)],
      redirectedTo,
      discarded: discarded && deliveredTo.length === 0,
      rejected,
      flags,
      matched: this.matched,
      stopped: this.stopped,
      ...(this.stoppedAt !== undefined ? { stoppedAt: this.stoppedAt } : {}),
      warnings: [...this.warnings],
    };
  }
}

/** Convenience wrapper: parse, lint and run a script against one message */
export function dryRunSieve(
  script: string,
  message: SieveMessage,
): SieveDryRunResult & { lint: string[]; errors: string[] } {
  const interpreter = new SieveInterpreter(script);
  return {
    ...interpreter.run(message),
    lint: interpreter.lint(),
    errors: interpreter.errors(),
  };
}
