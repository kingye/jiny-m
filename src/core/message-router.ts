/**
 * Message Router — receives all inbound messages and dispatches to ThreadManager.
 *
 * For each message:
 * 1. Gets the inbound adapter for the message's channel
 * 2. Delegates pattern matching to the adapter (channel-specific rules)
 * 3. If matched, delegates thread name derivation to the adapter
 * 4. Enqueues to ThreadManager (fire-and-forget)
 *
 * If no pattern matches, the message is silently ignored (logged at debug level).
 */

import type {
  InboundMessage,
  ChannelPattern,
  PatternMatch,
} from '../channels/types';
import { ChannelRegistry } from '../channels/registry';
import { ThreadManager } from './thread-manager';
import { logger } from './logger';

export class MessageRouter {
  private channelRegistry: ChannelRegistry;
  private threadManager: ThreadManager;
  private patterns: ChannelPattern[];

  constructor(options: {
    channelRegistry: ChannelRegistry;
    threadManager: ThreadManager;
    patterns: ChannelPattern[];
  }) {
    this.channelRegistry = options.channelRegistry;
    this.threadManager = options.threadManager;
    this.patterns = options.patterns;
  }

  /**
   * Handle an inbound message from any channel.
   * This is called by inbound adapters via the onMessage callback.
   * Non-blocking: enqueues matched messages and returns immediately.
   */
  async handleMessage(message: InboundMessage): Promise<void> {
    try {
      // 1. Get the inbound adapter for this channel
      const adapter = this.channelRegistry.getInbound(message.channel);

      // 2. Delegate pattern matching to the channel adapter
      const channelPatterns = this.patterns.filter(p => p.channel === message.channel);
      const patternMatch = adapter.matchMessage(message, channelPatterns);

      if (!patternMatch) {
        logger.debug('No pattern matched, skipping', {
          channel: message.channel,
          sender: message.senderAddress,
          topic: message.topic.substring(0, 80),
        });
        return;
      }

      logger.info('Pattern matched', {
        pattern: patternMatch.patternName,
        channel: message.channel,
        sender: message.senderAddress,
        topic: message.topic.substring(0, 80),
      });

      // Mark the message with the matched pattern name
      message.matchedPattern = patternMatch.patternName;

      // 3. Derive thread name via the channel adapter
      const threadName = adapter.deriveThreadName(message, patternMatch);

      logger.debug('Thread name derived', {
        threadName,
        channel: message.channel,
      });

      // 4. Find the full pattern config (for attachment settings etc.)
      const pattern = this.patterns.find(
        p => p.name === patternMatch.patternName && p.channel === message.channel,
      );

      // 5. Enqueue to ThreadManager (fire-and-forget)
      this.threadManager.enqueue(message, threadName, patternMatch, pattern);

    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Error routing message', {
        channel: message.channel,
        sender: message.senderAddress,
        error: msg,
      });
    }
  }

  /**
   * Update the pattern list (e.g. after config reload).
   */
  updatePatterns(patterns: ChannelPattern[]): void {
    this.patterns = patterns;
    logger.info('Patterns updated', { count: patterns.length });
  }
}
