import { describe, expect, it } from "vitest";
import {
  describeUnknownArgs,
  findUnknownArgs,
  summarizeArgs,
} from "../src/utils/toolArgs.js";

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

describe("findUnknownArgs", () => {
  const closed = {
    properties: { uid: {}, folder: {} },
    additionalProperties: false,
  };

  it("should list arguments the schema does not declare", () => {
    expect(
      findUnknownArgs(closed, { uid: 1, unread: true, is_read: false }),
    ).toEqual(["unread", "is_read"]);
  });

  it("should accept a call that uses only declared arguments", () => {
    expect(findUnknownArgs(closed, { uid: 1 })).toEqual([]);
    expect(findUnknownArgs(closed, undefined)).toEqual([]);
  });

  it("should accept anything when the schema is left open", () => {
    expect(findUnknownArgs({ properties: { uid: {} } }, { other: 1 })).toEqual(
      [],
    );
  });
});

describe("describeUnknownArgs", () => {
  it("should name the rejected and the accepted arguments", () => {
    expect(
      describeUnknownArgs({ properties: { uid: {}, folder: {} } }, ["x"]),
    ).toBe('Unknown argument "x". Accepted arguments: uid, folder.');
  });

  it("should say when a tool takes no arguments at all", () => {
    expect(describeUnknownArgs({ properties: {} }, ["a", "b"])).toBe(
      'Unknown arguments "a", "b". This tool takes no arguments.',
    );
  });
});
