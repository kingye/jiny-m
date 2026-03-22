# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.3] - 2026-03-22

### Fixed
- **Quoted history crash**: `parseStoredMessage()` returned `{ body }` but consumers expected `{ bodyText }`, causing `"undefined is not an object (evaluating 'bodyText.trim')"` when quoting historical messages
- **SMTP auto-reconnect not triggering**: Error string matching checked for `"connection"` but the disconnected-transporter error contains `"connected"` — broadened to match `"connect"` so auto-reconnect fires correctly
- **AlertService SMTP failure**: `sendFallbackReply()` and `sendDirectReply()` disconnected the shared SMTP adapter in their `finally` block, leaving AlertService unable to send digest emails; removed per-send connect/disconnect since the adapter is managed at the monitor lifecycle level

### Changed
- **Docker volumes simplified**: Reduced from 4 volume mounts to 2 — single host directory (`JINY_DIR`) maps to `/opt/jiny-m/` containing `.jiny/`, `.env`, and `workspace/`; OpenCode config remains a separate read-only mount
- **Quoted history reduced**: `MAX_HISTORY_QUOTE` reduced from 5 to 3 (current message + up to 2 previous)

## [0.2.2] - 2026-03-22

### Added
- **Historical message quoting**: `prepareBodyForQuoting()` includes up to 5 recent messages in replies, with fallback to single‑message quoting
- **Token integrity validation**: `_nonce` field detects AI tampering; validation rejects tokens containing backticks, escaped newlines, quotes

### Fixed
- **AI token tampering**: Stronger system prompt prohibits decoding/modifying the opaque base64 token
- **Reply tool errors**: Clear error messages when token appears modified

## [0.2.1] - 2026-03-22

### Fixed
- **Question tool now properly denied**: Changed from `tools: { question: false }` (ignored by OpenCode) to `permission: { question: "deny" }` (the correct OpenCode config syntax)
- **OpenCode server restart on model switch**: When `/model` command changes the model, the OpenCode server is restarted so the new model config takes effect
- **Command-only emails**: When email body contains only commands (e.g., `/model ...`), injects a system note telling the AI to confirm results and stop, preventing it from exploring the codebase
- **Activity timeouts increased**: Base timeout 2min→5min, tool timeout 5min→10min (sub-agents/task tool need more time)
- **Docker build**: Added `.dockerignore` to exclude `workspace/`, `bootstrapping/`, `.channels/` from build context (permission denied on `.bun-build` files)

### Changed
- Removed dead code: `attachment-commands.ts` (unused since command handler refactor)

### Tests
- Added 10 model ID preservation tests verifying no truncation at dots (e.g., `DeepSeek-V3.2` survives full round-trip)

## [0.2.0] - 2026-03-21

### Added
- **Bootstrapping**: Docker setup for self-development — jiny-M develops itself via email instructions
  - Dockerfile with multi-stage build: bun, git, opencode, gh, ripgrep, s6-overlay
  - Compiled `jiny-m-reply-tool` binary for MCP tool in container
  - s6-overlay supervisor with auto-restart, .env sourcing, GH_TOKEN git config
  - docker-compose.yml with 4 volume mounts (config, .env, workspace, opencode.jsonc)
  - Docker README with setup, mounts, bootstrapping workflow, troubleshooting
- **Thread-specific system prompt** (`system.md`): Optional file in thread directory, appended to AI system prompt. Enables domain-specific behavior per conversation.
- **Plan/Build mode detection**: General system prompt detects user intent from keywords (EN + CN). Plan mode = read-only analysis. Build mode = full execution. Defaults to plan if unclear.
- **`/model` command**: Switch AI model per thread via email
  - `/model <id>` — switch to specific model (persists via `.jiny/model-override`)
  - `/model` — list available models from opencode.jsonc
  - `/model reset` — revert to default model from config
- **Startup health check email**: Monitor sends startup notification with version on start
- **Headless mode**: `question` tool disabled in opencode.json (no interactive terminal)
- **Command system wired into processing pipeline**: Commands parsed and executed between message storage and AI prompt generation

### Fixed
- **Fallback reply includes quoted history**: `sendFallbackReply()` and `sendDirectReply()` now build full reply (AI text + quoted history) using `formatQuotedReply()`, matching the MCP tool path
- **Reply-tool binary for container**: Compiled `jiny-m-reply-tool` at `/usr/local/bin/`, with fallback path detection
- **system.md debug logging**: Logs success (path + length) or error (actual error message) instead of silent catch
- **Workspace mount path**: Consistent `/opt/jiny-m/workspace` (was `/workspace`, causing system.md invisible)
- **s6 run script**: bash with `cd /opt/jiny-m` + `.env` sourcing (was execlineb without cwd)
- **Startup notification ordering**: Sent before inbound adapters start (adapters block forever)

