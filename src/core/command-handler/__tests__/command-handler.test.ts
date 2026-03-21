import { beforeAll, afterAll, describe, expect, test } from 'bun:test';
import { CommandRegistry } from '..';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('Command Handler System', () => {
  const tempDir = join(tmpdir(), `command-handler-test-${Date.now()}`);

  beforeAll(async () => {
    await mkdir(tempDir, { recursive: true });
    await mkdir(join(tempDir, '.jiny'), { recursive: true });
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('CommandRegistry', () => {
    test('should list registered handlers', () => {
      const registry = new CommandRegistry();
      const handlers = registry.list();

      expect(handlers.length).toBeGreaterThan(0);
      expect(handlers[0]?.name).toBe('/model');
    });

    test('should get handler by name', () => {
      const registry = new CommandRegistry();
      const handler = registry.get('/model');

      expect(handler).toBeDefined();
      expect(handler?.name).toBe('/model');
    });

    test('should parse /model command from text', () => {
      const registry = new CommandRegistry();
      const text = '/model SiliconFlow/Pro/deepseek-ai/DeepSeek-V3.2\n\nImplement the feature.';
      const commands = registry.parseCommands(text);

      expect(commands.length).toBe(1);
      expect(commands[0]?.handler.name).toBe('/model');
      expect(commands[0]?.args).toEqual(['SiliconFlow/Pro/deepseek-ai/DeepSeek-V3.2']);
    });

    test('should parse /model reset', () => {
      const registry = new CommandRegistry();
      const commands = registry.parseCommands('/model reset');

      expect(commands.length).toBe(1);
      expect(commands[0]?.args).toEqual(['reset']);
    });

    test('should parse /model with no args (list)', () => {
      const registry = new CommandRegistry();
      const commands = registry.parseCommands('/model');

      expect(commands.length).toBe(1);
      expect(commands[0]?.args).toEqual([]);
    });

    test('should ignore unknown commands', () => {
      const registry = new CommandRegistry();
      const commands = registry.parseCommands('/unknown arg1\n/model test');

      expect(commands.length).toBe(1);
      expect(commands[0]?.handler.name).toBe('/model');
    });

    test('should parse empty text', () => {
      const registry = new CommandRegistry();
      const commands = registry.parseCommands('');

      expect(commands.length).toBe(0);
    });

    test('should ignore non-command text', () => {
      const registry = new CommandRegistry();
      const commands = registry.parseCommands('Hello, please help me.');

      expect(commands.length).toBe(0);
    });
  });

  describe('ModelCommandHandler', () => {
    const makeContext = (args: string[]) => ({
      email: { id: 'test', from: 'test@test.com', subject: 'Test' },
      threadPath: tempDir,
      config: { maxFileSize: '25mb', allowedExtensions: [] },
      args,
    });

    test('should switch model and write override file', async () => {
      const registry = new CommandRegistry();
      const handler = registry.get('/model')!;

      const result = await handler.execute(makeContext(['SiliconFlow/Pro/deepseek-ai/DeepSeek-V3.2']));

      expect(result.success).toBe(true);
      expect(result.message).toContain('DeepSeek-V3.2');

      // Verify override file was written
      const override = await readFile(join(tempDir, '.jiny', 'model-override'), 'utf-8');
      expect(override).toBe('SiliconFlow/Pro/deepseek-ai/DeepSeek-V3.2');
    });

    test('should reset model and delete override file', async () => {
      const registry = new CommandRegistry();
      const handler = registry.get('/model')!;

      // First set a model
      await handler.execute(makeContext(['test-model']));

      // Then reset
      const result = await handler.execute(makeContext(['reset']));

      expect(result.success).toBe(true);
      expect(result.message).toContain('reset');

      // Override file should be gone
      try {
        await readFile(join(tempDir, '.jiny', 'model-override'), 'utf-8');
        expect(true).toBe(false); // Should not reach here
      } catch {
        // Expected — file deleted
      }
    });

    test('should delete session.json when switching model', async () => {
      const registry = new CommandRegistry();
      const handler = registry.get('/model')!;

      // Create a fake session file
      await writeFile(join(tempDir, '.jiny', 'session.json'), '{"sessionId":"old"}');

      await handler.execute(makeContext(['new-model']));

      // Session should be deleted
      try {
        await readFile(join(tempDir, '.jiny', 'session.json'), 'utf-8');
        expect(true).toBe(false); // Should not reach here
      } catch {
        // Expected — session deleted
      }
    });

    test('should list models with no args', async () => {
      const registry = new CommandRegistry();
      const handler = registry.get('/model')!;

      const result = await handler.execute(makeContext([]));

      expect(result.success).toBe(true);
      expect(result.message).toBeDefined();
      expect(result.message).toContain('model');
    });
  });

  describe('readModelOverride', () => {
    test('should return null when no override exists', async () => {
      const { readModelOverride } = await import('../handlers/ModelCommandHandler');
      const noOverrideDir = join(tmpdir(), `no-override-${Date.now()}`);
      await mkdir(noOverrideDir, { recursive: true });

      const result = await readModelOverride(noOverrideDir);
      expect(result).toBeNull();

      await rm(noOverrideDir, { recursive: true, force: true });
    });

    test('should return model when override exists', async () => {
      const { readModelOverride } = await import('../handlers/ModelCommandHandler');
      await writeFile(join(tempDir, '.jiny', 'model-override'), 'test/model-id');

      const result = await readModelOverride(tempDir);
      expect(result).toBe('test/model-id');
    });
  });
});
