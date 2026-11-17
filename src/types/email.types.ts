export interface EmailSearchOptions {
  query?: string;
  folder?: string;
  since?: Date;
  before?: Date;
  limit?: number;
  offset?: number;
  /** Filter by \Seen flag: true = seen/read, false = unseen/unread */
  seen?: boolean;
  /** Filter by \Answered flag: true = replied, false = not replied */
  answered?: boolean;
  /** Filter by \Flagged flag: true = flagged/starred, false = not flagged */
  flagged?: boolean;
  /** Filter by \Draft flag: true = drafts, false = not drafts */
  draft?: boolean;
  /** Filter by \Deleted flag: true = deleted, false = not deleted */
  deleted?: boolean;
}

/**
 * A page of search results plus the size of the full match set, so callers can
 * tell "these are all of them" from "this is the first 50 of 800".
 */
export interface EmailSearchResult {
  messages: EmailMessage[];
  /** How many messages matched, before pagination. */
  total: number;
}

export interface EmailMessage {
  id: string;
  uid: number;
  subject: string;
  from: Array<{
    name?: string;
    address: string;
  }>;
  to: Array<{
    name?: string;
    address: string;
  }>;
  cc?: Array<{
    name?: string;
    address: string;
  }>;
  bcc?: Array<{
    name?: string;
    address: string;
  }>;
  /**
   * The Date header, else the server's arrival date; null when neither is
   * usable rather than a made-up one.
   */
  date: Date | null;
  text?: string;
  html?: string;
  attachments?: Array<{
    filename: string;
    contentType: string;
    size: number;
    contentId?: string;
  }>;
  flags: string[];
  folder: string;
}

export interface EmailThread {
  threadId: string;
  messages: EmailMessage[];
  subject: string;
  participants: Array<{
    name?: string;
    address: string;
  }>;
  /** Date of the newest dated message; null when none has a date. */
  lastActivity: Date | null;
}

export interface ImapConnection {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
}

export interface SmtpConnection {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
}

export interface EmailComposition {
  to: Array<{ name?: string; address: string }>;
  cc?: Array<{ name?: string; address: string }>;
  bcc?: Array<{ name?: string; address: string }>;
  subject: string;
  text?: string;
  html?: string;
  attachments?: Array<{
    filename: string;
    content: Buffer | string;
    contentType?: string;
  }>;
}

export interface EmailFolder {
  name: string;
  path: string;
  delimiter: string;
  flags: string[];
  specialUse?: string;
}

export interface EmailOperationResult {
  success: boolean;
  message: string;
  messageId?: string;
  uid?: number;
}
