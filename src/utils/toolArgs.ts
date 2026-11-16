import { createLogger } from "../services/Logger.js";

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

const logger = createLogger("ToolArgs");

/**
 * Removes the arguments a call passes that the tool's advertised input schema
 * does not declare, so they never reach validation or a service. Only a
 * schema closed with `additionalProperties: false` drops anything.
 *
 * Dropped rather than rejected on purpose: clients have been seen adding
 * arguments of their own (Claude Desktop sent `*uuid*` keys), and failing
 * every such call would break the client for nothing. The names, never the
 * values, are logged at debug level so a misspelt argument can be traced.
 */
export const dropUndeclaredArgs = (
  toolName: string,
  inputSchema: DeclaredInputSchema | undefined,
  args: unknown,
): Record<string, unknown> => {
  if (!args || typeof args !== "object") {
    return {};
  }
  const entries = Object.entries(args as Record<string, unknown>);
  if (inputSchema?.additionalProperties !== false) {
    return Object.fromEntries(entries);
  }

  const declared = new Set(Object.keys(inputSchema.properties ?? {}));
  const dropped = entries.map(([key]) => key).filter(key => !declared.has(key));
  if (dropped.length > 0) {
    logger.debug(
      `Ignoring undeclared arguments for ${toolName}`,
      { operation: "dropUndeclaredArgs", service: "toolArgs" },
      { tool: toolName, dropped },
    );
  }
  return Object.fromEntries(entries.filter(([key]) => declared.has(key)));
};
