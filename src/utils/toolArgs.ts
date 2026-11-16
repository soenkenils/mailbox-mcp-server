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

interface DeclaredInputSchema {
  properties?: Record<string, unknown>;
  additionalProperties?: unknown;
}

/**
 * Names of the arguments a call passes that the tool's advertised input
 * schema does not declare. Only a schema closed with
 * `additionalProperties: false` rejects anything; an open one accepts all.
 *
 * The validators used to strip unknown keys silently, so a misspelt or
 * invented filter (`unread` for `seen`, say) was dropped and the call
 * answered a different question than the one asked.
 */
export const findUnknownArgs = (
  inputSchema: DeclaredInputSchema,
  args: unknown,
): string[] => {
  if (
    inputSchema.additionalProperties !== false ||
    !args ||
    typeof args !== "object"
  ) {
    return [];
  }
  const declared = new Set(Object.keys(inputSchema.properties ?? {}));
  return Object.keys(args).filter(key => !declared.has(key));
};

/**
 * The validation message for a call with undeclared arguments, naming the
 * ones that are accepted so the caller can correct the call in one step.
 */
export const describeUnknownArgs = (
  inputSchema: DeclaredInputSchema,
  unknown: string[],
): string => {
  const accepted = Object.keys(inputSchema.properties ?? {});
  const names = unknown.map(key => `"${key}"`).join(", ");
  return `Unknown argument${unknown.length > 1 ? "s" : ""} ${names}. ${
    accepted.length > 0
      ? `Accepted arguments: ${accepted.join(", ")}.`
      : "This tool takes no arguments."
  }`;
};
