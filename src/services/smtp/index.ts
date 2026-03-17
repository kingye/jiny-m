import nodemailer from 'nodemailer';
import type { SmtpConfig, Email } from '../../types';
import { logger } from '../../core/logger';
import { marked } from 'marked';
import TurndownService from 'turndown';

const turndownService = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
});

// Configure marked to preserve HTML tags
marked.use({
  renderer: {
    html(src) {
      return typeof src === 'string' ? src : String(src);
    }
  }
});

export interface ReplyOptions {
  to: string;
  subject: string;
  text: string;
  html?: string;
  inReplyTo?: string;
  references?: string[];
  messageId?: string;
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

  sendReply(options: ReplyOptions): Promise<string> {
    if (!this.transporter) {
      throw new Error('SMTP transporter not connected. Call connect() first.');
    }

    const toAddress = options.to;
    const replySubject = options.subject.startsWith('Re:')
      ? options.subject
      : `Re: ${options.subject}`;

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

  async replyToEmail(email: Email, replyText: string): Promise<string> {
    const toAddress = email.headers['reply-to'] || email.from;
    
    const quotedOriginalEmail = this.quoteOriginalEmail(email);
    const fullReplyText = `${replyText}\n\n${quotedOriginalEmail}`;
    
    return this.sendReply({
      to: toAddress,
      subject: email.subject,
      text: fullReplyText,
      inReplyTo: email.messageId,
      references: email.references,
      messageId: email.messageId,
    });
  }

  private quoteOriginalEmail(email: Email): string {
    const lines: string[] = [];
    
    const timeStr = email.date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    let fromName = email.from || 'Unknown';
    if (fromName.includes('<')) {
      const parts = fromName.split('<');
      fromName = parts[0]?.trim().replace(/['"]/g, '') || fromName;
    }
    
    // Chat-style quoted message
    lines.push('---');
    lines.push(`### ${fromName} (${timeStr})`);
    lines.push('> ' + email.subject);
    lines.push('');
    
    if (email.body.text) {
      const quotedBody = email.body.text
        .split('\n')
        .map((line: string) => `> ${line}`)
        .join('\n');
      lines.push(quotedBody);
    } else if (email.body.html) {
      const quotedHtml = turndownService.turndown(email.body.html);
      const quotedBody = quotedHtml
        .split('\n')
        .map((line: string) => `> ${line}`)
        .join('\n');
      lines.push(quotedBody);
    }
    
    return lines.join('\n');
  }

  private markdownToHtml(markdown: string): string {
    const htmlBody = marked(markdown);
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
