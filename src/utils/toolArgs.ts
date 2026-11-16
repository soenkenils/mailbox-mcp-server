/**
 * Describes the shape of tool arguments for logging: key names and types,
 * never values. Arguments carry mail content, recipients and Sieve scripts,
 * which must not reach stderr or the MCP log stream even at debug level.
 */
export const summarizeArgs = (args: unknown): Record<string, string> => {
  if (!args || typeof args !== "object") {
    return {};
  }

  return Object.fromEntries(
    Object.entries(args as Record<string, unknown>).map(([key, value]) => {
      if (typeof value === "string") {
        return [key, `string(${value.length})`];
      }
      if (Array.isArray(value)) {
        return [key, `array(${value.length})`];
      }
      if (value === null) {
        return [key, "null"];
      }
      return [key, typeof value];
    }),
  );
};
