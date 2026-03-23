/**
 * Email inbound adapter.
 *
 * Wraps the existing EmailMonitor (IMAP) and provides:
 * - Email-specific pattern matching (sender, subject)
 * - Email-specific thread name derivation (strip reply prefixes, subject prefixes)
 * - Conversion from internal Email type to InboundMessage
 */

import type {
  ChannelType,
  InboundAdapter,
  InboundAdapterOptions,
  InboundMessage,
  ChannelPattern,
  PatternMatch,
  MessageAttachment,
} from '../types';
import type { ImapConfig, WatchConfig, Email, Pattern, OutputConfig } from '../../types';
import { EmailMonitor } from '../../services/imap/monitor';
import { logger } from '../../core/logger';
import { extractDomain, validateRegex, stripReplyPrefix } from '../../utils/helpers';
import { sanitizeForFilename, deriveThreadName, cleanEmailBody } from '../../core/email-parser';

/**
 * Email-specific matching rules within a ChannelPattern.
 */
interface EmailRules {
  sender?: {
    exact?: string[];
    domain?: string[];
    regex?: string;
  };
  subject?: {
    prefix?: string[];
    regex?: string;
  };
  caseSensitive?: boolean;
}

export class EmailInboundAdapter implements InboundAdapter {
  readonly channelType: ChannelType = 'email';
  readonly channelName: string;

  private imapConfig: ImapConfig;
  private watchConfig: WatchConfig;
  private outputConfig: OutputConfig;
  private monitor: EmailMonitor | null = null;
  private verbose: boolean;
  private debug: boolean;

  constructor(
    channelName: string,
    imapConfig: ImapConfig,
    watchConfig: WatchConfig,
    options?: { outputConfig?: OutputConfig; verbose?: boolean; debug?: boolean },
  ) {
    this.channelName = channelName;
    this.imapConfig = imapConfig;
    this.watchConfig = watchConfig;
    this.outputConfig = options?.outputConfig || { format: 'text', includeHeaders: false, includeAttachments: true };
    this.verbose = options?.verbose || false;
    this.debug = options?.debug || false;
  }

  /**
   * Derive thread name from an email message.
   * Strips reply prefixes (Re:, Fwd:, 回复:) and configured subject prefixes.
   */
  deriveThreadName(message: InboundMessage, patternMatch?: PatternMatch): string {
    const additionalPrefixes = patternMatch?.matches?.subject?.prefix
      ? [patternMatch.matches.subject.prefix]
      : undefined;

    const threadName = deriveThreadName(message.topic, additionalPrefixes);
    return sanitizeForFilename(threadName);
  }

  /**
   * Match a message against email-specific pattern rules.
   * Rules: sender (exact, domain, regex) + subject (prefix, regex).
   */
  matchMessage(message: InboundMessage, patterns: ChannelPattern[]): PatternMatch | null {
    const emailPatterns = patterns.filter(p => p.channel === 'email' && p.enabled !== false);

    for (const pattern of emailPatterns) {
      const rules = pattern.rules as EmailRules;
      const caseSensitive = rules.caseSensitive ?? false;
      const matches: Record<string, any> = {};

      // Match sender
      const senderMatch = this.matchSender(message.senderAddress, rules.sender, caseSensitive);
      if (senderMatch) {
        matches.sender = senderMatch;
      }

      // Match subject/topic
      const subjectMatch = this.matchSubject(message.topic, rules.subject, caseSensitive);
      if (subjectMatch) {
        matches.subject = subjectMatch;
      }

      // Both conditions must be met (if specified)
      const senderConditionMet = rules.sender ? !!senderMatch : true;
      const subjectConditionMet = rules.subject ? !!subjectMatch : true;

      if (senderConditionMet && subjectConditionMet) {
        return {
          patternName: pattern.name,
          channel: this.channelName,
          matches,
        };
      }
    }

    return null;
  }

  /**
   * Start monitoring IMAP inbox.
   * Calls onMessage for ALL received emails (router handles pattern filtering).
   */
  async start(options: InboundAdapterOptions): Promise<void> {
    // Create a "match-all" pattern so the monitor delivers every email to us
    const catchAllPattern: Pattern = {
      name: '__catch_all__',
      sender: { regex: '.*' },
      enabled: true,
    };

    this.monitor = new EmailMonitor(
      this.imapConfig,
      this.watchConfig,
      [catchAllPattern],
      this.outputConfig,
      this.watchConfig.folder || 'INBOX',
      this.verbose,
      this.debug,
    );

    await this.monitor.start({
      once: false,
      useIdle: this.watchConfig.useIdle !== false,
      verbose: this.verbose,
      onMatch: async (email: Email, _patternMatch: any) => {
        try {
          const message = this.emailToInboundMessage(email);
          await options.onMessage(message);
        } catch (error) {
          const msg = error instanceof Error ? error.message : 'Unknown error';
          logger.error('Error converting email to InboundMessage', { error: msg });
          options.onError(error instanceof Error ? error : new Error(msg));
        }
      },
      onError: (error: Error) => {
        options.onError(error);
      },
    });
  }

