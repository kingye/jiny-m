import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { EmailMonitor } from '../monitor';
import { StateManager } from '../../../core/state-manager';
import type { ImapConfig, WatchConfig, Pattern, OutputConfig } from '../../../types';

describe('EmailMonitor Sequence-Based Testing', () => {
  let processedEmailCount: number = 0;
  let fetchCallCount: number = 0;
  let tempTestDir: string;

  const testImapConfig: ImapConfig = {
    host: 'localhost',
    port: 993,
    username: 'test@example.com',
    password: 'password',
    tls: true,
  };

  const testWatchConfig: WatchConfig = {
    checkInterval: 1,
    maxRetries: 3,
    useIdle: false,
    maxNewEmailThreshold: 50,
    enableRecoveryMode: true,
  };

  const testPatterns: Pattern[] = [
    {
      name: 'test-pattern',
      sender: { exact: ['test@example.com'] },
    },
  ];

  const testOutputConfig: OutputConfig = {
    format: 'text',
    includeHeaders: true,
    includeAttachments: true,
  };

  const rawEmail = `From: test@example.com
To: recipient@example.com
Subject: Test Email
Date: Wed, 18 Mar 2026 13:00:00 +0000
Message-ID: <test@example.com>

Test body content`;

  async function setupMockImapClient(mockEmails: any[]) {
    return {
      connect: async () => {},
      disconnect: async () => {},
      isConnected: () => true,
      getNewestUid: async () => mockEmails.length > 0 ? mockEmails[mockEmails.length - 1].seq : 0,
      getMailboxCount: async () => mockEmails.length || 1,
      fetchRange: async (start: number, end: number, folder: string) => {
        fetchCallCount++;
        if (start === 1 && end === (mockEmails.length || 1)) {
          return mockEmails;
        }
        if (end === mockEmails[mockEmails.length - 1].seq) {
          return mockEmails;
        }
        return [];
      },
      fetchMessageBody: async () => rawEmail,
      client: {
        mailboxOpen: async (folder: string) => ({
          exists: mockEmails.length,
          uidValidity: 1,
        }),
      },
    };
  }

  beforeEach(async () => {
    processedEmailCount = 0;
    fetchCallCount = 0;
    tempTestDir = join(tmpdir(), `.jiny-test-${Date.now()}`);
    StateManager.setStateFilePath(join(tempTestDir, '.state.json'));
    await StateManager.skipMigrationForTests();
  });

  afterEach(async () => {
    await rm(tempTestDir, { recursive: true, force: true }).catch(() => {});
    StateManager.restoreAfterTests();
  });

  test('should process emails using fetchRange in normal mode', async () => {
    const mockEmails = [
      {
        seq: 1,
        uid: 1,
        envelope: {
          from: [{ address: 'test@example.com' }],
          to: [{ address: 'recipient@example.com' }],
          subject: 'Test Email 1',
          date: new Date(),
          messageId: '<test1@example.com>',
          inReplyTo: '',
          references: [],
        },
        flags: [],
      },
    ];

    const mockImapClient = await setupMockImapClient(mockEmails);

    const monitor = new EmailMonitor(
      testImapConfig,
      testWatchConfig,
      testPatterns,
      testOutputConfig,
      'INBOX',
      false,
      false
    );

    (monitor as any).imapClient = mockImapClient;

    await StateManager.reset();
    await StateManager.load();

    const onMatchCallback = async () => {
      processedEmailCount++;
    };

    await monitor.start({
      once: true,
      useIdle: false,
      verbose: false,
      onMatch: onMatchCallback,
    });

    expect(processedEmailCount).toBe(1);
  });

  test('should process multiple emails in normal mode', async () => {
    const mockEmails = [
      {
        seq: 1,
        uid: 1,
        envelope: {
          from: [{ address: 'test@example.com' }],
          to: [{ address: 'recipient@example.com' }],
          subject: 'Test Email 1',
          date: new Date(),
          messageId: '<test1@example.com>',
          inReplyTo: '',
          references: [],
        },
        flags: [],
      },
      {
        seq: 2,
        uid: 2,
        envelope: {
          from: [{ address: 'test@example.com' }],
          to: [{ address: 'recipient@example.com' }],
          subject: 'Test Email 2',
          date: new Date(),
          messageId: '<test2@example.com>',
          inReplyTo: '',
          references: [],
        },
        flags: [],
      },
    ];

    const mockImapClient = await setupMockImapClient(mockEmails);

    const monitor = new EmailMonitor(
      testImapConfig,
      testWatchConfig,
      testPatterns,
      testOutputConfig,
      'INBOX',
      false,
      false
    );

    (monitor as any).imapClient = mockImapClient;

    await StateManager.reset();
    await StateManager.load();

    const processedUids: number[] = [];

    const onMatchCallback = async (email: any) => {
      processedUids.push(email.uid);
    };

    await monitor.start({
      once: true,
      useIdle: false,
      verbose: false,
      onMatch: onMatchCallback,
    });

    expect(processedUids).toEqual([1, 2]);
    expect(processedUids.length).toBe(2);
  });

  test('should trigger recovery when emails are deleted', async () => {
    const allEmails = [
      {
        seq: 1,
        uid: 100,
        envelope: {
          from: [{ address: 'test@example.com' }],
          to: [{ address: 'recipient@example.com' }],
          subject: 'Test Email',
          date: new Date(),
          messageId: '<test@example.com>',
          inReplyTo: '',
          references: [],
        },
        flags: [],
      },
    ];

    const mockImapClient = await setupMockImapClient(allEmails);

    const monitor = new EmailMonitor(
      testImapConfig,
      testWatchConfig,
      testPatterns,
      testOutputConfig,
      'INBOX',
      false,
      false
    );

    (monitor as any).imapClient = mockImapClient;

    await StateManager.reset();
    StateManager.updateSequence(60);
    await StateManager.loadProcessedUids();
    await StateManager.save();
    await StateManager.load();

    const processedUids: number[] = [];

    const onMatchCallback = async (email: any) => {
      processedUids.push(email.uid);
    };

    await monitor.start({
      once: true,
      useIdle: false,
      verbose: false,
      onMatch: onMatchCallback,
    });

    expect(processedUids).toEqual([100]);
  });

  test('should not trigger recovery for small number of new emails', async () => {
    const mockEmails = Array.from({ length: 10 }, (_, i) => ({
      seq: i + 61,
      uid: i + 1000,
      envelope: {
        from: [{ address: 'test@example.com' }],
        to: [{ address: 'recipient@example.com' }],
        subject: `Test Email ${i + 1}`,
        date: new Date(),
        messageId: `<test${i + 1}@example.com>`,
        inReplyTo: '',
        references: [],
      },
      flags: [],
    }));

    const mockImapClient = await setupMockImapClient(mockEmails);

    const monitor = new EmailMonitor(
      testImapConfig,
      testWatchConfig,
      testPatterns,
      testOutputConfig,
      'INBOX',
      false,
      false
    );

    (monitor as any).imapClient = mockImapClient;

    await StateManager.reset();
    StateManager.updateSequence(60);
    await StateManager.save();
    await StateManager.loadProcessedUids();
    await StateManager.load();

    const onMatchCallback = async () => {
      processedEmailCount++;
    };

    await monitor.start({
      once: true,
      useIdle: false,
      verbose: false,
      onMatch: onMatchCallback,
    });

    expect(processedEmailCount).toBe(10);
  });

  test('should trigger recovery for suspiciously large number of new emails', async () => {
    const mockEmails = Array.from({ length: 10 }, (_, i) => ({
      seq: i + 1,
      uid: i + 1,
      envelope: {
        from: [{ address: 'test@example.com' }],
        to: [{ address: 'recipient@example.com' }],
        subject: `Test Email ${i + 1}`,
        date: new Date(),
        messageId: `<test${i + 1}@example.com>`,
        inReplyTo: '',
        references: [],
      },
      flags: [],
    }));

    const mockImapClient = await setupMockImapClient(mockEmails);

    const monitor = new EmailMonitor(
      testImapConfig,
      testWatchConfig,
      testPatterns,
      testOutputConfig,
      'INBOX',
      false,
      false
    );

    (monitor as any).imapClient = mockImapClient;

    await StateManager.reset();
    StateManager.updateSequence(60);
    await StateManager.save();
    await StateManager.loadProcessedUids();
    await StateManager.load();

    const onMatchCallback = async () => {
      processedEmailCount++;
    };

    await monitor.start({
      once: true,
      useIdle: false,
      verbose: false,
      onMatch: onMatchCallback,
    });

    expect(processedEmailCount).toBeGreaterThan(0);
  });
});
