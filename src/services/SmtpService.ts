import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import type {
  EmailComposition,
  EmailOperationResult,
  SmtpConnection,
} from "../types/email.types.js";

export class SmtpService {
  private connection: SmtpConnection;
  private transporter?: Transporter;

  constructor(connection: SmtpConnection) {
    this.connection = connection;
  }

  private async getTransporter(): Promise<Transporter> {
    if (!this.transporter) {
      this.transporter = nodemailer.createTransport({
        host: this.connection.host,
        port: this.connection.port,
        secure: this.connection.secure,
        auth: {
          user: this.connection.user,
          pass: this.connection.password,
        },
        tls: {
          rejectUnauthorized: false,
        },
      });
    }
    return this.transporter!;
  }

  async sendEmail(
    composition: EmailComposition,
  ): Promise<EmailOperationResult> {
    try {
      const transporter = await this.getTransporter();

      const mailOptions = {
        from: {
          name: this.extractNameFromEmail(this.connection.user),
          address: this.connection.user,
        },
        to: this.formatAddresses(composition.to),
        cc: composition.cc ? this.formatAddresses(composition.cc) : undefined,
        bcc: composition.bcc
          ? this.formatAddresses(composition.bcc)
          : undefined,
        subject: composition.subject,
        text: composition.text,
        html: composition.html,
        attachments: composition.attachments?.map((att) => ({
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
      console.error("Failed to send email:", error);
      return {
        success: false,
        message: `Failed to send email: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  async verifyConnection(): Promise<boolean> {
    try {
      const transporter = await this.getTransporter();
      await transporter.verify();
      return true;
    } catch (error) {
      console.error("SMTP connection verification failed:", error);
      return false;
    }
  }

  private formatAddresses(
    addresses: Array<{ name?: string; address: string }>,
  ): string {
    return addresses
      .map((addr) => {
        if (addr.name) {
          return `"${addr.name}" <${addr.address}>`;
        }
        return addr.address;
      })
      .join(", ");
  }

  private extractNameFromEmail(email: string): string {
    const localPart = email.split("@")[0];
    return localPart
      .split(/[._-]/)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
  }

  async close(): Promise<void> {
    if (this.transporter) {
      this.transporter.close();
      this.transporter = undefined;
    }
  }
}
