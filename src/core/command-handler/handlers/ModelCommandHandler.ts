import { join } from 'node:path';
import { readFile, unlink, mkdir } from 'node:fs/promises';
import type { CommandHandler, CommandContext, CommandResult } from '../CommandHandler';
import { logger } from '../../logger';
import { stripJsonComments } from '../../../utils/jsonc';

const MODEL_OVERRIDE_FILE = 'model-override';

/**
 * /model command — switch the AI model for the current thread.
 *
 * Usage:
 *   /model SiliconFlow/Pro/deepseek-ai/DeepSeek-V3.2   — switch to specific model
 *   /model                                               — list available models
 *   /model reset                                         — reset to default from config
 *
 * The override is stored in .jiny/model-override and persists across messages.
 * ensureThreadOpencodeSetup() reads this file and uses it over the config default.
 */
export class ModelCommandHandler implements CommandHandler {
  name = '/model';
  description = 'Switch the AI model for the current thread';

  async execute(context: CommandContext): Promise<CommandResult> {
    const { args, threadPath } = context;

    // No args → list available models
    if (!args || args.length === 0) {
      return this.listModels(threadPath);
    }

    const modelArg = args.join(' ').trim();

    // /model reset → remove model override, use default
    if (modelArg.toLowerCase() === 'reset') {
      return this.resetModel(threadPath);
    }

    // /model <id> → switch to specific model
    return this.switchModel(threadPath, modelArg);
  }

  private async switchModel(threadPath: string, modelId: string): Promise<CommandResult> {
    const overridePath = join(threadPath, '.jiny', MODEL_OVERRIDE_FILE);

    try {
      await mkdir(join(threadPath, '.jiny'), { recursive: true });
      await Bun.write(overridePath, modelId);

      // Delete session file to force new session with new model
      try {
        await unlink(join(threadPath, '.jiny', 'session.json'));
      } catch { /* may not exist */ }

      logger.info('Model override set', { model: modelId, threadPath });

      return {
        success: true,
        message: `Model switched to ${modelId}. Takes effect immediately.`,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to switch model', { modelId, error: msg });
      return {
        success: false,
        error: `Failed to switch model: ${msg}`,
      };
    }
  }

  private async resetModel(threadPath: string): Promise<CommandResult> {
    const overridePath = join(threadPath, '.jiny', MODEL_OVERRIDE_FILE);

    try {
      await unlink(overridePath);
    } catch { /* may not exist */ }

    // Delete session file to force new session
    try {
      await unlink(join(threadPath, '.jiny', 'session.json'));
    } catch { /* may not exist */ }

    logger.info('Model override removed, using default', { threadPath });

    return {
      success: true,
      message: 'Model reset to default from config.',
    };
  }

  private async listModels(threadPath: string): Promise<CommandResult> {
    // Check current override
    let currentOverride: string | null = null;
    try {
      currentOverride = (await readFile(join(threadPath, '.jiny', MODEL_OVERRIDE_FILE), 'utf-8')).trim();
    } catch { /* no override */ }

    // Read available models from OpenCode global config
    const configPaths = [
      join(process.env.HOME || '/root', '.config', 'opencode', 'opencode.jsonc'),
      join(process.env.HOME || '/root', '.config', 'opencode', 'opencode.json'),
    ];

    for (const configPath of configPaths) {
      try {
        let content = await readFile(configPath, 'utf-8');
        // Strip JSONC comments
        content = stripJsonComments(content);
        const config = JSON.parse(content);

        const models: string[] = [];

        // Collect models from all providers
        if (config.provider) {
          for (const [providerName, providerConfig] of Object.entries(config.provider as Record<string, any>)) {
            if (providerConfig.models) {
              for (const modelId of Object.keys(providerConfig.models)) {
                models.push(`${providerName}/${modelId}`);
              }
            }
          }
        }

        // Add well-known Anthropic models if provider exists
        if (config.provider?.anthropic) {
          const knownModels = [
            'anthropic/claude-opus-4-6',
            'anthropic/claude-sonnet-4-6',
            'anthropic/claude-haiku-4-5',
          ];
          for (const m of knownModels) {
            if (!models.includes(m)) models.push(m);
          }
        }

        const defaultModel = config.model || '(not set)';
        const activeModel = currentOverride || defaultModel;
        const modelList = models.map(m => `  - ${m}${m === activeModel ? ' (active)' : ''}`).join('\n');

        return {
          success: true,
          message: `Active model: ${activeModel}${currentOverride ? ' (override)' : ' (default)'}\nDefault: ${defaultModel}\n\nAvailable models:\n${modelList}\n\nUsage:\n  /model <model-id>  — switch model\n  /model reset        — reset to default`,
        };
      } catch {
        continue;
      }
    }

    return {
      success: true,
      message: `Active model: ${currentOverride || '(default)'}\n\nCould not read available models from OpenCode config.\nUsage: /model <provider/model-id>`,
    };
  }
}

/**
 * Read the model override for a thread (if any).
 * Used by ensureThreadOpencodeSetup() to respect /model commands.
 */
export async function readModelOverride(threadPath: string): Promise<string | null> {
  try {
    const content = await readFile(join(threadPath, '.jiny', MODEL_OVERRIDE_FILE), 'utf-8');
    return content.trim() || null;
  } catch {
    return null;
  }
}
