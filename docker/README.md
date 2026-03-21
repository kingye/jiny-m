# jiny-M Docker

Run jiny-M in a container with all dev tools for bootstrapping (self-development).

## Prerequisites

- [Podman](https://podman.io/) or [Docker](https://www.docker.com/)
- A jiny-M config file (`.jiny/config.json`)
- An OpenCode config file (`opencode.jsonc`) with your AI provider API keys

## Directory Structure

Prepare these on your host machine before starting:

```
your-project/
  .jiny/
    config.json        # jiny-M config (IMAP/SMTP, patterns, alerting)
  workspace/           # jiny-M workspace (thread dirs, messages)
  opencode.jsonc       # OpenCode global config (API keys, providers)
```

## Volume Mounts

The container mounts three paths from the host:

| Host path | Container path | Purpose |
|-----------|---------------|---------|
| `.jiny/config.json` | `/opt/jiny-m/.jiny/config.json` | jiny-M configuration (email accounts, patterns, alerting) |
| `workspace/` | `/workspace/` | Thread directories, messages, reply history |
| `opencode.jsonc` | `/root/.config/opencode/opencode.jsonc` | OpenCode AI config (API keys, providers, model settings) |

## Quick Start with Podman

### 1. Build the image

```bash
cd /path/to/jiny-m
podman build -t jiny-m:latest -f docker/Dockerfile .
```

If behind a proxy:

```bash
podman build \
  --build-arg http_proxy=http://your-proxy:8080 \
  --build-arg https_proxy=http://your-proxy:8080 \
  -t jiny-m:latest -f docker/Dockerfile .
```

### 2. Prepare config files

```bash
mkdir -p my-jiny/.jiny my-jiny/workspace
```

Create `my-jiny/.jiny/config.json`:

```json
{
  "channels": {
    "email": {
      "inbound": {
        "host": "imap.example.com",
        "port": 993,
        "username": "your-email@example.com",
        "password": "your-password"
      },
      "outbound": {
        "host": "smtp.example.com",
        "port": 465,
        "username": "your-email@example.com",
        "password": "your-password"
      }
    }
  },
  "patterns": [
    {
      "name": "default",
      "channel": "email",
      "rules": {
        "sender": { "exact": ["your-sender@example.com"] }
      }
    }
  ],
  "workspace": { "folder": "/workspace" },
  "reply": {
    "enabled": true,
    "mode": "opencode",
    "opencode": {
      "model": "anthropic/claude-sonnet-4-20250514",
      "enabled": true
    }
  },
  "alerting": {
    "enabled": true,
    "recipient": "your-email@example.com",
    "batchIntervalMinutes": 5,
    "healthCheck": {
      "enabled": true,
      "intervalHours": 6
    }
  }
}
```

Copy or symlink your `opencode.jsonc`:

```bash
cp ~/.config/opencode/opencode.jsonc my-jiny/opencode.jsonc
```

### 3. Run the container

```bash
podman run -d --name jiny-m \
  -v $(pwd)/my-jiny/.jiny:/opt/jiny-m/.jiny \
  -v $(pwd)/my-jiny/workspace:/workspace \
  -v $(pwd)/my-jiny/opencode.jsonc:/root/.config/opencode/opencode.jsonc:ro \
  jiny-m:latest
```

### 4. Check logs

```bash
podman logs -f jiny-m
```

You should see:
```
s6-rc: info: service jiny-m successfully started
[INFO] Starting monitor...
[INFO] Startup notification sent {"recipient":"your-email@example.com","version":"0.1.5"}
[INFO] Monitoring started {"folder":"INBOX"}
```

### 5. Stop / restart

```bash
podman stop jiny-m
podman start jiny-m
podman rm jiny-m       # remove container
```

## Quick Start with Docker Compose

### 1. Set up environment

```bash
cd docker/
cp .env.example .env
```

Edit `.env` with your paths:

```env
JINY_CONFIG_DIR=/path/to/your/.jiny
JINY_WORKSPACE_DIR=/path/to/your/workspace
OPENCODE_CONFIG=/path/to/your/opencode.jsonc
GH_TOKEN=ghp_...  # optional, for GitHub PR workflow
```

### 2. Build and run

```bash
docker compose up -d --build
docker compose logs -f
```

### 3. Stop

```bash
docker compose down
```

## Bootstrapping Setup

To use jiny-M for self-development:

### 1. Start the container (as above)

### 2. Send first email

Send an email to the monitored account with a subject matching your pattern (e.g., `jiny: bootstrapping jiny-M`). In the body, instruct the AI to clone the repository:

```
Clone the jiny-M repository from https://github.com/kingye/jiny-m.git
```

### 3. Add system.md to the thread

After jiny-M creates the thread directory, copy the example `system.md`:

```bash
# Find the thread directory name
ls workspace/

# Copy the bootstrapping system prompt
cp docker/system.md.example workspace/bootstrapping-jiny-M/system.md
```

The `system.md` tells the AI how to work with the jiny-M codebase: git workflow, build commands, deploy steps.

### 4. Send development instructions

Send follow-up emails in the same thread:

```
Implement feature X. Create a feature branch, run tests, and commit.
```

```
Push the branch and create a PR.
```

```
Build the new release.
```

```
Deploy the new release.
```

After deploy, jiny-M restarts automatically (via s6 supervisor) and sends a startup health check email confirming the new version is running.

## Tools Included

| Tool | Version | Purpose |
|------|---------|---------|
| bun | latest | JavaScript/TypeScript runtime |
| git | latest | Version control |
| opencode | latest | AI coding agent |
| gh | latest | GitHub CLI (PRs, issues) |
| ripgrep | latest | Fast code search |
| jq | latest | JSON processing |
| s6-overlay | 3.1.6.2 | Process supervisor (auto-restart) |

## Troubleshooting

### Container exits immediately

Check if config is mounted correctly:

```bash
podman run --rm --entrypoint="" jiny-m:latest cat /opt/jiny-m/.jiny/config.json
```

### SMTP/IMAP connection fails

Check network access from inside the container:

```bash
podman run --rm --entrypoint="" jiny-m:latest curl -v telnet://imap.example.com:993
```

If behind a proxy, pass proxy settings:

```bash
podman run -d --name jiny-m \
  -e http_proxy=http://proxy:8080 \
  -e https_proxy=http://proxy:8080 \
  -v ... \
  jiny-m:latest
```

### OpenCode can't find API keys

Verify the opencode.jsonc is mounted:

```bash
podman run --rm --entrypoint="" jiny-m:latest cat /root/.config/opencode/opencode.jsonc
```
