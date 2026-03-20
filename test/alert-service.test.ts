import { test, expect, describe, beforeEach, afterEach, mock } from 'bun:test';
import { AlertService, type QueueStatsProvider } from '../src/core/alert-service';
import { logger } from '../src/core/logger';
import type { AlertingConfig, OutboundAdapter, InboundMessage, ChannelType } from '../src/types';

/** Create a mock OutboundAdapter with a captured sendAlert spy. */
function createMockAdapter() {
  const sentAlerts: Array<{ recipient: string; subject: string; body: string }> = [];

  const adapter: OutboundAdapter = {
    channelType: 'email' as ChannelType,
    connect: async () => {},
    disconnect: async () => {},
    sendReply: async () => ({ messageId: 'mock-reply-id' }),
    sendAlert: async (recipient: string, subject: string, body: string) => {
      sentAlerts.push({ recipient, subject, body });
      return { messageId: `mock-alert-${sentAlerts.length}` };
    },
  };

  return { adapter, sentAlerts };
}

function defaultConfig(overrides?: Partial<AlertingConfig>): AlertingConfig {
  return {
    enabled: true,
    recipient: 'alerts@test.com',
    batchIntervalMinutes: 5,
    maxErrorsPerBatch: 50,
    subjectPrefix: 'Jiny-M Alert',
    includeReplyToolLog: false, // Disable for most tests (no filesystem)
    replyToolLogTailLines: 50,
    ...overrides,
  };
}

