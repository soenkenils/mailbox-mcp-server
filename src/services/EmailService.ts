import * as Imap from "imap";
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
  private imap?: Imap;

  constructor(connection: ImapConnection, cache: LocalCache) {
    this.connection = connection;
    this.cache = cache;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.imap = new (Imap as any)({
        user: this.connection.user,
        password: this.connection.password,
        host: this.connection.host,
        port: this.connection.port,
        tls: this.connection.secure,
        tlsOptions: { rejectUnauthorized: false },
      });

      this.imap!.once("ready", () => {
        resolve();
      });

      this.imap!.once("error", (err: Error) => {
        reject(err);
      });

      this.imap!.connect();
    });
  }

  async disconnect(): Promise<void> {
    if (this.imap) {
      this.imap.end();
    }
  }

  async searchEmails(options: EmailSearchOptions): Promise<EmailMessage[]> {
    const cacheKey = `email_search:${JSON.stringify(options)}`;
    const cached = this.cache.get<EmailMessage[]>(cacheKey);

    if (cached) {
      return cached;
    }

    if (!this.imap) {
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

    if (!this.imap) {
      await this.connect();
    }

    const message = await this.fetchEmailByUid(uid, folder);

    if (message) {
      this.cache.set(cacheKey, message, 600000); // 10 minutes TTL
    }

    return message;
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
    return new Promise((resolve, reject) => {
      if (!this.imap) {
        reject(new Error("IMAP connection not established"));
        return;
      }

      this.imap.openBox(folder, true, (err, box) => {
        if (err) {
          reject(err);
          return;
        }

        const searchCriteria = this.buildSearchCriteria(options);

        this.imap!.search(searchCriteria, (err, results) => {
          if (err) {
            reject(err);
            return;
          }

          if (!results || results.length === 0) {
            resolve([]);
            return;
          }

          const limitedResults = options.limit
            ? results.slice(
                options.offset || 0,
                (options.offset || 0) + options.limit,
              )
            : results.slice(options.offset || 0);

          const fetch = this.imap!.fetch(limitedResults, {
            bodies: "HEADER.FIELDS (FROM TO SUBJECT DATE MESSAGE-ID)",
            struct: true,
          });

          const messages: EmailMessage[] = [];

          fetch.on("message", (msg, seqno) => {
            let headers: any = {};
            let uid = 0;

            msg.on("body", (stream: any, info: any) => {
              simpleParser(stream as any, (err: any, parsed: ParsedMail) => {
                if (err) return;
                headers = parsed.headers;
              });
            });

            msg.once("attributes", (attrs) => {
              uid = attrs.uid;
            });

            msg.once("end", () => {
              const emailMessage = this.parseEmailMessage(headers, uid, folder);
              if (emailMessage) {
                messages.push(emailMessage);
              }
            });
          });

          fetch.once("error", (err) => {
            reject(err);
          });

          fetch.once("end", () => {
            resolve(
              messages.sort((a, b) => b.date.getTime() - a.date.getTime()),
            );
          });
        });
      });
    });
  }

  private async fetchEmailByUid(
    uid: number,
    folder: string,
  ): Promise<EmailMessage | null> {
    return new Promise((resolve, reject) => {
      if (!this.imap) {
        reject(new Error("IMAP connection not established"));
        return;
      }

      this.imap.openBox(folder, true, (err, box) => {
        if (err) {
          reject(err);
          return;
        }

        const fetch = this.imap!.fetch([uid], {
          bodies: "",
          struct: true,
        });

        let emailMessage: EmailMessage | null = null;

        fetch.on("message", (msg, seqno) => {
          let buffer = "";

          msg.on("body", (stream, info) => {
            stream.on("data", (chunk) => {
              buffer += chunk.toString();
            });

            stream.once("end", () => {
              simpleParser(buffer, (err, parsed) => {
                if (err) {
                  reject(err);
                  return;
                }

                emailMessage = this.parseFullEmailMessage(parsed, uid, folder);
              });
            });
          });

          msg.once("attributes", (attrs) => {
            // Additional attributes handling if needed
          });
        });

        fetch.once("error", (err) => {
          reject(err);
        });

        fetch.once("end", () => {
          resolve(emailMessage);
        });
      });
    });
  }

  private buildSearchCriteria(options: EmailSearchOptions): any[] {
    const criteria: any[] = ["ALL"];

    if (options.query) {
      criteria.push([
        "OR",
        ["SUBJECT", options.query],
        ["BODY", options.query],
      ]);
    }

    if (options.since) {
      criteria.push(["SINCE", options.since]);
    }

    if (options.before) {
      criteria.push(["BEFORE", options.before]);
    }

    return criteria.length === 1 ? criteria : [["AND", ...criteria.slice(1)]];
  }

  private parseEmailMessage(
    headers: any,
    uid: number,
    folder: string,
  ): EmailMessage | null {
    if (!headers.subject || !headers.from) {
      return null;
    }

    return {
      id: headers["message-id"]?.[0] || `${uid}@${folder}`,
      uid,
      subject: headers.subject?.[0] || "",
      from: this.parseAddresses(headers.from),
      to: this.parseAddresses(headers.to),
      cc: this.parseAddresses(headers.cc),
      date: new Date(headers.date?.[0] || Date.now()),
      flags: [],
      folder,
    };
  }

  private parseFullEmailMessage(
    parsed: ParsedMail,
    uid: number,
    folder: string,
  ): EmailMessage {
    return {
      id: parsed.messageId || `${uid}@${folder}`,
      uid,
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
      flags: [],
      folder,
    };
  }

  private parseAddresses(
    addresses: any,
  ): Array<{ name?: string; address: string }> {
    if (!addresses) return [];
    if (typeof addresses === "string") {
      return [{ address: addresses }];
    }
    if (Array.isArray(addresses)) {
      return addresses.map((addr) => ({
        name: addr.name,
        address: addr.address || addr,
      }));
    }
    return [];
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
