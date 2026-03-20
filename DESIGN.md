# Jiny-M: Channel-Agnostic AI Agent

## Overview
Jiny-M is an AI agent that operates through messaging channels. Users interact with the agent by sending messages (email, FeiShu, Slack, etc.), and the agent responds autonomously using OpenCode AI. The agent maintains conversation context per thread, enabling coherent multi-turn interactions.

**Core Concept:** Messaging channels are the interface; AI is the brain. The architecture is channel-agnostic — adding a new channel (e.g., FeiShu) requires only implementing an inbound and outbound adapter.

## Use Cases
- **Support Agent** - Automatically respond to support inquiries with context-aware replies
- **Task Automation** - Execute tasks requested via messages and respond with results
- **Notification Processor** - Process notifications and take action based on content
- **Personal Assistant** - Manage schedules, reminders, and information requests via messaging
- **Cross-Channel Agent** - Same AI agent accessible through multiple channels (email, FeiShu, etc.)

## Architecture

### High-Level Flow
```
User sends message (any channel) → Pattern Match → Thread Queue → Worker (AI) → Reply via originating channel
                                                         ↓
                                               Thread-based context
                                               (remembers conversation)
```

### Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                  Inbound Channels (run in parallel)               │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐           │
│  │ Email Inbound│  │FeiShu Inbound│  │ Slack Inbound│ (future)  │
│  │  (IMAP)      │  │  (WebHook)   │  │  (WebHook)   │           │
│  │              │  │              │  │              │           │
│  │ matchMessage │  │ matchMessage │  │ matchMessage │           │
│  │ deriveThread │  │ deriveThread │  │ deriveThread │           │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘           │
└─────────┼──────────────────┼──────────────────┼─────────────────┘
          │                  │                  │
          ▼                  ▼                  ▼
    InboundMessage     InboundMessage     InboundMessage
    (channel:"email")  (channel:"feishu") (channel:"slack")
          │                  │                  │
          └────────┬─────────┘──────────────────┘
                   ▼
┌─────────────────────────────────────────────────────────────────┐
│                      MessageRouter                               │
│  - Receives ALL messages from all channels                       │
│  - Delegates matching to adapter.matchMessage()                  │
│  - Delegates thread naming to adapter.deriveThreadName()         │
│  - Calls threadManager.enqueue() (fire-and-forget)               │
└────────────────────────┬────────────────────────────────────────┘
                         │ enqueue (non-blocking)
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│                      ThreadManager                               │
│  maxConcurrentThreads: 3 (only 3 workers run at same time)      │
│  maxQueueSizePerThread: 10                                       │
│                                                                   │
│  Active workers (3 slots):                                       │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐              │
│  │ Thread A    │  │ Thread B    │  │ Thread C    │              │
│  │ Queue: [m2] │  │ Queue: []   │  │ Queue: []   │              │
│  │ Worker: m1  │  │ Worker: m3  │  │ Worker: m4  │              │
│  │  (busy)     │  │  (busy)     │  │  (busy)     │              │
│  └─────────────┘  └─────────────┘  └─────────────┘              │
│                                                                   │
│  Waiting for slot:                                               │
│  ┌─────────────┐  ┌─────────────┐                                │
│  │ Thread D    │  │ Thread E    │                                │
│  │ Queue: [m5] │  │ Queue: [m6] │                                │
│  │ (no worker) │  │ (no worker) │                                │
│  └─────────────┘  └─────────────┘                                │
│                                                                   │
│  When Thread B finishes m3 (queue empty):                        │
│    → Slot freed → Thread D gets a worker, starts processing m5  │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│                   Worker (per thread)                             │
│  Picks up message from queue → processes → picks next            │
│                                                                   │
│  1. MessageStorage.store(msg) → messages/<ts>/received.md        │
│  2. Save inbound attachments (whitelisted)                       │
│  3. PromptBuilder.buildPrompt(msg) → prompt with <reply_context> │
│  4. OpenCode.generateReply(msg) — SSE streaming, may take mins   │
│  5. <reply_context> carries channel type + channelMetadata        │
│                                                                   │
│  ┌─────────────────────────────────────────┐                     │
│  │  MCP Tool: reply_message                │                     │
│  │  1. Read context.channel                │                     │
│  │  2. Instantiate OutboundAdapter         │                     │
│  │  3. adapter.sendReply(...)              │                     │
│  └──────────────────┬──────────────────────┘                     │
│                     │                                             │
│  6. Fallback: ThreadManager sends via OutboundAdapter            │
│  7. storage.storeReply()                                         │
│  8. Worker picks next message from queue                         │
└─────────────────────┼───────────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Outbound Channels (Reply)                     │
│  context.channel → ChannelRegistry → OutboundAdapter             │
│  ┌───────────────┐  ┌───────────────┐  ┌───────────────┐        │
│  │ Email Outbound│  │FeiShu Outbound│  │ Slack Outbound│ (future)│
│  │  (SMTP)       │  │  (API)        │  │  (API)        │        │
│  │               │  │               │  │               │        │
│  │ quoteOriginal │  │ format for    │  │ format for    │        │
│  │ threading hdrs│  │ feishu msg    │  │ slack blocks  │        │
│  │ markdown→HTML │  │ card/rich text│  │ mrkdwn format │        │
│  └───────────────┘  └───────────────┘  └───────────────┘        │
└─────────────────────────────────────────────────────────────────┘
```

### Components
1. **Inbound Adapters** - Channel-specific message receivers (Email/IMAP, FeiShu/WebHook, etc.)
2. **Outbound Adapters** - Channel-specific reply senders (Email/SMTP, FeiShu/API, etc.)
3. **Channel Registry** - Lookup adapters by channel type
4. **Message Router** - Delegates matching/naming to adapters, dispatches to thread queues
5. **Thread Manager** - Per-thread queues with concurrency-limited workers
6. **Worker (OpenCode Service)** - AI processing with SSE streaming, session management
7. **Prompt Builder** - Builds channel-agnostic prompts from InboundMessage
8. **MCP Reply Tool** - `reply_message` tool, routes replies to OutboundAdapter based on channel
9. **Message Storage** - Persist messages and replies per thread in `messages/` directories
10. **State Manager** - Track processed UIDs per channel, handle migrations
11. **Security Module** - Path validation, file size/extension checks for attachments

## Core Abstractions

### Channel Types (`src/channels/types.ts`)

```typescript
type ChannelType = "email" | "feishu" | "slack" | string;