describe('AlertService', () => {
  let alertService: AlertService;
  let mockAdapter: ReturnType<typeof createMockAdapter>;

  beforeEach(() => {
    // Suppress console output during tests
    logger.setSilent(true);
    mockAdapter = createMockAdapter();
  });

  afterEach(async () => {
    if (alertService) {
      await alertService.stop();
    }
    logger.setSilent(false);
    // Remove all log listeners to avoid leaks between tests
    logger.removeAllListeners('log');
  });

  test('should start and subscribe to logger events', () => {
    alertService = new AlertService(mockAdapter.adapter, defaultConfig(), './workspace');
    expect(logger.listenerCount('log')).toBe(0);

    alertService.start();
    expect(logger.listenerCount('log')).toBe(1);
  });

  test('should stop and unsubscribe from logger events', async () => {
    alertService = new AlertService(mockAdapter.adapter, defaultConfig(), './workspace');
    alertService.start();
    expect(logger.listenerCount('log')).toBe(1);

    await alertService.stop();
    expect(logger.listenerCount('log')).toBe(0);
  });

  test('should buffer ERROR-level log events', async () => {
    alertService = new AlertService(mockAdapter.adapter, defaultConfig(), './workspace');
    alertService.start();

    // Trigger some errors
    logger.error('Test error 1', { thread: 'test-thread', channel: 'email' });
    logger.error('Test error 2', { thread: 'test-thread', channel: 'email' });

    // INFO/DEBUG/WARN should not be buffered
    logger.info('This should not be buffered');
    logger.warn('This should not be buffered either');
    logger.debug('Nor this');

    // Flush manually
    await alertService.flush();

    expect(mockAdapter.sentAlerts.length).toBe(1);
    const alert = mockAdapter.sentAlerts[0]!;
    expect(alert.recipient).toBe('alerts@test.com');
    expect(alert.subject).toContain('2 error(s)');
    expect(alert.body).toContain('Test error 1');
    expect(alert.body).toContain('Test error 2');
  });

  test('should not flush when buffer is empty', async () => {
    alertService = new AlertService(mockAdapter.adapter, defaultConfig(), './workspace');
    alertService.start();

    await alertService.flush();

    expect(mockAdapter.sentAlerts.length).toBe(0);
  });

  test('should include subject prefix in alert email', async () => {
    alertService = new AlertService(
      mockAdapter.adapter,
      defaultConfig({ subjectPrefix: 'CUSTOM ALERT' }),
      './workspace',
    );
    alertService.start();

    logger.error('Something failed');
    await alertService.flush();

    expect(mockAdapter.sentAlerts[0]!.subject).toStartWith('CUSTOM ALERT:');
  });

  test('should include thread name in alert body', async () => {
    alertService = new AlertService(mockAdapter.adapter, defaultConfig(), './workspace');
    alertService.start();

    logger.error('Failed to process message', { thread: 'my-thread', channel: 'email' });
    await alertService.flush();

    const body = mockAdapter.sentAlerts[0]!.body;
    expect(body).toContain('my-thread');
    expect(body).toContain('Failed to process message');
  });

  test('should include context lines in alert body', async () => {
    alertService = new AlertService(mockAdapter.adapter, defaultConfig(), './workspace');
    alertService.start();

    // Generate some context lines before the error
    logger.info('Step 1: connecting');
    logger.info('Step 2: authenticating');
    logger.info('Step 3: sending');
    logger.error('Step 4: SMTP failed', { thread: 'smtp-thread' });

    await alertService.flush();

    const body = mockAdapter.sentAlerts[0]!.body;
    expect(body).toContain('Context:');
    expect(body).toContain('Step 1: connecting');
    expect(body).toContain('Step 2: authenticating');
    expect(body).toContain('Step 3: sending');
  });

  test('should respect maxErrorsPerBatch limit', async () => {
    alertService = new AlertService(
      mockAdapter.adapter,
      defaultConfig({ maxErrorsPerBatch: 3 }),
      './workspace',
    );
    alertService.start();

    for (let i = 0; i < 5; i++) {
      logger.error(`Error ${i + 1}`);
    }

    await alertService.flush();

    const body = mockAdapter.sentAlerts[0]!.body;
    // Only first 3 errors should be included (buffer caps at maxErrorsPerBatch)
    expect(body).toContain('Error 1');
    expect(body).toContain('Error 2');
    expect(body).toContain('Error 3');
    expect(body).not.toContain('Error 4');
  });

  test('should skip self-generated log events (_alertInternal)', async () => {
    alertService = new AlertService(mockAdapter.adapter, defaultConfig(), './workspace');
    alertService.start();

    // This should NOT be buffered
    logger.error('Internal alert error', { _alertInternal: true });

    await alertService.flush();

    // Nothing should have been sent
    expect(mockAdapter.sentAlerts.length).toBe(0);
  });

  test('should clear buffer after flush', async () => {
    alertService = new AlertService(mockAdapter.adapter, defaultConfig(), './workspace');
    alertService.start();

    logger.error('Error 1');
    await alertService.flush();
    expect(mockAdapter.sentAlerts.length).toBe(1);

    // Second flush should not send anything (buffer cleared)
    await alertService.flush();
    expect(mockAdapter.sentAlerts.length).toBe(1);

    // New error triggers new alert
    logger.error('Error 2');
    await alertService.flush();
    expect(mockAdapter.sentAlerts.length).toBe(2);
  });

  test('should flush pending errors on stop', async () => {
    alertService = new AlertService(mockAdapter.adapter, defaultConfig(), './workspace');
    alertService.start();

    logger.error('Pending error before shutdown');

    await alertService.stop();

    expect(mockAdapter.sentAlerts.length).toBe(1);
    expect(mockAdapter.sentAlerts[0]!.body).toContain('Pending error before shutdown');
  });

  test('should not start twice', () => {
    alertService = new AlertService(mockAdapter.adapter, defaultConfig(), './workspace');
    alertService.start();
    alertService.start(); // Should be a no-op

    expect(logger.listenerCount('log')).toBe(1);
  });

  test('should handle adapter without sendAlert gracefully', async () => {
    const adapterWithoutAlert: OutboundAdapter = {
      channelType: 'email' as ChannelType,
      connect: async () => {},
      disconnect: async () => {},
      sendReply: async () => ({ messageId: 'mock-reply-id' }),
      // No sendAlert method
    };

    alertService = new AlertService(adapterWithoutAlert, defaultConfig(), './workspace');
    alertService.start();

    logger.error('Error with no sendAlert');

    // Should not throw
    await alertService.flush();
  });

  test('should group errors by thread in alert body', async () => {
    alertService = new AlertService(mockAdapter.adapter, defaultConfig(), './workspace');
    alertService.start();

    logger.error('Error in thread A', { thread: 'thread-A' });
    logger.error('Error in thread B', { thread: 'thread-B' });
    logger.error('Another error in thread A', { thread: 'thread-A' });
    logger.error('Error with no thread');

    await alertService.flush();

    const body = mockAdapter.sentAlerts[0]!.body;
    expect(body).toContain('4 error(s)');
    expect(body).toContain('Error in thread A');
    expect(body).toContain('Error in thread B');
    expect(body).toContain('Another error in thread A');
    expect(body).toContain('Error with no thread');
  });
});

