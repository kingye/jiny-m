/**
 * Channel adapter registry.
 *
 * Provides lookup of inbound and outbound adapters by channel type.
 * Used by MessageRouter (to delegate matching/naming) and ThreadManager
 * (for fallback reply sending) and MCP reply-tool (to find the right
 * outbound adapter for a reply).
 */

import type { ChannelType, InboundAdapter, OutboundAdapter } from './types';
import { logger } from '../core/logger';

export class ChannelRegistry {
  private inboundAdapters = new Map<ChannelType, InboundAdapter>();
  private outboundAdapters = new Map<ChannelType, OutboundAdapter>();

  /**
   * Register an inbound adapter for a channel type.
   * Only one adapter per channel type is allowed.
   */
  registerInbound(adapter: InboundAdapter): void {
    if (this.inboundAdapters.has(adapter.channelType)) {
      logger.warn('Replacing existing inbound adapter', { channel: adapter.channelType });
    }
    this.inboundAdapters.set(adapter.channelType, adapter);
    logger.info('Inbound adapter registered', { channel: adapter.channelType });
  }

  /**
   * Register an outbound adapter for a channel type.
   */
  registerOutbound(adapter: OutboundAdapter): void {
    if (this.outboundAdapters.has(adapter.channelType)) {
      logger.warn('Replacing existing outbound adapter', { channel: adapter.channelType });
    }
    this.outboundAdapters.set(adapter.channelType, adapter);
    logger.info('Outbound adapter registered', { channel: adapter.channelType });
  }

  /**
   * Get the inbound adapter for a channel type.
   * Throws if not registered.
   */
  getInbound(channel: ChannelType): InboundAdapter {
    const adapter = this.inboundAdapters.get(channel);
    if (!adapter) {
      throw new Error(`No inbound adapter registered for channel: ${channel}`);
    }
    return adapter;
  }

  /**
   * Get the outbound adapter for a channel type.
   * Throws if not registered.
   */
  getOutbound(channel: ChannelType): OutboundAdapter {
    const adapter = this.outboundAdapters.get(channel);
    if (!adapter) {
      throw new Error(`No outbound adapter registered for channel: ${channel}`);
    }
    return adapter;
  }

  /**
   * Get all registered inbound adapters.
   */
  getAllInbound(): InboundAdapter[] {
    return Array.from(this.inboundAdapters.values());
  }

  /**
   * Get all registered outbound adapters.
   */
  getAllOutbound(): OutboundAdapter[] {
    return Array.from(this.outboundAdapters.values());
  }

  /**
   * Check if an inbound adapter is registered for a channel type.
   */
  hasInbound(channel: ChannelType): boolean {
    return this.inboundAdapters.has(channel);
  }

  /**
   * Check if an outbound adapter is registered for a channel type.
   */
  hasOutbound(channel: ChannelType): boolean {
    return this.outboundAdapters.has(channel);
  }
}
