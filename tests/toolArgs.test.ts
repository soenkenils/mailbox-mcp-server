import { describe, expect, it } from "vitest";
import { summarizeArgs } from "../src/utils/toolArgs.js";

describe("summarizeArgs", () => {
  it("should describe the shape of tool arguments without their values", () => {
    const summary = summarizeArgs({
      subject: "Secret subject",
      to: [{ address: "secret@example.com" }],
      uid: 42,
      permanent: true,
      folder: undefined,
      parent: null,
    });

    expect(summary).toEqual({
      subject: "string(14)",
      to: "array(1)",
      uid: "number",
      permanent: "boolean",
      folder: "undefined",
      parent: "null",
    });
    expect(JSON.stringify(summary)).not.toContain("Secret");
    expect(JSON.stringify(summary)).not.toContain("example.com");
  });

  it("should tolerate missing arguments", () => {
    expect(summarizeArgs(undefined)).toEqual({});
    expect(summarizeArgs("not an object")).toEqual({});
  });
});
