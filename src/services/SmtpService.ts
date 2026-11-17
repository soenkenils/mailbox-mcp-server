import type { Transporter } from "nodemailer";
import type {
  EmailComposition,
  EmailOperationResult,
  SmtpConnection,
} from "../types/email.types.js";
import {
  ConnectionError,
  EmailError,
  ErrorCode,
  type ErrorContext,
  ErrorUtils,
  ValidationError,
} from "../types/errors.js";
import { senderFor, toMailAddresses } from "../utils/mailAddresses.js";
import { createLogger } from "./Logger.js";
import {
  SmtpConnectionPool,
  type SmtpConnectionWrapper,
  type SmtpPoolConfig,
} from "./SmtpConnectionPool.js";

// Connection-level error types nodemailer sets as `code`: its transient
// errors (ECONNECTION, ESOCKET, ETIMEDOUT, see isTransientError) plus a failed
// DNS lookup. nodemailer replaces the system errno with these and keeps the
// errno in `originalCode`.
const CONNECTION_ERROR_CODES = new Set([
  "ECONNECTION",
  "ESOCKET",
  "ETIMEDOUT",
  "EDNS",
]);

// Raw system errnos, as found in `originalCode` (or in `code` of an error
// that did not pass through nodemailer)
const SYSTEM_NETWORK_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "ETIMEDOUT",
]);

// True when the error means the pooled connection is no longer usable, e.g.
// after a VPN or network change
function isNetworkError(error: unknown): boolean {
  const { code, originalCode } =
    (error as { code?: unknown; originalCode?: unknown } | null) ?? {};
  return (
    (typeof code === "string" &&
      (CONNECTION_ERROR_CODES.has(code) ||
        SYSTEM_NETWORK_ERROR_CODES.has(code))) ||
    (typeof originalCode === "string" &&
      SYSTEM_NETWORK_ERROR_CODES.has(originalCode))
  );
}

// Replaces anything shaped like an email address, so a server's reply that
// quotes a recipient does not carry it into the logs.
function redactAddresses(text: string): string {
  return text.replace(/[^\s<>"'@,;:]+@[^\s<>"',;]+/g, "[address]");
}

export class SmtpService {
  private pool: SmtpConnectionPool;
  private logger = createLogger("SmtpService");

  constructor(
    connection: SmtpConnection,
    poolConfig: Omit<SmtpPoolConfig, "connectionConfig">,
  ) {
    this.pool = new SmtpConnectionPool({
      ...poolConfig,
      connectionConfig: connection,
    });
  }

  async sendEmail(
    composition: EmailComposition,
  ): Promise<EmailOperationResult> {
    let wrapper: SmtpConnectionWrapper | null = null;

    try {
      wrapper = await this.pool.acquire();
      const transporter = wrapper.connection;

      const mailOptions = {
        from: senderFor(this.pool.connectionConfig.user),
        to: toMailAddresses(composition.to),
        cc: composition.cc && toMailAddresses(composition.cc),
        bcc: composition.bcc && toMailAddresses(composition.bcc),
        subject: composition.subject,
        text: composition.text,
        html: composition.html,
        attachments: composition.attachments?.map(att => ({
          filename: att.filename,
          content: att.content,
          contentType: att.contentType,
        })),
      };

      const info = await transporter.sendMail(mailOptions);

      return {
        success: true,
        message: "Email sent successfully",
        messageId: info.messageId,
      };
    } catch (error) {
      if (wrapper && isNetworkError(error)) {
        wrapper.isHealthy = false;
      }
      // Shape only: the logger forwards to stderr and to the MCP client's log
      // stream, and recipients, subject and body are the user's mail.
      const { code, responseCode } =
        (error as { code?: unknown; responseCode?: unknown } | null) ?? {};
      await this.logger.error(
        "Failed to send email",
        {
          operation: "sendEmail",
          service: "SmtpService",
        },
        {
          recipients:
            composition.to.length +
            (composition.cc?.length ?? 0) +
            (composition.bcc?.length ?? 0),
          subjectLength: composition.subject.length,
          hasText: Boolean(composition.text),
          hasHtml: Boolean(composition.html),
          attachments: composition.attachments?.length ?? 0,
          code,
          responseCode,
          // A rejection names the refused recipient, e.g. "550 <bob@x>: ..."
          error: redactAddresses(
            error instanceof Error ? error.message : String(error),
          ),
        },
      );
      return {
        success: false,
        message: `Failed to send email: ${error instanceof Error ? error.message : String(error)}`,
      };
    } finally {
      if (wrapper) {
        await this.pool.release(wrapper);
      }
    }
  }

  async verifyConnection(): Promise<boolean> {
    let wrapper: SmtpConnectionWrapper | null = null;

    try {
      wrapper = await this.pool.acquire();
      await wrapper.connection.verify();
      return true;
    } catch (error) {
      if (wrapper && isNetworkError(error)) {
        wrapper.isHealthy = false;
      }
      await this.logger.error(
        "SMTP connection verification failed",
        {
          operation: "verifyConnection",
          service: "SmtpService",
        },
        { error: error instanceof Error ? error.message : String(error) },
      );
      return false;
    } finally {
      if (wrapper) {
        await this.pool.release(wrapper);
      }
    }
  }

  async close(): Promise<void> {
    await this.pool.destroy();
  }

  // Pool management methods
  getPoolMetrics() {
    return this.pool.getSmtpMetrics();
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
        "Error checking SMTP pool health",
        {
          operation: "isHealthy",
          service: "SmtpService",
        },
        { error: error instanceof Error ? error.message : String(error) },
      );
      return false;
    }
  }

  async verifyAllPoolConnections(): Promise<{
    verified: number;
    failed: number;
  }> {
    return await this.pool.verifyAllConnections();
  }
}