interface InboundMessage {
  id: string;                        // Internal ID
  channel: ChannelType;              // "email" | "feishu" | ...
  channelUid: string;                // Channel-specific ID (email UID, feishu msg ID)
  sender: string;                    // Display name
  senderAddress: string;             // Canonical address (email addr, feishu user ID)
  recipients: string[];              // To addresses/IDs
  topic: string;                     // Subject for email, title for feishu
  content: MessageContent;
  timestamp: Date;
  threadRefs?: string[];             // Email: References; FeiShu: thread ID
  replyToId?: string;                // Email: In-Reply-To; FeiShu: parent msg ID
  externalId?: string;               // Email: Message-ID; FeiShu: message ID
  attachments?: MessageAttachment[];
  metadata: Record<string, any>;     // Channel-specific (email headers, feishu chat_id, etc.)
  matchedPattern?: string;
}

interface MessageContent {
  text?: string;                     // Plain text
  html?: string;                     // HTML (email)
  markdown?: string;                 // Markdown (feishu, slack)
}

interface MessageAttachment {
  filename: string;
  contentType: string;
  size: number;
  content?: Buffer;                  // Binary content (during processing only)
  savedPath?: string;                // Set after saving to disk
}

interface InboundAdapter {
  readonly channelType: ChannelType;
  deriveThreadName(message: InboundMessage, patternMatch?: PatternMatch): string;
  matchMessage(message: InboundMessage, patterns: ChannelPattern[]): PatternMatch | null;
  start(options: InboundAdapterOptions): Promise<void>;
  stop(): Promise<void>;
}

interface InboundAdapterOptions {
  onMessage: (message: InboundMessage) => Promise<void>;  // fire-and-forget
  onError: (error: Error) => void;
}

interface OutboundAdapter {
  readonly channelType: ChannelType;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  sendReply(
    originalMessage: InboundMessage,
    replyText: string,
    attachments?: Array<{ filename: string; path: string; contentType: string }>
  ): Promise<{ messageId: string }>;
}

interface ChannelPattern {
  name: string;
  channel: ChannelType;
  enabled?: boolean;
  rules: Record<string, any>;       // Channel-specific matching rules
  attachments?: AttachmentConfig;    // Inbound attachment download config
}

interface PatternMatch {
  patternName: string;
  channel: ChannelType;
  matches: Record<string, any>;      // Channel-specific match details
}
```

### Email Channel Pattern Rules

```typescript
// rules for channel: "email"
{
  sender?: {
    exact?: string[];                // ["kingye@petalmail.com"] (case-insensitive)
    domain?: string[];               // ["roedl.com"]
    regex?: string;                  // ".*@company\\.com"
  };
  subject?: {
    prefix?: string[];               // ["jiny"] — stripped from thread name
    regex?: string;                  // "\\[URGENT\\].*"
  };
}
```

Each channel defines its own matching rules. For email, matching is on sender + subject. For FeiShu (future), matching might be on sender + group_id or message content keywords.

### Thread Name Derivation

Each inbound adapter implements `deriveThreadName()` with channel-specific logic:

- **Email**: Strip reply prefixes (Re:, Fwd:, 回复:, 转发:), strip configured subject prefix (e.g., "Jiny:"), sanitize for filesystem. Supports broad separator recognition (`:`, `-`, `_`, `~`, `|`, `/`, `&`, `$`, etc.)
- **FeiShu** (future): Derive from group name, topic, or message content
- **Slack** (future): Derive from channel name + thread topic

## Thread Manager & Queue

### Per-Thread Queue with Concurrency Control

```typescript
class ThreadManager {
  private threadQueues = new Map<string, ThreadQueue>();
  private activeWorkers = 0;
  private maxConcurrentThreads: number;     // default: 3
  private maxQueueSizePerThread: number;    // default: 10
  private pendingThreads: string[] = [];

