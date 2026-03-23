import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ChannelRegistry } from '../src/channels/registry';
import { EmailInboundAdapter } from '../src/channels/email/inbound';
import { EmailOutboundAdapter } from '../src/channels/email/outbound';
import { MessageStorage } from '../src/core/message-storage';
import { validateConfig } from '../src/config/schemas';

// ============================================================================
// ChannelRegistry: multi-channel support
// ============================================================================

describe('ChannelRegistry: multi-channel', () => {
  test('registers multiple inbound adapters with different names', () => {
    const registry = new ChannelRegistry();

    const work = new EmailInboundAdapter(
      'work',
      { host: 'imap.work.com', port: 993, username: 'w', password: 'w', tls: true },
      { checkInterval: 30000, maxRetries: 3 },
    );
    const personal = new EmailInboundAdapter(
      'personal',
      { host: 'imap.gmail.com', port: 993, username: 'p', password: 'p', tls: true },
      { checkInterval: 30000, maxRetries: 3 },
    );

    registry.registerInbound(work);
    registry.registerInbound(personal);

    expect(registry.getAllInbound().length).toBe(2);
    expect(registry.hasInbound('work')).toBe(true);
    expect(registry.hasInbound('personal')).toBe(true);
    expect(registry.getInbound('work').channelName).toBe('work');
    expect(registry.getInbound('personal').channelName).toBe('personal');
  });

  test('getInbound throws for unregistered channel', () => {
    const registry = new ChannelRegistry();
    expect(() => registry.getInbound('nonexistent')).toThrow('No inbound adapter');
  });

  test('registers multiple outbound adapters with different names', () => {
    const registry = new ChannelRegistry();

    const work = new EmailOutboundAdapter(
      'work',
      { host: 'smtp.work.com', port: 465, username: 'w', password: 'w', tls: true },
    );
    const personal = new EmailOutboundAdapter(
      'personal',
      { host: 'smtp.gmail.com', port: 465, username: 'p', password: 'p', tls: true },
    );

    registry.registerOutbound(work);
    registry.registerOutbound(personal);

    expect(registry.getAllOutbound().length).toBe(2);
    expect(registry.hasOutbound('work')).toBe(true);
    expect(registry.hasOutbound('personal')).toBe(true);
  });
});

// ============================================================================
// Config validation: multi-channel format
// ============================================================================

describe('Config validation: multi-channel', () => {
  test('validates multi-channel config with named channels', () => {
    const config = {
      channels: {
        work: {
          type: 'email',
          inbound: { host: 'imap.work.com', port: 993, username: 'w', password: 'w', tls: true },
          outbound: { host: 'smtp.work.com', port: 465, username: 'w', password: 'w', secure: true },
          workspace: 'work/workspace',
        },
        personal: {
          type: 'email',
          inbound: { host: 'imap.gmail.com', port: 993, username: 'p', password: 'p', tls: true },
          outbound: { host: 'smtp.gmail.com', port: 465, username: 'p', password: 'p', secure: true },
        },
      },
      patterns: [],
      reply: { enabled: false },
      output: { format: 'text', includeHeaders: false, includeAttachments: false },
      workspace: { folder: 'workspace' },
    };

    const result = validateConfig(config);
    expect(result.channels).toBeDefined();
    expect(Object.keys(result.channels!).length).toBe(2);
    expect(result.channels!['work']).toBeDefined();
    expect(result.channels!['personal']).toBeDefined();
    expect(result.channels!['work']!.workspace).toBe('work/workspace');
  });

  test('legacy single-channel config still works', () => {
    const config = {
      channels: {
        email: {
          inbound: { host: 'imap.example.com', port: 993, username: 'u', password: 'p', tls: true },
          outbound: { host: 'smtp.example.com', port: 465, username: 'u', password: 'p', secure: true },
        },
      },
      patterns: [],
      reply: { enabled: false },
      output: { format: 'text', includeHeaders: false, includeAttachments: false },
      workspace: { folder: 'workspace' },
    };

    const result = validateConfig(config);
    expect(result.channels).toBeDefined();
    expect(result.channels!['email']).toBeDefined();
  });

  test('legacy top-level imap/smtp config still works', () => {
    const config = {
      imap: { host: 'imap.example.com', port: 993, username: 'u', password: 'p', tls: true },
      smtp: { host: 'smtp.example.com', port: 465, username: 'u', password: 'p', secure: true },
      patterns: [],
      reply: { enabled: false },
      output: { format: 'text', includeHeaders: false, includeAttachments: false },
      workspace: { folder: 'workspace' },
    };

    const result = validateConfig(config);
    expect(result.channels).toBeDefined();
    expect(result.channels!['email']).toBeDefined();
  });
});

// ============================================================================
// MessageStorage: per-channel workspace
// ============================================================================

describe('MessageStorage: per-channel workspace', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `jiny-storage-test-${Date.now()}`);
    await mkdir(tempDir, { recursive: true });
    tempDir = await realpath(tempDir); // Resolve macOS /var -> /private/var
    process.chdir(tempDir);
  });

  afterEach(async () => {
    process.chdir('/');
    await rm(tempDir, { recursive: true, force: true });
  });

  test('setChannelWorkspace and getChannelWorkspace', () => {
    const storage = new MessageStorage({ folder: 'workspace' });
    storage.setChannelWorkspace('work', 'work/workspace');

    const workPath = storage.getChannelWorkspace('work');
    expect(workPath).toBe(join(tempDir, 'work/workspace'));
  });

  test('default workspace falls back to {channel}/workspace', () => {
    const storage = new MessageStorage({ folder: 'workspace' });

    const personalPath = storage.getChannelWorkspace('personal');
    expect(personalPath).toBe(join(tempDir, 'personal', 'workspace'));
  });

  test('getEffectiveWorkspace returns channel-specific when given channelName', () => {
    const storage = new MessageStorage({ folder: 'workspace' });
    storage.setChannelWorkspace('work', 'work/data');

    expect(storage.getEffectiveWorkspace('work')).toBe(join(tempDir, 'work/data'));
    expect(storage.getEffectiveWorkspace()).toBe(join(tempDir, 'workspace'));
  });
});
