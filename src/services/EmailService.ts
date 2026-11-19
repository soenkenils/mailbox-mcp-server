import type { FetchMessageObject } from "imapflow";
import {
  type AddressObject,
  type EmailAddress,
  type ParsedMail,
  simpleParser,
} from "mailparser";
import MailComposer from "nodemailer/lib/mail-composer";

// IMAP library type definitions
interface ImapSearchCriteria {
  all?: boolean;
  since?: Date;
  before?: Date;
  from?: string;
  to?: string;
  subject?: string;
  body?: string;
  // Nested criteria, ORed together, as imapflow's SearchObject defines them.
  // The looser `Array<{ [key: string]: string | Date }>` this replaces could
  // not express one criterion built from another.
  or?: ImapSearchCriteria[];
  seen?: boolean;
  answered?: boolean;
  flagged?: boolean;
  draft?: boolean;
  deleted?: boolean;
}

/**
 * imapflow returns the raw header string when a Date: header will not parse
 * (see parseEnvelope in its tools.js), which mail from spammers and broken
 * clients regularly triggers. Such a value is normalised to a Date, or to
 * null when it names no real time, so one message cannot break a listing.
 */
const toDate = (value: unknown): Date | null => {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
};

/**
 * The message's own Date header, else the time the server received it
 * (INTERNALDATE). Null when neither is usable: inventing "now" would show a
 * made-up date and sort the message to the top of every listing.
 */
const messageDate = (header: unknown, internalDate: unknown): Date | null =>
  toDate(header) ?? toDate(internalDate);

/** Newest first, with undated messages after every dated one. */
const byDateDescending = (a: EmailMessage, b: EmailMessage): number =>
  (b.date?.getTime() ?? Number.NEGATIVE_INFINITY) -
    (a.date?.getTime() ?? Number.NEGATIVE_INFINITY) || 0;

/** Oldest first, as a thread reads, with undated messages at the end. */
const byDateAscending = (a: EmailMessage, b: EmailMessage): number =>
  (a.date?.getTime() ?? Number.POSITIVE_INFINITY) -
    (b.date?.getTime() ?? Number.POSITIVE_INFINITY) || 0;

/**
 * The shape imapflow actually hands back, taken from the library rather than
 * restated here. The hand-written version this replaces had drifted: it
 * declared `date?: Date` where the library may return the raw header string,
 * a required `envelope` the library marks optional, and `bodystructure`
 * misspelt (the library spells it `bodyStructure`). Because the casts at the
 * fetch sites were `as unknown as`, none of that could be caught by
 * type-checking.
 */
type ImapMessage = FetchMessageObject;

import type { CacheConfig, LocalCache } from "../types/cache.types.js";
import type {
  EmailComposition,
  EmailFolder,
  EmailMessage,
  EmailOperationResult,
  EmailSearchOptions,
  EmailSearchResult,
  EmailThread,
  ImapConnection,
} from "../types/email.types.js";
import { createCacheFetcher } from "../utils/cacheFallback.js";
import { senderFor, toMailAddresses } from "../utils/mailAddresses.js";
import {
  ImapConnectionPool,
  type ImapConnectionWrapper,
  type ImapPoolConfig,
} from "./ImapConnectionPool.js";
import { createLogger } from "./Logger.js";

const FOLDERS_CACHE_KEY = "email_folders";

/**
 * Separates the sides of a disjunctive query. Case-insensitive, matching the
 * from:/to: prefixes, so a lowercase `or` is not searched as literal text; a
 * phrase in double quotes is never split. Anchored, as it is tried at each
 * position outside quotes.
 */
const OR_SEPARATOR = /^\s+or\s+/i;

/** One side of a query: its text, and whether it was a quoted phrase. */
interface QueryTerm {
  text: string;
  quoted: boolean;
}

/** A term in double quotes is a literal phrase; the quotes are not searched. */
const toTerm = (raw: string): QueryTerm => {
  const text = raw.trim();
  return text.length >= 2 && text.startsWith('"') && text.endsWith('"')
    ? { text: text.slice(1, -1).trim(), quoted: true }
    : { text, quoted: false };
};

