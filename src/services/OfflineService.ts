import type { LocalCache } from "../types/cache.types.js";
import type {
  EmailFolder,
  EmailMessage,
  EmailSearchOptions,
} from "../types/email.types.js";
import { createLogger } from "./Logger.js";

export interface OfflineCapabilities {
  canSearchEmails: boolean;
  canGetEmail: boolean;
  canGetFolders: boolean;
  canAccessCachedData: boolean;
  lastSyncTime?: Date;
}

export class OfflineService {
  private logger = createLogger("OfflineService");

  constructor(private cache: LocalCache) {}

  getOfflineCapabilities(): OfflineCapabilities {
    const stats = this.cache.size();
    const hasData = stats > 0;

    return {
      canSearchEmails: hasData,
      canGetEmail: hasData,
      canGetFolders: hasData,
      canAccessCachedData: hasData,
      lastSyncTime: this.getLastSyncTime(),
    };
  }

  async searchEmailsOffline(
    options: EmailSearchOptions,
  ): Promise<EmailMessage[]> {
    // Try multiple cache keys that might contain relevant data
    const possibleKeys = this.generateSearchCacheKeys(options);

    for (const key of possibleKeys) {
      const cachedResults = this.cache.getStale<EmailMessage[]>(key);
      if (cachedResults) {
        await this.logger.info(
          `Found offline search results for query`,
          {
            operation: "searchOfflineEmails",
            service: "OfflineService",
          },
          { options },
        );
        return this.filterOfflineResults(cachedResults, options);
      }
    }

    await this.logger.info(
      `No offline search results found for query`,
      {
        operation: "searchOfflineEmails",
        service: "OfflineService",
      },
      { options },
    );
    return [];
  }

  async getEmailOffline(
    uid: number,
    folder = "INBOX",
  ): Promise<EmailMessage | null> {
    const cacheKey = `email:${folder}:${uid}`;
    const cachedEmail = this.cache.getStale<EmailMessage>(cacheKey);

    if (cachedEmail) {
      await this.logger.info(
        `Found offline email UID ${uid} in folder ${folder}`,
        {
          operation: "getOfflineEmail",
          service: "OfflineService",
        },
        { uid, folder },
      );
      return cachedEmail;
    }

    await this.logger.info(
      `No offline email found for UID ${uid} in folder ${folder}`,
      {
        operation: "getOfflineEmail",
        service: "OfflineService",
      },
      { uid, folder },
    );
    return null;
  }

  async getFoldersOffline(): Promise<EmailFolder[]> {
    const cacheKey = "email_folders";
    const cachedFolders = this.cache.getStale<EmailFolder[]>(cacheKey);

    if (cachedFolders) {
      await this.logger.info("Found offline folders list", {
        operation: "getOfflineFolders",
        service: "OfflineService",
      });
      return cachedFolders;
    }

    await this.logger.info(
      "No offline folders found, returning default folders",
      {
        operation: "getOfflineFolders",
        service: "OfflineService",
      },
    );
    return this.getDefaultFolders();
  }

  getCachedEmailsList(): Array<{
    uid: number;
    folder: string;
    subject: string;
    from: string;
  }> {
    const emailList: Array<{
      uid: number;
      folder: string;
      subject: string;
      from: string;
    }> = [];

    // This is a simple implementation - in a production system,
    // you'd want to maintain an index of cached emails
    // For now, we'll return an empty list as this would require
    // iterating through all cache keys

    return emailList;
  }

  getOfflineStats(): {
    cachedEmails: number;
    cachedSearches: number;
    totalCacheSize: number;
    oldestCacheEntry?: Date;
    newestCacheEntry?: Date;
  } {
    // Basic cache statistics
    const totalSize = this.cache.size();

    return {
      cachedEmails: 0, // Would need cache key enumeration
      cachedSearches: 0, // Would need cache key enumeration
      totalCacheSize: totalSize,
      oldestCacheEntry: undefined,
      newestCacheEntry: undefined,
    };
  }

  private generateSearchCacheKeys(options: EmailSearchOptions): string[] {
    const keys: string[] = [];

    // Generate possible cache keys for this search
    const baseKey = `email_search:${JSON.stringify(options)}`;
    keys.push(baseKey);

    // Try with different limit/offset combinations
    if (options.limit || options.offset) {
      const { limit, offset, ...optionsWithoutPaging } = options;
      keys.push(`email_search:${JSON.stringify(optionsWithoutPaging)}`);
    }

    // Try with just folder
    if (options.folder) {
      keys.push(`email_search:${JSON.stringify({ folder: options.folder })}`);
    }

    return keys;
  }

  private filterOfflineResults(
    results: EmailMessage[],
    options: EmailSearchOptions,
  ): EmailMessage[] {
    let filtered = [...results];

    // Apply client-side filtering since we're working with cached data
    if (options.query) {
      filtered = filtered.filter((email) =>
        this.matchesOfflineQuery(email, options.query!),
      );
    }

    if (options.since) {
      filtered = filtered.filter((email) => email.date >= options.since!);
    }

    if (options.before) {
      filtered = filtered.filter((email) => email.date <= options.before!);
    }

    // Apply pagination
    if (options.offset) {
      filtered = filtered.slice(options.offset);
    }

    if (options.limit) {
      filtered = filtered.slice(0, options.limit);
    }

    return filtered;
  }

  private matchesOfflineQuery(email: EmailMessage, query: string): boolean {
    const lowerQuery = query.toLowerCase();

    // Simple text matching
    return (
      email.subject.toLowerCase().includes(lowerQuery) ||
      email.from.some(
        (addr) =>
          addr.address.toLowerCase().includes(lowerQuery) ||
          addr.name?.toLowerCase().includes(lowerQuery),
      ) ||
      email.to.some(
        (addr) =>
          addr.address.toLowerCase().includes(lowerQuery) ||
          addr.name?.toLowerCase().includes(lowerQuery),
      ) ||
      (email.text?.toLowerCase().includes(lowerQuery) ?? false)
    );
  }

  private getLastSyncTime(): Date | undefined {
    // This would need to be tracked separately
    // For now, return undefined
    return undefined;
  }

  private getDefaultFolders(): EmailFolder[] {
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
}
