import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isMainModule } from "../src/utils/isMainModule.js";

describe("isMainModule", () => {
  let dir: string;
  let realFile: string;

  beforeAll(() => {
    // import.meta.url is always a real path (macOS tmpdir is a symlink)
    dir = realpathSync(mkdtempSync(join(tmpdir(), "is-main-")));
    realFile = join(dir, "main.js");
    writeFileSync(realFile, "");
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("is true when argv[1] is the module file", () => {
    expect(isMainModule(pathToFileURL(realFile).href, realFile)).toBe(true);
  });

  it("is true when argv[1] is a symlink to the module file", () => {
    const link = join(dir, "link.js");
    symlinkSync(realFile, link);

    expect(isMainModule(pathToFileURL(realFile).href, link)).toBe(true);
  });

  it("handles paths with spaces and non-ASCII characters", () => {
    const odd = join(dir, "mäilbox ünï");
    mkdirSync(odd);
    const file = join(odd, "main.js");
    writeFileSync(file, "");

    expect(isMainModule(pathToFileURL(file).href, file)).toBe(true);
  });

  it("is false when another file is the entry point", () => {
    const other = join(dir, "other.js");
    writeFileSync(other, "");

    expect(isMainModule(pathToFileURL(realFile).href, other)).toBe(false);
  });

  it("is false when argv[1] is missing", () => {
    expect(isMainModule(pathToFileURL(realFile).href, undefined)).toBe(false);
  });

  it("is false when argv[1] does not exist", () => {
    expect(
      isMainModule(pathToFileURL(realFile).href, join(dir, "missing.js")),
    ).toBe(false);
  });
});
