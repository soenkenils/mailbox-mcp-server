/**
 * Minimal RFC 5228 Sieve parser (tokenizer + AST).
 *
 * Supports the full core grammar: commands, tests, test lists, string lists,
 * numbers with K/M/G quantifiers, tagged arguments, quoted strings,
 * multi-line `text:` strings, `#` and `/* *\/` comments.
 *
 * The parser does not validate command semantics; that is up to the
 * interpreter. Each command remembers the last comment seen before it so the
 * dry run can report human-readable rule labels (e.g. "## Flag: ... Rulename: ..." comments written by webmail filter editors).
 */

export type SieveArgument =
  | { type: "string"; value: string }
  | { type: "list"; values: string[] }
  | { type: "number"; value: number }
  | { type: "tag"; value: string };

export interface SieveTest {
  name: string;
  args: SieveArgument[];
  tests: SieveTest[];
  line: number;
}

export interface SieveCommand {
  name: string;
  args: SieveArgument[];
  tests: SieveTest[];
  block?: SieveCommand[];
  line: number;
  /** Last comment that appeared before this command (if any) */
  comment?: string;
}

export class SieveSyntaxError extends Error {
  constructor(
    message: string,
    public readonly line: number,
  ) {
    super(`Sieve syntax error in line ${line}: ${message}`);
    this.name = "SieveSyntaxError";
  }
}

type TokenType = "ident" | "tag" | "string" | "number" | "punct" | "eof";

interface Token {
  type: TokenType;
  value: string;
  num?: number;
  line: number;
  /** Comment text seen immediately before this token */
  comment?: string;
}

const QUANTIFIERS: Record<string, number> = {
  K: 1024,
  M: 1024 * 1024,
  G: 1024 * 1024 * 1024,
};

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let pendingComment: string | undefined;
  let lastCommentLine = -1;
  const len = source.length;

  const push = (token: Omit<Token, "comment">) => {
    tokens.push({ ...token, comment: pendingComment });
    pendingComment = undefined;
  };

  while (i < len) {
    const ch = source[i];

    if (ch === "\n") {
      line++;
      i++;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\r") {
      i++;
      continue;
    }

    // Hash comment
    if (ch === "#") {
      const end = source.indexOf("\n", i);
      const text = source
        .slice(i + 1, end === -1 ? len : end)
        .replace(/^#+/, "")
        .trim();
      if (text) {
        // Consecutive comment lines form one block; keep them together so the
        // first (most descriptive) line leads the rule label.
        pendingComment =
          pendingComment && lastCommentLine === line - 1
            ? `${pendingComment} ${text}`
            : text;
        lastCommentLine = line;
      }
      i = end === -1 ? len : end;
      continue;
    }

    // Bracket comment
    if (ch === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      if (end === -1) {
        throw new SieveSyntaxError("unterminated /* comment", line);
      }
      const text = source.slice(i + 2, end);
      line += (text.match(/\n/g) || []).length;
      const trimmed = text.trim();
      if (trimmed) {
        pendingComment = trimmed;
      }
      i = end + 2;
      continue;
    }

    // Quoted string
    if (ch === '"') {
      const startLine = line;
      let value = "";
      i++;
      while (i < len && source[i] !== '"') {
        if (source[i] === "\\" && i + 1 < len) {
          value += source[i + 1];
          i += 2;
          continue;
        }
        if (source[i] === "\n") {
          line++;
        }
        value += source[i];
        i++;
      }
      if (i >= len) {
        throw new SieveSyntaxError("unterminated string", startLine);
      }
      i++; // closing quote
      push({ type: "string", value, line: startLine });
      continue;
    }

    // Tag
    if (ch === ":") {
      const match = /^:([A-Za-z_][A-Za-z0-9_]*)/.exec(source.slice(i));
      if (!match) {
        throw new SieveSyntaxError("invalid tag", line);
      }
      push({ type: "tag", value: match[1].toLowerCase(), line });
      i += match[0].length;
      continue;
    }

    // Number
    if (/[0-9]/.test(ch)) {
      const match = /^([0-9]+)([KMGkmg])?/.exec(source.slice(i));
      if (!match) {
        throw new SieveSyntaxError("invalid number", line);
      }
      const base = Number.parseInt(match[1], 10);
      const q = match[2] ? QUANTIFIERS[match[2].toUpperCase()] : 1;
      push({ type: "number", value: match[0], num: base * q, line });
      i += match[0].length;
      continue;
    }

    // Identifier or multi-line string ("text:")
    if (/[A-Za-z_]/.test(ch)) {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(i));
      if (!match) {
        throw new SieveSyntaxError("invalid identifier", line);
      }
      const word = match[0];
      if (
        word.toLowerCase() === "text" &&
        source[i + match[0].length] === ":"
      ) {
        const startLine = line;
        // Skip to end of the "text:" line
        const eol = source.indexOf("\n", i);
        if (eol === -1) {
          throw new SieveSyntaxError("unterminated multi-line string", line);
        }
        i = eol + 1;
        line++;
        const lines: string[] = [];
        let terminated = false;
        while (i < len) {
          const next = source.indexOf("\n", i);
          const raw = source.slice(i, next === -1 ? len : next);
          const content = raw.replace(/\r$/, "");
          i = next === -1 ? len : next + 1;
          line++;
          if (content === ".") {
            terminated = true;
            break;
          }
          lines.push(content.startsWith("..") ? content.slice(1) : content);
        }
        if (!terminated) {
          throw new SieveSyntaxError(
            "unterminated multi-line string",
            startLine,
          );
        }
        push({
          type: "string",
          value: lines.length ? `${lines.join("\r\n")}\r\n` : "",
          line: startLine,
        });
        continue;
      }
      push({ type: "ident", value: word.toLowerCase(), line });
      i += word.length;
      continue;
    }

    if (";,(){}[]".includes(ch)) {
      push({ type: "punct", value: ch, line });
      i++;
      continue;
    }

    throw new SieveSyntaxError(`unexpected character '${ch}'`, line);
  }

  tokens.push({ type: "eof", value: "", line, comment: pendingComment });
  return tokens;
}