describe('AlertService config validation', () => {
  test('should validate alerting config via schemas', async () => {
    const { validateAlertingConfig } = await import('../src/config/schemas');

    const config = validateAlertingConfig({
      enabled: true,
      recipient: 'ops@example.com',
      batchIntervalMinutes: 10,
    });

    expect(config).toBeDefined();
    expect(config!.enabled).toBe(true);
    expect(config!.recipient).toBe('ops@example.com');
    expect(config!.batchIntervalMinutes).toBe(10);
    // Defaults
    expect(config!.maxErrorsPerBatch).toBe(50);
    expect(config!.subjectPrefix).toBe('Jiny-M Alert');
    expect(config!.includeReplyToolLog).toBe(true);
    expect(config!.replyToolLogTailLines).toBe(50);
  });

  test('should reject invalid alerting config', async () => {
    const { validateAlertingConfig } = await import('../src/config/schemas');

    expect(() => validateAlertingConfig({ enabled: true })).toThrow('recipient');
    expect(() => validateAlertingConfig({ enabled: true, recipient: 123 })).toThrow('recipient');
    expect(() => validateAlertingConfig({
      enabled: true,
      recipient: 'a@b.com',
      batchIntervalMinutes: -1,
    })).toThrow('batchIntervalMinutes');
  });

  test('should return undefined for no config', async () => {
    const { validateAlertingConfig } = await import('../src/config/schemas');
    expect(validateAlertingConfig(undefined)).toBeUndefined();
    expect(validateAlertingConfig(null)).toBeUndefined();
  });

  test('should allow disabled config without recipient', async () => {
    const { validateAlertingConfig } = await import('../src/config/schemas');
    const config = validateAlertingConfig({ enabled: false });
    expect(config).toBeDefined();
    expect(config!.enabled).toBe(false);
  });
});

describe('Logger EventEmitter', () => {
  afterEach(() => {
    logger.removeAllListeners('log');
    logger.setSilent(false);
  });

  test('should emit log events on all levels', () => {
    logger.setSilent(true);
    const events: Array<{ level: string; message: string }> = [];

    logger.on('log', (event) => {
      events.push({ level: event.level, message: event.message });
    });

    logger.error('error msg');
    logger.warn('warn msg');
    logger.info('info msg');
    logger.debug('debug msg');

    expect(events.length).toBe(4);
    expect(events[0]).toEqual({ level: 'ERROR', message: 'error msg' });
    expect(events[1]).toEqual({ level: 'WARN', message: 'warn msg' });
    expect(events[2]).toEqual({ level: 'INFO', message: 'info msg' });
    expect(events[3]).toEqual({ level: 'DEBUG', message: 'debug msg' });
  });

  test('should include meta in log events', () => {
    logger.setSilent(true);
    let captured: any;

    logger.on('log', (event) => {
      captured = event;
    });

    logger.error('test', { foo: 'bar' });

    expect(captured.meta).toEqual({ foo: 'bar' });
    expect(captured.timestamp).toBeDefined();
  });

  test('should not emit when no listeners', () => {
    logger.setSilent(true);
    // This should not throw even with no listeners
    logger.error('test error');
    logger.info('test info');
  });
});

