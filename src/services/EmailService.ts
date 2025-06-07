import { ImapFlow } from "imapflow";
import { type ParsedMail, simpleParser } from "mailparser";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { LocalCache } from "../types/cache.types.js";
import type {
  EmailMessage,
  EmailSearchOptions,
  EmailThread,
  ImapConnection,
} from "../types/email.types.js";

export class EmailService {
  private connection: ImapConnection;
  private cache: LocalCache;
  private client?: ImapFlow;
  private server: Server;

  constructor(connection: ImapConnection, cache: LocalCache, server: Server) {
    this.connection = connection;
    this.cache = cache;
    this.server = server;
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

    if (this.client.on && typeof this.client.on === 'function') {
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

      await this.server.sendLoggingMessage({
        level: "info",
        logger: "EmailService",
        data: `Fetching email with UID ${uid} from folder ${folder}`
      });

      const message = await this.fetchEmailByUid(uid, folder);

      if (message) {
        this.cache.set(cacheKey, message, 600000); // 10 minutes TTL
      }

      await this.server.sendLoggingMessage({
        level: "info",
        logger: "EmailService",
        data: `Fetched email with UID ${uid} from folder ${folder}`
      });

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
    if (!this.client) {
      throw new Error("IMAP connection not established");
    }

    // Select the mailbox
    await this.client.mailboxOpen(folder);

    // Build search criteria
    const searchCriteria = this.buildSearchCriteria(options);

    // Search for messages
    const searchResult = await this.client.search(searchCriteria);

    if (!searchResult || searchResult.length === 0) {
      return [];
    }

    // Apply pagination
    const limitedResults = options.limit
      ? searchResult.slice(
          options.offset || 0,
          (options.offset || 0) + options.limit,
        )
      : searchResult.slice(options.offset || 0);

    // Fetch message headers and envelopes
    const messages: EmailMessage[] = [];

    if (limitedResults.length > 0) {
      for await (const message of this.client.fetch(limitedResults, {
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

    // Apply in-memory filtering for complex queries
    const filteredMessages = this.applyInMemoryFilters(messages, options);

    // Sort by date (newest first)
    filteredMessages.sort((a, b) => b.date.getTime() - a.date.getTime());

    return filteredMessages;
  }

  private async fetchEmailByUid(
    uid: number,
    folder: string,
  ): Promise<EmailMessage | null> {
    if (!this.client) {
      throw new Error("IMAP connection not established");
    }

    try {
      // Select the mailbox
      await this.client.mailboxOpen(folder);

      // Fetch the full message by UID using fetch method
      let message: any = null;
      for await (const msg of this.client.fetch(
        `${uid}:${uid}`,
        {
          source: true,
          envelope: true,
          uid: true,
          flags: true,
        },
        { uid: true },
      )) {
        message = msg;
        break; // We only expect one message
      }

      if (!message) {
        console.error(
          `Failed to fetch email with UID ${uid} from folder ${folder}`,
        );
        return null;
      }

      // Parse the full message
      const parsed = await simpleParser(message.source as Buffer);

      return this.parseFullEmailMessage(parsed, message, folder);
    } catch (error) {
      // Log the specific error type for debugging
      if (error instanceof Error) {
        const errorWithCode = error as Error & { code?: string };
        if (
          errorWithCode.code === "ECONNRESET" ||
          errorWithCode.code === "EPIPE"
        ) {
          console.error(
            `Connection error while fetching UID ${uid}: ${error.message}`,
          );
          // Reset client to force reconnection on next attempt
          this.client = undefined;
        }
      }
      throw new Error(
        `Failed to fetch email with UID ${uid} from folder ${folder}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private buildSearchCriteria(options: EmailSearchOptions): any {
    const criteria: any = {};

    // Add date filters
    if (options.since) {
      criteria.since = options.since;
    }

    if (options.before) {
      criteria.before = options.before;
    }

    // Handle query searches
    if (options.query) {
      const query = options.query.trim();

      // Handle complex queries with OR operations
      if (query.includes(" OR ")) {
        // For OR queries, we'll use a broader search and filter in memory
        // imapflow doesn't support complex OR queries in the same way
        if (Object.keys(criteria).length === 0) {
          return { all: true }; // No date filters, search all
        }
        return criteria; // Return just date filters, handle query in memory
      }

      // Handle from: queries
      if (query.toLowerCase().startsWith("from:")) {
        const fromValue = query.substring(5).trim();
        criteria.from = fromValue;
        return criteria;
      }

      // Handle to: queries
      if (query.toLowerCase().startsWith("to:")) {
        const toValue = query.substring(3).trim();
        criteria.to = toValue;
        return criteria;
      }

      // For simple text queries, search in subject and body
      criteria.or = [{ subject: query }, { body: query }];
    }

    // If no criteria, return all messages
    if (Object.keys(criteria).length === 0) {
      return { all: true };
    }

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
          (from.name && from.name.toLowerCase().includes(searchText)),
      ) ||
      message.to.some(
        (to) =>
          to.address.toLowerCase().includes(searchText) ||
          (to.name && to.name.toLowerCase().includes(searchText)),
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
}
