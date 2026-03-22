import nodemailer from 'nodemailer';
import type { SmtpConfig, Email } from '../../types';
import { logger } from '../../core/logger';
import { marked } from 'marked';

// Configure marked: preserve HTML tags and disable auto-linking.
// Auto-linking email addresses/URLs causes bracket nesting when the
// recipient's email client converts <a href="mailto:...">ADDR</a>
// back to plain text as "ADDR [addr]" — each round-trip adds a layer.
marked.use({
  renderer: {
    html(src) {
      return typeof src === 'string' ? src : String(src);
    },
    // Render auto-detected URLs/emails as plain text, not <a> tags
    link({ href, text }) {
      // If the link text matches the href (auto-linked), render as plain text
      const hrefClean = href.replace(/^mailto:/, '');
      if (text === href || text === hrefClean) {
        return text;
      }
      // For explicit markdown links [text](url), keep the <a> tag
      return `<a href="${href}">${text}</a>`;
    },
  },
  tokenizer: {
    // Disable auto-detection of URLs in text
    url(_src: string) {
      return undefined as any; // Return undefined to skip auto-linking
    },
  },
});

export interface ReplyOptions {
  to: string;
  subject: string;
  text: string;
  html?: string;
  inReplyTo?: string;
  references?: string[];
  messageId?: string;
  attachments?: Array<{
    filename: string;
    path: string;
    contentType: string;
  }>;
}

/** Options for sending a fresh (non-reply) email. */
export interface MailOptions {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export class SmtpService {
  private config: SmtpConfig;
  private transporter?: ReturnType<typeof nodemailer.createTransport>;

  constructor(config: SmtpConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    try {
      this.transporter = nodemailer.createTransport({
        host: this.config.host,
        port: this.config.port ?? 587,
        secure: this.config.tls,
        auth: {
          user: this.config.username,
          pass: this.config.password,
        },
      });

      await this.transporter.verify();
      logger.success('Connected to SMTP server', { host: this.config.host, user: this.config.username });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to connect to SMTP server', { error: errorMessage });
      throw new Error(`Failed to connect to SMTP server: ${errorMessage}`);
    }
  }

  async disconnect(): Promise<void> {
    if (this.transporter) {
      this.transporter.close();
      this.transporter = undefined;
    }
    logger.info('Disconnected from SMTP server');
  }

  async reconnect(): Promise<void> {
    logger.info('Attempting to reconnect to SMTP server...');
    await this.disconnect();
    await this.connect();
  }

  isConnected(): boolean {
    return this.transporter !== undefined;
  }

  sendReply(options: ReplyOptions): Promise<string> {
    return this.sendReplyInternal(options).catch(async (err) => {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      const lowerMsg = errorMessage.toLowerCase();
      const isConnectionError = lowerMsg.includes('connect') ||
                                lowerMsg.includes('econn') ||
                                lowerMsg.includes('timeout');

      if (!isConnectionError) {
        throw err;
      }

      logger.warn('Connection error sending reply, attempting reconnect and retry...', { error: errorMessage });

      try {
        await this.reconnect();
        return await this.sendReplyInternal(options);
      } catch (retryError) {
        const retryErrorMessage = retryError instanceof Error ? retryError.message : 'Unknown error';
        logger.error('Failed to send reply after reconnect', { error: retryErrorMessage });
        throw new Error(`Failed to send reply after reconnect: ${retryErrorMessage}`);
      }
    });
  }

  /**
   * Send a fresh (non-reply) email — no Re: prefix, no threading headers.
   * Used for alerts, notifications, and other outbound emails.
   */
  sendMail(options: MailOptions): Promise<string> {
    return this.sendMailInternal(options).catch(async (err) => {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      const lowerMsg = errorMessage.toLowerCase();
      const isConnectionError = lowerMsg.includes('connect') ||
                                lowerMsg.includes('econn') ||
                                lowerMsg.includes('timeout');

      if (!isConnectionError) {
        throw err;
      }

      logger.warn('Connection error sending mail, attempting reconnect and retry...', { error: errorMessage });

      try {
        await this.reconnect();
        return await this.sendMailInternal(options);
      } catch (retryError) {
        const retryErrorMessage = retryError instanceof Error ? retryError.message : 'Unknown error';
        logger.error('Failed to send mail after reconnect', { error: retryErrorMessage });
        throw new Error(`Failed to send mail after reconnect: ${retryErrorMessage}`);
      }
    });
  }