describe('AlertService Health Check', () => {
  let alertService: AlertService;
  let mockAdapter: ReturnType<typeof createMockAdapter>;

  beforeEach(() => {
    logger.setSilent(true);
    mockAdapter = createMockAdapter();
  });

  afterEach(async () => {
    if (alertService) {
      await alertService.stop();
    }
    logger.setSilent(false);
    logger.removeAllListeners('log');
  });

  test('should track message received stats from log events', () => {
    alertService = new AlertService(mockAdapter.adapter, defaultConfig(), './workspace');
    alertService.start();

    logger.info('Message received', { channel: 'email', sender: 'a@b.com', topic: 'Test' });
    logger.info('Message received', { channel: 'email', sender: 'c@d.com', topic: 'Test 2' });

    const stats = alertService.getHealthStats();
    expect(stats.messagesReceived).toBe(2);
  });

  test('should track pattern matched stats', () => {
    alertService = new AlertService(mockAdapter.adapter, defaultConfig(), './workspace');
    alertService.start();

    logger.info('Pattern matched', { pattern: 'sap', channel: 'email' });

    const stats = alertService.getHealthStats();
    expect(stats.messagesMatched).toBe(1);
  });

  test('should track reply sent via MCP tool', () => {
    alertService = new AlertService(mockAdapter.adapter, defaultConfig(), './workspace');
    alertService.start();

    logger.info('Reply sent via MCP reply_message tool', { thread: 'my-thread', channel: 'email' });

    const stats = alertService.getHealthStats();
    expect(stats.messagesProcessed).toBe(1);
    expect(stats.repliesSent).toBe(1);
    expect(stats.repliesByTool).toBe(1);
    expect(stats.repliesByFallback).toBe(0);
    expect(stats.perThread.get('my-thread')).toEqual({ received: 0, processed: 1, errors: 0 });
  });

  test('should track reply sent via fallback', () => {
    alertService = new AlertService(mockAdapter.adapter, defaultConfig(), './workspace');
    alertService.start();

    logger.info('Reply sent via outbound adapter (fallback)', { thread: 'fallback-thread', channel: 'email' });

    const stats = alertService.getHealthStats();
    expect(stats.repliesByFallback).toBe(1);
    expect(stats.repliesByTool).toBe(0);
    expect(stats.perThread.get('fallback-thread')?.processed).toBe(1);
  });

  test('should track error stats from log events', () => {
    alertService = new AlertService(mockAdapter.adapter, defaultConfig(), './workspace');
    alertService.start();

    logger.error('Failed to process message', { thread: 'err-thread', channel: 'email', error: 'timeout' });

    const stats = alertService.getHealthStats();
    expect(stats.errors).toBe(1);
    expect(stats.perThread.get('err-thread')?.errors).toBe(1);
  });

  test('should track worker finished events per thread', () => {
    alertService = new AlertService(mockAdapter.adapter, defaultConfig(), './workspace');
    alertService.start();

    logger.info('Worker finished', { thread: 'thread-a' });
    logger.info('Worker finished', { thread: 'thread-a' });
    logger.info('Worker finished', { thread: 'thread-b' });

    const stats = alertService.getHealthStats();
    expect(stats.perThread.get('thread-a')?.received).toBe(2);
    expect(stats.perThread.get('thread-b')?.received).toBe(1);
  });

  test('should send health report with stats', async () => {
    alertService = new AlertService(mockAdapter.adapter, defaultConfig({
      healthCheck: { enabled: true, intervalHours: 24 },
    }), './workspace');
    alertService.start();

    // Simulate some activity
    logger.info('Message received', { channel: 'email' });
    logger.info('Message received', { channel: 'email' });
    logger.info('Pattern matched', { pattern: 'sap' });
    logger.info('Reply sent via MCP reply_message tool', { thread: 'test-thread', channel: 'email' });
    logger.error('Failed to process message', { thread: 'test-thread', channel: 'email', error: 'oops' });

    await alertService.sendHealthReport();

    expect(mockAdapter.sentAlerts.length).toBe(1);
    const alert = mockAdapter.sentAlerts[0]!;
    expect(alert.subject).toContain('Health');
    expect(alert.subject).toContain('DEGRADED'); // because errors > 0
    expect(alert.body).toContain('Messages received:     2');
    expect(alert.body).toContain('Messages matched:      1');
    expect(alert.body).toContain('Replies sent:          1');
    expect(alert.body).toContain('Errors:                1');
    expect(alert.body).toContain('test-thread');
  });

  test('should reset stats after health report', async () => {
    alertService = new AlertService(mockAdapter.adapter, defaultConfig({
      healthCheck: { enabled: true },
    }), './workspace');
    alertService.start();

    logger.info('Message received', { channel: 'email' });
    await alertService.sendHealthReport();

    const stats = alertService.getHealthStats();
    expect(stats.messagesReceived).toBe(0);
    expect(stats.perThread.size).toBe(0);
  });

  test('should show OK status when no errors', async () => {
    alertService = new AlertService(mockAdapter.adapter, defaultConfig({
      healthCheck: { enabled: true },
    }), './workspace');
    alertService.start();

    logger.info('Message received', { channel: 'email' });
    logger.info('Reply sent via MCP reply_message tool', { thread: 'ok-thread', channel: 'email' });

    await alertService.sendHealthReport();

    const alert = mockAdapter.sentAlerts[0]!;
    expect(alert.subject).toContain('OK');
    expect(alert.subject).not.toContain('DEGRADED');
  });

  test('should use healthCheck.recipient override', async () => {
    alertService = new AlertService(mockAdapter.adapter, defaultConfig({
      healthCheck: { enabled: true, recipient: 'ops@special.com' },
    }), './workspace');
    alertService.start();

    logger.info('Message received', { channel: 'email' });
    await alertService.sendHealthReport();

    expect(mockAdapter.sentAlerts[0]!.recipient).toBe('ops@special.com');
  });

  test('should fall back to alerting.recipient when healthCheck.recipient not set', async () => {
    alertService = new AlertService(mockAdapter.adapter, defaultConfig({
      recipient: 'default@test.com',
      healthCheck: { enabled: true },
    }), './workspace');
    alertService.start();

    logger.info('Message received', { channel: 'email' });
    await alertService.sendHealthReport();

    expect(mockAdapter.sentAlerts[0]!.recipient).toBe('default@test.com');
  });

  test('should include queue stats when provider is available', async () => {
    const queueStatsProvider: QueueStatsProvider = {
      getStats: () => ({
        activeWorkers: 1,
        pendingThreads: 2,
        threadQueues: [
          { thread: 'queue-thread', size: 3, processing: true },
        ],
      }),
    };

    alertService = new AlertService(
      mockAdapter.adapter,
      defaultConfig({ healthCheck: { enabled: true } }),
      './workspace',
      queueStatsProvider,
    );
    alertService.start();

    await alertService.sendHealthReport();

    const body = mockAdapter.sentAlerts[0]!.body;
    expect(body).toContain('Active workers: 1');
    expect(body).toContain('Pending threads: 2');
    expect(body).toContain('queue-thread: 3 queued, processing');
  });

  test('should not track _alertInternal events in health stats', () => {
    alertService = new AlertService(mockAdapter.adapter, defaultConfig(), './workspace');
    alertService.start();

    logger.info('Message received', { _alertInternal: true });

    const stats = alertService.getHealthStats();
    expect(stats.messagesReceived).toBe(0);
  });
});