  // Called by MessageRouter — non-blocking (fire-and-forget)
  enqueue(message, threadName, patternMatch): void {
    let queue = this.threadQueues.get(threadName);
    if (!queue) {
      queue = new ThreadQueue(threadName);
      this.threadQueues.set(threadName, queue);
    }

    if (queue.size >= this.maxQueueSizePerThread) {
      logger.warn('Thread queue full, dropping message', { thread: threadName });
      return;
    }

    queue.push({ message, patternMatch });
    this.tryProcessNext(threadName);
  }

  private tryProcessNext(threadName): void {
    const queue = this.threadQueues.get(threadName);
    if (!queue || queue.isEmpty || queue.processing) return;

    if (this.activeWorkers >= this.maxConcurrentThreads) {
      if (!this.pendingThreads.includes(threadName)) {
        this.pendingThreads.push(threadName);
      }
      return;  // No slot, wait
    }

    this.activeWorkers++;
    queue.processing = true;

    this.processMessage(queue).finally(() => {
      queue.processing = false;
      this.activeWorkers--;

      if (!queue.isEmpty) this.tryProcessNext(threadName);

      // Check pending threads for free slot
      while (this.pendingThreads.length > 0 && this.activeWorkers < this.maxConcurrentThreads) {
        const next = this.pendingThreads.shift()!;
        this.tryProcessNext(next);
      }
    });
  }

  private async processMessage(queue): Promise<void> {
    const { message, patternMatch } = queue.shift();
    // 1. storage.store(message, threadName)
    // 2. opencode.generateReply(message, threadPath, messageDir)
    // 3. If replySentByTool → done
    // 4. Fallback: outboundAdapter.sendReply(message, replyText)
    // 5. storage.storeReply(...)
  }
}
```

### Key Properties
- **Inbound channels run in parallel** — Email monitor and FeiShu monitor listen simultaneously
- **Fire-and-forget enqueue** — MessageRouter enqueues and returns immediately
- **Each thread has its own FIFO queue** — Order preserved within a conversation
- **One worker per thread** — Sequential processing within a thread (order matters)
- **Different threads process in parallel** — Up to `maxConcurrentThreads` (default: 3)
- **Concurrency limit** — Prevents overloading the AI service
- **In-memory queues** — Lost on restart, IMAP re-fetch handles recovery
- **Queue overflow** — Messages dropped with warning when `maxQueueSizePerThread` exceeded

## Worker (OpenCode Service)

### Session-Based Thread Management
Each thread has a dedicated OpenCode session persisted in `session.json`. This enables:
- **Memory** - AI remembers previous replies in the conversation
- **Coherence** - Consistent responses across the thread
- **Context** - Full conversation history available
- **Debugging** - Can inspect/replay sessions in OpenCode TUI

### Worker Processing Flow
```
Worker picks message from thread queue
       ↓
MessageStorage.store(msg, threadName)
  → creates messages/<timestamp>/ directory
  → saves whitelisted inbound attachments
  → writes received.md
  → returns { messageDir, threadPath }
       ↓
ensureThreadOpencodeSetup(threadPath)
  → writes opencode.json with:
    - model + small_model from config
    - MCP config: jiny_reply server
    - permission: { "*": "allow" }
  → staleness check: rewrites if model, tool path, or JINY_ROOT changed
       ↓
OpenCodeService.generateReply(msg, threadPath, messageDir)
       ↓
