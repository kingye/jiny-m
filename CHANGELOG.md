# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
- Channel-agnostic architecture: pluggable multi-channel system with InboundAdapter/OutboundAdapter interfaces
- ChannelRegistry, MessageRouter, ThreadManager (per-thread queues with concurrency control)
- PromptBuilder for channel-agnostic prompt construction
- Channel-agnostic ReplyContext and MessageStorage
- Migration v3: automatic state file relocation to `.jiny/email/`
- Standalone binary build support (`bun build --compile`)
- `--workdir` flag for flexible deployment

[0.1.2]: https://github.com/kingye/jiny-m/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/kingye/jiny-m/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/kingye/jiny-m/releases/tag/v0.1.0
