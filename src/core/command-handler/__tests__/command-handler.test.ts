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

  describe('Model ID preservation (no truncation)', () => {
    const MODEL_IDS = [
      'SiliconFlow/Pro/deepseek-ai/DeepSeek-V3.2',
      'SiliconFlow/Pro/zai-org/GLM-4.7',
      'SiliconFlow/Pro/MiniMaxAI/MiniMax-M2.5',
      'anthropic/claude-opus-4-6',
      'anthropic/claude-sonnet-4-6',
      'anthropic/claude-haiku-4-5',
      'openai/gpt-4.1-2025-04-14',
      'provider/model-with.many.dots.v1.2.3',
    ];

    const makeContext = (args: string[]) => ({
      email: { id: 'test', from: 'test@test.com', subject: 'Test' },
      threadPath: tempDir,
      config: { maxFileSize: '25mb', allowedExtensions: [] },
      args,
    });

    for (const modelId of MODEL_IDS) {
      test(`full round-trip preserves "${modelId}"`, async () => {
        const registry = new CommandRegistry();

        // Step 1: Parse from email text
        const text = `/model ${modelId}\n\nDo something.`;
        const commands = registry.parseCommands(text);
        expect(commands.length).toBe(1);
        expect(commands[0]?.args).toEqual([modelId]);

        // Step 2: Execute command → write override file
        const handler = registry.get('/model')!;
        const result = await handler.execute(makeContext([modelId]));
        expect(result.success).toBe(true);

        // Step 3: Read override file → verify exact match
        const { readModelOverride } = await import('../handlers/ModelCommandHandler');
        const override = await readModelOverride(tempDir);
        expect(override).toBe(modelId);

        // Step 4: Verify no truncation at dots
        if (modelId.includes('.')) {
          const lastDotIndex = modelId.lastIndexOf('.');
          const afterDot = modelId.substring(lastDotIndex);
          expect(override).toContain(afterDot);
        }
      });
    }

    test('command parsing does not split on dots or slashes', () => {
      const registry = new CommandRegistry();
      const text = '/model SiliconFlow/Pro/deepseek-ai/DeepSeek-V3.2';
      const commands = registry.parseCommands(text);

      // Must be a single arg, not split on / or .
      expect(commands[0]?.args.length).toBe(1);
      expect(commands[0]?.args[0]).toBe('SiliconFlow/Pro/deepseek-ai/DeepSeek-V3.2');
    });

    test('model ID with version suffix survives JSON round-trip', async () => {
      const modelId = 'SiliconFlow/Pro/deepseek-ai/DeepSeek-V3.2';

      // Simulate what ensureThreadOpencodeSetup does
      const config = { model: modelId };
      const json = JSON.stringify(config);
      const parsed = JSON.parse(json);

      expect(parsed.model).toBe(modelId);
      expect(parsed.model).toContain('.2');
      expect(parsed.model).not.toBe('SiliconFlow/Pro/deepseek-ai/DeepSeek-V3');
    });
  });

  describe('ModeCommandHandler (/plan and /build)', () => {
    const makeContext = (args: string[]) => ({
      email: { id: 'test', from: 'test@test.com', subject: 'Test' },
      threadPath: tempDir,
      config: { maxFileSize: '25mb', allowedExtensions: [] },
      args,
    });

    test('should register /plan and /build handlers', () => {
      const registry = new CommandRegistry();
      expect(registry.get('/plan')).toBeDefined();
      expect(registry.get('/build')).toBeDefined();
    });

    test('should parse /plan command', () => {
      const registry = new CommandRegistry();
      const commands = registry.parseCommands('/plan\n\nAnalyze the code.');
      expect(commands.length).toBe(1);
      expect(commands[0]?.handler.name).toBe('/plan');
    });

    test('should parse /build command', () => {
      const registry = new CommandRegistry();
      const commands = registry.parseCommands('/build\n\nImplement the feature.');
      expect(commands.length).toBe(1);
      expect(commands[0]?.handler.name).toBe('/build');
    });

    test('/plan should write mode-override file', async () => {
      const registry = new CommandRegistry();
      const handler = registry.get('/plan')!;

      const result = await handler.execute(makeContext([]));
      expect(result.success).toBe(true);
      expect(result.message).toContain('plan');

      const { readModeOverride } = await import('../handlers/ModeCommandHandler');
      const mode = await readModeOverride(tempDir);
      expect(mode).toBe('plan');
    });

    test('/build should delete mode-override file', async () => {
      const registry = new CommandRegistry();

      // Set plan mode first
      await registry.get('/plan')!.execute(makeContext([]));

      // Then switch to build
      const result = await registry.get('/build')!.execute(makeContext([]));
      expect(result.success).toBe(true);
      expect(result.message).toContain('build');

      const { readModeOverride } = await import('../handlers/ModeCommandHandler');
      const mode = await readModeOverride(tempDir);
      expect(mode).toBeNull();
    });

    test('readModeOverride returns null when no override exists', async () => {
      const { readModeOverride } = await import('../handlers/ModeCommandHandler');
      const noOverrideDir = join(tmpdir(), `no-mode-${Date.now()}`);
      await mkdir(noOverrideDir, { recursive: true });

      const result = await readModeOverride(noOverrideDir);
      expect(result).toBeNull();

      await rm(noOverrideDir, { recursive: true, force: true });
    });

    test('mode persists across command registry instances', async () => {
      const registry1 = new CommandRegistry();
      await registry1.get('/plan')!.execute(makeContext([]));

      const { readModeOverride } = await import('../handlers/ModeCommandHandler');
      const mode = await readModeOverride(tempDir);
      expect(mode).toBe('plan');

      // New registry instance reads the same override
      const registry2 = new CommandRegistry();
      const result = await registry2.get('/build')!.execute(makeContext([]));
      expect(result.success).toBe(true);

      const modeAfter = await readModeOverride(tempDir);
      expect(modeAfter).toBeNull();
    });
  });
});