PromptBuilder.buildPrompt(msg, threadPath, messageDir)
  → buildPromptContext(): reads messages/*/ (stripped + truncated)
  → Incoming message body (stripped)
  → <reply_context> with channel + channelMetadata + incomingMessageDir
  → Reply instructions: use reply_message tool
       ↓
promptWithProgress() (SSE streaming):
  1. Subscribe to SSE events ({ directory: threadPath })
  2. Fire promptAsync() (returns immediately)
  3. Process events (filtered by sessionID, deduped):
     - server.connected → confirm SSE stream alive
     - message.updated → capture modelID/providerID
     - message.part.updated → accumulate parts, detect tool calls
     - session.status → track busy/retry (deduped)
     - session.idle → done, collect result
     - session.error → handle (ContextOverflow → new session + retry)
  4. Activity-based timeout: 2 min of silence → timeout
  5. Progress log every 10s (elapsed, parts, activity, silence)
  6. Step start/finish: log model used per step (detects main vs small_model usage)
       ↓
OpenCode calls reply_message MCP tool
       ↓
MCP Tool (reply-tool.ts):
  1. Deserialize ReplyContext → get context.channel
  2. Instantiate OutboundAdapter for context.channel
     - "email" → EmailOutboundAdapter (SMTP)
     - "feishu" → FeiShuOutboundAdapter (future)
  3. Read messages/<incomingMessageDir>/received.md for full body (quoted history)
  4. adapter.sendReply(originalMessage, replyText, attachments)
  5. MessageStorage.storeReply() → reply.md alongside received.md
  6. Write .jiny/reply-sent.flag (signal file)
       ↓
Check replySentByTool:
  1. SSE parts → tool call detected in real-time (check output for "Error:" prefix)
  2. checkToolUsed(accumulatedParts) — post-hoc
  3. checkSignalFile(.jiny/reply-sent.flag) — last-resort fallback
       ↓
If tool NOT used → ThreadManager fallback:
  → Get OutboundAdapter for message.channel
  → adapter.sendReply(message, replyText, attachments)
  → storage.storeReply()
       ↓
Worker picks next message from thread queue
```

### Context Management Strategy

To balance context depth with token limits, the agent uses a multi-layered approach:

1. **Thread Files (Durable)** - Last 5 markdown files stored in thread folder
   - Includes both received messages and AI auto-replies
   - Files store full body (including quoted history) as canonical record
   - When loaded into prompt context, `stripQuotedHistory()` + truncation applied
   - Files are limited to 400 chars each (1,000 chars total) in prompt

2. **OpenCode Session (Ephemeral)** - Conversation memory maintained by OpenCode
   - Persists only while server instance is alive
   - Lost on jiny-m restart
   - Contains condensed message history
   - More efficient than raw files

3. **Incoming Message (Current)** - Latest message being processed
   - Body stripped of quoted reply history
   - Topic cleaned of repeated Reply/Fwd prefixes
   - Limited to 2,000 chars

**Context Limits:**
```
MAX_FILES_IN_CONTEXT = 10          // Total markdown files to load
MAX_EMAIL_REPLY_FILES = 2          // Email reply files specifically
MAX_BODY_IN_PROMPT = 2000          // Incoming message body
MAX_PER_FILE = 400                 // Per-file context
MAX_TOTAL_CONTEXT = 2000           // Combined thread context
MAX_TOTAL_PROMPT = 6000            // Total prompt to AI
```

**Thread File Processing:**
- Received files: Extract body (between `## Name (time)` and `---`), then `stripQuotedHistory()` at prompt load time
- Reply files: Skipped (already visible in conversation history)
- General files: Included as-is (useful for reference documents)
- Method: `PromptBuilder.buildPromptContext()`

### OpenCode Server Architecture

A single shared OpenCode server handles all threads. Each thread session operates in its designated directory via the `query.directory` parameter.

```
┌─────────────────────────────────────────────────────────────┐
│                    OpenCodeService                          │
│                                                             │
│  Single Server (auto-port: 49152+)                          │
│       ↓                                                     │
│  Shared Client                                              │
│       ↓                                                     │
│  ┌─────────────────────────────────────┐                    │
│  │ Sessions (per-thread directory)     │                    │
│  │                                     │                    │
│  │ Thread A → session.json + .opencode/│                    │
│  │ Thread B → session.json + .opencode/│                    │
│  │ Thread C → session.json + .opencode/│                    │
│  └─────────────────────────────────────┘                    │
│                                                             │
│  Server lives until CLI exits                               │
└─────────────────────────────────────────────────────────────┘
```

#### Key Points:
- **Single server** - Auto-started on first request, auto-finds free port (49152+)
- **Health check** - Before reusing server, `isServerAlive()` pings with 3s timeout; restarts if dead
- **Startup timeout** - 15 seconds for `opencode serve` CLI to start
- **Shared client** - One client instance for all sessions (supports concurrent sessions for parallel workers)
- **MCP tool per-thread** - `opencode.json` in each thread dir configures `jiny_reply` MCP server
- **Per-session directory** - `query.directory` parameter tells OpenCode where to work
- **Thread isolation** - Each thread has its own session and `.opencode/` directory
- **Model config via opencode.json** - `model` and `small_model` written to per-thread config; staleness check detects changes
- **SSE streaming** - `promptAsync()` + `event.subscribe()` for real-time progress and tool detection
- **Activity-based timeout** - No fixed deadline, only times out if AI goes silent for 2 min
- **Fallback** - If SSE subscription fails, falls back to blocking `prompt()` with 5-min timeout
- **Signal file detection** - Last-resort: checks `.jiny/reply-sent.flag` if SSE missed tool call events

### SSE Event Logging

Events from `promptWithProgress()` are logged with deduplication:
- **Step start**: Logged at INFO with step number and model name (from `message.updated` event). Shows which model (main vs `small_model`) is used for each step.
- **Step finish**: Logged at DEBUG with cost, token counts (input/output/reasoning/cache), and reason.
- **Tool calls**: Logged at INFO only on status change per part ID (pending → running → completed). Avoids duplicate "running" logs from repeated SSE updates.
- **Tool input**: reply_message tool args logged at DEBUG on `pending` (message preview, context preview, attachments)
- **Tool errors**: reply_message `completed` with error output logged at WARN (not treated as success)
- **Session status**: Logged at DEBUG only on status type change (avoids duplicate "Session busy" logs)
- **Progress**: Every 10s at INFO with elapsed time, part count, current activity (reasoning/text/tool name), silence duration
- **Raw SSE**: First 5 events logged at DEBUG (before session filter) for diagnostics
- **Message updated**: Model info (`providerID/modelID`) captured from `message.updated` events for step logging

### ContextOverflow Recovery

When the accumulated conversation history in an OpenCode session exceeds the model's context limit:

```
AI Prompt → ContextOverflowError (detected via SSE session.error)
    ↓
Log warning with old sessionId
    ↓
Create new session (clears history)
    ↓
Retry prompt with new session (blocking fallback)
    ↓
Thread files still provide recent conversation context
```

## MCP Reply Tool

### Overview

OpenCode is given a `reply_message` MCP tool so the AI agent can send replies directly through the originating channel. The tool is a stateless local MCP server (`src/mcp/reply-tool.ts`) spawned via stdio transport, configured per-thread via `opencode.json`.

The reply context (recipient, topic, channel, threading metadata) is serialized as a JSON block in the user prompt. The AI passes this context verbatim when calling the tool.

### Reply Context (`src/mcp/context.ts`)

```typescript
interface ReplyContext {
  channel: ChannelType;              // "email" | "feishu" — routing key for outbound adapter
  threadName: string;
  sender: string;                    // Who sent the original message
  recipient: string;                 // Who to reply to
  topic: string;                     // Subject / title
  timestamp: string;
  contentPreview?: string;           // Stripped body for AI display
  incomingMessageDir?: string;       // For reading full body from messages/<dir>/received.md
  externalId?: string;               // Email: Message-ID; FeiShu: msg_id
  threadRefs?: string[];             // Email: References; FeiShu: thread_id
  uid: string;                       // Channel-specific UID
  channelMetadata?: Record<string, any>;
  // Email: { messageId, references, inReplyTo, headers, fromName }
  // FeiShu: { chatId, messageType, ... }
}
```

**Serialization helpers:**
- `serializeContext(message: InboundMessage, threadName, incomingMessageDir?)` → JSON string
- `deserializeAndValidateContext(json)` → validated `ReplyContext` (with JSON sanitization fallback for AI-corrupted input)

### MCP Tool: `reply_message`

```
MCP Server (stdio subprocess, cwd = thread dir):
  1. Parse context JSON, validate required fields
  2. Read context.channel → determine which outbound adapter to use
  3. Load config from JINY_ROOT/.jiny/config.json
  4. Instantiate OutboundAdapter for context.channel:
     - "email" → EmailOutboundAdapter (loads SMTP config, creates SmtpService)
     - "feishu" → FeiShuOutboundAdapter (future)
  5. Validate attachments via PathValidator (exclude .opencode/, .jiny/)
  6. Reconstruct InboundMessage from context
  7. Read messages/<incomingMessageDir>/received.md → extract full body for quoted history
  8. adapter.sendReply(originalMessage, replyText, attachments)
  9. MessageStorage.storeReply(threadPath, replyText, message, messageDir)
  10. Write .jiny/reply-sent.flag (signal file for cross-process detection)
  11. Return success message
```

### Per-Thread OpenCode Config (`opencode.json`)

Written by `ensureThreadOpencodeSetup()` in each thread directory:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "SiliconFlow/Pro/zai-org/GLM-4.7",
  "small_model": "SiliconFlow/Qwen/Qwen2.5-7B-Instruct",
  "permission": { "*": "allow" },
  "mcp": {
    "jiny_reply": {
      "type": "local",
      "command": ["bun", "run", "<absolute-path>/src/mcp/reply-tool.ts"],
      "environment": { "JINY_ROOT": "<root-dir>" },
      "enabled": true,
      "timeout": 60000
    }
  }
}
```

- `model` and `small_model` from jiny-m config (`reply.opencode.model` / `reply.opencode.smallModel`)
- `small_model` used by OpenCode for lightweight internal tasks (title generation, compaction)
- Model is NOT passed per-prompt — OpenCode reads from project config
- Staleness check includes model, tool path, JINY_ROOT — changes trigger rewrite + new session
- `JINY_ROOT` tells the MCP tool where to find the project config

### Fallback Behavior

| Scenario | What Happens |
|----------|-------------|
| OpenCode uses `reply_message` tool successfully | Detected via SSE (checks output for errors); `replySentByTool: true`, skips fallback |
| `reply_message` tool fails (e.g. invalid JSON) | SSE shows `completed` but output starts with "Error:" → stays false; AI may retry |
| AI reconstructs context instead of passing verbatim | JSON sanitization attempts repair; if parse still fails, tool returns error |
| AI returns text without using tool | `session.idle` fires; ThreadManager sends via OutboundAdapter directly |
| AI takes very long but keeps working | SSE events keep arriving → no timeout; progress logged every 10s |
| AI goes silent for 2 minutes | Activity timeout → checks signal file → if sent, success; otherwise error |
| SSE subscription fails | Falls back to blocking `prompt()` with 5-min timeout |
| OpenCode server dies between messages | Health check detects it, restarts automatically |
| ContextOverflowError | Detected via SSE `session.error` → new session → retry (blocking) |
| Thread queue full | Message dropped with warning; IMAP re-fetch recovers on restart |

### Signal File (`.jiny/reply-sent.flag`)

Cross-process detection mechanism for when the MCP tool sends the reply but tool parts are missing from the prompt response (or the prompt times out).

**Format:** Single-line JSON
```json
{"sentAt":"2026-03-19T13:09:43Z","to":"user@example.com","messageId":"<123@smtp>","attachmentCount":1}
```

**Lifecycle:**
1. Written by MCP reply-tool after successful outbound send
2. Read by `OpenCodeService.checkSignalFile()` as fallback detection
3. Deleted immediately after detection to prevent stale signals

### MCP Tool Logging

The MCP tool logs to `<thread-dir>/.jiny/reply-tool.log` (file-based, since stdout is reserved for MCP stdio protocol). Each thread gets its own log file. Logs include:
- Tool startup (cwd, JINY_ROOT, pid)
- Each handler step (context validation, config loading, path resolution, attachment validation, outbound send, storage)
- On context validation failure: raw context preview (first 500 chars) for debugging AI-corrupted JSON
- Errors with stack traces

## Directory Structure

### Project Root
```
<root-dir>/
├── .jiny/
│   ├── config.json                      # Project config
│   └── email/                           # Email channel state
│       ├── .state.json                  # IMAP monitor state (seq, uid, migration)
│       └── .processed-uids.txt         # Processed UIDs
├── workspace/
│   ├── <thread-dir-1>/                  # Thread directory (OpenCode cwd for this thread)
│   │   ├── messages/                    # Per-message directories (conversation turns)
│   │   │   ├── 2026-03-19_23-02-20/    # Turn 1
│   │   │   │   ├── received.md          # Incoming message (full body, canonical record)
│   │   │   │   ├── reply.md             # AI reply (alongside received)
│   │   │   │   └── report.pdf           # Saved inbound attachment
│   │   │   └── 2026-03-19_23-10-00/    # Turn 2
│   │   │       ├── received.md
│   │   │       └── reply.md
│   │   ├── .jiny/                       # Internal state only
│   │   │   ├── session.json             # AI session state
│   │   │   ├── reply-tool.log           # MCP tool log (per-thread)
│   │   │   └── reply-sent.flag          # Signal file (transient)
│   │   ├── .opencode/                   # OpenCode internal directory
│   │   ├── opencode.json                # Per-thread OpenCode config
│   │   └── opencode_skills.pptx         # AI-generated working files
│   └── <thread-dir-2>/
│       └── ...
└── src/
    ├── channels/
    │   ├── types.ts                     # InboundMessage, adapter interfaces
    │   ├── registry.ts                  # ChannelRegistry
    │   └── email/
    │       ├── inbound.ts               # EmailInboundAdapter
    │       ├── outbound.ts              # EmailOutboundAdapter
    │       └── config.ts                # EmailChannelConfig
    ├── core/
    │   ├── message-router.ts            # MessageRouter
    │   ├── thread-manager.ts            # ThreadManager (queues + workers)
    │   ├── message-storage.ts           # MessageStorage (channel-agnostic)
    │   ├── state-manager.ts             # StateManager (per-channel state dirs)
    │   ├── email-parser.ts              # Utility: stripQuotedHistory, truncateText, etc.
    │   └── security/                    # PathValidator
    ├── services/
    │   ├── opencode/
    │   │   ├── index.ts                 # Worker: server/session/SSE
    │   │   └── prompt-builder.ts        # PromptBuilder (channel-agnostic)
    │   ├── imap/                        # Used internally by email/inbound.ts
    │   └── smtp/                        # Used internally by email/outbound.ts
    ├── mcp/
    │   ├── reply-tool.ts                # reply_message MCP tool
    │   └── context.ts                   # ReplyContext serialization
    └── cli/
        └── commands/
            └── monitor.ts               # Wiring: adapters → router → thread manager
```

### Message Markdown Format (Unified)

```yaml
---
channel: email
uid: "12345"
external_id: "<abc123@mail.example.com>"
matched_pattern: "support"
---
```

```markdown
## Sender Name (10:15 AM)

Message body content here (full body including quoted history preserved)

*📎 Attachments:*
  - **report.pdf** (application/pdf, 52410 bytes) ✅ saved
  - **malware.exe** (application/x-msdownload, 12345 bytes) ⛔ skipped
---
```

### Message Directory Naming

Per-message directories use the message timestamp:
```
messages/2026-03-19_23-02-20/     # Timestamp from message
messages/2026-03-19_23-02-20_2/   # Collision: counter suffix added
```

Each directory contains:
- `received.md` — incoming message (always present)
- `reply.md` — AI reply (written alongside received when reply is sent)
- `<attachment>.pdf` — saved inbound attachments (if whitelist config enabled)

## Configuration

### Config Structure (`config.json`)

```json
{
  "channels": {
    "email": {
      "inbound": {
        "host": "imap.163.com",
        "port": 993,
        "tls": true,
        "username": "jiny283@163.com",
        "password": "${IMAP_PASSWORD}"
      },
      "outbound": {
        "host": "smtp.163.com",
        "port": 465,
        "secure": true,
        "username": "jiny283@163.com",
        "password": "${SMTP_PASSWORD}"
      },
      "watch": {
        "pollInterval": 30000,
        "folder": "INBOX",
        "useIdle": true
      }
    }
  },
  "patterns": [
    {
      "name": "sap",
      "channel": "email",
      "rules": {
        "sender": { "exact": ["kingye@petalmail.com"] },
        "subject": { "prefix": ["jiny"] }
      },
      "attachments": {
        "enabled": true,
        "allowedExtensions": [".pdf", ".pptx", ".docx", ".xlsx", ".png", ".jpg", ".txt", ".md"],
        "maxFileSize": "25mb",
        "maxAttachmentsPerEmail": 10
      }
    }
  ],
  "workspace": {
    "folder": "./workspace"
  },
  "worker": {
    "maxConcurrentThreads": 3,
    "maxQueueSizePerThread": 10
  },
  "reply": {
    "enabled": true,
    "mode": "opencode",
    "opencode": {
      "model": "SiliconFlow/Pro/zai-org/GLM-4.7",
      "smallModel": "SiliconFlow/Qwen/Qwen2.5-7B-Instruct",
      "systemPrompt": "You are an AI assistant.\nRespond professionally and concisely.",
      "includeThreadHistory": true
    },
    "attachments": {
      "enabled": true,
      "maxFileSize": "10mb",
      "allowedExtensions": [".ppt", ".pptx", ".doc", ".docx", ".txt", ".md"]
    }
  },
  "output": {
    "format": "text"
  }
}
```

### Types

```typescript
interface Config {
  channels: {
    email?: EmailChannelConfig;
    feishu?: FeiShuChannelConfig;     // future
  };
  patterns: ChannelPattern[];
  workspace: WorkspaceConfig;
  worker?: WorkerConfig;
  reply: ReplyConfig;
  output?: OutputConfig;
}

interface EmailChannelConfig {
  inbound: ImapConfig;
  outbound: SmtpConfig;
  watch?: WatchConfig;
}

interface WorkerConfig {
  maxConcurrentThreads?: number;     // default: 3
  maxQueueSizePerThread?: number;    // default: 10
}

interface ReplyConfig {
  enabled: boolean;
  mode: 'static' | 'opencode';
  text?: string;
  opencode?: OpenCodeConfig;
  attachments?: AttachmentConfig;
}

interface OpenCodeConfig {
  enabled: boolean;
  hostname?: string;
  model?: string;                    // "provider/model" format
  smallModel?: string;               // "provider/model" for lightweight tasks
  systemPrompt?: string;
  includeThreadHistory?: boolean;
}

interface AttachmentConfig {
  enabled: boolean;
  maxFileSize: number | string;      // bytes or "10mb"
  allowedExtensions: string[];
  maxAttachmentsPerEmail?: number;   // for inbound (default: 10)
}
```

### State Files (Per-Channel)

```
.jiny/
├── config.json                       # Main config
└── email/                            # Email channel state
    ├── .state.json                   # { lastSequenceNumber, lastProcessedTimestamp, migrationVersion }
    └── .processed-uids.txt           # One UID per line, append-only
```

Each channel manages its own state independently. For email, state tracks IMAP sequence numbers and processed UIDs. For FeiShu (future), state would track webhook cursors or message timestamps.

### Backward Compatibility

- Old config with top-level `imap`/`smtp`/`patterns` auto-converted to `channels.email` + unified `patterns` format
- Old `received.md` without `channel` field treated as `"email"`
- Old `<reply_context>` without `channel` field treated as `"email"`
- Old `.jiny/.state.json` migrated to `.jiny/email/.state.json`
- `buildPromptContext()` has legacy fallback that reads `.jiny/*.md` if `messages/` doesn't exist

## Inbound Attachment Download

Configurable per pattern via `attachments` in the pattern config.

**Processing flow:**
1. `mailparser.simpleParser()` parses MIME and provides `att.content` (Buffer)
2. Inbound adapter preserves the Buffer on the `MessageAttachment` object
3. `MessageStorage.store()` calls `saveAttachments()` before writing `received.md`
4. For each attachment: check extension whitelist → check size limit → check count limit → sanitize filename → resolve collisions → write to disk
5. Buffer freed after write (`attachment.content = undefined`)
6. Attachment metadata in `received.md` shows saved/skipped status

**Security measures:**
- Extension allowlist (not blocklist) — only explicitly permitted types saved
- File size limit per attachment (human-readable: `"25mb"`, `"150kb"`)
- Max attachments per message (prevents resource exhaustion)
- Filename sanitization: basename only, no path traversal, no hidden files, no null bytes, max 200 chars, Unicode NFC normalized
- Double extension defense: only the **last** extension is checked
- Collision handling: counter suffix (e.g. `report_2.pdf`)

**Memory note:** In-memory approach (Phase 1). Attachment Buffers are loaded by mailparser during parsing. A future optimization could use streaming (`imapflow.download()` + `MailParser` streaming API) for constant memory usage regardless of message size.

## Stripping Strategy

`stripQuotedHistory()` is only applied at **AI prompt consumption time**, never at storage or reply time.

| Stage | Where | Strips? | Purpose |
|-------|-------|---------|---------|
| **Storage** (`.md` files) | `MessageStorage.store()` | **No** | Canonical record — full body preserved |
| **AI Prompt Context** | `PromptBuilder.buildPromptContext()` | **Yes** | Keep AI focused on latest message |
| **AI Prompt Body** | `PromptBuilder.buildPrompt()` | **Yes** | Incoming message body for AI |
| **`<reply_context>`** | `serializeContext()` | **Yes** (contentPreview only) | Lean context in prompt |
| **Outbound Reply** | `OutboundAdapter.sendReply()` | **No** | Full thread history in reply |
| **MCP Tool Quoting** | `reply-tool.ts` | **No** | Reads `.md` file for full body |

**Code Organization:**
- `stripQuotedHistory()` and `truncateText()` in `src/core/email-parser.ts`
- `deriveThreadName()` in email adapter (channel-specific thread naming)
- `parseFileSize()` in `src/utils/helpers.ts` — parses human-readable sizes like `"25mb"`, `"150kb"`

## Security Considerations
- Environment variables for credentials (never commit passwords)
- Validate regex patterns to prevent ReDoS
- Rate limiting for AI API calls
- Path validation for all file operations (PathValidator)
- Attachment security: extension allowlist, size limit, filename sanitization
- MCP tool: validate context before processing
- `permission: { "*": "allow" }` in opencode.json prevents headless blocking; consider tightening for production

## Migration

### Migration v3: Channel-Agnostic State

Runs automatically on first startup after upgrade (via `StateManager.ensureInitialized()`):

1. Move `.jiny/.state.json` → `.jiny/email/.state.json`
2. Move `.jiny/.processed-uids.txt` → `.jiny/email/.processed-uids.txt`
3. Add `channel: email` to existing `received.md` frontmatter (if missing)
4. Update `migrationVersion` to 3

**Backward compatibility:** Parser treats missing `channel` field in `received.md` as `"email"`. Missing state files in `.jiny/email/` triggers check for legacy `.jiny/.state.json`.

### Previous Migrations
- **v1**: Initialize UID set from mailbox (IMAP fetch)
- **v2**: Move `.jiny/*.md` files to `messages/<timestamp>/` per-message directories

## Known Issues / TODO

- Some models (e.g. GLM-4.7) reconstruct the `<reply_context>` JSON instead of passing it verbatim. Defensive JSON sanitization handles common corruption (smart quotes, trailing commas). Models may need multiple retry attempts before succeeding.
- Model sometimes uses built-in tools (glob, read, task) before calling `reply_message`. System prompt instructions mitigate this but model behavior varies.
