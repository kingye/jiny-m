import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm } from 'node:fs/promises';
import { ThreadManager } from '../src/core/thread-manager';
import { MessageStorage } from '../src/core/message-storage';
import { ChannelRegistry } from '../src/channels/registry';
import type { InboundMessage, ChannelPattern, OutboundAdapter } from '../src/channels/types';

function makeMessage(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    id: 'test-1',
    channel: 'email',
    channelUid: '1',
    sender: 'Test User',
    senderAddress: 'test@example.com',
    recipients: ['jiny@example.com'],
    topic: 'Hello World',
    content: { text: '/model' },
    timestamp: new Date(),
    metadata: {},
    ...overrides,
  };
}

function makePattern(overrides: Partial<ChannelPattern> = {}): ChannelPattern {
  return {
    name: 'test-pattern',
    channel: 'email',
    rules: {},
    ...overrides,
  };
}

describe('ThreadManager command-only handling', () => {
  let workspaceDir: string;
  let sentReply: { message: InboundMessage; replyText: string } | null = null;

  beforeEach(async () => {
    workspaceDir = join(tmpdir(), `thread-manager-test-${Date.now()}`);
    await mkdir(workspaceDir, { recursive: true });
    sentReply = null;
  });

  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
  });

  test('should send direct reply for message containing only /model command', async () => {
    // Create a mock outbound adapter that captures sent replies
    const mockOutboundAdapter: OutboundAdapter = {
      channelType: 'email',
      channelName: 'email',
      connect: async () => {},
      disconnect: async () => {},
      sendReply: async (message, replyText) => {
        sentReply = { message, replyText };
        return { messageId: 'mock-id' };
      },
      sendAlert: async () => ({ messageId: 'alert-id' }),
    };

    const channelRegistry = new ChannelRegistry();
    channelRegistry.registerOutbound(mockOutboundAdapter);

    const storage = new MessageStorage({ folder: workspaceDir });
    const replyConfig = {
      enabled: true,
      mode: 'opencode' as const,
      opencode: undefined,
    };

    const manager = new ThreadManager({
      storage,
      opencode: undefined,
      channelRegistry,
      replyConfig,
    });

    // Enqueue a message with only /model command
    const message = makeMessage();
    const pattern = makePattern();
    manager.enqueue(message, 'test-thread', { pattern }, pattern);

    // Wait for async processing (worker runs asynchronously)
    await new Promise(resolve => setTimeout(resolve, 200));

    // Verify reply was sent via outbound adapter (command result)
    expect(sentReply).toBeDefined();
    expect(sentReply?.replyText).toContain('/model:');
    expect(sentReply?.replyText).toContain('model');
    // Should not contain the old system note
    expect(sentReply?.replyText).not.toContain('[System:');
  });

  test('should still invoke AI when message contains commands AND other text', async () => {
    // This test ensures that mixed content still triggers AI.
    // Since we can't easily mock OpenCodeService, we'll rely on the fact that
    // with opencode undefined and mode 'opencode', the system will skip AI
    // (but that's okay; we just want to verify the early-exit doesn't happen).
    // For simplicity, we'll just check that the reply is NOT sent immediately.
    // We'll set up a mock outbound adapter that records calls; if called, fail.
    let callCount = 0;
    const mockOutboundAdapter: OutboundAdapter = {
      channelType: 'email',
      channelName: 'email',
      connect: async () => {},
      disconnect: async () => {},
      sendReply: async () => {
        callCount++;
        return { messageId: 'mock-id' };
      },
      sendAlert: async () => ({ messageId: 'alert-id' }),
    };

    const channelRegistry = new ChannelRegistry();
    channelRegistry.registerOutbound(mockOutboundAdapter);
    const storage = new MessageStorage({ folder: workspaceDir });
    const replyConfig = {
      enabled: true,
      mode: 'opencode' as const,
      opencode: undefined,
    };

    const manager = new ThreadManager({
      storage,
      opencode: undefined,
      channelRegistry,
      replyConfig,
    });

    // Enqueue a message with command + regular text
    const message = makeMessage({ content: { text: '/model\n\nPlease help me.' } });
    const pattern = makePattern();
    manager.enqueue(message, 'test-thread', { pattern }, pattern);

    await new Promise(resolve => setTimeout(resolve, 200));

    // Since opencode is undefined and mode is opencode, no reply will be sent.
    // That's fine; we just want to ensure the early-exit didn't trigger.
    // We'll verify that sendReply was NOT called (callCount === 0).
    expect(callCount).toBe(0);
  });
});