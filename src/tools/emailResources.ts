import {
  ErrorCode,
  McpError,
  type ReadResourceResult,
  type Resource,
} from "@modelcontextprotocol/sdk/types.js";
import type { EmailService } from "../services/EmailService.js";

/** Canonical URI for the browsable folder listing. */
export const FOLDERS_RESOURCE_URI = "mailbox://folders";

/**
 * Folder layout is reference data the host can browse and pull into context,
 * rather than something the model has to spend a tool call on. get_folders
 * stays for when the model decides mid-task that it needs the list.
 */
export function listEmailResources(): Resource[] {
  return [
    {
      uri: FOLDERS_RESOURCE_URI,
      name: "Mail folders",
      title: "Mail folders",
      description:
        "Every folder in the mailbox with its IMAP path, hierarchy delimiter, flags and special-use role.",
      mimeType: "application/json",
    },
  ];
}

export async function readEmailResource(
  uri: string,
  emailService: EmailService,
): Promise<ReadResourceResult> {
  if (uri !== FOLDERS_RESOURCE_URI) {
    throw new McpError(ErrorCode.InvalidParams, `Unknown resource: ${uri}`);
  }

  const folders = await emailService.getFolders();

  return {
    contents: [
      {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(folders, null, 2),
      },
    ],
  };
}
