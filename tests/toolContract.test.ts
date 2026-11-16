import type {
  CallToolRequest,
  CallToolResult,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import type { ServerConfig } from "../src/config/config.js";
import type { EmailService } from "../src/services/EmailService.js";
import { SieveService } from "../src/services/SieveService.js";
import type { SmtpService } from "../src/services/SmtpService.js";
import { createEmailTools, handleEmailTool } from "../src/tools/emailTools.js";
import { getSieveTools, handleSieveTool } from "../src/tools/sieveTools.js";
import {
  createProgressReporter,
  type ToolContext,
} from "../src/types/tool.types.js";
import { textOf } from "./helpers/toolResult.js";

vi.mock("../src/services/Logger.js", () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  })),
}));

// Closed local port: a call that got past argument checking would fail with a
// connection error instead of the validation error the tests expect.
const sieveConfig = {
  sieve: {
    host: "127.0.0.1",
    port: 1,
    secure: false,
    user: "test@example.org",
    password: "not-a-real-password",
  },
} as unknown as ServerConfig;

/**
 * Every service method is a spy, so a test can assert that a call was turned
 * away before any of them ran.
 */
const spyService = <T>() =>
  new Proxy({} as Record<string, ReturnType<typeof vi.fn>>, {
    get: (target, key: string) => {
      target[key] ??= vi.fn();
      return target[key];
    },
  }) as unknown as T & Record<string, ReturnType<typeof vi.fn>>;

interface ContractModule {
  name: string;
  tools: () => Tool[];
  call: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<CallToolResult>;
}

/**
 * Tool modules that meet the full contract checked below. Each entry is
 * checked tool by tool, so a tool added to one of them is covered without
 * touching this file.
 *
 * TODO: add the calendar tools once their annotations and argument checks
 * land (they are being reworked separately).
 */
const CONTRACT_MODULES: ContractModule[] = [
  {
    name: "email",
    tools: () => createEmailTools(),
    call: (name, args) =>
      handleEmailTool(
        name,
        args,
        spyService<EmailService>(),
        spyService<SmtpService>(),
      ),
  },
  {
    name: "sieve",
    tools: getSieveTools,
    call: (name, args) =>
      handleSieveTool(
        { params: { name, arguments: args } } as CallToolRequest,
        sieveConfig,
      ),
  },
];

const allTools = (): Tool[] => CONTRACT_MODULES.flatMap(m => m.tools());

const toolNamed = (name: string): Tool => {
  const tool = allTools().find(t => t.name === name);
  if (!tool) {
    throw new Error(`No tool named ${name}`);
  }
  return tool;
};

const contractCases = CONTRACT_MODULES.flatMap(module =>
  module.tools().map(tool => ({ module, tool, label: tool.name })),
);

describe("tool annotations", () => {
  it.each(
    contractCases,
  )("$label should carry a human title for the permission prompt", ({
    tool,
  }) => {
    expect(tool.annotations?.title).toBeTruthy();
    expect(tool.annotations?.title).not.toBe(tool.name);
  });

  it.each(
    contractCases,
  )("$label should state whether it reads, and if not whether it destroys", ({
    tool,
  }) => {
    const hints = tool.annotations;
    expect(typeof hints?.readOnlyHint).toBe("boolean");
    expect(typeof hints?.openWorldHint).toBe("boolean");
    if (!hints?.readOnlyHint) {
      expect(typeof hints?.destructiveHint).toBe("boolean");
      expect(typeof hints?.idempotentHint).toBe("boolean");
    }
  });

  it("should mark sending and deleting as destructive", () => {
    for (const name of [
      "send_email",
      "delete_email",
      "create_sieve_filter",
      "delete_sieve_script",
    ]) {
      expect(toolNamed(name).annotations?.destructiveHint, name).toBe(true);
    }
  });

  it("should mark only send_email as reaching outside the mailbox", () => {
    const openWorld = allTools()
      .filter(t => t.annotations?.openWorldHint)
      .map(t => t.name);

    expect(openWorld).toEqual(["send_email"]);
  });
});

