import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import type { EmailService } from "../src/services/EmailService.js";
import {
  FOLDERS_RESOURCE_URI,
  listEmailResources,
  readEmailResource,
} from "../src/tools/emailResources.js";

describe("email resources", () => {
  it("should list the folder resource as JSON", () => {
    expect(listEmailResources()).toEqual([
      expect.objectContaining({
        uri: FOLDERS_RESOURCE_URI,
        mimeType: "application/json",
      }),
    ]);
  });

  it("should read the folder list from the email service", async () => {
    const folders = [
      {
        name: "Trash",
        path: "Trash",
        delimiter: "/",
        flags: [],
        specialUse: "\\Trash",
      },
    ];
    const getFolders = vi.fn().mockResolvedValue(folders);

    const result = await readEmailResource(FOLDERS_RESOURCE_URI, {
      getFolders,
    } as unknown as EmailService);

    expect(result.contents).toHaveLength(1);
    expect(result.contents[0]).toMatchObject({
      uri: FOLDERS_RESOURCE_URI,
      mimeType: "application/json",
    });
    const [content] = result.contents;
    if (!content || !("text" in content)) {
      throw new Error("Expected a text resource");
    }
    expect(JSON.parse(content.text)).toEqual(folders);
  });

  it("should surface a failed folder listing instead of an empty one", async () => {
    const getFolders = vi.fn().mockRejectedValue(new Error("IMAP down"));

    await expect(
      readEmailResource(FOLDERS_RESOURCE_URI, {
        getFolders,
      } as unknown as EmailService),
    ).rejects.toThrow("IMAP down");
  });

  it("should reject an unknown resource as invalid params", async () => {
    const getFolders = vi.fn();

    const read = readEmailResource("mailbox://nope", {
      getFolders,
    } as unknown as EmailService);

    await expect(read).rejects.toBeInstanceOf(McpError);
    await expect(read).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    expect(getFolders).not.toHaveBeenCalled();
  });
});
