import {
  type CallToolResult,
  ProtocolError,
  ProtocolErrorCode,
} from "@modelcontextprotocol/server";

/**
 * Per-call context the transport hands to a tool handler.
 *
 * The MCP SDK exposes this as `ServerContext`, which carries transport
 * internals the tools have no business knowing about. Narrowing it here keeps
 * the handlers testable with a plain object and leaves the SDK type at the
 * single point where the request is dispatched.
 */
export interface ToolContext {
  /** Aborted when the client cancels the request or the transport goes away. */
  signal?: AbortSignal;
  /**
   * Emits a progress notification. Only wired up when the client sent a
   * progressToken, so handlers call it unconditionally and it no-ops otherwise.
   */
  reportProgress?: (update: ProgressUpdate) => void | Promise<void>;
}

export interface ProgressUpdate {
  progress: number;
  total?: number;
  message?: string;
}

/**
 * True once the client has given up on this call. Handlers check it around
 * their awaits so a cancelled request stops before doing more work.
 *
 * Note this does not abort an IMAP fetch that is already in flight — the
 * connection stays busy until the library returns. It only stops the handler
 * from starting or finishing work nobody is waiting for.
 */
export const isCancelled = (context?: ToolContext): boolean =>
  context?.signal?.aborted === true;

/**
 * Builds the reporter a handler calls to publish progress.
 *
 * Returns undefined when the client sent no progressToken, since there is
 * nothing to address a notification to. Delivery is best-effort: a transport
 * that drops the notification must not fail the operation the caller actually
 * asked for, so send failures are swallowed.
 */
export const createProgressReporter = (
  progressToken: string | number | undefined,
  send: (
    update: ProgressUpdate & { progressToken: string | number },
  ) => void | Promise<void>,
): ToolContext["reportProgress"] => {
  if (progressToken === undefined) {
    return undefined;
  }

  return async update => {
    try {
      await send({ progressToken, ...update });
    } catch {
      // Progress is advisory; the operation continues regardless.
    }
  };
};

/** Result returned when a call is abandoned before it produced anything. */
export const cancelledResult = (operation: string) => ({
  content: [
    {
      type: "text" as const,
      text: `Cancelled ${operation} before it completed.`,
    },
  ],
  isError: true,
});

/**
 * Whether a tool call worked, read from the result rather than assumed: a
 * handler reports most failures as a result with `isError`, not by throwing.
 */
export const toolOutcome = (result: CallToolResult): { success: boolean } => ({
  success: result.isError !== true,
});

/**
 * A call naming no tool this server has is a protocol error (JSON-RPC
 * InvalidParams), like an unknown prompt or resource, not a failed tool run.
 */
export const unknownToolError = (name: string): ProtocolError =>
  new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown tool: ${name}`);