  private sendReplyInternal(options: ReplyOptions): Promise<string> {
    if (!this.transporter) {
      throw new Error('SMTP transporter not connected. Call connect() first.');
    }

    const toAddress = options.to;
    const replySubject = `Re: ${options.subject}`;

    const replyMessageId = `<${Date.now()}.reply@${this.config.host.split(':')[0]}>`;

    const headers: Record<string, string> = {};

    if (options.inReplyTo) {
      headers['In-Reply-To'] = options.inReplyTo;
    }

    if (options.references && options.references.length > 0) {
      const allReferences = [...options.references];
      if (options.messageId && !allReferences.includes(options.messageId)) {
        allReferences.push(options.messageId);
      }
      headers['References'] = allReferences.join(' ');
    } else if (options.messageId) {
      headers['References'] = options.messageId;
    }

    const mailOptions: any = {
      from: this.config.username,
      to: toAddress,
      subject: replySubject,
      text: options.text,
      html: options.html || this.markdownToHtml(options.text),
      messageId: replyMessageId,
      headers,
      attachments: options.attachments || [],
    };

    return new Promise<string>((resolve, reject) => {
      if (!this.transporter) {
        reject(new Error('SMTP transporter not connected'));
        return;
      }

      this.transporter.sendMail(mailOptions, (err: Error | null, info: nodemailer.SentMessageInfo) => {
        if (err) {
          logger.error('Failed to send reply', { error: err.message, to: toAddress });
          reject(new Error(`Failed to send reply: ${err.message}`));
          return;
        }

        logger.info('Reply sent successfully', {
          to: toAddress,
          messageId: replyMessageId,
          response: info.response,
        });
        resolve(replyMessageId);
      });
    });
  }

  private sendMailInternal(options: MailOptions): Promise<string> {
    if (!this.transporter) {
      throw new Error('SMTP transporter not connected. Call connect() first.');
    }

    const messageId = `<${Date.now()}.alert@${this.config.host.split(':')[0]}>`;

    const mailOptions: any = {
      from: this.config.username,
      to: options.to,
      subject: options.subject,
      text: options.text,
      html: options.html || this.markdownToHtml(options.text),
      messageId,
    };

    return new Promise<string>((resolve, reject) => {
      if (!this.transporter) {
        reject(new Error('SMTP transporter not connected'));
        return;
      }

      this.transporter.sendMail(mailOptions, (err: Error | null, info: nodemailer.SentMessageInfo) => {
        if (err) {
          logger.error('Failed to send mail', { error: err.message, to: options.to });
          reject(new Error(`Failed to send mail: ${err.message}`));
          return;
        }

        logger.info('Mail sent successfully', {
          to: options.to,
          subject: options.subject,
          messageId,
          response: info.response,
        });
        resolve(messageId);
      });
    });
  }

  /**
   * Reply to an email. Receives the full reply text (already includes quoted history).
   * Just adds threading headers and sends — no content transformation.
   */
  async replyToEmail(
    email: Email,
    replyText: string,
    attachments?: Array<{ filename: string; path: string; contentType: string }>
  ): Promise<string> {
    const toAddress = email.headers['reply-to'] || email.from;

    return this.sendReply({
      to: toAddress,
      subject: email.subject,
      text: replyText,
      inReplyTo: email.messageId,
      references: email.references,
      messageId: email.messageId,
      attachments: attachments || [],
    });
  }

  private markdownToHtml(markdown: string): string {
    const htmlBody = marked.parse(markdown, { async: false }) as string;
    return `
      <html>
        <head>
          <meta charset="UTF-8">
          <style>
            body {
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
              line-height: 1.6;
              color: #333;
              max-width: 600px;
              margin: 0 auto;
              padding: 20px;
              background: #f8f9fa;
            }
            .body-wrapper {
              background: white;
              padding: 24px;
              border-radius: 12px;
              box-shadow: 0 1px 3px rgba(0,0,0,0.1);
            }
            h2 {
              color: #1a1a1a;
              margin: 16px 0 8px 0;
              font-size: 15px;
            }
            blockquote {
              margin: 16px 0;
            }
            blockquote p {
              color: #555;
              font-style: normal;
              font-size: 14px;
            }
            hr {
              border: none;
              border-top: 1px solid #e9ecef;
              margin: 20px 0;
            }
            pre {
              background: #f8f9fa;
              padding: 16px;
              border-radius: 8px;
              overflow-x: auto;
              font-size: 13px;
            }
            code {
              background: #f8f9fa;
              padding: 2px 8px;
              border-radius: 4px;
              font-size: 13px;
            }
          </style>
        </head>
        <body>
          <div class="body-wrapper">
            ${htmlBody}
          </div>
        </body>
      </html>
    `;
  }
}
