import {
  type CallToolRequest,
  type CallToolResult,
  ListToolsResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import * as v from "valibot";
import type { ServerConfig } from "../config/config.js";
import { createLogger } from "../services/Logger.js";
import { SieveService } from "../services/SieveService.js";

const logger = createLogger("SieveTools");

/** Sieve tool names - exported for tool routing */
export const SIEVE_TOOLS = [
  "list_sieve_scripts",
  "get_sieve_script",
  "create_sieve_filter",
  "delete_sieve_script",
  "activate_sieve_script",
  "check_sieve_script",
  "get_sieve_capabilities",
] as const;

export type SieveToolName = (typeof SIEVE_TOOLS)[number];

export function isSieveTool(name: string): name is SieveToolName {
  return SIEVE_TOOLS.includes(name as SieveToolName);
}

// Validation schemas
const ListSieveScriptsSchema = v.object({});

const GetSieveScriptSchema = v.object({
  name: v.pipe(v.string(), v.minLength(1), v.maxLength(100)),
});

const CreateSieveFilterSchema = v.object({
  name: v.pipe(v.string(), v.minLength(1), v.maxLength(100)),
  content: v.pipe(v.string(), v.minLength(1)),
  activate: v.optional(v.boolean(), true),
});

const DeleteSieveScriptSchema = v.object({
  name: v.pipe(v.string(), v.minLength(1), v.maxLength(100)),
});

const ActivateSieveScriptSchema = v.object({
  name: v.pipe(v.string(), v.minLength(1), v.maxLength(100)),
});

const CheckSieveScriptSchema = v.object({
  content: v.pipe(v.string(), v.minLength(1)),
});

export function getSieveTools(): Tool[] {
  return [
    {
      name: "list_sieve_scripts",
      description: "List all Sieve filter scripts on the server",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "get_sieve_script",
      description: "Retrieve the content of a specific Sieve script",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Name of the Sieve script to retrieve",
            minLength: 1,
            maxLength: 100,
          },
        },
        required: ["name"],
      },
    },
    {
      name: "create_sieve_filter",
      description: "Create or update a Sieve filter script",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Name for the Sieve script",
            minLength: 1,
            maxLength: 100,
          },
          content: {
            type: "string",
            description: "Sieve script content (RFC 5228 compliant)",
            minLength: 1,
          },
          activate: {
            type: "boolean",
            description: "Whether to activate the script after creation",
            default: true,
          },
        },
        required: ["name", "content"],
      },
    },
    {
      name: "delete_sieve_script",
      description: "Delete a Sieve script from the server",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Name of the Sieve script to delete",
            minLength: 1,
            maxLength: 100,
          },
        },
        required: ["name"],
      },
    },
    {
      name: "activate_sieve_script",
      description: "Activate a specific Sieve script (deactivates others)",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Name of the Sieve script to activate",
            minLength: 1,
            maxLength: 100,
          },
        },
        required: ["name"],
      },
    },
    {
      name: "check_sieve_script",
      description: "Validate Sieve script syntax without saving",
      inputSchema: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description: "Sieve script content to validate",
            minLength: 1,
          },
        },
        required: ["content"],
      },
    },
    {
      name: "get_sieve_capabilities",
      description:
        "Get ManageSieve server capabilities and supported extensions",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
  ];
}