describe("advertised input schemas", () => {
  // Claude builds calls from the advertised schema. Anything the validator
  // rejects but the schema permits is a round-trip the model cannot predict.

  it.each(contractCases)("$label should close its input schema", ({ tool }) => {
    expect(
      (tool.inputSchema as { additionalProperties?: unknown })
        .additionalProperties,
    ).toBe(false);
  });

  it.each(
    contractCases,
  )("$label should reject an argument its schema does not declare", async ({
    module,
    tool,
  }) => {
    const result = await module.call(tool.name, { notAnArgument: 1 });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Unknown argument "notAnArgument"');
    expect(textOf(result)).not.toMatch(/ECONNREFUSED|connect/i);
  });

  it("should name the accepted arguments when rejecting one", async () => {
    const searchEmails = vi.fn();

    const result = await handleEmailTool("search_emails", { unread: true }, {
      searchEmails,
    } as unknown as EmailService);

    expect(searchEmails).not.toHaveBeenCalled();
    expect(textOf(result)).toContain('"unread"');
    expect(textOf(result)).toContain("seen");
  });

  it("should advertise that send_email needs a text or html body", () => {
    const schema = toolNamed("send_email").inputSchema as {
      anyOf?: Array<{ required?: string[] }>;
    };

    expect(schema.anyOf).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ required: ["text"] }),
        expect.objectContaining({ required: ["html"] }),
      ]),
    );
  });

  it("should not require a body for create_draft, which the validator allows", () => {
    const schema = toolNamed("create_draft").inputSchema as { anyOf?: unknown };

    expect(schema.anyOf).toBeUndefined();
  });

  it("should advertise the same search_emails limit the validator enforces", async () => {
    const schema = toolNamed("search_emails").inputSchema as unknown as {
      properties: { limit: { maximum: number } };
    };
    const advertisedMax = schema.properties.limit.maximum;

    const searchEmails = vi.fn().mockResolvedValue({ messages: [], total: 0 });
    const result = await handleEmailTool(
      "search_emails",
      { limit: advertisedMax + 1 },
      { searchEmails } as unknown as EmailService,
    );

    expect(result.isError).toBe(true);
    expect(searchEmails).not.toHaveBeenCalled();
  });

  it("should advertise the settable IMAP flags for mark_email", () => {
    const schema = toolNamed("mark_email").inputSchema as unknown as {
      properties: { flags: { items: { enum?: string[] } } };
    };

    // \Recent is deliberately absent: RFC 3501 forbids clients from storing it.
    expect(schema.properties.flags.items.enum).toEqual([
      "\\Seen",
      "\\Answered",
      "\\Flagged",
      "\\Deleted",
      "\\Draft",
    ]);
  });
});

describe("cancellation", () => {
  const aborted = (): ToolContext => {
    const controller = new AbortController();
    controller.abort();
    return { signal: controller.signal };
  };

  it("should not reach the email service once the client has cancelled", async () => {
    const searchEmails = vi.fn();

    const result = await handleEmailTool(
      "search_emails",
      { query: "test" },
      { searchEmails } as unknown as EmailService,
      undefined,
      aborted(),
    );

    expect(searchEmails).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Cancelled search_emails");
  });

  it("should not open a Sieve session once the client has cancelled", async () => {
    const connect = vi.spyOn(SieveService.prototype, "connect");

    const result = await handleSieveTool(
      {
        params: { name: "list_sieve_scripts", arguments: {} },
      } as CallToolRequest,
      sieveConfig,
      aborted(),
    );

    expect(connect).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
  });

  it("should run normally when the signal has not fired", async () => {
    const getFolders = vi.fn().mockResolvedValue([]);

    const result = await handleEmailTool(
      "get_folders",
      {},
      { getFolders } as unknown as EmailService,
      undefined,
      { signal: new AbortController().signal },
    );

    expect(getFolders).toHaveBeenCalled();
    expect(result.isError).toBeUndefined();
  });
});

describe("createProgressReporter", () => {
  it("should not report when the client asked for no progress", () => {
    expect(createProgressReporter(undefined, vi.fn())).toBeUndefined();
  });

  it("should address notifications to the client's token", async () => {
    const send = vi.fn();

    await createProgressReporter("tok-1", send)?.({ progress: 1, total: 2 });

    expect(send).toHaveBeenCalledWith({
      progressToken: "tok-1",
      progress: 1,
      total: 2,
    });
  });

  it("should not fail the operation when a notification cannot be sent", async () => {
    const send = vi.fn().mockRejectedValue(new Error("transport closed"));

    // Progress is advisory: losing it must not surface as a tool failure.
    await expect(
      createProgressReporter("tok-1", send)?.({ progress: 1 }),
    ).resolves.toBeUndefined();
  });
});

describe("progress reporting", () => {
  it("should report progress through an email search", async () => {
    const reportProgress = vi.fn();
    const searchEmails = vi.fn().mockResolvedValue({ messages: [], total: 0 });

    await handleEmailTool(
      "search_emails",
      { query: "test" },
      { searchEmails } as unknown as EmailService,
      undefined,
      { reportProgress },
    );

    expect(reportProgress).toHaveBeenCalled();
    const final = reportProgress.mock.calls.at(-1)?.[0];
    expect(final).toMatchObject({ progress: 1, total: 1 });
  });

  it("should work without a progress reporter", async () => {
    const searchEmails = vi.fn().mockResolvedValue({ messages: [], total: 0 });

    const result = await handleEmailTool(
      "search_emails",
      { query: "test" },
      { searchEmails } as unknown as EmailService,
      undefined,
      {},
    );

    expect(result.isError).toBeUndefined();
  });

  it("should drop a search result the client cancelled while it ran", async () => {
    const controller = new AbortController();
    const searchEmails = vi.fn().mockImplementation(async () => {
      controller.abort();
      return { messages: [], total: 0 };
    });

    const result = await handleEmailTool(
      "search_emails",
      {},
      { searchEmails } as unknown as EmailService,
      undefined,
      { signal: controller.signal },
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Cancelled");
  });
});
