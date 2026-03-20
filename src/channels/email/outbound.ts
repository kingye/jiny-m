/**
 * Email outbound adapter.
 *
 * Wraps the existing SmtpService to implement the OutboundAdapter interface.
 * Converts InboundMessage back to the internal Email type for SmtpService.replyToEmail().
 */

import type {
  ChannelType,
  OutboundAdapter,
  InboundMessage,
} from '../types';
import type { SmtpConfig, Email } from '../../types';
import { SmtpService } from '../../services/smtp';
import { logger } from '../../core/logger';

export class EmailOutboundAdapter implements OutboundAdapter {
  readonly channelType: ChannelType = 'email';

  private smtpService: SmtpService;

  constructor(smtpConfig: SmtpConfig) {
    this.smtpService = new SmtpService(smtpConfig);
  }

  async connect(): Promise<void> {
    await this.smtpService.connect();
  }

  async disconnect(): Promise<void> {
    await this.smtpService.disconnect();
  }

  /**
   * Send a reply to the original email via SMTP.
   * Converts InboundMessage to Email for SmtpService.replyToEmail(),
   * which handles quoting, threading headers, and markdown→HTML conversion.
   */
  async sendReply(
    originalMessage: InboundMessage,
    replyText: string,
    attachments?: Array<{ filename: string; path: string; contentType: string }>,
  ): Promise<{ messageId: string }> {
    const email = this.inboundMessageToEmail(originalMessage);
    const messageId = await this.smtpService.replyToEmail(email, replyText, attachments);
    return { messageId };
  }

  /**
   * Send a fresh (non-reply) alert email.
   * Uses SmtpService.sendMail() — no Re: prefix, no threading headers.
   */
  async sendAlert(
    recipient: string,
    subject: string,
    body: string,
  ): Promise<{ messageId: string }> {
    const messageId = await this.smtpService.sendMail({
      to: recipient,
      subject,
      text: body,
    });
    return { messageId };
  }

  /**
   * Get the underlying SmtpService (for direct access when needed,
   * e.g. by the MCP reply tool which needs low-level control).
   */
  getSmtpService(): SmtpService {
    return this.smtpService;
  }

  /**
   * Convert an InboundMessage back to the internal Email type.
   * Uses channel metadata to reconstruct email-specific fields.
   */
  private inboundMessageToEmail(msg: InboundMessage): Email {
    const metadata = msg.metadata || {};

    // Reconstruct the "from" field — prefer the original From header from metadata
    const from = metadata.from || msg.senderAddress;

    // Reconstruct reply-to from metadata headers
    const headers: Record<string, string> = {};
    if (metadata.headers) {
      Object.assign(headers, metadata.headers);
    }
    // If the sender address differs from the recipients, add reply-to
    if (!headers['reply-to'] && msg.recipients.length > 0) {
      const recipientAddress = msg.recipients[0];
      if (recipientAddress && recipientAddress !== from) {
        headers['reply-to'] = from;
      }
    }

    return {
      id: msg.id,
      uid: parseInt(msg.channelUid, 10) || 0,
      from,
      to: msg.recipients,
      subject: msg.topic,
      date: msg.timestamp,
      body: {
        text: msg.content.text,
        html: msg.content.html,
      },
      headers,
      messageId: msg.externalId || metadata.messageId,
      inReplyTo: msg.replyToId || metadata.inReplyTo,
      references: msg.threadRefs || metadata.references,
      attachments: msg.attachments?.map(att => ({
        filename: att.filename,
        contentType: att.contentType,
        size: att.size,
        content: att.content,
        savedPath: att.savedPath,
      })),
    };
  }
}