/** Splits a query on OR separators that lie outside double quotes. */
const splitOnOr = (query: string): QueryTerm[] => {
  const parts: string[] = [];
  let current = "";
  let inQuotes = false;
  let i = 0;
  while (i < query.length) {
    const char = query[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (!inQuotes) {
      const separator = OR_SEPARATOR.exec(query.slice(i));
      if (separator) {
        parts.push(current);
        current = "";
        i += separator[0].length;
        continue;
      }
    }
    current += char;
    i++;
  }
  parts.push(current);
  return parts.map(toTerm).filter(term => term.text !== "");
};

/** Used when no TTLs are passed in; match the defaults in config.ts. */
const DEFAULT_EMAIL_TTLS: CacheConfig["email"] = {
  searchTtl: 300000, // 5 minutes
  messageTtl: 600000, // 10 minutes
  threadTtl: 300000, // 5 minutes
};

/** Common trash folder names, tried after the server's \Trash folder. */
const TRASH_FOLDER_NAMES = ["Trash", "Deleted Items", "Deleted", "INBOX.Trash"];

export class EmailService {
  private pool: ImapConnectionPool;
  private cache: LocalCache;
  private logger = createLogger("EmailService");
  private cachedFetch: ReturnType<typeof createCacheFetcher>;
  private sender: { name?: string; address: string };
  private ttls: CacheConfig["email"];

  constructor(
    connection: ImapConnection,
    cache: LocalCache,
    poolConfig: Omit<ImapPoolConfig, "connectionConfig">,
    ttls: CacheConfig["email"] = DEFAULT_EMAIL_TTLS,
  ) {
    this.cache = cache;
    this.ttls = ttls;
    this.sender = senderFor(connection.user);
    this.cachedFetch = createCacheFetcher(
      this.cache,
      this.logger,
      "EmailService",
    );
    this.pool = new ImapConnectionPool({
      ...poolConfig,
      connectionConfig: connection,
    });
  }

  async disconnect(): Promise<void> {
    await this.pool.destroy();
  }

  async searchEmails(options: EmailSearchOptions): Promise<EmailSearchResult> {
    const cacheKey = `email_search:${JSON.stringify(options)}`;

    return this.cachedFetch(
      cacheKey,
      async () => {
        const folder = options.folder || "INBOX";
        let wrapper: ImapConnectionWrapper | null = null;

        try {
          wrapper = await this.pool.acquireForFolder(folder);
          return await this.performEmailSearch(wrapper, options);
        } finally {
          if (wrapper) {
            await this.pool.releaseFromFolder(wrapper);
          }
        }
      },
      "searchEmails",
      this.ttls.searchTtl,
      // No default: on a connection failure with nothing cached, an empty
      // list would read as "no such emails" instead of an outage.
    );
  }

  async getEmail(uid: number, folder = "INBOX"): Promise<EmailMessage | null> {
    const cacheKey = `email:${folder}:${uid}`;
    let wrapper: ImapConnectionWrapper | null = null;

    try {
      // No fallback: when the connection fails and there is no stale copy,
      // the error must surface instead of reading as "not found".
      return await this.cachedFetch(
        cacheKey,
        async () => {
          wrapper = await this.pool.acquireForFolder(folder);
          return await this.fetchEmailByUid(wrapper, uid, folder);
        },
        "getEmail",
        this.ttls.messageTtl,
      );
    } finally {
      // A timed-out or failed fetch has already marked the connection
      // unhealthy (fetchRawMessageByUid), so releasing it retires it.
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
      this.cache.set(cacheKey, thread, this.ttls.threadTtl);
    }

    return thread;
  }

  private async performEmailSearch(
    wrapper: ImapConnectionWrapper,
    options: EmailSearchOptions,
  ): Promise<EmailSearchResult> {
    const searchResult = await this.executeSearch(wrapper, options);
    if (searchResult.length === 0) {
      return { messages: [], total: 0 };
    }

    // Captured before pagination: this is how many messages matched, not how
    // many this page returns. The server evaluates the whole query, including
    // OR terms and flag filters, so the count is exact.
    const total = searchResult.length;
    const paginatedResults = this.applyPagination(searchResult, options);
    const messages = await this.fetchMessageHeaders(
      wrapper,
      paginatedResults,
      options.folder || "INBOX",
    );

    return { messages: this.sortMessagesByDate(messages), total };
  }

  private async executeSearch(
    wrapper: ImapConnectionWrapper,
    options: EmailSearchOptions,
  ): Promise<number[]> {
    const searchCriteria = this.buildSearchCriteria(options);
    // Search by UID (stable across expunges) instead of sequence numbers.
    const result = await wrapper.connection.search(searchCriteria, {
      uid: true,
    });
    // imapflow resolves false when the server rejects SEARCH and undefined
    // when no folder is selected, instead of throwing. Either is a failure;
    // returning no matches would read as an empty mailbox.
    if (!Array.isArray(result)) {
      throw new Error(
        `IMAP search failed in folder ${options.folder || "INBOX"}`,
      );
    }
    return result;
  }

  private applyPagination(
    searchResult: number[],
    options: EmailSearchOptions,
  ): number[] {
    // IMAP SEARCH returns results sorted ascending (oldest first). Callers
    // expect the NEWEST emails, so reverse before paginating; otherwise
    // slicing from the front always yields the oldest matches.
    const newestFirst = [...searchResult].reverse();
    const offset = options.offset || 0;
    const end = options.limit ? offset + options.limit : undefined;
    return newestFirst.slice(offset, end);
  }

  private async fetchMessageHeaders(
    wrapper: ImapConnectionWrapper,
    uids: number[],
    folder: string,
  ): Promise<EmailMessage[]> {
    const messages: EmailMessage[] = [];

    if (uids.length > 0) {
      const iterator = wrapper.connection.fetch(
        uids,
        {
          envelope: true,
          uid: true,
          flags: true,
          internalDate: true,
        },
        { uid: true },
      );

      try {
        for await (const message of iterator) {
          const emailMessage = this.parseEmailMessage(message, folder);
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
          this.logger.warning(
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
    return messages.sort(byDateDescending);
  }

  private async fetchEmailByUid(
    wrapper: ImapConnectionWrapper,
    uid: number,
    folder: string,
  ): Promise<EmailMessage | null> {
    try {
      const rawMessage = await this.fetchRawMessageByUid(wrapper, uid, folder);

      // `source` is optional on FetchMessageObject: a partial fetch can yield
      // a message with no body to parse, which reads as not found.
      if (!rawMessage?.source) {
        return null;
      }

      const parsed = await simpleParser(rawMessage.source);
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

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new Error(`IMAP fetch operation timed out after ${timeoutMs}ms`),
        );
      }, timeoutMs);
    });

    try {
      return await Promise.race([fetchPromise, timeoutPromise]);
    } catch (error) {
      this.logger.error(
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
      // Rethrown rather than returning null, which callers read as "no such
      // message". Only fetchOne resolving without a message means not found.
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private async performFetch(
    wrapper: ImapConnectionWrapper,
    uid: number,
  ): Promise<ImapMessage | null> {
    // fetchOne issues the FETCH and resolves once the command has completed.
    // Avoid returning early from a fetch() async iterator: on imapflow 1.x that
    // left the command pending and blocked the connection (issue #8).
    const message = await wrapper.connection.fetchOne(
      uid,
      {
        source: true,
        envelope: true,
        uid: true,
        flags: true,
        internalDate: true,
      },
      { uid: true },
    );

    // undefined means no folder was selected, which is a failure; false means
    // the server returned no such message.
    if (message === undefined) {
      throw new Error("IMAP fetch failed: no folder selected");
    }
    return message || null;
  }

  private buildSearchCriteria(options: EmailSearchOptions): ImapSearchCriteria {
    let criteria: ImapSearchCriteria = {};

    criteria = this.addDateFilters(criteria, options);
    criteria = this.addQueryFilters(criteria, options);
    criteria = this.addFlagFilters(criteria, options);

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

  private addFlagFilters(
    criteria: ImapSearchCriteria,
    options: EmailSearchOptions,
  ): ImapSearchCriteria {
    if (options.seen !== undefined) {
      criteria.seen = options.seen;
    }
    if (options.answered !== undefined) {
      criteria.answered = options.answered;
    }
    if (options.flagged !== undefined) {
      criteria.flagged = options.flagged;
    }
    if (options.draft !== undefined) {
      criteria.draft = options.draft;
    }
    if (options.deleted !== undefined) {
      criteria.deleted = options.deleted;
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
      return this.handleOrQuery(criteria, query);
    }

    const whole = toTerm(query);
    if (whole.quoted) {
      return whole.text ? this.handleTextQuery(criteria, whole.text) : criteria;
    }

    if (this.isFromQuery(query)) {
      return this.handleFromQuery(criteria, query);
    }

    if (this.isToQuery(query)) {
      return this.handleToQuery(criteria, query);
    }

    return this.handleTextQuery(criteria, query);
  }

  /** The sides of a disjunctive query; fewer than two means it is not one. */
  private orTerms(query: string): QueryTerm[] {
    return splitOnOr(query);
  }

  private isOrQuery(query: string): boolean {
    return this.orTerms(query).length > 1;
  }

  /**
   * Expands `a OR b` into an IMAP OR the server evaluates itself.
   *
   * This used to leave the query to a filter applied to each page after it
   * was fetched, which only ever examined one page of the mailbox: matches
   * older than the newest `limit` messages were invisible, the match count
   * was the size of the folder, and with a date filter the query was dropped
   * altogether.
   *
   * Top-level criteria are ANDed by IMAP, so assigning `or` alongside date
   * and flag filters narrows the disjunction instead of replacing it.
   */
  private handleOrQuery(
    criteria: ImapSearchCriteria,
    query: string,
  ): ImapSearchCriteria {
    criteria.or = this.orTerms(query).flatMap(term => this.termCriteria(term));
    return criteria;
  }

  /**
   * The criteria one side of an OR contributes, keeping from:/to: addressed.
   * A quoted phrase is always plain text, even when it starts with from:.
   */
  private termCriteria({
    text: term,
    quoted,
  }: QueryTerm): ImapSearchCriteria[] {
    if (quoted) {
      return [{ subject: term }, { body: term }];
    }
    if (this.isFromQuery(term)) {
      return [{ from: term.substring(5).trim() }];
    }
    if (this.isToQuery(term)) {
      return [{ to: term.substring(3).trim() }];
    }
    return [{ subject: term }, { body: term }];
  }

  /**
   * A prefix with nothing after it is not an addressed query: IMAP treats
   * `FROM ""` as matching every message, so `from:` alone would quietly return
   * the whole mailbox. Such a term falls through to a text search instead.
   */
  private isFromQuery(query: string): boolean {
    return (
      query.toLowerCase().startsWith("from:") &&
      query.substring(5).trim() !== ""
    );
  }

  private handleFromQuery(
    criteria: ImapSearchCriteria,
    query: string,
  ): ImapSearchCriteria {
    criteria.from = query.substring(5).trim();
    return criteria;
  }

  private isToQuery(query: string): boolean {
    return (
      query.toLowerCase().startsWith("to:") && query.substring(3).trim() !== ""
    );
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
      date: messageDate(envelope.date, message.internalDate),
      flags: Array.from(message.flags ?? []),
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
      date: messageDate(parsed.date, message.internalDate),
      text: parsed.text,
      html: parsed.html || undefined,
      attachments: parsed.attachments?.map(att => ({
        filename: att.filename || "unnamed",
        contentType: att.contentType,
        size: att.size,
        contentId: att.cid,
      })),
      flags: Array.from(message.flags ?? []),
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

  /**
   * mailparser returns `AddressObject | AddressObject[]`, where each
   * AddressObject wraps its entries in `value`, and an entry may be a group
   * (`{ name, group: [...] }`) instead of an address. Flatten all of it.
   */
  private parseAddressesFromParsed(
    addresses: AddressObject | AddressObject[] | undefined,
  ): Array<{ name?: string; address: string }> {
    if (!addresses) return [];
    const objects = Array.isArray(addresses) ? addresses : [addresses];
    const result: Array<{ name?: string; address: string }> = [];
    const collect = (entries: EmailAddress[] | undefined) => {
      for (const entry of entries ?? []) {
        if (entry.group) {
          collect(entry.group);
        } else if (entry.address) {
          result.push({
            name: entry.name || undefined,
            address: entry.address,
          });
        }
      }
    };
    for (const object of objects) collect(object?.value);
    return result;
  }

  private async buildEmailThread(
    messageId: string,
    folder: string,
  ): Promise<EmailThread | null> {
    let wrapper: ImapConnectionWrapper | null = null;

    try {
      wrapper = await this.pool.acquireForFolder(folder);

      // Match the message itself plus anything replying to it, by header.
      // A text search would only hit messages quoting the id in their body.
      const uids = await wrapper.connection.search(
        {
          or: [
            { header: { "message-id": messageId } },
            { header: { references: messageId } },
            { header: { "in-reply-to": messageId } },
          ],
        },
        { uid: true },
      );

      // imapflow resolves false instead of throwing when SEARCH fails; that
      // is an error, not an empty thread.
      if (uids === false) {
        throw new Error(`IMAP search failed in folder ${folder}`);
      }
      if (!Array.isArray(uids) || uids.length === 0) {
        return null;
      }

      const messages = await this.fetchMessageHeaders(wrapper, uids, folder);

      if (messages.length === 0) {
        return null;
      }

      // Oldest first: a thread reads in the order it happened.
      const ordered = [...messages].sort(byDateAscending);
      // Callers may pass the id with or without angle brackets, while the
      // envelope keeps whichever form the sender used.
      const sameId = (a: string, b: string) =>
        a.replace(/[<>]/g, "").trim() === b.replace(/[<>]/g, "").trim();
      const root =
        ordered.find(message => sameId(message.id, messageId)) ?? ordered[0];

      return {
        threadId: messageId,
        messages: ordered,
        subject: root.subject,
        participants: this.collectParticipants(ordered),
        // The newest known date: undated messages sort last, so skip them.
        lastActivity:
          [...ordered].reverse().find(message => message.date !== null)?.date ??
          null,
      };
    } finally {
      if (wrapper) {
        await this.pool.releaseFromFolder(wrapper);
      }
    }
  }

  private collectParticipants(
    messages: EmailMessage[],
  ): Array<{ name?: string; address: string }> {
    const byAddress = new Map<string, { name?: string; address: string }>();

    for (const message of messages) {
      for (const participant of [...message.from, ...message.to]) {
        const key = participant.address.toLowerCase();
        if (!byAddress.has(key)) {
          byAddress.set(key, participant);
        }
      }
    }

    return [...byAddress.values()];
  }

  async getFolders(): Promise<EmailFolder[]> {
    const cacheKey = FOLDERS_CACHE_KEY;
    let wrapper: ImapConnectionWrapper | null = null;

    try {
      return await this.cachedFetch(
        cacheKey,
        async (): Promise<EmailFolder[]> => {
          wrapper = await this.pool.acquire();
          const folders = await wrapper.connection.list();

          return folders.map(folder => ({
            name: folder.name,
            path: folder.path,
            delimiter: folder.delimiter || "/",
            flags: Array.isArray(folder.flags)
              ? folder.flags
              : folder.flags instanceof Set
                ? Array.from(folder.flags)
                : [],
            specialUse: folder.specialUse,
          }));
        },
        "getFolders",
        900000, // Cache for 15 minutes
        // No default: a guessed folder list would read as the real one.
      );
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
      // imapflow resolves false instead of throwing when the server refuses,
      // e.g. for a destination folder that does not exist.
      const moved = await wrapper.connection.messageMove(
        `${uid}:${uid}`,
        toFolder,
        { uid: true },
      );
      if (!moved) {
        throw new Error(`Server refused to move the message to ${toFolder}`);
      }

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
      this.logger.error(
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

      // Like messageMove, these resolve false on failure rather than throwing.
      const updated =
        action === "add"
          ? await wrapper.connection.messageFlagsAdd(`${uid}:${uid}`, flags, {
              uid: true,
            })
          : await wrapper.connection.messageFlagsRemove(
              `${uid}:${uid}`,
              flags,
              { uid: true },
            );
      if (!updated) {
        throw new Error("Server refused to update the message flags");
      }

      // Clear cache for the folder
      this.clearFolderCache(folder);

      return {
        success: true,
        message: `Email flags ${action === "add" ? "added" : "removed"} successfully`,
      };
    } catch (error) {
      this.logger.error(
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

  /**
   * Where a soft delete may move a message, best first: the folder the server
   * marks with the \Trash special-use flag, then the common names. Read
   * before a folder connection is taken, so a delete never holds two pool
   * connections. If the folder list cannot be loaded, the names still apply.
   */
  private async trashCandidates(): Promise<{
    candidates: string[];
    specialUse?: string;
  }> {
    let specialUse: string | undefined;
    try {
      const folders = await this.getFolders();
      specialUse = folders.find(f => f.specialUse === "\\Trash")?.path;
    } catch (error) {
      this.logger.warning(
        "Could not list folders to find the trash folder; trying common names",
        { operation: "deleteEmail", service: "EmailService" },
        { error: error instanceof Error ? error.message : String(error) },
      );
    }
    const candidates = [
      ...(specialUse ? [specialUse] : []),
      ...TRASH_FOLDER_NAMES.filter(name => name !== specialUse),
    ];
    return { candidates, specialUse };
  }

  // Tries each candidate in turn and returns the folder the message moved
  // to, or null when none accepted it.
  private async moveToTrash(
    wrapper: ImapConnectionWrapper,
    uid: number,
    candidates: string[],
  ): Promise<string | null> {
    for (const trashFolder of candidates) {
      // messageMove resolves false for a missing destination rather than
      // throwing, so the return value is the only signal that it worked.
      const moved = await wrapper.connection.messageMove(
        `${uid}:${uid}`,
        trashFolder,
        { uid: true },
      );

      if (moved) {
        return trashFolder;
      }
    }

    return null;
  }

  async deleteEmail(
    uid: number,
    folder: string,
    permanent = false,
  ): Promise<EmailOperationResult> {
    let wrapper: ImapConnectionWrapper | null = null;
    let movedTo: string | null = null;

    try {
      let candidates: string[] = [];
      if (!permanent) {
        const trash = await this.trashCandidates();
        // Moving a message from the trash to the trash does nothing, and
        // falling through to the \Deleted flag would not remove it either.
        const isTrash = trash.specialUse
          ? folder === trash.specialUse
          : TRASH_FOLDER_NAMES.includes(folder);
        if (isTrash) {
          return {
            success: false,
            message: `Email is already in the trash folder "${folder}"; use permanent: true to remove it`,
          };
        }
        candidates = trash.candidates.filter(name => name !== folder);
      }

      wrapper = await this.pool.acquireForFolder(folder);

      if (permanent) {
        // Without UIDPLUS, imapflow's messageDelete falls back to a plain
        // EXPUNGE, which removes every message flagged \Deleted in the folder
        // (including ones our own soft-delete fallback flagged), not just
        // this one. Refuse rather than risk deleting other mail.
        if (!wrapper.connection.capabilities?.has("UIDPLUS")) {
          throw new Error(
            "server does not support UIDPLUS; cannot permanently delete a single message safely",
          );
        }
        // Flags the message \Deleted and expunges it (UID EXPUNGE with
        // UIDPLUS). Resolves false instead of throwing when that fails.
        const expunged = await wrapper.connection.messageDelete(
          `${uid}:${uid}`,
          { uid: true },
        );
        if (expunged !== true) {
          throw new Error("Server did not expunge the message");
        }
      } else {
        movedTo = await this.moveToTrash(wrapper, uid, candidates);

        if (!movedTo) {
          // No trash folder anywhere: flag the message and say so, rather
          // than reporting a move that never happened.
          const flagged = await wrapper.connection.messageFlagsAdd(
            `${uid}:${uid}`,
            ["\\Deleted"],
            {
              uid: true,
            },
          );
          if (!flagged) {
            throw new Error(
              "No trash folder found and the server refused to flag the message as deleted",
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
          : movedTo
            ? `Email moved to trash folder "${movedTo}"`
            : "Email marked as deleted: no trash folder found",
      };
    } catch (error) {
      this.logger.error(
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

      const emailContent = await this.buildEmailContent(composition);

      // Append to drafts folder
      const result = await wrapper.connection.append(folder, emailContent, [
        "\\Draft",
      ]);
      // append resolves false instead of throwing when the server refuses.
      if (!result) {
        throw new Error(`Server refused to save the draft to ${folder}`);
      }

      // Clear cache for the drafts folder
      this.clearFolderCache(folder);

      return {
        success: true,
        message: "Draft saved successfully",
        uid: result.uid,
      };
    } catch (error) {
      this.logger.error(
        "Error creating draft",
        {
          operation: "createDraft",
          service: "EmailService",
        },
        // Shape only: subject, body and addresses are mail content.
        {
          folder,
          recipients:
            composition.to.length +
            (composition.cc?.length ?? 0) +
            (composition.bcc?.length ?? 0),
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

  /**
   * Builds the RFC 5322 message with nodemailer, the same composer that sends
   * mail: encoded headers, CRLF lines, MIME structure (multipart/alternative
   * when there is both text and HTML) and a Message-ID on the account's
   * domain. Recipients go in as objects, so a crafted display name cannot add
   * recipients or headers. Bcc is kept, since a draft has to remember who it
   * is for.
   */
  private async buildEmailContent(
    composition: EmailComposition,
  ): Promise<Buffer> {
    const message = new MailComposer({
      from: this.sender,
      to: toMailAddresses(composition.to),
      cc: composition.cc && toMailAddresses(composition.cc),
      bcc: composition.bcc && toMailAddresses(composition.bcc),
      subject: composition.subject,
      text: composition.text,
      html: composition.html,
      // Without this the body's line breaks pass through as is, and the bodies
      // arrive LF-normalised from validation. IMAP APPEND stores the message
      // unchanged, and some servers reject bare LF.
      newline: "\r\n",
    }).compile();
    // MailComposer has no option for this; nodemailer's transports set it the
    // same way.
    message.keepBcc = true;

    return message.build();
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

  // Pool management methods
  getPoolMetrics() {
    return this.pool.getImapMetrics();
  }

  async createDirectory(
    name: string,
    parentPath = "",
  ): Promise<EmailOperationResult> {
    let wrapper: ImapConnectionWrapper | null = null;

    try {
      wrapper = await this.pool.acquire();

      // Servers differ ("/" or "."), so a nested path is passed as parts for
      // imapflow to join with the server's own delimiter.
      const folderPath = parentPath ? [parentPath, name] : name;

      // Create the folder using IMAP CREATE command
      const created = await wrapper.connection.mailboxCreate(folderPath);
      // imapflow answers ALREADYEXISTS with created: false instead of throwing.
      if (created && created.created === false) {
        return {
          success: false,
          message: `Failed to create directory: '${created.path}' already exists`,
        };
      }
      // Otherwise get_folders keeps serving the old list for up to 15 minutes.
      this.cache.delete(FOLDERS_CACHE_KEY);

      return {
        success: true,
        message: `Directory '${name}' created successfully`,
      };
    } catch (error) {
      this.logger.error(
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
