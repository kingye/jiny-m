import { join } from 'node:path';
import { readFile, unlink, mkdir } from 'node:fs/promises';
import type { CommandHandler, CommandContext, CommandResult } from '../CommandHandler';
import { logger } from '../../logger';

const MODE_OVERRIDE_FILE = 'mode-override';

/**
 * /plan and /build commands — switch between plan (read-only) and build (full execution) modes.
 *
 * Usage:
 *   /plan    — switch to plan mode (read-only, enforced by OpenCode)
 *   /build   — switch to build mode (full execution, default)
 *
 * The override is stored in .jiny/mode-override and persists across messages.
 * promptWithProgress() reads this file and passes `agent: "plan"` to OpenCode
 * when plan mode is active. OpenCode enforces plan mode at the tool level —
 * the AI literally cannot edit files or run modifying commands.
 */
export class PlanCommandHandler implements CommandHandler {
  name = '/plan';
  description = 'Switch to plan mode (read-only, enforced by OpenCode)';

  async execute(context: CommandContext): Promise<CommandResult> {
    const { threadPath } = context;

    try {
      await mkdir(join(threadPath, '.jiny'), { recursive: true });
      await Bun.write(join(threadPath, '.jiny', MODE_OVERRIDE_FILE), 'plan');

      logger.info('Mode switched to plan', { threadPath });

      return {
        success: true,
        message: 'Switched to plan mode (read-only). AI will analyze and propose, but will NOT edit files or run modifying commands.',
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: `Failed to switch mode: ${msg}` };
    }
  }
}

export class BuildCommandHandler implements CommandHandler {
  name = '/build';
  description = 'Switch to build mode (full execution, default)';

  async execute(context: CommandContext): Promise<CommandResult> {
    const { threadPath } = context;

    try {
      await unlink(join(threadPath, '.jiny', MODE_OVERRIDE_FILE));
    } catch { /* may not exist */ }

    logger.info('Mode switched to build', { threadPath });

    return {
      success: true,
      message: 'Switched to build mode (full execution). AI can edit files, run tests, commit, etc.',
    };
  }
}

/**
 * Read the mode override for a thread (if any).
 * Returns "plan" if plan mode is active, null otherwise (default = build).
 */
export async function readModeOverride(threadPath: string): Promise<string | null> {
  try {
    const content = await readFile(join(threadPath, '.jiny', MODE_OVERRIDE_FILE), 'utf-8');
    return content.trim() || null;
  } catch {
    return null;
  }
}
