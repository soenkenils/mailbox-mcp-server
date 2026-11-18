import type { CallToolResult } from "@modelcontextprotocol/server";

/**
 * Reads a text block out of a tool result.
 *
 * `CallToolResult.content` is a union (text, image, resource, ...), so the
 * `.text` property only exists on one member. Tests assert on text, and this
 * narrows to it with a clear failure instead of a cast that would hide a
 * handler returning the wrong content type.
 */
export const textOf = (result: CallToolResult, index = 0): string => {
  const block = result.content[index];

  if (!block) {
    throw new Error(
      `Expected a content block at index ${index}, got ${result.content.length} block(s)`,
    );
  }

  if (block.type !== "text") {
    throw new Error(
      `Expected a text block at index ${index}, got "${block.type}"`,
    );
  }

  return block.text;
};
