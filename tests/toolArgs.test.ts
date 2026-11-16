import { describe, expect, it } from "vitest";
import { dropUndeclaredArgs, summarizeArgs } from "../src/utils/toolArgs.js";

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

describe("dropUndeclaredArgs", () => {
  const closed = {
    properties: { uid: {}, folder: {} },
    additionalProperties: false,
  };

  it("should drop arguments the schema does not declare", () => {
    expect(
      dropUndeclaredArgs("get_email", closed, {
        uid: 1,
        parent_message_uuid: "null",
        unread: true,
      }),
    ).toEqual({ uid: 1 });
  });

  it("should keep declared arguments untouched, invalid ones included", () => {
    // Validation is the validator's job; dropping only removes what the tool
    // never declared.
    expect(
      dropUndeclaredArgs("get_email", closed, { uid: "x", folder: "INBOX" }),
    ).toEqual({ uid: "x", folder: "INBOX" });
  });

  it("should treat missing arguments as none", () => {
    expect(dropUndeclaredArgs("get_email", closed, undefined)).toEqual({});
  });

  it("should keep everything when the schema is left open or unknown", () => {
    expect(
      dropUndeclaredArgs("x", { properties: { uid: {} } }, { other: 1 }),
    ).toEqual({ other: 1 });
    expect(dropUndeclaredArgs("x", undefined, { other: 1 })).toEqual({
      other: 1,
    });
  });
});
