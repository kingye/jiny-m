/**
 * PM2 Ecosystem Configuration for jiny-m
 *
 * Local process supervision equivalent to s6-overlay in Docker.
 * Runs jiny-m from source via bun (no compiled binary needed locally).
 *
 * Configuration via .env or environment:
 *   JINY_WORKDIR=.channels   # working directory (default: "." i.e. project root)
 *
 * Usage:
 *   bun run start                       # start jiny-m under pm2
 *   bun run stop                        # stop
 *   bun run restart                     # restart (e.g., after code changes)
 *   bun run logs                        # tail logs
 *   bun run status                      # process status
 */

const path = require("path");
const fs = require("fs");

// Load .env manually (pm2 doesn't use Bun, so no auto-loading)
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
}

const workdir = process.env.JINY_WORKDIR || ".";

module.exports = {
  apps: [
    {
      name: "jiny-m",
      script: "bun",
      args: `cli.ts monitor --workdir ${workdir} --debug`,
      cwd: __dirname,

      // Restart policy (mirrors s6 longrun behavior)
      autorestart: true,
      max_restarts: 50,
      min_uptime: "10s",
      restart_delay: 5000,

      // Graceful shutdown
      kill_timeout: 10000,
      listen_timeout: 8000,

      // Logging
      error_file: path.join(__dirname, "logs", "jiny-m-error.log"),
      out_file: path.join(__dirname, "logs", "jiny-m-out.log"),
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",

      // Watch is disabled — jiny-m is a long-running monitor, not a dev server.
      // Use `pm2 restart jiny-m` after code changes.
      watch: false,
    },
  ],
};
