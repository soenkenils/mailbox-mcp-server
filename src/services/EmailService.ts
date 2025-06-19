import { ImapFlow } from "imapflow";
import { type ParsedMail, simpleParser } from "mailparser";
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
}
