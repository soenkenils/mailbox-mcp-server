export interface IMAPConfig {
  host: string;
  port: number;
  tls: boolean;
  user: string;
  password: string;
  authTimeout?: number;
  connTimeout?: number;
  keepalive?:
    | boolean
    | { interval?: number; idleInterval?: number; forceNoop?: boolean };
  tlsOptions?: Record<string, unknown>;
  socketTimeout?: number;
  smtpConfig?: SMTPConfig;
}

export interface SMTPConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
}

export interface EmailAddress {
  name: string;
  address: string;
}

export interface EmailAttachment {
  filename: string;
  contentType: string;
  size: number;
  contentId?: string;
  checksum?: string;
}

export interface EmailHeaders {
  messageId: string;
  inReplyTo?: string;
  references?: string[];
  date: Date;
  subject: string;
  from: EmailAddress[];
  to?: EmailAddress[];
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
  replyTo?: EmailAddress[];
}

export interface Email {
  uid: number;
  headers: EmailHeaders;
  text?: string;
  html?: string;
  textAsHtml?: string;
  attachments: EmailAttachment[];
  hasAttachments: boolean;
  flags: string[];
  internalDate: Date;
  size: number;
  threadId?: string;
}

export interface EmailSearchOptions {
  from?: string;
  to?: string;
  subject?: string;
  text?: string;
  since?: Date;
  before?: Date;
  hasAttachment?: boolean;
  flagged?: boolean;
  unread?: boolean;
  folder?: string;
  limit?: number;
  offset?: number;
}

export interface EmailFetchOptions {
  markAsRead?: boolean;
  headersOnly?: boolean;
  fetchAttachments?: boolean;
}

export interface Folder {
  name: string;
  delimiter: string;
  specialUse?: string[];
  flags: string[];
  readonly: boolean;
  attributes: string[];
  children?: Folder[];
}

export interface EmailMoveOptions {
  fromFolder: string;
  toFolder: string;
  uids: number[];
}

export interface EmailFlagOptions {
  folder: string;
  uids: number[];
  add?: string[];
  remove?: string[];
}

export interface SendEmailOptions {
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  subject: string;
  text?: string;
  html?: string;
  inReplyTo?: string;
  references?: string | string[];
  attachments?: Array<{
    filename: string;
    content: Buffer | string;
    contentType?: string;
    cid?: string;
  }>;
}

export interface EmailThread {
  threadId: string;
  subject: string;
  participants: EmailAddress[];
  messages: Email[];
  messageCount: number;
  lastActivity: Date;
  hasUnread: boolean;
}

export interface ReplyEmailOptions
  extends Omit<
    SendEmailOptions,
    "to" | "subject" | "inReplyTo" | "references"
  > {
  originalMessageId: string;
  replyToAll?: boolean;
}

export interface ForwardEmailOptions
  extends Omit<SendEmailOptions, "inReplyTo" | "references" | "subject"> {
  originalMessageId: string;
  includeAttachments?: boolean;
}
