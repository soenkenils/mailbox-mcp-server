import { type ParsedMail, simpleParser } from "mailparser";

// IMAP library type definitions
interface ImapSearchCriteria {
  all?: boolean;
  since?: Date;
  before?: Date;
  from?: string;
  to?: string;
  subject?: string;
  body?: string;
  or?: Array<{ [key: string]: string | Date }>;
}

interface ImapMessage {
  envelope: {
    messageId?: string;
    subject?: string;
    from?: Array<{ name?: string; address: string }>;
    to?: Array<{ name?: string; address: string }>;
    cc?: Array<{ name?: string; address: string }>;
    date?: Date;
  };
  uid: number;
  flags: string[];
  bodystructure?: unknown;
  size?: number;
}

interface ImapEnvelopeAddress {
  name?: string;
  address: string;
}

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
import {
  CacheError,
  ConnectionError,
  EmailError,
  ErrorCode,
  type ErrorContext,
  ErrorUtils,
} from "../types/errors.js";
import {
  ImapConnectionPool,
  type ImapConnectionWrapper,
  type ImapPoolConfig,
} from "./ImapConnectionPool.js";
import { createLogger } from "./Logger.js";
import { type OfflineCapabilities, OfflineService } from "./OfflineService.js";
import { withCacheFallback } from "../utils/cacheFallback.js";

export class EmailService {
  private pool: ImapConnectionPool;
  private cache: LocalCache;
  private offlineService: OfflineService;
  private logger = createLogger("EmailService");

  constructor(
    connection: ImapConnection,
    cache: LocalCache,
    poolConfig: Omit<ImapPoolConfig, "connectionConfig">,
  ) {
    this.cache = cache;
    this.offlineService = new OfflineService(cache);
    this.pool = new ImapConnectionPool({
      ...poolConfig,
      connectionConfig: connection,
    });
  }

  async disconnect(): Promise<void> {
    await this.pool.destroy();
  }

  async searchEmails(options: EmailSearchOptions): Promise<EmailMessage[]> {
    const cacheKey = `email_search:${JSON.stringify(options)}`;

    return withCacheFallback({
      cacheKey,
      cache: this.cache,
      fetch: async () => {
        const folder = options.folder || "INBOX";
        let wrapper: ImapConnectionWrapper | null = null;

        try {
          wrapper = await this.pool.acquireForFolder(folder);
          const messages = await this.performEmailSearch(wrapper, options);
          return messages;
        } finally {
          if (wrapper) {
            await this.pool.releaseFromFolder(wrapper);
          }
        }
      },
      defaultValue: [],
      logger: this.logger,
      operation: "searchEmails",
      service: "EmailService",
      ttl: 300000, // 5 minutes TTL
      logContext: { folder: options.folder, query: options.query },
    });
  }