export async function handleSieveTool(
  request: CallToolRequest,
  config: ServerConfig,
): Promise<CallToolResult> {
  const sieveService = new SieveService(config.sieve);

  try {
    switch (request.params.name) {
      case "list_sieve_scripts":
        return await handleListSieveScripts(sieveService, request);

      case "get_sieve_script":
        return await handleGetSieveScript(sieveService, request);

      case "create_sieve_filter":
        return await handleCreateSieveFilter(sieveService, request);

      case "delete_sieve_script":
        return await handleDeleteSieveScript(sieveService, request);

      case "activate_sieve_script":
        return await handleActivateSieveScript(sieveService, request);

      case "check_sieve_script":
        return await handleCheckSieveScript(sieveService, request);

      case "get_sieve_capabilities":
        return await handleGetSieveCapabilities(sieveService, request);

      default:
        return {
          content: [
            {
              type: "text",
              text: `Unknown Sieve tool: ${request.params.name}`,
            },
          ],
          isError: true,
        };
    }
  } catch (error) {
    logger.error(
      "Error handling Sieve tool",
      {
        operation: "handleSieveTool",
        service: "SieveTools",
      },
      {
        tool: request.params.name,
        error: error instanceof Error ? error.message : String(error),
      },
    );

    return {
      content: [
        {
          type: "text",
          text: `Error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  } finally {
    try {
      await sieveService.disconnect();
    } catch {
      // Ignore disconnect errors
    }
  }
}

async function handleListSieveScripts(
  sieveService: SieveService,
  request: CallToolRequest,
): Promise<CallToolResult> {
  v.parse(ListSieveScriptsSchema, request.params.arguments);

  await sieveService.connect();
  await sieveService.authenticate();

  const scripts = await sieveService.listScripts();

  logger.info(
    "Listed Sieve scripts",
    {
      operation: "listSieveScripts",
      service: "SieveTools",
    },
    {
      scriptCount: scripts.length,
    },
  );

  return {
    content: [
      {
        type: "text",
        text: `Found ${scripts.length} Sieve scripts:\n\n${scripts
          .map(script => `• ${script.name}${script.active ? " (ACTIVE)" : ""}`)
          .join("\n")}`,
      },
    ],
  };
}

async function handleGetSieveScript(
  sieveService: SieveService,
  request: CallToolRequest,
): Promise<CallToolResult> {
  const args = v.parse(GetSieveScriptSchema, request.params.arguments);

  await sieveService.connect();
  await sieveService.authenticate();

  const content = await sieveService.getScript(args.name);

  logger.info(
    "Retrieved Sieve script",
    {
      operation: "getSieveScript",
      service: "SieveTools",
    },
    {
      scriptName: args.name,
      contentLength: content.length,
    },
  );

  return {
    content: [
      {
        type: "text",
        text: `Sieve script '${args.name}':\n\n\`\`\`sieve\n${content}\n\`\`\``,
      },
    ],
  };
}

async function handleCreateSieveFilter(
  sieveService: SieveService,
  request: CallToolRequest,
): Promise<CallToolResult> {
  const args = v.parse(CreateSieveFilterSchema, request.params.arguments);

  await sieveService.connect();
  await sieveService.authenticate();

  // First validate the script
  await sieveService.checkScript(args.content);

  // Then save it
  await sieveService.putScript(args.name, args.content);

  let activationMsg = "";
  if (args.activate) {
    await sieveService.setActiveScript(args.name);
    activationMsg = " and activated";
  }

  logger.info(
    "Created Sieve script",
    {
      operation: "createSieveFilter",
      service: "SieveTools",
    },
    {
      scriptName: args.name,
      contentLength: args.content.length,
      activated: args.activate,
    },
  );

  return {
    content: [
      {
        type: "text",
        text: `Successfully created Sieve script '${args.name}'${activationMsg}.`,
      },
    ],
  };
}

async function handleDeleteSieveScript(
  sieveService: SieveService,
  request: CallToolRequest,
): Promise<CallToolResult> {
  const args = v.parse(DeleteSieveScriptSchema, request.params.arguments);

  await sieveService.connect();
  await sieveService.authenticate();

  await sieveService.deleteScript(args.name);

  logger.info(
    "Deleted Sieve script",
    {
      operation: "deleteSieveScript",
      service: "SieveTools",
    },
    {
      scriptName: args.name,
    },
  );

  return {
    content: [
      {
        type: "text",
        text: `Successfully deleted Sieve script '${args.name}'.`,
      },
    ],
  };
}

async function handleActivateSieveScript(
  sieveService: SieveService,
  request: CallToolRequest,
): Promise<CallToolResult> {
  const args = v.parse(ActivateSieveScriptSchema, request.params.arguments);

  await sieveService.connect();
  await sieveService.authenticate();

  await sieveService.setActiveScript(args.name);

  logger.info(
    "Activated Sieve script",
    {
      operation: "activateSieveScript",
      service: "SieveTools",
    },
    {
      scriptName: args.name,
    },
  );

  return {
    content: [
      {
        type: "text",
        text: `Successfully activated Sieve script '${args.name}'.`,
      },
    ],
  };
}

async function handleCheckSieveScript(
  sieveService: SieveService,
  request: CallToolRequest,
): Promise<CallToolResult> {
  const args = v.parse(CheckSieveScriptSchema, request.params.arguments);

  await sieveService.connect();
  await sieveService.authenticate();

  await sieveService.checkScript(args.content);

  logger.info(
    "Validated Sieve script",
    {
      operation: "checkSieveScript",
      service: "SieveTools",
    },
    {
      contentLength: args.content.length,
    },
  );

  return {
    content: [
      {
        type: "text",
        text: "Sieve script syntax is valid.",
      },
    ],
  };
}

async function handleGetSieveCapabilities(
  sieveService: SieveService,
  request: CallToolRequest,
): Promise<CallToolResult> {
  v.parse(ListSieveScriptsSchema, request.params.arguments);

  await sieveService.connect();
  await sieveService.authenticate();

  const capabilities = sieveService.getServerCapabilities();

  logger.info(
    "Retrieved Sieve capabilities",
    {
      operation: "getSieveCapabilities",
      service: "SieveTools",
    },
    {
      implementation: capabilities?.implementation,
      version: capabilities?.version,
    },
  );

  if (!capabilities) {
    return {
      content: [
        {
          type: "text",
          text: "No capabilities information available.",
        },
      ],
    };
  }

  return {
    content: [
      {
        type: "text",
        text: `ManageSieve Server Capabilities:

**Implementation:** ${capabilities.implementation}
**Version:** ${capabilities.version}

**SASL Mechanisms:** ${capabilities.saslMechanisms.join(", ")}

**Sieve Extensions:** ${capabilities.sieveExtensions.join(", ")}

${capabilities.maxRedirects ? `**Max Redirects:** ${capabilities.maxRedirects}` : ""}
${capabilities.maxScriptSize ? `**Max Script Size:** ${capabilities.maxScriptSize} bytes` : ""}
${capabilities.maxScriptName ? `**Max Script Name:** ${capabilities.maxScriptName} chars` : ""}`,
      },
    ],
  };
}
