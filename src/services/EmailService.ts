import { ImapFlow } from "imapflow";
import { type ParsedMail, simpleParser } from "mailparser";
import type { LocalCache } from "../types/cache.types.js";
import type {
  EmailComposition,
  EmailFolder,
  EmailMessage,
  EmailOperationResult,
  EmailSearchOptions,
  EmailThread,
  ImapConnection,
} from "../types/email.types.js";

export class EmailService {
  private connection: ImapConnection;
  private cache: LocalCache;
  private client?: ImapFlow;

  constructor(connection: ImapConnection, cache: LocalCache) {
    this.connection = connection;
    this.cache = cache;
  }

  async connect(): Promise<void> {
    this.client = new ImapFlow({
      host: this.connection.host,
      port: this.connection.port,
      secure: this.connection.secure,
      auth: {
        user: this.connection.user,
        pass: this.connection.password,
      },
      logger: false, // Disable logging for production
    });

    if (this.client.on && typeof this.client.on === "function") {
      this.client.on("error", (error: Error) => {
        console.error("IMAP connection error:", error);
      });
    }

    await this.client.connect();
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      try {
        await this.client.logout();
      } catch (error) {
        console.warn("Error during logout:", error);
      }
      this.client = undefined;
    }
  }

  async searchEmails(options: EmailSearchOptions): Promise<EmailMessage[]> {
    const cacheKey = `email_search:${JSON.stringify(options)}`;
    const cached = this.cache.get<EmailMessage[]>(cacheKey);

    if (cached) {
      return cached;
    }

    if (!this.client) {
      await this.connect();
    }

    const folder = options.folder || "INBOX";
    const messages = await this.performEmailSearch(folder, options);

    this.cache.set(cacheKey, messages, 300000); // 5 minutes TTL
    return messages;
  }

  async getEmail(uid: number, folder = "INBOX"): Promise<EmailMessage | null> {
    const cacheKey = `email:${folder}:${uid}`;
    const cached = this.cache.get<EmailMessage>(cacheKey);

    if (cached) {
      return cached;
    }

    try {
      if (!this.client) {
        await this.connect();
      }

      const message = await this.fetchEmailByUid(uid, folder);

      if (message) {
        this.cache.set(cacheKey, message, 600000); // 10 minutes TTL
      }

      return message;
    } catch (error) {
      console.error(`Error fetching email UID ${uid}:`, error);
      // Reset connection on error
      this.client = undefined;
      throw error;
    }
  }

  async getEmailThread(
    messageId: string,
    folder = "INBOX",
  ): Promise<EmailThread | null> {
    const cacheKey = `thread:${folder}:${messageId}`;
    const cached = this.cache.get<EmailThread>(cacheKey);

    if (cached) {
      return cached;
    }

    const thread = await this.buildEmailThread(messageId, folder);

    if (thread) {
      this.cache.set(cacheKey, thread, 300000); // 5 minutes TTL
    }

    return thread;
  }

  private async performEmailSearch(
    folder: string,
    options: EmailSearchOptions,
  ): Promise<EmailMessage[]> {
    await this.ensureConnectionAndSelectFolder(folder);

    const searchResult = await this.executeSearch(options);
    if (!searchResult || searchResult.length === 0) {
      return [];
    }

    const paginatedResults = this.applyPagination(searchResult, options);
    const messages = await this.fetchMessageHeaders(paginatedResults, folder);
    const filteredMessages = this.applyInMemoryFilters(messages, options);

    return this.sortMessagesByDate(filteredMessages);
  }

  private async ensureConnectionAndSelectFolder(folder: string): Promise<void> {
    if (!this.client) {
      throw new Error("IMAP connection not established");
    }
    await this.client.mailboxOpen(folder);
  }

  private async executeSearch(
    options: EmailSearchOptions,
  ): Promise<number[] | null> {
    const searchCriteria = this.buildSearchCriteria(options);
    return await this.client?.search(searchCriteria);
  }

  private applyPagination(
    searchResult: number[],
    options: EmailSearchOptions,
  ): number[] {
    const offset = options.offset || 0;
    const end = options.limit ? offset + options.limit : undefined;
    return searchResult.slice(offset, end);
  }

  private async fetchMessageHeaders(
    uids: number[],
    folder: string,
  ): Promise<EmailMessage[]> {
    const messages: EmailMessage[] = [];

    if (uids.length > 0) {
      for await (const message of this.client?.fetch(uids, {
        envelope: true,
        uid: true,
        flags: true,
      })) {
        const emailMessage = this.parseEmailMessage(message, folder);
        if (emailMessage) {
          messages.push(emailMessage);
        }
      }
    }

    return messages;
  }

  private sortMessagesByDate(messages: EmailMessage[]): EmailMessage[] {
    return messages.sort((a, b) => b.date.getTime() - a.date.getTime());
  }

  private async fetchEmailByUid(
    uid: number,
    folder: string,
  ): Promise<EmailMessage | null> {
    try {
      await this.ensureConnectionAndSelectFolder(folder);
      const rawMessage = await this.fetchRawMessageByUid(uid, folder);

      if (!rawMessage) {
        return null;
      }

      const parsed = await simpleParser(rawMessage.source as Buffer);
      return this.parseFullEmailMessage(parsed, rawMessage, folder);
    } catch (error) {
      this.handleFetchError(error, uid, folder);
      throw new Error(
        `Failed to fetch email with UID ${uid} from folder ${folder}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async fetchRawMessageByUid(
    uid: number,
    folder: string,
  ): Promise<any | null> {
    for await (const msg of this.client?.fetch(
      `${uid}:${uid}`,
      {
        source: true,
        envelope: true,
        uid: true,
        flags: true,
      },
      { uid: true },
    )) {
      return msg;
    }

    console.error(
      `Failed to fetch email with UID ${uid} from folder ${folder}`,
    );
    return null;
  }

  private handleFetchError(error: unknown, uid: number, folder: string): void {
    if (error instanceof Error) {
      const errorWithCode = error as Error & { code?: string };
      if (
        errorWithCode.code === "ECONNRESET" ||
        errorWithCode.code === "EPIPE"
      ) {
        console.error(
          `Connection error while fetching UID ${uid}: ${error.message}`,
        );
        this.client = undefined;
      }
    }
  }

  private buildSearchCriteria(options: EmailSearchOptions): any {
    let criteria: any = {};

    criteria = this.addDateFilters(criteria, options);
    criteria = this.addQueryFilters(criteria, options);

    return Object.keys(criteria).length === 0 ? { all: true } : criteria;
  }

  private addDateFilters(criteria: any, options: EmailSearchOptions): any {
    if (options.since) {
      criteria.since = options.since;
    }
    if (options.before) {
      criteria.before = options.before;
    }
    return criteria;
  }

  private addQueryFilters(criteria: any, options: EmailSearchOptions): any {
    if (!options.query) {
      return criteria;
    }

    const query = options.query.trim();

    if (this.isOrQuery(query)) {
      return this.handleOrQuery(criteria);
    }

    if (this.isFromQuery(query)) {
      return this.handleFromQuery(criteria, query);
    }

    if (this.isToQuery(query)) {
      return this.handleToQuery(criteria, query);
    }

    return this.handleTextQuery(criteria, query);
  }

  private isOrQuery(query: string): boolean {
    return query.includes(" OR ");
  }

  private handleOrQuery(criteria: any): any {
    return Object.keys(criteria).length === 0 ? { all: true } : criteria;
  }

  private isFromQuery(query: string): boolean {
    return query.toLowerCase().startsWith("from:");
  }

  private handleFromQuery(criteria: any, query: string): any {
    criteria.from = query.substring(5).trim();
    return criteria;
  }

  private isToQuery(query: string): boolean {
    return query.toLowerCase().startsWith("to:");
  }

  private handleToQuery(criteria: any, query: string): any {
    criteria.to = query.substring(3).trim();
    return criteria;
  }

  private handleTextQuery(criteria: any, query: string): any {
    criteria.or = [{ subject: query }, { body: query }];
    return criteria;
  }

  private applyInMemoryFilters(
    messages: EmailMessage[],
    options: EmailSearchOptions,
  ): EmailMessage[] {
    let filtered = messages;

    // Apply query filter for complex queries that weren't handled by IMAP
    if (options.query) {
      const needsInMemoryQueryFilter = options.query.includes(" OR ");

      if (needsInMemoryQueryFilter) {
        filtered = filtered.filter((msg) =>
          this.matchesQuery(msg, options.query!),
        );
      }
    }

    return filtered;
  }

  private matchesQuery(message: EmailMessage, query: string): boolean {
    // Handle complex query matching in memory
    const lowercaseQuery = query.toLowerCase();

    // Handle OR operations
    if (lowercaseQuery.includes(" or ")) {
      const orParts = lowercaseQuery.split(" or ").map((part) => part.trim());
      return orParts.some((part) => this.matchesSingleQuery(message, part));
    }

    return this.matchesSingleQuery(message, lowercaseQuery);
  }

  private matchesSingleQuery(message: EmailMessage, query: string): boolean {
    // Handle from: queries
    if (query.startsWith("from:")) {
      const emailDomain = query.substring(5).trim();
      return message.from.some((from) =>
        from.address.toLowerCase().includes(emailDomain),
      );
    }

    // Handle to: queries
    if (query.startsWith("to:")) {
      const emailDomain = query.substring(3).trim();
      return message.to.some((to) =>
        to.address.toLowerCase().includes(emailDomain),
      );
    }

    // Default text search in subject and from/to addresses
    const searchText = query.toLowerCase();
    return (
      message.subject.toLowerCase().includes(searchText) ||
      message.from.some(
        (from) =>
          from.address.toLowerCase().includes(searchText) ||
          from.name?.toLowerCase().includes(searchText),
      ) ||
      message.to.some(
        (to) =>
          to.address.toLowerCase().includes(searchText) ||
          to.name?.toLowerCase().includes(searchText),
      )
    );
  }

  private parseEmailMessage(message: any, folder: string): EmailMessage | null {
    if (!message.envelope) {
      return null;
    }

    const envelope = message.envelope;

    return {
      id: envelope.messageId || `${message.uid}@${folder}`,
      uid: message.uid,
      subject: envelope.subject || "",
      from: this.parseAddressesFromEnvelope(envelope.from),
      to: this.parseAddressesFromEnvelope(envelope.to),
      cc: this.parseAddressesFromEnvelope(envelope.cc),
      date: envelope.date || new Date(),
      flags: message.flags || [],
      folder,
    };
  }

  private parseFullEmailMessage(
    parsed: ParsedMail,
    message: any,
    folder: string,
  ): EmailMessage {
    return {
      id: parsed.messageId || `${message.uid}@${folder}`,
      uid: message.uid,
      subject: parsed.subject || "",
      from: this.parseAddressesFromParsed(parsed.from),
      to: this.parseAddressesFromParsed(parsed.to),
      cc: this.parseAddressesFromParsed(parsed.cc),
      bcc: this.parseAddressesFromParsed(parsed.bcc),
      date: parsed.date || new Date(),
      text: parsed.text,
      html: parsed.html || undefined,
      attachments: parsed.attachments?.map((att) => ({
        filename: att.filename || "unnamed",
        contentType: att.contentType,
        size: att.size,
        contentId: att.cid,
      })),
      flags: message.flags || [],
      folder,
    };
  }

  private parseAddressesFromEnvelope(
    addresses: any,
  ): Array<{ name?: string; address: string }> {
    if (!addresses) return [];
    if (!Array.isArray(addresses)) {
      return [addresses];
    }
    return addresses.map((addr) => ({
      name: addr.name,
      address: addr.address,
    }));
  }

  private parseAddressesFromParsed(
    addresses: any,
  ): Array<{ name?: string; address: string }> {
    if (!addresses) return [];
    if (!Array.isArray(addresses)) {
      return [addresses];
    }
    return addresses.map((addr) => ({
      name: addr.name,
      address: addr.address,
    }));
  }

  private async buildEmailThread(
    messageId: string,
    folder: string,
  ): Promise<EmailThread | null> {
    // Basic implementation - can be enhanced with proper thread detection
    const message = await this.searchEmails({
      query: messageId.replace(/[<>]/g, ""),
      folder,
      limit: 1,
    });

    if (message.length === 0) {
      return null;
    }

    const baseMessage = message[0];

    return {
      threadId: messageId,
      messages: [baseMessage],
      subject: baseMessage.subject,
      participants: [...baseMessage.from, ...baseMessage.to],
      lastActivity: baseMessage.date,
    };
  }

  async getFolders(): Promise<EmailFolder[]> {
    try {
      if (!this.client) {
        await this.connect();
      }

      const folders = await this.client!.list();

      return folders.map((folder) => ({
        name: folder.name,
        path: folder.path,
        delimiter: folder.delimiter || "/",
        flags: Array.isArray(folder.flags) ? folder.flags : [],
        specialUse: folder.specialUse,
      }));
    } catch (error) {
      console.error("Error fetching folders:", error);
      throw error;
    }
  }

  async moveEmail(
    uid: number,
    fromFolder: string,
    toFolder: string,
  ): Promise<EmailOperationResult> {
    try {
      if (!this.client) {
        await this.connect();
      }

      await this.client!.mailboxOpen(fromFolder);
      await this.client!.messageMove(`${uid}:${uid}`, toFolder, { uid: true });

      // Clear cache for both folders
      this.clearFolderCache(fromFolder);
      this.clearFolderCache(toFolder);

      return {
        success: true,
        message: `Email moved from ${fromFolder} to ${toFolder}`,
      };
    } catch (error) {
      console.error(`Error moving email UID ${uid}:`, error);
      return {
        success: false,
        message: `Failed to move email: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  async markEmail(
    uid: number,
    folder: string,
    flags: string[],
    action: "add" | "remove",
  ): Promise<EmailOperationResult> {
    try {
      if (!this.client) {
        await this.connect();
      }

      await this.client!.mailboxOpen(folder);

      if (action === "add") {
        await this.client!.messageFlagsAdd(`${uid}:${uid}`, flags, {
          uid: true,
        });
      } else {
        await this.client!.messageFlagsRemove(`${uid}:${uid}`, flags, {
          uid: true,
        });
      }

      // Clear cache for the folder
      this.clearFolderCache(folder);

      return {
        success: true,
        message: `Email flags ${action === "add" ? "added" : "removed"} successfully`,
      };
    } catch (error) {
      console.error(`Error marking email UID ${uid}:`, error);
      return {
        success: false,
        message: `Failed to mark email: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  async deleteEmail(
    uid: number,
    folder: string,
    permanent = false,
  ): Promise<EmailOperationResult> {
    try {
      if (!this.client) {
        await this.connect();
      }

      await this.client!.mailboxOpen(folder);

      if (permanent) {
        // Add deleted flag and expunge
        await this.client!.messageFlagsAdd(`${uid}:${uid}`, ["\\Deleted"], {
          uid: true,
        });
        await this.client!.expunge();
      } else {
        // Move to Trash folder
        try {
          await this.client!.messageMove(`${uid}:${uid}`, "Trash", {
            uid: true,
          });
        } catch (moveError) {
          // If Trash folder doesn't exist, try other common names
          const trashFolders = ["Deleted Items", "Deleted", "INBOX.Trash"];
          let moved = false;

          for (const trashFolder of trashFolders) {
            try {
              await this.client!.messageMove(`${uid}:${uid}`, trashFolder, {
                uid: true,
              });
              moved = true;
              break;
            } catch (error) {
              // Continue to next folder
            }
          }

          if (!moved) {
            // If no trash folder found, mark as deleted
            await this.client!.messageFlagsAdd(`${uid}:${uid}`, ["\\Deleted"], {
              uid: true,
            });
          }
        }
      }

      // Clear cache for the folder
      this.clearFolderCache(folder);

      return {
        success: true,
        message: permanent
          ? "Email permanently deleted"
          : "Email moved to trash",
      };
    } catch (error) {
      console.error(`Error deleting email UID ${uid}:`, error);
      return {
        success: false,
        message: `Failed to delete email: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  async createDraft(
    composition: EmailComposition,
    folder = "Drafts",
  ): Promise<EmailOperationResult> {
    try {
      if (!this.client) {
        await this.connect();
      }

      // Create email content
      const emailContent = this.buildEmailContent(composition);

      // Append to drafts folder
      const result = await this.client!.append(folder, emailContent, [
        "\\Draft",
      ]);

      // Clear cache for the drafts folder
      this.clearFolderCache(folder);

      return {
        success: true,
        message: "Draft saved successfully",
        uid: result.uid,
      };
    } catch (error) {
      console.error("Error creating draft:", error);
      return {
        success: false,
        message: `Failed to create draft: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  private buildEmailContent(composition: EmailComposition): string {
    const headers: string[] = [];

    // Add recipients
    headers.push(`To: ${this.formatAddressesForHeader(composition.to)}`);

    if (composition.cc && composition.cc.length > 0) {
      headers.push(`CC: ${this.formatAddressesForHeader(composition.cc)}`);
    }

    if (composition.bcc && composition.bcc.length > 0) {
      headers.push(`BCC: ${this.formatAddressesForHeader(composition.bcc)}`);
    }

    headers.push(`Subject: ${composition.subject}`);
    headers.push(`Date: ${new Date().toUTCString()}`);
    headers.push(
      `Message-ID: <${Date.now()}.${Math.random()}@${this.connection.host}>`,
    );

    if (composition.html) {
      headers.push("Content-Type: text/html; charset=utf-8");
    } else {
      headers.push("Content-Type: text/plain; charset=utf-8");
    }

    const content = composition.html || composition.text || "";

    return `${headers.join("\r\n")}\r\n\r\n${content}`;
  }

  private formatAddressesForHeader(
    addresses: Array<{ name?: string; address: string }>,
  ): string {
    return addresses
      .map((addr) => {
        if (addr.name) {
          return `"${addr.name}" <${addr.address}>`;
        }
        return addr.address;
      })
      .join(", ");
  }

  private clearFolderCache(folder: string): void {
    // Clear all cache entries that might be affected by folder changes
    const keysToDelete: string[] = [];

    // This is a simple implementation - in a more sophisticated cache,
    // you'd want to track keys by folder
    for (let i = 0; i < 1000; i++) {
      const searchKey = `email_search:${JSON.stringify({ folder })}`;
      if (this.cache.has && this.cache.has(searchKey)) {
        keysToDelete.push(searchKey);
      }
    }

    keysToDelete.forEach((key) => this.cache.delete(key));
  }
}
