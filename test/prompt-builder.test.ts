import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PromptBuilder } from '../src/services/opencode/prompt-builder';
import type { OpenCodeConfig } from '../src/types';

const testConfig: OpenCodeConfig = {
  enabled: true,
  model: 'test-model',
};

describe('PromptBuilder.buildSystemPrompt', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `jiny-test-${Date.now()}`);
    await mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test('should return standard system prompt when no system.md exists', async () => {
    const builder = new PromptBuilder(testConfig);
    const prompt = await builder.buildSystemPrompt(tempDir);

    expect(prompt).toContain('Reply Instructions');
    expect(prompt).toContain('reply_message');
    expect(prompt).toContain(tempDir);
  });

  test('should append system.md content when file exists', async () => {
    const systemMd = 'You are developing jiny-M.\n\n## Build\n1. bun test\n2. bun build';
    await writeFile(join(tempDir, 'system.md'), systemMd);

    const builder = new PromptBuilder(testConfig);
    const prompt = await builder.buildSystemPrompt(tempDir);

    // Standard prompt still present
    expect(prompt).toContain('Reply Instructions');
    expect(prompt).toContain('reply_message');

    // Thread-specific content appended
    expect(prompt).toContain('You are developing jiny-M.');
    expect(prompt).toContain('## Build');
    expect(prompt).toContain('bun test');
  });

  test('should ignore empty system.md', async () => {
    await writeFile(join(tempDir, 'system.md'), '   \n\n  ');

    const builder = new PromptBuilder(testConfig);
    const prompt = await builder.buildSystemPrompt(tempDir);

    // Standard prompt only, no extra blank content
    expect(prompt).toContain('Reply Instructions');
    expect(prompt).not.toContain('\n\n\n\n');
  });

  test('should include custom systemPrompt from config', async () => {
    const config: OpenCodeConfig = {
      ...testConfig,
      systemPrompt: 'You are a helpful assistant.',
    };
    const builder = new PromptBuilder(config);
    const prompt = await builder.buildSystemPrompt(tempDir);

    expect(prompt).toContain('You are a helpful assistant.');
    expect(prompt).toContain('Reply Instructions');
  });

  test('should combine config systemPrompt + system.md', async () => {
    const config: OpenCodeConfig = {
      ...testConfig,
      systemPrompt: 'You are a helpful assistant.',
    };
    await writeFile(join(tempDir, 'system.md'), '## Thread-specific rules\nAlways use TypeScript.');

    const builder = new PromptBuilder(config);
    const prompt = await builder.buildSystemPrompt(tempDir);

    expect(prompt).toContain('You are a helpful assistant.');
    expect(prompt).toContain('Reply Instructions');
    expect(prompt).toContain('## Thread-specific rules');
    expect(prompt).toContain('Always use TypeScript.');
  });
});
