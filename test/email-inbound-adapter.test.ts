import { test, expect, describe } from 'bun:test';
import { EmailInboundAdapter } from '../src/channels/email/inbound';
import type { InboundMessage, ChannelPattern } from '../src/channels/types';

function makeMessage(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    id: 'test-1',
    channel: 'email',
    channelUid: '1',
    sender: 'Test User',
    senderAddress: 'test@example.com',
    recipients: ['jiny@example.com'],
    topic: 'Hello World',
    content: { text: 'Test body' },
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

// Minimal adapter instance (doesn't start IMAP, just uses matching/naming)
const adapter = new EmailInboundAdapter(
  { host: 'localhost', port: 993, username: 'test', password: 'test', tls: true },
  { checkInterval: 30000, maxRetries: 3 },
);

describe('EmailInboundAdapter.matchMessage', () => {
  test('no patterns returns null', () => {
    const msg = makeMessage();
    expect(adapter.matchMessage(msg, [])).toBeNull();
  });

  test('sender exact match (case-insensitive)', () => {
    const msg = makeMessage({ senderAddress: 'Qing.cheng@roedl.com' });
    const patterns = [makePattern({
      rules: { sender: { exact: ['qing.cheng@roedl.com'] } },
    })];
    const result = adapter.matchMessage(msg, patterns);
    expect(result).not.toBeNull();
    expect(result?.patternName).toBe('test-pattern');
    expect(result?.channel).toBe('email');
    expect(result?.matches.sender?.type).toBe('exact');
  });

  test('sender domain match', () => {
    const msg = makeMessage({ senderAddress: 'user@roedl.com' });
    const patterns = [makePattern({
      rules: { sender: { domain: ['roedl.com'] } },
    })];
    const result = adapter.matchMessage(msg, patterns);
    expect(result).not.toBeNull();
    expect(result?.matches.sender?.type).toBe('domain');
  });

  test('sender regex match', () => {
    const msg = makeMessage({ senderAddress: 'user@company.com' });
    const patterns = [makePattern({
      rules: { sender: { regex: '.*@company\\.com' } },
    })];
    const result = adapter.matchMessage(msg, patterns);
    expect(result).not.toBeNull();
    expect(result?.matches.sender?.type).toBe('regex');
  });

  test('subject prefix match', () => {
    const msg = makeMessage({ topic: 'Jiny: Test Task' });
    const patterns = [makePattern({
      rules: { subject: { prefix: ['jiny'] } },
    })];
    const result = adapter.matchMessage(msg, patterns);
    expect(result).not.toBeNull();
    expect(result?.matches.subject?.prefix).toBe('jiny');
  });

  test('subject prefix match with Re: prefix', () => {
    const msg = makeMessage({ topic: 'Re: Jiny: Test Task' });
    const patterns = [makePattern({
      rules: { subject: { prefix: ['jiny'] } },
    })];
    const result = adapter.matchMessage(msg, patterns);
    expect(result).not.toBeNull();
  });

  test('subject regex match', () => {
    const msg = makeMessage({ topic: '[URGENT] Server down' });
    const patterns = [makePattern({
      rules: { subject: { regex: '\\[URGENT\\]' } },
    })];
    const result = adapter.matchMessage(msg, patterns);
    expect(result).not.toBeNull();
    expect(result?.matches.subject?.regex).toBe('\\[URGENT\\]');
  });

  test('both sender and subject must match (AND logic)', () => {
    const msg = makeMessage({ senderAddress: 'user@roedl.com', topic: 'Jiny: Task' });
    const patterns = [makePattern({
      rules: {
        sender: { domain: ['roedl.com'] },
        subject: { prefix: ['jiny'] },
      },
    })];
    const result = adapter.matchMessage(msg, patterns);
    expect(result).not.toBeNull();
    expect(result?.matches.sender).toBeDefined();
    expect(result?.matches.subject).toBeDefined();
  });

  test('sender matches but subject does not → null', () => {
    const msg = makeMessage({ senderAddress: 'user@roedl.com', topic: 'Random Subject' });
    const patterns = [makePattern({
      rules: {
        sender: { domain: ['roedl.com'] },
        subject: { prefix: ['jiny'] },
      },
    })];
    expect(adapter.matchMessage(msg, patterns)).toBeNull();
  });

  test('filters patterns by channel', () => {
    const msg = makeMessage();
    const patterns = [
      makePattern({ channel: 'feishu', rules: { sender: { exact: ['test@example.com'] } } }),
      makePattern({ channel: 'email', rules: { sender: { exact: ['test@example.com'] } } }),
    ];
    const result = adapter.matchMessage(msg, patterns);
    expect(result).not.toBeNull();
    expect(result?.channel).toBe('email');
  });

  test('disabled patterns are skipped', () => {
    const msg = makeMessage({ senderAddress: 'test@example.com' });
    const patterns = [makePattern({
      enabled: false,
      rules: { sender: { exact: ['test@example.com'] } },
    })];
    expect(adapter.matchMessage(msg, patterns)).toBeNull();
  });
});

describe('EmailInboundAdapter.deriveThreadName', () => {
  test('strips Re: prefix', () => {
    const msg = makeMessage({ topic: 'Re: Hello World' });
    const name = adapter.deriveThreadName(msg);
    expect(name).toBe('Hello_World');
  });

  test('strips configured subject prefix', () => {
    const msg = makeMessage({ topic: 'Jiny: My Task' });
    const match = { patternName: 'test', channel: 'email' as const, matches: { subject: { prefix: 'jiny' } } };
    const name = adapter.deriveThreadName(msg, match);
    expect(name).toBe('My_Task');
  });

  test('strips prefix with dash separator', () => {
    const msg = makeMessage({ topic: 'Jiny - My Task' });
    const match = { patternName: 'test', channel: 'email' as const, matches: { subject: { prefix: 'jiny' } } };
    const name = adapter.deriveThreadName(msg, match);
    expect(name).toBe('My_Task');
  });

  test('strips nested Re: + prefix', () => {
    const msg = makeMessage({ topic: 'Re: Re: Jiny: Task' });
    const match = { patternName: 'test', channel: 'email' as const, matches: { subject: { prefix: 'jiny' } } };
    const name = adapter.deriveThreadName(msg, match);
    expect(name).toBe('Task');
  });

  test('returns untitled for empty subject', () => {
    const msg = makeMessage({ topic: '' });
    const name = adapter.deriveThreadName(msg);
    expect(name).toBe('untitled');
  });
});