/** Maximum nesting of blocks and tests (Pigeonhole uses a similar limit) */
export const MAX_NESTING = 64;

class Parser {
  private pos = 0;
  private depth = 0;

  private enter(line: number) {
    this.depth++;
    if (this.depth > MAX_NESTING) {
      throw new SieveSyntaxError(
        `nesting deeper than ${MAX_NESTING} levels`,
        line,
      );
    }
  }

  private leave() {
    this.depth--;
  }

  constructor(private readonly tokens: Token[]) {}

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private next(): Token {
    return this.tokens[this.pos++];
  }

  private isPunct(value: string): boolean {
    const t = this.peek();
    return t.type === "punct" && t.value === value;
  }

  private expectPunct(value: string): Token {
    const t = this.next();
    if (t.type !== "punct" || t.value !== value) {
      throw new SieveSyntaxError(
        `expected '${value}' but found '${t.value || t.type}'`,
        t.line,
      );
    }
    return t;
  }

  parseScript(): SieveCommand[] {
    const commands = this.parseCommands();
    const t = this.peek();
    if (t.type !== "eof") {
      throw new SieveSyntaxError(`unexpected '${t.value}'`, t.line);
    }
    return commands;
  }

  private parseCommands(): SieveCommand[] {
    const commands: SieveCommand[] = [];
    while (this.peek().type !== "eof" && !this.isPunct("}")) {
      commands.push(this.parseCommand());
    }
    return commands;
  }

  private parseCommand(): SieveCommand {
    const t = this.next();
    if (t.type !== "ident") {
      throw new SieveSyntaxError(
        `expected command but found '${t.value || t.type}'`,
        t.line,
      );
    }
    const args = this.parseArguments();
    const tests = this.parseTestsOf();

    const command: SieveCommand = {
      name: t.value,
      args,
      tests,
      line: t.line,
      ...(t.comment ? { comment: t.comment } : {}),
    };

    if (this.isPunct("{")) {
      this.next();
      this.enter(t.line);
      command.block = this.parseCommands();
      this.leave();
      this.expectPunct("}");
    } else {
      this.expectPunct(";");
    }
    return command;
  }

  private parseArguments(): SieveArgument[] {
    const args: SieveArgument[] = [];
    for (;;) {
      const t = this.peek();
      if (t.type === "string") {
        this.next();
        args.push({ type: "string", value: t.value });
      } else if (t.type === "number") {
        this.next();
        args.push({ type: "number", value: t.num ?? 0 });
      } else if (t.type === "tag") {
        this.next();
        args.push({ type: "tag", value: t.value });
      } else if (t.type === "punct" && t.value === "[") {
        args.push({ type: "list", values: this.parseStringList() });
      } else {
        return args;
      }
    }
  }