### Changed
- **`formatQuotedReply()` moved to shared utility** (`email-parser.ts`): Used by both MCP tool path (reads received.md from file) and fallback path (uses in-memory message)
- **`AttachCommandHandler` removed**: Replaced by `/model` command system
- **`CommandResult` interface**: Added `message` field for command feedback
- **`buildSystemPrompt()` is now async**: File I/O for system.md reading

### Documentation
- DESIGN.md: Bootstrapping section (architecture, deploy sequence, Docker setup, system.md, modes)
- DESIGN.md: Email Command System section (/model, architecture, persistence, adding new commands)
- Docker README: setup, mounts, bootstrapping workflow, local model connectivity, troubleshooting

## [0.1.5] - 2026-03-21

### Fixed
- **Bracket nesting root cause**: Disabled `marked` auto-linking of email addresses and URLs in `markdownToHtml()`. This was the source of exponentially nested brackets (`addr [addr] [addr [addr]]`) — `marked.parse()` converted addresses to `<a href="mailto:...">` tags, and recipients' email clients rendered them as `ADDR [addr]` in plain text on each reply round-trip.
- **Reply email subject**: Always `Re: <clean subject>` — strips all accumulated `Re:/回复:` prefixes
- **Reply email quoted history**: Full conversation history preserved (not stripped like AI prompt)
- **`reply.md` content**: Now stores exactly what was sent (AI reply + full quoted history), matching the recipient's view
- **`cleanEmailBody` simplified**: Removed ~80 lines of bracket removal logic and `joinBracketContinuations()`. Now only normalizes `主題/Subject` Re: prefixes — the body is stored as received.
- **Message directory naming**: Uses UTC instead of local time for consistency across timezones

### Changed
- **Component responsibilities enforced**:
  - InboundAdapter cleans data at boundary (`cleanEmailBody`, `stripReplyPrefix`)
  - MessageStorage is pure storage — no transformation
  - Reply Tool builds full reply markdown (AI text + `formatQuotedReply`)
  - SmtpService is dumb transport (markdown→HTML, headers, send — no quoting)
- **`formatQuotedReply()`**: Private function in Reply Tool — formats quoted history without stripping
- **SmtpService**: Removed `quoteOriginalEmail()` and `TurndownService` — quoting moved to Reply Tool

### Documentation
- DESIGN.md: comprehensive update — 14 fixes, end-to-end sequence diagram, component responsibilities, session lifecycle

## [0.1.3] - 2026-03-21

### Added
- **Enhanced tool call logging**: SSE logs now show tool details (command, path, pattern, task list) alongside tool name
- **Todowrite logging**: Shows AI's task planning with status (`[in_progress]`, `[pending]`, `[completed]`)
- **Reply tool input/output logging**: Reply tool args logged at INFO on `running` status (where input is populated), output logged at `completed`
- **Stale session detection**: When SSE reports reply success but signal file is missing, automatically deletes stale session and retries with a fresh one
- **Session cleanup on shutdown**: All `session.json` files deleted on SIGINT/SIGTERM to prevent stale sessions on restart
- **End-to-end sequence diagram** in DESIGN.md

### Changed
- **Architecture: clear component responsibilities**
  - InboundAdapter: cleans data at boundary (`cleanEmailBody`, `stripReplyPrefix`)
  - MessageStorage: pure storage, no transformation
  - Reply Tool: builds full reply (AI text + quoted history), passes to both send and store
  - SmtpService: dumb transport (markdown→HTML, threading headers, send — no quoting)
  - `reply.md` now stores exactly what was sent to the recipient (full reply with quoted history)
- **Context encoding**: Changed from JSON string to base64 opaque token — AI passes it through unchanged, eliminating all context corruption issues (truncation, type mismatch, tag wrapping, smart quotes)
- **Reply tool schema**: Context parameter accepts `z.string()` (base64 token) instead of `z.record()` (JSON object)
- **System prompt**: Simplified from verbose CRITICAL RULES to concise 4-line instructions
- **Message directory naming**: Uses UTC instead of local time for consistency across timezones
- **Reply subject**: Always `Re: <clean subject>` — strips all accumulated `Re:/回复:` prefixes
- **Email body cleaning at ingest**: `cleanEmailBody()` moved from MessageStorage to InboundAdapter (clean at boundary, store as-is)

### Fixed
- **Reply tool not invoked**: MCP `z.string()` schema rejected context passed as JSON object by AI models; now uses base64 string that models pass through unchanged
- **Reply tool detection**: Now matches both `reply_email` and `reply_message` tool names (was only checking `reply_email` after channel-agnostic refactor)
- **MCP error detection**: Checks for both `"Error"` and `"MCP error"` prefixes in tool output
- **Reply tool failure log level**: Upgraded from WARN to ERROR so failures are captured by AlertService
- **`<reply_context>` tag stripping**: AI models wrapping context in XML tags now handled by base64 encoding (irrelevant — opaque token)
- **Quoted history nesting**: Bracket-nested duplicate email addresses/URLs cleaned at ingest (`cleanEmailBody`)
- **Invalid Date in quoted history**: Graceful fallback to current time
- **Empty quoted body**: Skips quoted block entirely when body cannot be loaded

