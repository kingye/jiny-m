# Jiny-M

AI agent that operates through messaging channels. Users interact by sending messages (email, FeiShu, Slack, etc.), and the agent responds autonomously using [OpenCode](https://opencode.ai) AI.

## Features

- **Email monitoring** via IMAP with pattern matching (sender, subject)
- **AI-powered replies** via OpenCode with per-thread conversation memory
- **Attachment handling** — download inbound attachments, attach files to replies
- **MCP reply tool** — OpenCode calls `reply_message` to send replies directly
- **SSE streaming** — real-time progress tracking with activity-based timeout
- **Per-thread queues** — parallel processing across threads, sequential within
- **Standalone binary** — compile to a single executable, run from anywhere

## Requirements

- [Bun](https://bun.sh) v1.0+
- [OpenCode](https://opencode.ai) CLI installed and configured
- IMAP/SMTP email account

## Quick Start

```bash
# Install dependencies
bun install

# Initialize config
bun jiny-m config init

# Edit config with your IMAP/SMTP credentials
$EDITOR .jiny/config.json

# Start monitoring
bun jiny-m monitor --debug
```

## Build & Install

Compile standalone binaries (no Bun required on target):

```bash
# Build for macOS ARM64
bun run build

# Build and install to ~/.local/bin
bun run build -- --install

# Run from anywhere
jiny-m --workdir /path/to/project monitor --debug
```

## Usage

```bash
# Monitor with debug logging
jiny-m monitor --debug

# Monitor from a different directory
jiny-m --workdir /path/to/project monitor

# Check once and exit
jiny-m monitor --once

# Show monitoring state
jiny-m state

# Validate config
jiny-m config validate
```

## Configuration

Config lives in `.jiny/config.json`:

```jsonc
{
  "channels": {
    "email": {
      "inbound": {
        "host": "imap.example.com",
        "port": 993,
        "tls": true,
        "username": "you@example.com",
        "password": "${IMAP_PASSWORD}"       // env var substitution
      },
      "outbound": {
        "host": "smtp.example.com",
        "port": 465,
        "secure": true,
        "username": "you@example.com",
        "password": "${SMTP_PASSWORD}"
      }
    }
  },
  "patterns": [
    {
      "name": "support",
      "channel": "email",
      "rules": {
        "sender": { "exact": ["user@example.com"] },
        "subject": { "prefix": ["Jiny"] }
      },
      "attachments": {
        "enabled": true,
        "allowedExtensions": [".pdf", ".pptx", ".docx", ".xlsx", ".png", ".jpg"],
        "maxFileSize": "25mb"
      }
    }
  ],
  "reply": {
    "enabled": true,
    "mode": "opencode",
    "opencode": {
      "model": "SiliconFlow/Pro/zai-org/GLM-4.7",
      "smallModel": "SiliconFlow/Qwen/Qwen2.5-7B-Instruct"
    }
  }
}
```

## Architecture

See [DESIGN.md](DESIGN.md) for the full architecture documentation.

```
Inbound Channel (IMAP) → MessageRouter → ThreadManager → Worker (OpenCode AI)
                                                              ↓
                                                        MCP reply_message tool
                                                              ↓
                                                   Outbound Channel (SMTP)
```

## Development

```bash
# Run in dev mode
bun jiny-m monitor --debug

# Run tests
bun test

# Build standalone binaries
bun run build
```

## License

Private