  private parseStringList(): string[] {
    this.expectPunct("[");
    const values: string[] = [];
    for (;;) {
      const t = this.next();
      if (t.type !== "string") {
        throw new SieveSyntaxError("expected string in string list", t.line);
      }
      values.push(t.value);
      if (this.isPunct(",")) {
        this.next();
        continue;
      }
      this.expectPunct("]");
      return values;
    }
  }

  /** Parse the (optional) test or test list that follows arguments */
  private parseTestsOf(): SieveTest[] {
    if (this.isPunct("(")) {
      return this.parseTestList();
    }
    if (this.peek().type === "ident") {
      return [this.parseTest()];
    }
    return [];
  }

  private parseTestList(): SieveTest[] {
    this.expectPunct("(");
    const tests: SieveTest[] = [this.parseTest()];
    while (this.isPunct(",")) {
      this.next();
      tests.push(this.parseTest());
    }
    this.expectPunct(")");
    return tests;
  }

  private parseTest(): SieveTest {
    const t = this.next();
    if (t.type !== "ident") {
      throw new SieveSyntaxError(
        `expected test but found '${t.value || t.type}'`,
        t.line,
      );
    }
    this.enter(t.line);
    const args = this.parseArguments();
    const tests = this.parseTestsOf();
    this.leave();
    return { name: t.value, args, tests, line: t.line };
  }
}

/** Number of positional (non-tag) arguments, skipping values of known tags */
function positionalCount(cmd: SieveCommand, tagsWithValue: string[]): number {
  let count = 0;
  for (let i = 0; i < cmd.args.length; i++) {
    const arg = cmd.args[i];
    if (arg.type === "tag") {
      if (tagsWithValue.includes(arg.value)) {
        i++;
      }
      continue;
    }
    count++;
  }
  return count;
}

const ARITY: Record<
  string,
  { min: number; max: number; tagsWithValue?: string[] }
> = {
  require: { min: 1, max: 1 },
  stop: { min: 0, max: 0 },
  keep: { min: 0, max: 0, tagsWithValue: ["flags"] },
  discard: { min: 0, max: 0 },
  fileinto: { min: 1, max: 1, tagsWithValue: ["flags"] },
  redirect: { min: 1, max: 1 },
  reject: { min: 1, max: 1 },
  ereject: { min: 1, max: 1 },
  set: { min: 2, max: 2 },
  addflag: { min: 1, max: 2 },
  setflag: { min: 1, max: 2 },
  removeflag: { min: 1, max: 2 },
};

/**
 * Structural checks the server performs as well: control commands need a
 * block (and a test where applicable), elsif/else must follow if/elsif,
 * actions need the right number of arguments.
 */
function validate(commands: SieveCommand[]): void {
  let previous: string | undefined;
  for (const cmd of commands) {
    const control = ["if", "elsif", "else"].includes(cmd.name);
    if (control) {
      if (!cmd.block) {
        throw new SieveSyntaxError(`'${cmd.name}' needs a block`, cmd.line);
      }
      if (cmd.name !== "else" && cmd.tests.length !== 1) {
        throw new SieveSyntaxError(`'${cmd.name}' needs one test`, cmd.line);
      }
      if (cmd.name === "else" && cmd.tests.length) {
        throw new SieveSyntaxError("'else' takes no test", cmd.line);
      }
      if (cmd.name !== "if" && previous !== "if" && previous !== "elsif") {
        throw new SieveSyntaxError(
          `'${cmd.name}' without preceding 'if'`,
          cmd.line,
        );
      }
      validate(cmd.block);
    } else {
      if (cmd.block) {
        throw new SieveSyntaxError(`'${cmd.name}' takes no block`, cmd.line);
      }
      if (cmd.tests.length) {
        throw new SieveSyntaxError(`'${cmd.name}' takes no test`, cmd.line);
      }
      const arity = ARITY[cmd.name];
      if (arity) {
        const n = positionalCount(cmd, arity.tagsWithValue ?? []);
        if (n < arity.min || n > arity.max) {
          throw new SieveSyntaxError(
            `'${cmd.name}' expects ${arity.min === arity.max ? arity.min : `${arity.min}-${arity.max}`} argument(s), got ${n}`,
            cmd.line,
          );
        }
      }
    }
    previous = cmd.name;
  }
}

export function parseSieve(source: string): SieveCommand[] {
  const commands = new Parser(tokenize(source)).parseScript();
  validate(commands);
  return commands;
}
