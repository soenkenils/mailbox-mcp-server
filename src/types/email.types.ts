export interface EmailSearchOptions {
  query?: string;
  folder?: string;
  since?: Date;
  before?: Date;
  limit?: number;
  offset?: number;
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
  date: Date;
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
  lastActivity: Date;
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
