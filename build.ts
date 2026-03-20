#!/usr/bin/env bun

/**
 * Build script for jiny-m standalone binaries.
 *
 * Produces two binaries in dist/:
 *   - jiny-m            (main CLI)
 *   - jiny-m-reply-tool (MCP reply tool, spawned by OpenCode as subprocess)
 *
 * Usage:
 *   bun run build          # Build for current platform
 *   bun run build.ts       # Same
 *
 * Install:
 *   cp dist/jiny-m dist/jiny-m-reply-tool /usr/local/bin/
 *
 * Run from any directory:
 *   jiny-m --workdir /path/to/project monitor --debug
 */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const DIST_DIR = join(import.meta.dir, 'dist');

await mkdir(DIST_DIR, { recursive: true });

console.log('Building jiny-m standalone binaries...\n');

// Build main CLI
console.log('  [1/2] Compiling jiny-m (main CLI)...');
const mainResult = Bun.spawnSync({
  cmd: [
    'bun', 'build', '--compile',
    '--target', 'bun-darwin-arm64',
    './cli.ts',
    '--outfile', join(DIST_DIR, 'jiny-m'),
  ],
  cwd: import.meta.dir,
  stdout: 'inherit',
  stderr: 'inherit',
});

if (mainResult.exitCode !== 0) {
  console.error('  Failed to build jiny-m');
  process.exit(1);
}
console.log('  ✓ jiny-m built\n');

// Build MCP reply tool
console.log('  [2/2] Compiling jiny-m-reply-tool (MCP subprocess)...');
const toolResult = Bun.spawnSync({
  cmd: [
    'bun', 'build', '--compile',
    '--target', 'bun-darwin-arm64',
    './src/mcp/reply-tool.ts',
    '--outfile', join(DIST_DIR, 'jiny-m-reply-tool'),
  ],
  cwd: import.meta.dir,
  stdout: 'inherit',
  stderr: 'inherit',
});

if (toolResult.exitCode !== 0) {
  console.error('  Failed to build jiny-m-reply-tool');
  process.exit(1);
}
console.log('  ✓ jiny-m-reply-tool built\n');

// Print summary
const { statSync } = await import('node:fs');
const mainSize = statSync(join(DIST_DIR, 'jiny-m')).size;
const toolSize = statSync(join(DIST_DIR, 'jiny-m-reply-tool')).size;
const formatSize = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)}MB`;

console.log('Build complete:');
console.log(`  dist/jiny-m              ${formatSize(mainSize)}`);
console.log(`  dist/jiny-m-reply-tool   ${formatSize(toolSize)}`);
console.log('');
console.log('Install:');
console.log('  cp dist/jiny-m dist/jiny-m-reply-tool /usr/local/bin/');
console.log('');
console.log('Usage:');
console.log('  jiny-m --workdir /path/to/project monitor --debug');

// Check for --install flag
if (process.argv.includes('--install')) {
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  const localBin = join(homeDir, '.local', 'bin');
  const systemBin = '/usr/local/bin';

  // Prefer ~/.local/bin (no sudo), fall back to /usr/local/bin
  const { existsSync, accessSync, constants, mkdirSync } = await import('node:fs');

  let installDir: string;
  try {
    mkdirSync(localBin, { recursive: true });
    accessSync(localBin, constants.W_OK);
    installDir = localBin;
  } catch {
    installDir = systemBin;
  }

  console.log(`\nInstalling to ${installDir}...`);

  const needsSudo = (() => {
    try {
      accessSync(installDir, constants.W_OK);
      return false;
    } catch {
      return true;
    }
  })();

  const prefix = needsSudo ? ['sudo'] : [];

  for (const bin of ['jiny-m', 'jiny-m-reply-tool']) {
    const result = Bun.spawnSync({
      cmd: [...prefix, 'cp', join(DIST_DIR, bin), join(installDir, bin)],
      stdout: 'inherit',
      stderr: 'inherit',
    });
    if (result.exitCode !== 0) {
      console.error(`  Failed to install ${bin}`);
      process.exit(1);
    }
    console.log(`  ✓ ${bin} → ${installDir}/${bin}`);
  }

  // Verify it's on PATH
  const pathDirs = (process.env.PATH || '').split(':');
  if (!pathDirs.includes(installDir)) {
    console.log(`\nNote: ${installDir} is not in your PATH. Add it:`);
    console.log(`  export PATH="${installDir}:$PATH"`);
  }

  console.log('\nInstalled. Run from anywhere:');
  console.log('  jiny-m --workdir /path/to/project monitor --debug');
}