### Removed
- `deserializeAndValidateContext()` — replaced by `deserializeContext()` (base64 decode)
- `sanitizeContextJson()` and `repairTruncatedJson()` — no longer needed with base64 encoding
- `quoteOriginalEmail()` from SmtpService — quoting moved to Reply Tool
- `TurndownService` dependency from SmtpService
- `contentPreview` field from ReplyContext interface

### Documentation
- DESIGN.md: comprehensive update (14 fixes) to match current implementation
- Added "Design Principles: Component Responsibilities" section
- Added end-to-end sequence diagram (8 components, full message lifecycle)
- Added session lifecycle documentation (stale detection, shutdown cleanup)
- Updated stripping strategy table with InboundAdapter cleaning column

## [0.1.2] - 2026-03-20

### Fixed
- CLI `--version` flag now reads from `package.json` instead of a hardcoded value
- CLI version works correctly with `bun build --compile` standalone binaries (static import)

### Documentation
- Updated DESIGN.md with alerting, health check, and v0.1.1 bug fixes

## [0.1.1] - 2026-03-20

### Added
- **Alert Service**: Error alert digest emails sent periodically with buffered errors, surrounding log context, and per-thread reply-tool.log tails
- **Health Check**: Periodic health report emails summarizing message processing stats (received, matched, processed, replies, errors, per-thread breakdown, live queue status)
- **Logger EventEmitter**: Logger now extends EventEmitter, emitting `'log'` events on all levels for subscribers
- **SmtpService.sendMail()**: New method for sending fresh (non-reply) emails without `Re:` prefix or threading headers
- **OutboundAdapter.sendAlert()**: Optional method on the adapter interface for sending alert/notification emails
- **AlertingConfig**: New config section with `healthCheck` sub-config (configurable intervals, recipients, reply-tool log inclusion)
- **QueueStatsProvider**: Interface for injecting ThreadManager stats into AlertService without tight coupling

### Fixed
- **Unicode filenames**: PathValidator switched from ASCII-only whitelist (`/^[\w\-. ]+$/`) to dangerous-character blocklist, allowing CJK and other Unicode filenames (e.g. `飞书钉钉API方案总结.pptx`)
- **Stale signal file detection**: `reply-sent.flag` is now cleaned up before each prompt to prevent false-positive detection from previous runs
- **SSE loop hanging**: Activity timeout and signal file check now call `sseStream.return()` to force-close the SSE stream, unblocking the `for await` loop immediately
- **Extended tool timeout**: When an AI tool is actively running (e.g. `write`, `bash`), the activity timeout extends from 2 minutes to 5 minutes, since OpenCode doesn't emit SSE events during tool execution

## [0.1.0] - 2026-03-20

### Added
- **Channel-agnostic architecture**: Complete refactor from email-only to pluggable multi-channel system
- InboundAdapter / OutboundAdapter interfaces for channel-specific message handling
- ChannelRegistry for adapter lookup by channel type
- MessageRouter: delegates matching/naming to adapters, dispatches to thread queues
- ThreadManager: per-thread FIFO queues with concurrency-limited workers (default: 3)
- PromptBuilder for channel-agnostic prompt construction
- Channel-agnostic ReplyContext and MessageStorage
- Migration v3: automatic state file relocation to `.jiny/email/` + `channel` field in received.md frontmatter
- BigInt boundary fix: convert imapflow BigInt values to Number at the adapter boundary

## [0.0.1] - 2026-03-19

### Added
- Initial release: Email monitoring CLI with pattern matching and AI auto-reply
- IMAP monitoring with IDLE and polling support
- Pattern-based email filtering (sender, subject prefix/regex)
- OpenCode AI integration with SSE streaming for progress visibility
- MCP `reply_message` tool for AI-driven email replies via SMTP
- Per-thread conversation context with OpenCode session persistence
- Message storage in `messages/<timestamp>/` directories
- Inbound attachment download with extension whitelist, size limits, and security validation
- UID-based state recovery and deletion detection
- Signal file detection (`.jiny/reply-sent.flag`) for cross-process reply verification
- ContextOverflow recovery (new session + retry)
- Standalone binary build support (`bun build --compile`)
- `--workdir` flag for flexible deployment

[0.2.1]: https://github.com/kingye/jiny-m/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/kingye/jiny-m/compare/v0.1.5...v0.2.0
[0.1.5]: https://github.com/kingye/jiny-m/compare/v0.1.3...v0.1.5
[0.1.3]: https://github.com/kingye/jiny-m/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/kingye/jiny-m/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/kingye/jiny-m/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/kingye/jiny-m/compare/v0.0.1...v0.1.0
[0.0.1]: https://github.com/kingye/jiny-m/releases/tag/v0.0.1