describe('HealthCheck config validation', () => {
  test('should validate healthCheck sub-config', async () => {
    const { validateAlertingConfig } = await import('../src/config/schemas');

    const config = validateAlertingConfig({
      enabled: true,
      recipient: 'ops@example.com',
      healthCheck: {
        enabled: true,
        intervalHours: 6,
        recipient: 'health@example.com',
      },
    });

    expect(config!.healthCheck).toBeDefined();
    expect(config!.healthCheck!.enabled).toBe(true);
    expect(config!.healthCheck!.intervalHours).toBe(6);
    expect(config!.healthCheck!.recipient).toBe('health@example.com');
  });

  test('should default healthCheck intervalHours to 24', async () => {
    const { validateAlertingConfig } = await import('../src/config/schemas');

    const config = validateAlertingConfig({
      enabled: true,
      recipient: 'ops@example.com',
      healthCheck: { enabled: true },
    });

    expect(config!.healthCheck!.intervalHours).toBe(24);
  });

  test('should reject invalid intervalHours', async () => {
    const { validateAlertingConfig } = await import('../src/config/schemas');

    expect(() => validateAlertingConfig({
      enabled: true,
      recipient: 'ops@example.com',
      healthCheck: { enabled: true, intervalHours: -1 },
    })).toThrow('intervalHours');
  });
});
