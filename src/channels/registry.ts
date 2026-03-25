/**
 * Channel adapter registry.
 *
 * Provides lookup of inbound and outbound adapters by channel name.
 * Used by MessageRouter (to delegate matching/naming) and ThreadManager
 * (for fallback reply sending) and MCP reply-tool (to find the right
 * outbound adapter for a reply).
 */

import type { ChannelType, InboundAdapter, OutboundAdapter } from './types';
import { logger } from '../core/logger';

export class ChannelRegistry {
  private inboundAdapters = new Map<string, InboundAdapter>();
  private outboundAdapters = new Map<string, OutboundAdapter>();

  /**
   * Register an inbound adapter for a channel name.
   * Multiple adapters with different names allowed (e.g., work, personal).
   */
  registerInbound(adapter: InboundAdapter): void {
    if (this.inboundAdapters.has(adapter.channelName)) {
      logger.warn('Replacing existing inbound adapter', { channel: adapter.channelName });
    }
    this.inboundAdapters.set(adapter.channelName, adapter);
    logger.info('Inbound adapter registered', { channel: adapter.channelName, type: adapter.channelType });
  }

  /**
   * Register an outbound adapter for a channel name.
   */
  registerOutbound(adapter: OutboundAdapter): void {
    if (this.outboundAdapters.has(adapter.channelName)) {
      logger.warn('Replacing existing outbound adapter', { channel: adapter.channelName });
    }
    this.outboundAdapters.set(adapter.channelName, adapter);
    logger.info('Outbound adapter registered', { channel: adapter.channelName, type: adapter.channelType });
  }

  /**
   * Get the inbound adapter for a channel name.
   * Throws if not registered.
   */
  getInbound(channel: string): InboundAdapter {
    const adapter = this.inboundAdapters.get(channel);
    if (!adapter) {
      throw new Error(`No inbound adapter registered for channel: ${channel}`);
    }
    return adapter;
  }

  /**
   * Get the outbound adapter for a channel name.
   * Throws if not registered.
   */
  getOutbound(channel: string): OutboundAdapter {
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
   * Check if an inbound adapter is registered for a channel name.
   */
  hasInbound(channel: string): boolean {
    return this.inboundAdapters.has(channel);
  }

  /**
   * Check if an outbound adapter is registered for a channel name.
   */
  hasOutbound(channel: string): boolean {
    return this.outboundAdapters.has(channel);
  }

  /**
   * Get outbound adapter for a specific channel name.
   * Falls back to the first available outbound adapter if channel not found or not specified.
   */
  getOutboundWithFallback(channel?: string): OutboundAdapter | undefined {
    if (channel) {
      const adapter = this.outboundAdapters.get(channel);
      if (adapter) return adapter;
    }
    const all = Array.from(this.outboundAdapters.values());
    return all[0];
  }
}