  async getEmail(uid: number, folder = "INBOX"): Promise<EmailMessage | null> {
    const cacheKey = `email:${folder}:${uid}`;
    let wrapper: ImapConnectionWrapper | null = null;

    try {
      return await withCacheFallback({
        cacheKey,
        cache: this.cache,
        fetch: async () => {
          wrapper = await this.pool.acquireForFolder(folder);
          const message = await this.fetchEmailByUid(wrapper, uid, folder);
          return message;
        },
        defaultValue: null,
        logger: this.logger,
        operation: "getEmail",
        service: "EmailService",
        ttl: 600000, // 10 minutes TTL
        logContext: { uid, folder },
      });
    } catch (error) {
      // Mark connection as unhealthy if fetch operation timed out
      if (
        wrapper &&
        error instanceof Error &&
        error.message.includes("timed out")
      ) {
        wrapper.isHealthy = false;
        await this.logger.warning(
          "Marking connection as unhealthy due to timeout",
          {
            operation: "getEmail",
            service: "EmailService",
          },
          { uid, folder },
        );
      }
      throw error;
    } finally {
      if (wrapper) {
        await this.pool.releaseFromFolder(wrapper);
      }
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
    wrapper: ImapConnectionWrapper,
    options: EmailSearchOptions,
  ): Promise<EmailMessage[]> {
    const searchResult = await this.executeSearch(wrapper, options);
    if (!searchResult || searchResult.length === 0) {
      return [];
    }

    const paginatedResults = this.applyPagination(searchResult, options);
    const messages = await this.fetchMessageHeaders(
      wrapper,
      paginatedResults,
      options.folder || "INBOX",
    );
    const filteredMessages = this.applyInMemoryFilters(messages, options);

    return this.sortMessagesByDate(filteredMessages);
  }

  private async executeSearch(
    wrapper: ImapConnectionWrapper,
    options: EmailSearchOptions,
  ): Promise<number[] | null> {
    const searchCriteria = this.buildSearchCriteria(options);
    const result = await wrapper.connection.search(searchCriteria);
    return Array.isArray(result) ? result : null;
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
    wrapper: ImapConnectionWrapper,
    uids: number[],
    folder: string,
  ): Promise<EmailMessage[]> {
    const messages: EmailMessage[] = [];

    if (uids.length > 0) {
      const iterator = wrapper.connection.fetch(uids, {
        envelope: true,
        uid: true,
        flags: true,
      });

      try {
        for await (const message of iterator) {
          const emailMessage = this.parseEmailMessage(
            message as unknown as ImapMessage,
            folder,
          );
          if (emailMessage) {
            messages.push(emailMessage);
          }
        }
      } finally {
        // Ensure iterator is properly closed even if an error occurs during parsing
        try {
          if (iterator && typeof iterator.return === "function") {
            await iterator.return();
          }
        } catch (error) {
          await this.logger.warning(
            "Failed to close fetch iterator for message headers",
            {
              operation: "fetchMessageHeaders",
              service: "EmailService",
            },
            {
              folder,
              uidCount: uids.length,
              error: error instanceof Error ? error.message : String(error),
            },
          );
          wrapper.isHealthy = false;
        }
      }
    }

    return messages;
  }

  private sortMessagesByDate(messages: EmailMessage[]): EmailMessage[] {
    return messages.sort((a, b) => b.date.getTime() - a.date.getTime());
  }

  private async fetchEmailByUid(
    wrapper: ImapConnectionWrapper,
    uid: number,
    folder: string,
  ): Promise<EmailMessage | null> {
    try {
      const rawMessage = await this.fetchRawMessageByUid(wrapper, uid, folder);

      if (!rawMessage) {
        return null;
      }

      const parsed = await simpleParser(
        (rawMessage as ImapMessage & { source: Buffer }).source,
      );
      return this.parseFullEmailMessage(parsed, rawMessage, folder);
    } catch (error) {
      throw new Error(
        `Failed to fetch email with UID ${uid} from folder ${folder}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async fetchRawMessageByUid(
    wrapper: ImapConnectionWrapper,
    uid: number,
    folder: string,
  ): Promise<ImapMessage | null> {
    // Add timeout to prevent hanging fetch operations
    const timeoutMs = 10000; // 10 seconds timeout for fetch operation
    const fetchPromise = this.performFetch(wrapper, uid);

    const timeoutPromise = new Promise<null>((_, reject) => {
      setTimeout(() => {
        reject(
          new Error(`IMAP fetch operation timed out after ${timeoutMs}ms`),
        );
      }, timeoutMs);
    });

    try {
      return await Promise.race([fetchPromise, timeoutPromise]);
    } catch (error) {
      await this.logger.error(
        `Failed to fetch email with UID ${uid} from folder ${folder}`,
        {
          operation: "fetchEmailContent",
          service: "EmailService",
        },
        {
          uid,
          folder,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      // CRITICAL: Mark connection as unhealthy when fetch times out
      // The background performFetch() may still be running, leaving the
      // IMAP connection in a corrupted state. Marking it unhealthy ensures
      // it won't be reused and will be destroyed on next validation.
      wrapper.isHealthy = false;
      return null;
    }
  }

  private async performFetch(
    wrapper: ImapConnectionWrapper,
    uid: number,
  ): Promise<ImapMessage | null> {
    // Create iterator explicitly so we can properly close it
    const iterator = wrapper.connection.fetch(
      `${uid}:${uid}`,
      {
        source: true,
        envelope: true,
        uid: true,
        flags: true,
      },
      { uid: true },
    );

    try {
      // Get the first (and should be only) message
      for await (const msg of iterator) {
        return msg as unknown as ImapMessage;
      }
      return null;
    } finally {
      // Explicitly close the iterator to prevent connection state issues
      // This is critical for connection reuse - without this, the connection
      // may be left in a state where it's waiting for the iterator to complete
      try {
        if (iterator && typeof iterator.return === "function") {
          await iterator.return();
        }
      } catch (error) {
        // If iterator cleanup fails, mark the connection as unhealthy
        // to prevent reuse of a potentially corrupted connection
        await this.logger.warning(
          "Failed to properly close fetch iterator",
          {
            operation: "performFetch",
            service: "EmailService",
          },
          {
            uid,
            error: error instanceof Error ? error.message : String(error),
          },
        );
        wrapper.isHealthy = false;
      }
    }
  }

  private buildSearchCriteria(options: EmailSearchOptions): ImapSearchCriteria {
    let criteria: ImapSearchCriteria = {};

    criteria = this.addDateFilters(criteria, options);
    criteria = this.addQueryFilters(criteria, options);

    return Object.keys(criteria).length === 0 ? { all: true } : criteria;
  }

  private addDateFilters(
    criteria: ImapSearchCriteria,
    options: EmailSearchOptions,
  ): ImapSearchCriteria {
    if (options.since) {
      criteria.since = options.since;
    }
    if (options.before) {
      criteria.before = options.before;
    }
    return criteria;
  }

  private addQueryFilters(
    criteria: ImapSearchCriteria,
    options: EmailSearchOptions,
  ): ImapSearchCriteria {
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

  private handleOrQuery(criteria: ImapSearchCriteria): ImapSearchCriteria {
    return Object.keys(criteria).length === 0 ? { all: true } : criteria;
  }

  private isFromQuery(query: string): boolean {
    return query.toLowerCase().startsWith("from:");
  }

  private handleFromQuery(
    criteria: ImapSearchCriteria,
    query: string,
  ): ImapSearchCriteria {
    criteria.from = query.substring(5).trim();
    return criteria;
  }

  private isToQuery(query: string): boolean {
    return query.toLowerCase().startsWith("to:");
  }

  private handleToQuery(
    criteria: ImapSearchCriteria,
    query: string,
  ): ImapSearchCriteria {
    criteria.to = query.substring(3).trim();
    return criteria;
  }

  private handleTextQuery(
    criteria: ImapSearchCriteria,
    query: string,
  ): ImapSearchCriteria {
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
      const query = options.query;
      const needsInMemoryQueryFilter = query.includes(" OR ");

      if (needsInMemoryQueryFilter) {
        filtered = filtered.filter(msg => this.matchesQuery(msg, query));
      }
    }

    return filtered;
  }

  private matchesQuery(message: EmailMessage, query: string): boolean {
    // Handle complex query matching in memory
    const lowercaseQuery = query.toLowerCase();

    // Handle OR operations
    if (lowercaseQuery.includes(" or ")) {
      const orParts = lowercaseQuery.split(" or ").map(part => part.trim());
      return orParts.some(part => this.matchesSingleQuery(message, part));
    }

    return this.matchesSingleQuery(message, lowercaseQuery);
  }

  private matchesSingleQuery(message: EmailMessage, query: string): boolean {
    // Handle from: queries
    if (query.startsWith("from:")) {
      const emailDomain = query.substring(5).trim();
      return message.from.some(from =>
        from.address.toLowerCase().includes(emailDomain),
      );
    }

    // Handle to: queries
    if (query.startsWith("to:")) {
      const emailDomain = query.substring(3).trim();
      return message.to.some(to =>
        to.address.toLowerCase().includes(emailDomain),
      );
    }

    // Default text search in subject and from/to addresses
    const searchText = query.toLowerCase();
    return (
      message.subject.toLowerCase().includes(searchText) ||
      message.from.some(
        from =>
          from.address.toLowerCase().includes(searchText) ||
          from.name?.toLowerCase().includes(searchText),
      ) ||
      message.to.some(
        to =>
          to.address.toLowerCase().includes(searchText) ||
          to.name?.toLowerCase().includes(searchText),
      )
    );
  }

  private parseEmailMessage(
    message: ImapMessage,
    folder: string,
  ): EmailMessage | null {
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
    message: ImapMessage,
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
      attachments: parsed.attachments?.map(att => ({
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
    addresses: unknown,
  ): Array<{ name?: string; address: string }> {
    if (!addresses) return [];
    if (!Array.isArray(addresses)) {
      const addr = addresses as { name?: string; address: string };
      if (addr.address) {
        return [{ name: addr.name, address: addr.address }];
      }
      return [];
    }
    return addresses.map(addr => ({
      name: addr.name,
      address: addr.address,
    }));
  }

  private parseAddressesFromParsed(
    addresses: unknown,
  ): Array<{ name?: string; address: string }> {
    if (!addresses) return [];
    if (!Array.isArray(addresses)) {
      const addr = addresses as { name?: string; address: string };
      if (addr.address) {
        return [{ name: addr.name, address: addr.address }];
      }
      return [];
    }
    return addresses.map(addr => ({
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
    const cacheKey = "email_folders";
    let wrapper: ImapConnectionWrapper | null = null;

    try {
      return await withCacheFallback({
        cacheKey,
        cache: this.cache,
        fetch: async () => {
          wrapper = await this.pool.acquire();
          const folders = await wrapper.connection.list();

          const result = folders.map(folder => ({
            name: folder.name,
            path: folder.path,
            delimiter: folder.delimiter || "/",
            flags: Array.isArray(folder.flags) ? folder.flags : [],
            specialUse: folder.specialUse,
          }));

          return result;
        },
        defaultValue: this.getDefaultFolders(),
        logger: this.logger,
        operation: "getFolders",
        service: "EmailService",
        ttl: 900000, // Cache for 15 minutes
      });
    } finally {
      if (wrapper) {
        await this.pool.release(wrapper);
      }
    }
  }

  async moveEmail(
    uid: number,
    fromFolder: string,
    toFolder: string,
  ): Promise<EmailOperationResult> {
    let wrapper: ImapConnectionWrapper | null = null;

    try {
      wrapper = await this.pool.acquireForFolder(fromFolder);
      await wrapper.connection.messageMove(`${uid}:${uid}`, toFolder, {
        uid: true,
      });

      // Clear cache for both folders
      this.clearFolderCache(fromFolder);
      this.clearFolderCache(toFolder);

      // Invalidate connections for the affected folders
      await this.pool.invalidateFolderConnections(fromFolder);
      await this.pool.invalidateFolderConnections(toFolder);

      return {
        success: true,
        message: `Email moved from ${fromFolder} to ${toFolder}`,
      };
    } catch (error) {
      await this.logger.error(
        `Error moving email UID ${uid}`,
        {
          operation: "moveEmail",
          service: "EmailService",
        },
        {
          uid,
          fromFolder,
          toFolder,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      return {
        success: false,
        message: `Failed to move email: ${error instanceof Error ? error.message : String(error)}`,
      };
    } finally {
      if (wrapper) {
        await this.pool.releaseFromFolder(wrapper);
      }
    }
  }

  async markEmail(
    uid: number,
    folder: string,
    flags: string[],
    action: "add" | "remove",
  ): Promise<EmailOperationResult> {
    let wrapper: ImapConnectionWrapper | null = null;

    try {
      wrapper = await this.pool.acquireForFolder(folder);

      if (action === "add") {
        await wrapper.connection.messageFlagsAdd(`${uid}:${uid}`, flags, {
          uid: true,
        });
      } else {
        await wrapper.connection.messageFlagsRemove(`${uid}:${uid}`, flags, {
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
      await this.logger.error(
        `Error marking email UID ${uid}`,
        {
          operation: "markEmail",
          service: "EmailService",
        },
        {
          uid,
          folder,
          flags,
          action,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      return {
        success: false,
        message: `Failed to mark email: ${error instanceof Error ? error.message : String(error)}`,
      };
    } finally {
      if (wrapper) {
        await this.pool.releaseFromFolder(wrapper);
      }
    }
  }

  async deleteEmail(
    uid: number,
    folder: string,
    permanent = false,
  ): Promise<EmailOperationResult> {
    let wrapper: ImapConnectionWrapper | null = null;

    try {
      wrapper = await this.pool.acquireForFolder(folder);

      if (permanent) {
        // Add deleted flag and expunge
        await wrapper.connection.messageFlagsAdd(
          `${uid}:${uid}`,
          ["\\Deleted"],
          {
            uid: true,
          },
        );
        // Note: expunge is called automatically after messageDelete in newer ImapFlow versions
        // await wrapper.connection.expunge(); // This method may not exist in current ImapFlow version
      } else {
        // Move to Trash folder
        try {
          await wrapper.connection.messageMove(`${uid}:${uid}`, "Trash", {
            uid: true,
          });
        } catch (moveError) {
          // If Trash folder doesn't exist, try other common names
          const trashFolders = ["Deleted Items", "Deleted", "INBOX.Trash"];
          let moved = false;

          for (const trashFolder of trashFolders) {
            try {
              await wrapper.connection.messageMove(
                `${uid}:${uid}`,
                trashFolder,
                {
                  uid: true,
                },
              );
              moved = true;
              break;
            } catch (error) {
              // Continue to next folder
            }
          }

          if (!moved) {
            // If no trash folder found, mark as deleted
            await wrapper.connection.messageFlagsAdd(
              `${uid}:${uid}`,
              ["\\Deleted"],
              {
                uid: true,
              },
            );
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
      await this.logger.error(
        `Error deleting email UID ${uid}`,
        {
          operation: "deleteEmail",
          service: "EmailService",
        },
        {
          uid,
          folder,
          permanent,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      return {
        success: false,
        message: `Failed to delete email: ${error instanceof Error ? error.message : String(error)}`,
      };
    } finally {
      if (wrapper) {
        await this.pool.releaseFromFolder(wrapper);
      }
    }
  }

  async createDraft(
    composition: EmailComposition,
    folder = "Drafts",
  ): Promise<EmailOperationResult> {
    let wrapper: ImapConnectionWrapper | null = null;

    try {
      wrapper = await this.pool.acquireForFolder(folder);

      // Create email content
      const emailContent = this.buildEmailContent(composition);

      // Append to drafts folder
      const result = await wrapper.connection.append(folder, emailContent, [
        "\\Draft",
      ]);

      // Clear cache for the drafts folder
      this.clearFolderCache(folder);

      return {
        success: true,
        message: "Draft saved successfully",
        uid:
          result && typeof result === "object" && "uid" in result
            ? result.uid
            : undefined,
      };
    } catch (error) {
      await this.logger.error(
        "Error creating draft",
        {
          operation: "createDraft",
          service: "EmailService",
        },
        {
          composition,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      return {
        success: false,
        message: `Failed to create draft: ${error instanceof Error ? error.message : String(error)}`,
      };
    } finally {
      if (wrapper) {
        await this.pool.releaseFromFolder(wrapper);
      }
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
    headers.push(`Message-ID: <${Date.now()}.${Math.random()}@mailbox.org>`);

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
      .map(addr => {
        if (addr.name) {
          return `"${addr.name}" <${addr.address}>`;
        }
        return addr.address;
      })
      .join(", ");
  }

  private clearFolderCache(folder: string): void {
    // Clear all cache entries that are associated with the specified folder
    // Check if keys() method exists (for backwards compatibility)
    if (typeof this.cache.keys !== "function") {
      return;
    }

    const keysToDelete: string[] = [];

    for (const key of this.cache.keys()) {
      // Match email search keys containing this folder
      if (
        key.startsWith("email_search:") &&
        key.includes(`"folder":"${folder}"`)
      ) {
        keysToDelete.push(key);
      }
      // Match individual email keys for this folder
      if (key.startsWith(`email:${folder}:`)) {
        keysToDelete.push(key);
      }
      // Match thread keys for this folder
      if (key.startsWith(`thread:${folder}:`)) {
        keysToDelete.push(key);
      }
    }

    for (const key of keysToDelete) {
      this.cache.delete(key);
    }
  }

  private getDefaultFolders(): EmailFolder[] {
    // Return a basic set of folders when connection is not available
    return [
      {
        name: "INBOX",
        path: "INBOX",
        delimiter: "/",
        flags: [],
        specialUse: undefined,
      },
      {
        name: "Sent",
        path: "Sent",
        delimiter: "/",
        flags: [],
        specialUse: "\\Sent",
      },
      {
        name: "Drafts",
        path: "Drafts",
        delimiter: "/",
        flags: [],
        specialUse: "\\Drafts",
      },
      {
        name: "Trash",
        path: "Trash",
        delimiter: "/",
        flags: [],
        specialUse: "\\Trash",
      },
    ];
  }

  // Pool management methods
  getPoolMetrics() {
    return this.pool.getImapMetrics();
  }

  // Offline capabilities
  getOfflineCapabilities(): OfflineCapabilities {
    return this.offlineService.getOfflineCapabilities();
  }

  async searchEmailsOffline(
    options: EmailSearchOptions,
  ): Promise<EmailMessage[]> {
    return this.offlineService.searchEmailsOffline(options);
  }

  async getEmailOffline(
    uid: number,
    folder = "INBOX",
  ): Promise<EmailMessage | null> {
    return this.offlineService.getEmailOffline(uid, folder);
  }

  async getFoldersOffline(): Promise<EmailFolder[]> {
    return this.offlineService.getFoldersOffline();
  }

  async validatePoolHealth(): Promise<boolean> {
    try {
      const metrics = this.pool.getMetrics();
      return (
        metrics.totalConnections > 0 &&
        metrics.totalErrors < metrics.totalConnections
      );
    } catch (error) {
      await this.logger.error(
        "Error checking pool health",
        {
          operation: "isHealthy",
          service: "EmailService",
        },
        { error: error instanceof Error ? error.message : String(error) },
      );
      return false;
    }
  }

  async createDirectory(
    name: string,
    parentPath = "",
  ): Promise<EmailOperationResult> {
    let wrapper: ImapConnectionWrapper | null = null;

    try {
      wrapper = await this.pool.acquire();

      // Construct the full folder path
      // Use standard IMAP delimiter
      const delimiter = "/"; // Standard IMAP delimiter
      const folderPath = parentPath ? `${parentPath}${delimiter}${name}` : name;

      // Create the folder using IMAP CREATE command
      await wrapper.connection.mailboxCreate(folderPath);

      return {
        success: true,
        message: `Directory '${name}' created successfully`,
      };
    } catch (error) {
      await this.logger.error(
        `Error creating directory '${name}'`,
        {
          operation: "createDirectory",
          service: "EmailService",
        },
        { name, error: error instanceof Error ? error.message : String(error) },
      );
      return {
        success: false,
        message: `Failed to create directory: ${error instanceof Error ? error.message : String(error)}`,
      };
    } finally {
      if (wrapper) {
        await this.pool.release(wrapper);
      }
    }
  }
}
