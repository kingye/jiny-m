#!/usr/bin/env bun

/**
 * Main entry point for jiny-m CLI.
 * This file is used for bun build --compile.
 * The ./jiny-m file (no extension) is the dev-mode entry point.
 */

import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { program } from 'commander';
import { monitorCommand } from './src/cli/commands/monitor';
import { initConfigCommand, validateConfigCommand } from './src/cli/commands/config';
import { listPatternsCommand, addPatternCommand } from './src/cli/commands/patterns';
import pkg from './package.json';

const VERSION: string = pkg.version;

// Parse --workdir early (before commander), since it must take effect before any other code runs.
// This changes process.cwd() so all path resolution throughout the app is relative to the workdir.
const workdirIndex = process.argv.indexOf('--workdir');
const workdirShortIndex = process.argv.indexOf('-w');
const wdIdx = workdirIndex !== -1 ? workdirIndex : workdirShortIndex;
if (wdIdx !== -1 && process.argv[wdIdx + 1]) {
  let rawWorkdir = process.argv[wdIdx + 1]!;
  // Expand ~ to home directory (shell expansion doesn't happen when spawned by PM2/spawn)
  if (rawWorkdir === '~' || rawWorkdir.startsWith('~/')) {
    rawWorkdir = join(homedir(), rawWorkdir.slice(1));
  }
  const workdir = resolve(rawWorkdir);
  try {
    process.chdir(workdir);
  } catch (err) {
    console.error(`Error: Cannot change to workdir "${workdir}": ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
  // Remove --workdir/-w and its value from argv so commander doesn't see them
  process.argv.splice(wdIdx, 2);
}

// Ensure .jiny directory exists before any command runs
const jinyDir = join(process.cwd(), '.jiny');
await mkdir(jinyDir, { recursive: true });

program
  .name('jiny-m')
  .description('Jiny-M: AI Agent - Monitor messages and respond with AI')
  .version(VERSION)
  .option('-w, --workdir <path>', 'Working directory (where .jiny/config.json lives). Parsed early, before subcommands.');

program
  .command('monitor')
  .description('Monitor IMAP inbox for emails matching patterns')
  .option('-c, --config <file>', 'Path to configuration file', '.jiny/config.json')
  .option('--once', 'Check once and exit')
  .option('--no-idle', 'Use polling instead of IMAP IDLE')
  .option('-v, --verbose', 'Enable verbose IMAP protocol logging')
  .option('-d, --debug', 'Enable debug logging')
  .option('--reset', 'Reset monitoring state (start from beginning)')
  .action(monitorCommand);

program
  .command('state')
  .description('Show monitoring state')
  .action(async () => {
    const { StateManager } = await import('./src/core/state-manager');
    await StateManager.load();
    const state = StateManager.getState();
    console.log('Current monitoring state:');
    console.log(`  Last sequence number: ${state.lastSequenceNumber}`);
    console.log(`  Last processed UID: ${state.lastProcessedUid}`);
    console.log(`  Last processed timestamp: ${state.lastProcessedTimestamp}`);
  });

program
  .command('config')
  .description('Manage configuration')
  .argument('<action>', 'Action to perform: init, validate')
  .option('-c, --config <file>', 'Path to configuration file', '.jiny/config.json')
  .action(async (action, options) => {
    switch (action) {
      case 'init':
        await initConfigCommand(options.config);
        break;
      case 'validate':
        await validateConfigCommand(options.config);
        break;
      default:
        console.error(`Unknown action: ${action}. Available actions: init, validate`);
        process.exit(1);
    }
  });

program
  .command('patterns')
  .description('Manage email patterns')
  .argument('<action>', 'Action to perform: list, add')
  .option('-c, --config <file>', 'Path to configuration file', '.jiny/config.json')
  .action(async (action, options) => {
    switch (action) {
      case 'list':
        await listPatternsCommand(options.config);
        break;
      case 'add':
        console.error('Pattern addition not yet implemented with interactive CLI.');
        console.error('Please edit your config file directly to add patterns.');
        process.exit(1);
        break;
      default:
        console.error(`Unknown action: ${action}. Available actions: list, add`);
        process.exit(1);
    }
  });

program.parse();