  async stop(): Promise<void> {
    if (this.monitor) {
      this.monitor.stop();
      this.monitor = null;
    }
  }

  /**
   * Convert an internal Email to a channel-agnostic InboundMessage.
   */
  private emailToInboundMessage(email: Email): InboundMessage {
    // Extract sender display name and address
    let sender = email.from || 'Unknown';
    let senderAddress = email.from || '';
    if (sender.includes('<')) {
      const parts = sender.split('<');
      sender = parts[0]?.trim().replace(/['"]/g, '') || sender;
      senderAddress = parts[1]?.replace('>', '').trim() || senderAddress;
    }

    // Convert attachments
    const attachments: MessageAttachment[] | undefined = email.attachments?.map(att => ({
      filename: att.filename,
      contentType: att.contentType,
      size: att.size,
      content: att.content,
      savedPath: att.savedPath,
    }));

    return {
      id: email.id || `email-${email.uid}`,
      channel: this.channelName,
      channelUid: String(email.uid),
      sender,
      senderAddress,
      recipients: email.to || [],
      topic: stripReplyPrefix(email.subject || '(no subject)'),
      content: {
        text: cleanEmailBody(email.body.text || ''),
        html: email.body.html,
      },
      timestamp: email.date,
      threadRefs: email.references,
      replyToId: email.inReplyTo,
      externalId: email.messageId,
      attachments,
      metadata: {
        headers: email.headers,
        messageId: email.messageId,
        inReplyTo: email.inReplyTo,
        references: email.references,
        from: email.from, // Original From header (for reply quoting)
      },
      matchedPattern: email.matchedPattern,
    };
  }

  // ---- Private matching methods (ported from PatternMatcher) ----

  private matchSender(
    senderAddress: string,
    senderRules?: EmailRules['sender'],
    caseSensitive: boolean = false,
  ): Record<string, any> | null {
    if (!senderRules) return null;

    const normalized = caseSensitive ? senderAddress : senderAddress.toLowerCase();

    // Regex match
    if (senderRules.regex && validateRegex(senderRules.regex)) {
      const regex = caseSensitive
        ? new RegExp(senderRules.regex)
        : new RegExp(senderRules.regex, 'i');
      if (regex.test(normalized)) {
        return { type: 'regex', value: senderRules.regex };
      }
    }

    // Exact match
    if (senderRules.exact && senderRules.exact.length > 0) {
      for (const exact of senderRules.exact) {
        const normalizedExact = caseSensitive ? exact : exact.toLowerCase();
        if (normalized === normalizedExact) {
          return { type: 'exact', value: exact };
        }
      }
    }

    // Domain match
    if (senderRules.domain && senderRules.domain.length > 0) {
      const domain = extractDomain(senderAddress);
      if (domain) {
        const normalizedDomain = caseSensitive ? domain : domain.toLowerCase();
        for (const patternDomain of senderRules.domain) {
          const normalizedPatternDomain = caseSensitive ? patternDomain : patternDomain.toLowerCase();
          if (normalizedDomain === normalizedPatternDomain) {
            return { type: 'domain', value: patternDomain };
          }
        }
      }
    }

    return null;
  }

  private matchSubject(
    topic: string,
    subjectRules?: EmailRules['subject'],
    caseSensitive: boolean = false,
  ): Record<string, any> | null {
    if (!subjectRules) return null;

    const strippedSubject = stripReplyPrefix(topic);
    const normalizedSubject = caseSensitive ? strippedSubject : strippedSubject.toLowerCase();

    const prefix = subjectRules.prefix;
    const regex = subjectRules.regex;

    if (!prefix && !regex) return null;

    // Check prefix
    let prefixMatched = false;
    let matchedPrefix: string | undefined;
    if (prefix && prefix.length > 0) {
      for (const pref of prefix) {
        const normalizedPrefix = caseSensitive ? pref : pref.toLowerCase();
        if (normalizedSubject.startsWith(normalizedPrefix)) {
          prefixMatched = true;
          matchedPrefix = pref;
          break;
        }
      }
    }

    // Check regex
    let regexMatched = false;
    if (regex && validateRegex(regex)) {
      const regexPattern = caseSensitive
        ? new RegExp(regex)
        : new RegExp(regex, 'i');
      const normalizedOriginal = caseSensitive ? topic : topic.toLowerCase();
      regexMatched = regexPattern.test(normalizedOriginal);
    }

    // AND logic: if both defined, both must match
    const needsPrefix = prefix && prefix.length > 0;
    const needsRegex = !!regex;

    if (needsPrefix && needsRegex && (!prefixMatched || !regexMatched)) return null;
    if (needsPrefix && !needsRegex && !prefixMatched) return null;
    if (!needsPrefix && needsRegex && !regexMatched) return null;

    const matches: Record<string, any> = {};
    if (prefixMatched && matchedPrefix) matches.prefix = matchedPrefix;
    if (regexMatched) matches.regex = regex;
    return matches;
  }
}
