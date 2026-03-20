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
