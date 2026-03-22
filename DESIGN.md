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
│  5. <reply_context> is a base64 opaque token (metadata only)      │
│                                                                   │
│  ┌─────────────────────────────────────────┐                     │
│  │  MCP Tool: reply_message                │                     │
│  │  1. Decode base64 context token         │                     │
│  │  2. Read received.md → full body        │                     │
│  │  3. Build full reply (AI + quoted hst)  │                     │
│  │  4. Instantiate OutboundAdapter         │                     │
│  │  5. adapter.sendReply(fullReplyText)    │                     │
│  │  6. storage.storeReply(fullReplyText)   │                     │
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
│  │ markdown→HTML │  │ format for    │  │ format for    │        │
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
12. **Alert Service** - Error alert digests + periodic health check reports via email
13. **Command System** - Email `/command` parsing and execution (e.g., `/model` for model switching)

### Design Principles: Component Responsibilities

Each component has a single, clear responsibility. Data flows through the system with transformations happening at well-defined boundaries.

**InboundAdapter** (e.g., `EmailInboundAdapter`)
- Boundary between the external world and the internal system
- Parses raw data from the channel (e.g., raw email from IMAP)
- Cleans and normalizes data at the boundary: strips redundant `Re:/回复:` from subject, cleans bracket-nested duplicates and redundant prefixes in body (`cleanEmailBody`)
- Produces a clean `InboundMessage` — all downstream consumers receive clean data without needing to clean it themselves

**MessageStorage**
- Pure storage: reads and writes files to disk
- No transformation, no cleaning, no business logic
- Stores `received.md` and `reply.md` exactly as given
- `received.md` = the clean inbound message (cleaned by InboundAdapter)
- `reply.md` = the full reply as sent (built by Reply Tool)

**PromptBuilder**
- Read-only consumer of stored data
- Reads `received.md` and `reply.md` for conversation history
- Strips quoted history (`stripQuotedHistory`) and truncates to fit AI token budget
- Builds the user prompt with stripped body + opaque base64 context token
- The context token contains only metadata references (`incomingMessageDir`), never real content

**Reply Tool** (MCP `reply_message`)
- Orchestrator for the reply flow
- Decodes the opaque context token to get metadata (channel, recipient, `incomingMessageDir`, etc.)
- Reads `received.md` to get the full message body (the clean source of truth)
- Builds the full reply in markdown: AI reply text + quoted history (`prepareBodyForQuoting` → includes recent historical messages)
- Delegates sending to OutboundAdapter/SmtpService (passes the full markdown reply)
- Delegates storage to MessageStorage (stores the same full reply as `reply.md`)
- `reply.md` reflects exactly what was sent to the recipient

**SmtpService** (and other transport services)
- Dumb transport: receives markdown, converts to HTML, adds email headers, sends
- Adds `Re:` to subject, sets `In-Reply-To` and `References` headers for threading
- Does NOT build quoted history, does NOT clean or transform content
- Just a transport tool that converts format and sends
- **Auto-reconnect**: `sendReply()` and `sendMail()` wrap their internal send with a one-retry-on-connection-error pattern. If the error message (lowercased) contains `"connect"`, `"econn"`, or `"timeout"`, the service calls `reconnect()` (disconnect + connect) and retries once. Other errors are thrown immediately.
- **Shared instance**: A single `SmtpService` (via `EmailOutboundAdapter`) is created at monitor startup and shared across ThreadManager fallback, MCP reply tool (creates its own instance), and AlertService. The adapter stays connected for the process lifetime — consumers must not call `disconnect()` after individual sends.

**ReplyContext** (base64 opaque token)
- Metadata-only: contains channel type, sender, recipient, subject, `incomingMessageDir`, threading IDs
- Never contains real content (no message body, no preview)
- The AI passes it through unchanged (opaque base64 string)
- The Reply Tool decodes it to locate the stored message and reconstruct threading metadata

### Data Flow Summary

```
Email arrives
  → InboundAdapter: parse, clean subject + body → clean InboundMessage
    → MessageStorage: store as-is → received.md (clean source of truth)
      → PromptBuilder: read received.md, strip + truncate for AI → prompt
        → AI: receives stripped body + opaque context token
          → Reply Tool: decode context, read received.md (full body)
            → prepareBodyForQuoting(): AI reply + full quoted history (including recent historical messages)
            → SmtpService: markdown→HTML, add headers, send via SMTP
            → MessageStorage: store full reply → reply.md (= what was sent)
```

### End-to-End Sequence Diagram

```
┌──────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐
│ IMAP │  │ Inbound  │  │ Message  │  │  Thread  │  │ Prompt   │  │ OpenCode │  │  Reply   │  │  SMTP    │
│Server│  │ Adapter  │  │ Storage  │  │ Manager  │  │ Builder  │  │  (AI)    │  │  Tool    │  │ Service  │
└──┬───┘  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘
   │           │             │             │             │             │             │             │
   │ new email │             │             │             │             │             │             │
   ├──────────>│             │             │             │             │             │             │
   │           │             │             │             │             │             │             │
   │      parse raw email    │             │             │             │             │             │
   │      clean at boundary: │             │             │             │             │             │
   │       stripReplyPrefix  │             │             │             │             │             │
   │         (subject)       │             │             │             │             │             │
   │       cleanEmailBody    │             │             │             │             │             │
   │         (body text)     │             │             │             │             │             │
   │           │             │             │             │             │             │             │
   │      clean InboundMessage             │             │             │             │             │
   │           ├─────────────┼────────────>│             │             │             │             │
   │           │             │             │             │             │             │             │
   │           │             │  store()    │             │             │             │             │
   │           │             │<────────────┤             │             │             │             │
   │           │             │             │             │             │             │             │
   │           │        write received.md  │             │             │             │             │
   │           │        (as-is, no logic)  │             │             │             │             │
   │           │             │             │             │             │             │             │
   │           │             │             │ buildPrompt()             │             │             │
   │           │             │             ├────────────>│             │             │             │
   │           │             │             │             │             │             │             │
   │           │             │  read received.md + reply.md           │             │             │
   │           │             │  (conversation history)   │             │             │             │
   │           │             │<─────────────┤             │             │             │             │
   │           │             │             │             │             │             │             │
   │           │             │        stripQuotedHistory  │             │             │             │
   │           │             │        + truncate for      │             │             │             │
   │           │             │          token budget      │             │             │             │
   │           │             │             │             │             │             │             │
   │           │             │        serializeContext()  │             │             │             │
   │           │             │        → base64 token      │             │             │             │
   │           │             │          (metadata only,   │             │             │             │
   │           │             │           no body)         │             │             │             │
   │           │             │             │             │             │             │             │
   │           │             │             │  prompt:    │             │             │             │
   │           │             │             │  stripped body            │             │             │
   │           │             │             │  + base64 token           │             │             │
   │           │             │             │             │             │             │             │
   │           │             │             │ generateReply()           │             │             │
   │           │             │             ├─────────────┼────────────>│             │             │
   │           │             │             │             │             │             │             │
   │           │             │             │             │    AI processes prompt    │             │
   │           │             │             │             │    calls reply_message:   │             │
   │           │             │             │             │      message = AI reply   │             │
   │           │             │             │             │      context = base64     │             │
   │           │             │             │             │      attachments = [...]  │             │
   │           │             │             │             │             │             │             │
   │           │             │             │             │             ├────────────>│             │
   │           │             │             │             │             │             │             │
   │           │             │             │             │        decode base64 token│             │
   │           │             │             │             │        → channel, sender, │             │
   │           │             │             │             │          recipient,       │             │
   │           │             │             │             │          incomingMsgDir   │             │
   │           │             │             │             │             │             │             │
   │           │             │  read received.md         │             │             │             │
   │           │             │  (full clean body)        │             │             │             │
   │           │             │<──────────────────────────┼─────────────┤             │             │
   │           │             │──────────────────────────>│─────────────>             │             │
   │           │             │             │             │             │             │             │
│           │             │             │             │   prepareBodyForQuoting()│             │
    │           │             │             │             │   (current + historical  │             │
    │           │             │             │             │    messages, max 5 total)│             │
   │           │             │             │             │             │             │             │
   │           │             │             │             │        fullReplyText =    │             │
   │           │             │             │             │          AI reply text    │             │
   │           │             │             │             │          + quoted history │             │
   │           │             │             │             │          (markdown)       │             │
   │           │             │             │             │             │             │             │
   │           │             │             │             │   sendReply(fullReplyText)│             │
   │           │             │             │             │             ├────────────>│             │
   │           │             │             │             │             │             │             │
   │           │             │             │             │             │   markdown  │             │
   │           │             │             │             │             │    → HTML   │             │
   │           │             │             │             │             │   add Re:   │             │
   │           │             │             │             │             │   add hdrs  │             │
   │           │             │             │             │             │   send SMTP │────> recipient
   │           │             │             │             │             │             │             │
   │           │             │             │             │             │  {messageId}│             │
   │           │             │             │             │             │<────────────┤             │
   │           │             │             │             │             │             │             │
   │           │             │  storeReply(fullReplyText)│             │             │             │
   │           │             │<──────────────────────────┼─────────────┤             │             │
   │           │             │             │             │             │             │             │
   │           │             │  write reply.md           │             │             │             │
   │           │             │  (= exactly what was sent)│             │             │             │
   │           │             │             │             │             │             │             │
   │           │             │             │             │  write signal file        │             │
   │           │             │             │             │  (.jiny/reply-sent.flag)  │             │
   │           │             │             │             │             │             │             │
   │           │             │             │             │  return success           │             │
   │           │             │             │             │             │             │             │
   │           │             │             │  detect signal file /     │             │             │
   │           │             │             │  SSE tool completion      │             │             │
   │           │             │             │             │             │             │             │
   │           │             │             │  worker done,             │             │             │
   │           │             │             │  pick next from queue     │             │             │
```

**Key invariants in this flow:**
- **InboundAdapter** is the only place where data is cleaned (subject + body)
- **MessageStorage** stores data as-is, no transformation
- **PromptBuilder** is the only place where history is stripped (for AI token budget)
- **Reply Tool** is the only place where the full reply is assembled (AI text + quoted history)
- **SmtpService** is a dumb transport: markdown→HTML + headers + send
- **ReplyContext** is an opaque base64 token carrying only metadata references, never content
- **reply.md** = exactly what the recipient receives (minus HTML formatting)

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
  // Optional: send a fresh (non-reply) alert/notification email
  sendAlert?(recipient: string, subject: string, body: string): Promise<{ messageId: string }>;
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
   → reads .jiny/model-override (if exists, takes priority over config)
   → writes opencode.json with:
     - model from override or config
     - MCP config: jiny_reply server
     - permission: { "*": "allow", "question": "deny" } (headless mode)
   → staleness check: rewrites if model, tool path, JINY_ROOT, or tools changed
   → if config changed: restart OpenCode server + create new session
     (server caches model from opencode.json at startup — must restart to switch)
       ↓
OpenCodeService.generateReply(msg, threadPath, messageDir)
       ↓
PromptBuilder.buildPrompt(msg, threadPath, messageDir)
  → buildPromptContext(): reads messages/*/ (stripped + truncated)
  → Incoming message body (stripped)
   → <reply_context> with channel + channelMetadata + incomingMessageDir
   → Reply instructions: use reply_message tool
   → Mode instructions: plan mode vs build mode (from user's keywords)
   → Thread-specific system.md (if exists)
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
  4. Activity-based timeout: 5 min of silence → timeout (10 min when tool running)
  5. Progress log every 10s (elapsed, parts, activity, silence)
  6. Step start/finish: log model used per step (detects main vs small_model usage)
       ↓
OpenCode calls reply_message MCP tool
       ↓
MCP Tool (reply-tool.ts):
  1. Decode base64 context token → validate required fields
  2. Instantiate OutboundAdapter for context.channel
     - "email" → EmailOutboundAdapter (SMTP)
     - "feishu" → FeiShuOutboundAdapter (future)
  3. Read messages/<incomingMessageDir>/received.md for full body
  4. Build fullReplyText = AI reply + prepareBodyForQuoting(full body + recent historical messages)
  5. adapter.sendReply(originalMessage, fullReplyText, attachments)
     → SmtpService: markdown→HTML, add Re: + threading headers, send
  6. MessageStorage.storeReply(fullReplyText) → reply.md = what was sent
  7. Write .jiny/reply-sent.flag (signal file)
       ↓
Check replySentByTool:
  1. SSE parts → tool call detected in real-time (check output for "Error:" or "MCP error" prefix)
  2. checkToolUsed(accumulatedParts) — post-hoc
  3. checkSignalFile(.jiny/reply-sent.flag) — last-resort fallback
       ↓
Stale session detection:
  If replySentByTool=true but signal file missing:
    → Session is stale (OpenCode replayed cached results without invoking MCP tool)
    → Delete session file, create new session, retry prompt once
       ↓
If tool NOT used → ThreadManager fallback:
  → Get OutboundAdapter for message.channel (shared instance, already connected)
  → adapter.sendReply(message, replyText, attachments)
  → storage.storeReply()
  Note: adapter is NOT disconnected after send — it is a shared, long-lived
  resource managed at the monitor lifecycle level (see SmtpService notes above)
       ↓
Worker picks next message from thread queue
```

**Session lifecycle:**
- Sessions are created on first use per thread and persisted in `.jiny/session.json`
- On shutdown (SIGINT/SIGTERM): all session files are deleted to prevent stale sessions on restart
- On stale session detection: session file is deleted and a new session is created for retry

### Context Management Strategy

To balance context depth with token limits, the agent uses a multi-layered approach:

1. **Thread Files (Durable)** - Last 10 markdown files stored in thread folder
   - Includes both received messages and AI auto-replies
   - Files store full body (including quoted history) as canonical record
   - When loaded into prompt context, `stripQuotedHistory()` + truncation applied
   - Files are limited to 400 chars each (2,000 chars total) in prompt

2. **OpenCode Session (Ephemeral)** - Conversation memory maintained by OpenCode
   - Persists only while server instance is alive
   - Deleted on shutdown to prevent stale sessions on restart
   - Contains condensed message history
   - More efficient than raw files

3. **Incoming Message (Current)** - Latest message being processed
   - Body stripped of quoted reply history
   - Topic cleaned of repeated Reply/Fwd prefixes (at ingest time by InboundAdapter)
   - Limited to 2,000 chars

**Context Limits:**
```
MAX_FILES_IN_CONTEXT = 10          // Total markdown files to load
MAX_BODY_IN_PROMPT = 2000          // Incoming message body
MAX_PER_FILE = 400                 // Per-file context
MAX_TOTAL_CONTEXT = 2000           // Combined thread context
MAX_TOTAL_PROMPT = 6000            // Total prompt to AI
```

**Thread File Processing:**
- Received files: Extract body (between `## Name (time)` and `---`), then `stripQuotedHistory()` at prompt load time
- Reply files: Included with same extraction and stripping as received files
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
- **Headless mode** - `permission: { "question": "deny" }` blocks the interactive question tool; staleness check ensures it's set
- **Compiled reply-tool** - In Docker, `jiny-m-reply-tool` binary found at `/usr/local/bin/`; fallback to `bun run` in dev mode
- **SSE streaming** - `promptAsync()` + `event.subscribe()` for real-time progress and tool detection
- **Activity-based timeout** - No fixed deadline; times out if AI goes silent for 5 min (10 min when a tool is actively running, since OpenCode doesn't emit SSE events during tool execution or sub-agent work)
- **Fallback** - If SSE subscription fails, falls back to blocking `prompt()` with 5-min timeout
- **Signal file detection** - Last-resort: checks `.jiny/reply-sent.flag` if SSE missed tool call events
- **Stale signal cleanup** - Before each prompt, any leftover `reply-sent.flag` from a previous run is deleted to prevent false-positive detection
- **SSE force-close** - On timeout, `sseStream.return()` is called to force-unblock the `for await` loop immediately

### SSE Event Logging

Events from `promptWithProgress()` are logged with deduplication:
- **Step start**: Logged at INFO with step number and model name (from `message.updated` event). Shows which model (main vs `small_model`) is used for each step.
- **Step finish**: Logged at DEBUG with cost, token counts (input/output/reasoning/cache), and reason.
- **Tool calls**: Logged at INFO only on status change per part ID (pending → running → completed). Avoids duplicate "running" logs from repeated SSE updates.
- **Tool input**: reply_message tool args logged at INFO on `running` (message preview, context type/length, attachments). Tool details (command, path, pattern) logged for other tools.
- **Tool output**: reply_message output logged at INFO on `completed` (success or error)
- **Tool errors**: reply_message `completed` with error output logged at ERROR (MCP errors and application errors)
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

The reply context (recipient, topic, channel, threading metadata) is base64-encoded and embedded in the user prompt as `<reply_context>BASE64_TOKEN</reply_context>`. The AI passes this opaque token unchanged when calling the tool. The token contains only metadata references — never message body content.

### Reply Context (`src/mcp/context.ts`)

```typescript
interface ReplyContext {
  channel: ChannelType;              // "email" | "feishu" — routing key for outbound adapter
  threadName: string;
  sender: string;                    // Who sent the original message
  recipient: string;                 // Who to reply to
  topic: string;                     // Subject / title (cleaned at ingest, no Re:/回复: prefixes)
  timestamp: string;
  incomingMessageDir?: string;       // For reading full body from messages/<dir>/received.md
  externalId?: string;               // Email: Message-ID; FeiShu: msg_id
  threadRefs?: string[];             // Email: References; FeiShu: thread_id
  uid: string;                       // Channel-specific UID
  _nonce?: string;                   // Integrity nonce — must be present in token.
  channelMetadata?: Record<string, any>;
  // Email: { inReplyTo, from }
  // FeiShu: { chatId, messageType, ... }
}
```

**Serialization helpers:**
- `serializeContext(message, threadName, incomingMessageDir?)` → base64-encoded string (JSON → base64)
- `deserializeContext(encoded)` → validated `ReplyContext` (base64 → JSON → validate required fields)

### Token Integrity Validation

To prevent AI tampering with the opaque token, the system now includes integrity checks:

- **Nonce field**: `serializeContext()` adds a `_nonce` field (timestamp + random suffix). Missing nonce in older tokens is tolerated but logged.
- **Formatting detection**: `deserializeContext()` scans string fields for backticks (`` ` ``), escaped newlines (`\\n`), and escaped quotes (`\\\"`). If found, validation rejects the token with a clear error: "token appears modified … DO NOT decode or modify the token."
- **Stronger system prompt**: The AI receives explicit instructions not to decode, modify, re‑encode, or add any formatting to the token.

### MCP Tool: `reply_message`

```
MCP Server (stdio subprocess, cwd = thread dir):
  Tool schema: message (string), context (string, opaque base64 token), attachments (string[], optional)

  1. Decode base64 context token → JSON → validate required fields
  2. Read context.channel → determine which outbound adapter to use
  3. Load config from JINY_ROOT/.jiny/config.json
  4. Instantiate OutboundAdapter for context.channel:
     - "email" → EmailOutboundAdapter (loads SMTP config, creates SmtpService)
     - "feishu" → FeiShuOutboundAdapter (future)
  5. Validate attachments via PathValidator (exclude .opencode/, .jiny/)
  6. Reconstruct InboundMessage from context (content.text = empty)
  7. Read messages/<incomingMessageDir>/received.md → extract full body
  8. Build full reply markdown: AI reply text + prepareBodyForQuoting(full body + recent historical messages)
  9. adapter.sendReply(originalMessage, fullReplyText, attachments)
     → SmtpService: markdown→HTML, add threading headers, send via SMTP
  10. MessageStorage.storeReply(threadPath, fullReplyText, messageDir)
      → reply.md = exactly what was sent to the recipient
  11. Write .jiny/reply-sent.flag (signal file for cross-process detection)
  12. Return success message
```
 
### Historical Message Quoting

`prepareBodyForQuoting()` combines the current message with recent historical messages to provide conversation context in replies:

- **Current message**: The message being replied to (sender, timestamp, topic, full body)
- **Historical messages**: Reads `messages/` subdirectories sorted by timestamp (descending)
- **Limit**: `MAX_HISTORY_QUOTE = 5` messages total (current + up to 4 previous)
- **Format**: Each message formatted with `formatQuotedReply()` into markdown quoted blocks
- **Fallback**: If historical reading fails, falls back to single-message quoting with `formatQuotedReply()`

**Implementation** (`src/core/email-parser.ts`):
- `parseStoredMessage()` extracts sender, timestamp, topic, bodyText from stored `received.md` frontmatter
- `prepareBodyForQuoting(threadPath, currentMessage, maxHistory?, excludeMessageDir?)` orchestrates the collection and formatting
- `formatQuotedReply(sender, timestamp, subject, bodyText)` formats a single message as a quoted markdown block

**Frontmatter enhancement**: Stored `received.md` files now include `topic` and `timestamp` fields in YAML frontmatter for reliable historical reconstruction.

### Per-Thread OpenCode Config (`opencode.json`)

Written by `ensureThreadOpencodeSetup()` in each thread directory:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "SiliconFlow/Pro/zai-org/GLM-4.7",
  "small_model": "SiliconFlow/Qwen/Qwen2.5-7B-Instruct",
  "permission": {
    "*": "allow",
    "question": "deny"
  },
  "mcp": {
    "jiny_reply": {
      "type": "local",
      "command": ["/usr/local/bin/jiny-m-reply-tool"],
      "environment": { "JINY_ROOT": "<root-dir>" },
      "enabled": true,
      "timeout": 60000
    }
  }
}
```

**Tool command resolution** (`getReplyToolCommand()`):
1. Check for `jiny-m-reply-tool` next to the main binary (`process.argv[0]`)
2. Check common paths: `/usr/local/bin/jiny-m-reply-tool`, `/usr/bin/jiny-m-reply-tool`
3. Fallback (dev mode): `bun run <source>/src/mcp/reply-tool.ts`

**Disabled tools:**
- `question: "deny"` — jiny-M runs headless via email, no interactive terminal. The `question` tool would hang indefinitely.

**Staleness check**: Rewrites `opencode.json` if model, tool path, JINY_ROOT, or `permission.question` changed. When config changes, the OpenCode server is restarted (server caches model at startup) and a new session is created.
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
| AI goes silent for 5 minutes | Activity timeout (10 min if tool running) → force-closes SSE stream → checks signal file → if sent, success; otherwise error |
| SSE subscription fails | Falls back to blocking `prompt()` with 5-min timeout |
| OpenCode server dies between messages | Health check detects it, restarts automatically |
| ContextOverflowError | Detected via SSE `session.error` → new session → retry (blocking) |
| Thread queue full | Message dropped with warning; IMAP re-fetch recovers on restart |

### Signal File (`.jiny/reply-sent.flag`)

Cross-process detection mechanism for when the MCP tool sends the reply but tool parts are missing from the prompt response (or the prompt times out).

**Format:** Single-line JSON
```json
{"sentAt":"2026-03-19T13:09:43Z","channel":"email","recipient":"user@example.com","messageId":"<123@smtp>","attachmentCount":1}
```

**Lifecycle:**
1. **Cleanup**: Before starting a new prompt, `cleanupStaleSignalFile()` deletes any leftover file from a previous run
2. Written by MCP reply-tool after successful outbound send
3. Read by `OpenCodeService.checkSignalFile()` as fallback detection
4. Deleted immediately after detection to prevent stale signals

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
    │   ├── alert-service.ts             # AlertService (error alerts + health check)
    │   ├── state-manager.ts             # StateManager (per-channel state dirs)
    │   ├── logger.ts                    # Logger (EventEmitter, emits log events)
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
  alerting?: AlertingConfig;
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
- Filename sanitization: basename only, no path traversal, no hidden files, no null bytes, max 200 chars, Unicode NFC normalized. Dangerous character blocklist (`/\:*?"<>|` + control chars) allows CJK and other Unicode filenames.
- Double extension defense: only the **last** extension is checked
- Collision handling: counter suffix (e.g. `report_2.pdf`)

**Memory note:** In-memory approach (Phase 1). Attachment Buffers are loaded by mailparser during parsing. A future optimization could use streaming (`imapflow.download()` + `MailParser` streaming API) for constant memory usage regardless of message size.

## Stripping Strategy

`stripQuotedHistory()` is only applied at **AI prompt consumption time**, never at storage or reply time. Cleaning (`cleanEmailBody`) happens once at the InboundAdapter boundary — downstream consumers receive clean data.

| Stage | Where | Strips history? | Cleans? | Purpose |
|-------|-------|----|---------|---------|
| **Inbound** | `InboundAdapter` | **No** | **Yes** (`cleanEmailBody`, `stripReplyPrefix`) | Clean at boundary: fix bracket nesting, normalize Re: in subject |
| **Storage** (`.md` files) | `MessageStorage.store()` | **No** | **No** (data already clean) | Canonical record — full body preserved as-is |
| **AI Prompt Context** | `PromptBuilder.buildPromptContext()` | **Yes** | **No** | Keep AI focused on latest message |
| **AI Prompt Body** | `PromptBuilder.buildPrompt()` | **Yes** | **No** | Incoming message body for AI |
| **`<reply_context>`** | `serializeContext()` | N/A | N/A | Metadata-only base64 token — no body content |
| **Reply Tool** | `reply-tool.ts` | **No** | **No** | Reads `received.md` (already clean), builds full reply with quoted history (includes recent historical messages via `prepareBodyForQuoting`) |
| **Outbound** | `SmtpService` | **No** | **No** | Dumb transport: markdown→HTML, add headers, send |

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
- `permission: { "*": "allow", "question": "deny" }` in opencode.json allows all tools except interactive question
- `system.md` per-thread customization — file permissions should restrict who can modify thread directories

## Email Command System

Users can include commands in email messages using `/command` syntax. Commands are parsed and executed before the AI processes the message. Command lines are stripped from the body so the AI doesn't see them.

### Available Commands

| Command | Description | Example |
|---------|-------------|---------|
| `/model <id>` | Switch AI model for this thread | `/model SiliconFlow/Pro/deepseek-ai/DeepSeek-V3.2` |
| `/model` | List available models | `/model` |
| `/model reset` | Reset to default model from config | `/model reset` |
| `/plan` | Switch to plan mode (read-only, enforced by OpenCode) | `/plan` |
| `/build` | Switch to build mode (full execution, default) | `/build` |

### Architecture

```
Email body: "/model SiliconFlow/Pro/deepseek-ai/DeepSeek-V3.2\n\nImplement feature X"
  │
  ▼
CommandRegistry.parseCommands(body)
  → finds /model command
  │
  ▼
ModelCommandHandler.execute()
  → writes .jiny/model-override file (persists across messages)
  → deletes .jiny/session.json (force new session)
  │
  ▼
Strip /model line from body
  → "Implement feature X" (clean body for AI)
  │
  ▼
ensureThreadOpencodeSetup()
  → reads .jiny/model-override
  → uses override model instead of config default
  → writes opencode.json with override model
  → detects config changed → restarts OpenCode server
  │
  ▼
New OpenCode server starts (reads updated opencode.json)
  → creates new session with new model
  │
  ▼
AI processes with new model
```

### Model Override Persistence

The `/model` command writes the model ID to `.jiny/model-override` in the thread directory. This persists across messages — subsequent emails in the same thread use the overridden model until `/model reset` is sent.

```
<threadPath>/.jiny/
  model-override      ← contains model ID (e.g., "SiliconFlow/Pro/deepseek-ai/DeepSeek-V3.2")
  session.json        ← deleted on model switch (forces new session)
```

`ensureThreadOpencodeSetup()` reads the override file and uses it over the config default via `readModelOverride(threadPath)`.

### Plan/Build Mode

The `/plan` and `/build` commands switch between OpenCode's built-in plan mode (read-only, tool-level enforcement) and build mode (full execution).

- **Plan mode**: OpenCode enforces read-only at the tool level — the AI literally cannot edit files or run modifying commands. This is NOT a prompt-based suggestion; it's a hard constraint.
- **Build mode**: Default. Full execution — AI can edit files, run tests, commit, etc.

```
<threadPath>/.jiny/
  mode-override      ← contains "plan" when plan mode active
                       file absent = build mode (default)
```

When `promptWithProgress()` sends the prompt to OpenCode, it reads `mode-override` via `readModeOverride(threadPath)`. If plan mode is active, it passes `agent: "plan"` to `promptAsync()`. OpenCode then enforces read-only at the tool level for that prompt.

### Command Processing Flow (in `thread-manager.ts`)

```
processMessage():
  1. MessageStorage.store() → received.md (full body including commands)
  2. CommandRegistry.parseCommands() → find /model etc.
  3. Execute commands (model switch, etc.)
  4. Strip command lines from body
  5. If body is empty after stripping → inject system note:
     "[System: The following commands were executed. Confirm the results
      to the user and stop.]"
     This prevents the AI from exploring the codebase based on
     conversation history when only commands were sent.
  6. ensureThreadOpencodeSetup() → opencode.json (with model override)
     → if config changed: restart OpenCode server + create new session
  7. PromptBuilder → build prompt (cleaned body or command summary)
  8. OpenCode → AI processes → reply
```

### Adding New Commands

1. Create a handler implementing `CommandHandler` interface:
   ```typescript
   interface CommandHandler {
     name: string;          // e.g., "/mycommand"
     description: string;
     execute(context: CommandContext): Promise<CommandResult>;
   }
   ```
2. Register it in `CommandRegistry.registerDefaultHandlers()`
3. The command is automatically parsed from email bodies and executed

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

- Model sometimes uses built-in tools (glob, read, task) before calling `reply_message`. System prompt instructions mitigate this but model behavior varies.
- Reply context is base64-encoded to prevent AI from modifying it. If a model fails to pass the opaque token correctly, the reply tool will fail to decode it and return an error.

## Alerting & Health Check (v0.1.1)

### Overview

The AlertService monitors application logs for errors and sends batched alert digest emails. It also provides periodic health check reports summarizing message processing activity.

```
Logger (EventEmitter)
  │ emit('log', { level, message, meta, timestamp })
  ▼
AlertService
  │ ├── Error buffer → batched digest email (every N minutes)
  │ │     includes: error details, context lines, reply-tool.log tails
  │ └── Health stats → periodic summary email (every N hours)
  │       includes: messages received/matched/processed, per-thread breakdown
  ▼
OutboundAdapter.sendAlert() → SmtpService.sendMail() → SMTP
```

### Logger Enhancement (`src/core/logger.ts`)

The Logger class extends `EventEmitter` and emits a `'log'` event on every log call (all levels). Zero cost when no listeners are attached (checked via `listenerCount`).

```typescript
interface LogEvent {
  level: LogLevel;     // 'ERROR' | 'WARN' | 'INFO' | 'DEBUG'
  message: string;
  meta?: any;
  timestamp: string;   // ISO 8601
}
```

### OutboundAdapter.sendAlert()

Optional method on the `OutboundAdapter` interface for sending fresh (non-reply) emails:

```typescript
interface OutboundAdapter {
  // ... existing methods ...
  sendAlert?(recipient: string, subject: string, body: string): Promise<{ messageId: string }>;
}
```

`EmailOutboundAdapter` implements this via `SmtpService.sendMail()` — a new method that sends fresh emails without the `Re:` prefix or threading headers (`In-Reply-To`, `References`).

### Error Alerting

**Behavior:**
1. AlertService subscribes to all logger events
2. Maintains a rolling window of recent log lines (~100 lines) for context
3. Buffers ERROR-level events with: timestamp, message, meta, last 10 context lines
4. Every N minutes (configurable, default: 5), flushes the buffer into a digest email
5. For each error with `meta.thread`: reads tail of `<threadPath>/.jiny/reply-tool.log`
6. Sends via `outboundAdapter.sendAlert()`

**Self-protection:** Events with `meta._alertInternal: true` are skipped to prevent infinite loops. SMTP failures in the alert path use `console.error()` instead of `logger.error()`.

**Alert email format:**
```
Jiny-M Alert Digest
====================

3 error(s) in the last 5 minutes.
Time: 2026-03-20T10:00:00.000Z

Errors
------

### [10:04:54.303] Failed to process message
{
  "thread": "my-thread",
  "channel": "email",
  "error": "No activity from OpenCode for 120 seconds"
}

Context:
  [10:04:44] [INFO] AI processing... {"elapsed":"190s"...}
  [10:04:54] [WARN] Activity timeout: no events for 5 minutes
  [10:04:54] [ERROR] Failed to process message ...

Reply Tool Logs
---------------

### Thread: my-thread

[last 50 lines of reply-tool.log]
```

### Health Check

**Behavior:**
1. AlertService tracks processing stats by pattern-matching on well-known log messages
2. Every N hours (configurable, default: 24), sends a health check summary email
3. Stats are reset after each report

**Stats tracked (from log event messages):**

| Metric | Log message pattern |
|--------|-------------------|
| Messages received | `"Message received"` |
| Messages matched | `"Pattern matched"` |
| Replies via MCP tool | `"Reply sent via MCP reply_message tool"` |
| Replies via fallback | `"Reply sent via outbound adapter (fallback)"` |
| Processing errors | `"Failed to process message"` |
| Dropped messages | `"Queue full"` / `"dropping message"` |
| Per-thread breakdown | Thread name extracted from `meta.thread` |
| Live queue status | From `ThreadManager.getStats()` (injected via `QueueStatsProvider` interface) |

**Health check email format:**
```
Jiny-M Health Check Report
==========================

Period: 2026-03-20 04:00 -- 2026-03-20 10:00 UTC
Status: OK

Summary
-------
Messages received:     12
Messages matched:       8
Messages processed:     7
Replies sent:           7
  - via MCP tool:       6
  - via fallback:       1
Errors:                 0
Dropped (queue full):   0

Per-Thread Activity
-------------------
Thread: my-thread
  Received: 5 | Processed: 5 | Errors: 0

Current Queue Status
--------------------
Active workers: 0
Pending threads: 0
  (all queues empty)
```

### Configuration

```json
{
  "alerting": {
    "enabled": true,
    "recipient": "ops@example.com",
    "batchIntervalMinutes": 5,
    "maxErrorsPerBatch": 50,
    "subjectPrefix": "Jiny-M Alert",
    "includeReplyToolLog": true,
    "replyToolLogTailLines": 50,
    "healthCheck": {
      "enabled": true,
      "intervalHours": 6,
      "recipient": "ops-health@example.com"
    }
  }
}
```

```typescript
interface AlertingConfig {
  enabled: boolean;
  recipient: string;
  batchIntervalMinutes?: number;     // default: 5
  maxErrorsPerBatch?: number;        // default: 50
  subjectPrefix?: string;            // default: "Jiny-M Alert"
  includeReplyToolLog?: boolean;     // default: true
  replyToolLogTailLines?: number;    // default: 50
  healthCheck?: HealthCheckConfig;
}

interface HealthCheckConfig {
  enabled: boolean;
  intervalHours?: number;            // default: 24 (supports decimals, e.g. 0.5 = 30 min)
  recipient?: string;                // optional override, falls back to alerting.recipient
}
```

### Wiring (`monitor.ts`)

```
1. Load config → create ChannelRegistry
2. Register email adapters (inbound IMAP + outbound SMTP)
3. Create MessageStorage, OpenCodeService, ThreadManager, MessageRouter
4. Create AlertService (after ThreadManager, so it can be injected as QueueStatsProvider)
   → Pass: emailOutbound, alertingConfig, workspaceFolder, threadManager
   → alertService.start() subscribes to logger events, starts timers
5. Start all inbound adapters
6. On shutdown (SIGINT/SIGTERM): alertService.stop() flushes pending errors
```

The AlertService requires the email outbound adapter to be connected. It shares the same `EmailOutboundAdapter` instance registered in the `ChannelRegistry` with ThreadManager's fallback/direct reply paths. The adapter is connected once at monitor startup and stays connected for the process lifetime — AlertService does not manage the connection lifecycle itself. If SMTP connection fails at startup, alerting is skipped with a warning. If the connection drops later, `SmtpService.sendMail()`'s auto-reconnect handles recovery transparently.

## Bootstrapping: Using jiny-M to Develop jiny-M

### Overview

jiny-M can be used to develop itself — a bootstrapping setup where the AI agent receives development instructions via email, makes code changes, runs tests, builds releases, and deploys them. The system runs in a Docker container with a supervisor that handles restarts after deployment.

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Docker Container                          │
│                                                                  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                  s6-overlay (supervisor)                    │  │
│  │                                                            │  │
│  │  ┌──────────────┐           ┌──────────────┐              │  │
│  │  │   jiny-M     │           │   OpenCode   │              │  │
│  │  │  (monitor)   │           │   (server)   │              │  │
│  │  │              │           │              │              │  │
│  │  │  watches     │           │  AI backend  │              │  │
│  │  │  email       │           │  for coding  │              │  │
│  │  └──────┬───────┘           └──────────────┘              │  │
│  │         │                                                  │  │
│  │         │  On deploy: replace binary → s6 auto-restarts    │  │
│  └─────────┼──────────────────────────────────────────────────┘  │
│            │                                                     │
│  Volumes (mounted from host):                                    │
│    /opt/jiny-m/.jiny/config.json   ← config (from host)         │
│    /opt/jiny-m/.env                ← secrets (Bun auto-loads)    │
│    /opt/jiny-m/workspace/          ← workspace (from host)       │
│      bootstrapping-jiny-M/         ← thread directory            │
│        system.md                   ← thread-specific AI prompt   │
│        jiny-m/                     ← git clone of repo           │
│        messages/                   ← email conversation          │
│    /root/.config/opencode/         ← OpenCode config (from host) │
│      opencode.jsonc                ← API keys, providers         │
│                                                                  │
│  Binaries:                                                       │
│    /usr/local/bin/jiny-m           ← main CLI (compiled)         │
│    /usr/local/bin/jiny-m-reply-tool← MCP tool (compiled)         │
│                                                                  │
│  Dev tools: bun, git, opencode, ripgrep, gh, jq                 │
└─────────────────────────────────────────────────────────────────┘
```

### Key Features

#### Thread-Specific System Prompt (`system.md`)

If a `system.md` file exists in a thread directory, its content is appended to the AI's system prompt for that thread. This enables domain-specific behavior per conversation without code changes.

```
<threadPath>/
  system.md       ← optional, thread-specific system prompt
  messages/       ← conversation history
  opencode.json   ← per-thread OpenCode config
```

**PromptBuilder** reads `system.md` in `buildSystemPrompt(threadPath)`:
- File exists → append content to system prompt
- File missing → no-op (standard system prompt only)

This is a generic feature — not limited to bootstrapping. Any thread can have a `system.md` for domain-specific instructions (e.g., "you are a support agent for product X", "you are a code reviewer for repo Y").

#### Plan/Build Mode

Plan/build mode is controlled via email commands (`/plan`, `/build`), not prompt-based keyword detection. OpenCode enforces plan mode at the tool level — the AI cannot edit files or run modifying commands when plan mode is active. See the [Email Command System](#email-command-system) section for details.

#### Headless Mode (Disabled Interactive Tools)

jiny-M runs headless via email — no interactive terminal. The `question` tool is denied in `opencode.json` (`permission: { "question": "deny" }`). If the AI needs clarification, it should include its question in the reply email and wait for the user to respond in the next email.

#### Startup Health Check Email

When the monitor starts, it sends a one-time startup notification email to the configured alerting recipient. This confirms:
- jiny-M started successfully
- Version number
- Timestamp

This is essential for the deploy flow: after the AI replaces the binary and triggers a restart, the user receives this email to know the new version is running and ready.

#### Build and Deploy Workflow

Build and deploy are independent operations. The user can request either one separately or both together via email instructions. The AI executes them as bash commands — no special jiny-M feature needed, just `system.md` instructions.

**Build** (when instructed):
```
1. cd jiny-m && bun test           ← run tests first
2. bun build --compile cli.ts      ← compile standalone binary
   --outfile /tmp/jiny-m-new
3. /tmp/jiny-m-new --version       ← verify build
4. Report results to user
```

**Deploy** (when instructed):
```
1. Verify /tmp/jiny-m-new exists
2. cp /tmp/jiny-m-new /usr/local/bin/jiny-m
3. Reply "deploying, restarting..."
4. s6-svc -r /run/service/jiny-m   ← trigger supervisor restart
   → jiny-M stops
   → supervisor restarts with new binary
   → new jiny-M sends startup health check email
   → user receives "started v0.1.6" email
   → user continues conversation
```

**Build and Deploy** (when instructed):
```
Run Build steps, then Deploy steps in sequence.
```

### Deploy Restart Sequence

```
User email: "deploy the new release"
  │
  ▼
AI (in OpenCode):
  1. cp /tmp/jiny-m-new /usr/local/bin/jiny-m
  2. Send reply: "deploying, restarting..."
  3. s6-svc -r /run/service/jiny-m
  │
  ▼
s6 supervisor detects jiny-M exit:
  → restarts jiny-M with new binary
  │
  ▼
New jiny-M starts:
  → connects to IMAP/SMTP
  → sends startup health check email
  → resumes monitoring
  │
  ▼
User receives:
  1. Reply email: "deploying, restarting..."
  2. Health check email: "jiny-M v0.1.6 started"
  → user continues sending instructions
```

### Docker Setup

**Dockerfile** (`docker/Dockerfile`):
- Base: `oven/bun:latest` (multi-stage build)
- Dev tools: git, ripgrep, jq, curl, inotify-tools
- s6-overlay for process supervision (auto-detects x86_64/aarch64)
- OpenCode CLI
- GitHub CLI (for PR workflow)
- Two compiled binaries: `jiny-m` (main) + `jiny-m-reply-tool` (MCP tool)
- jiny-M source at `/opt/jiny-m-src/` (for rebuilding during bootstrapping)

**Volume mounts** (4 volumes from host):
```yaml
services:
  jiny-m:
    build:
      context: ..
      dockerfile: docker/Dockerfile
    volumes:
      - ${JINY_CONFIG_DIR}:/opt/jiny-m/.jiny          # config.json (with ${VAR} refs)
      - ${JINY_ENV_FILE}:/opt/jiny-m/.env:ro           # secrets (Bun auto-loads)
      - ${JINY_WORKSPACE_DIR}:/opt/jiny-m/workspace    # thread dirs, messages
      - ${OPENCODE_CONFIG}:/root/.config/opencode/opencode.jsonc:ro  # AI provider config
    environment:
      - GH_TOKEN            # GitHub CLI auth
      - GIT_USER_NAME       # git commit author
      - GIT_USER_EMAIL      # git commit email
    restart: unless-stopped
```

**s6 service** (`docker/s6-rc.d/jiny-m/run`):
```bash
#!/bin/bash
cd /opt/jiny-m

# Load .env (for both bash script and Bun)
if [ -f .env ]; then
  set -a; source .env; set +a
fi

# Configure git/gh from GH_TOKEN (if provided)
if [ -n "$GH_TOKEN" ]; then
  git config --global url."https://${GH_TOKEN}@github.com/".insteadOf "https://github.com/"
  git config --global user.name "${GIT_USER_NAME:-jiny-m}"
  git config --global user.email "${GIT_USER_EMAIL:-jiny-m@bot}"
fi

exec /usr/local/bin/jiny-m monitor --workdir /opt/jiny-m
```

**Secrets management:**
- `config.json` uses `${VAR}` syntax (e.g., `${IMAP_PASSWORD}`)
- `ConfigManager.expandEnvVars()` substitutes from `process.env`
- Bun auto-loads `.env` from `/opt/jiny-m/.env` (working directory)
- The s6 run script sources `.env` before starting (for GH_TOKEN in bash)

**Local model connectivity:**
- Inside container, `host.containers.internal` (podman) or `host.docker.internal` (docker) reaches the host machine
- On macOS with podman machine: resolves automatically to `192.168.127.254`
- Use in `opencode.jsonc`: `"baseURL": "http://host.containers.internal:11434/v1"`

### Example `system.md` for Bootstrapping

```markdown
You are developing the jiny-M project itself (bootstrapping).

## Repository
The jiny-M git repository should be at: ./jiny-m/
If not yet cloned: git clone https://github.com/kingye/jiny-m.git

## Development Workflow
- Always create a feature branch: git checkout -b feat/<name>
- After changes, run tests: cd jiny-m && bun test
- Commit with clear messages describing what changed and why
- Push and create PR when instructed

## Build (when instructed)
1. cd jiny-m && bun test
2. bun build --compile cli.ts --outfile /tmp/jiny-m-new
3. /tmp/jiny-m-new --version
4. Report: version, binary size, test results

## Deploy (when instructed)
1. Verify /tmp/jiny-m-new exists
2. Reply to confirm deployment is starting
3. cp /tmp/jiny-m-new /usr/local/bin/jiny-m
4. s6-svc -r /run/service/jiny-m
Note: jiny-M will restart. A startup health check email confirms readiness.

## Build and Deploy (when instructed)
Run Build steps, then Deploy steps in sequence.

## References
- See jiny-m/DESIGN.md for architecture and component responsibilities
- See jiny-m/CHANGELOG.md for version history
- See jiny-m/CLAUDE.md for coding conventions (use Bun, not Node)
```

### Files for Bootstrapping

```
docker/
  Dockerfile                  # Full dev environment (multi-stage, multi-arch)
  docker-compose.yml          # Volume mounts, env vars
  .env.example                # Template for secrets and paths
  README.md                   # Setup, mounts, bootstrapping, troubleshooting
  s6-rc.d/
    jiny-m/
      type                    # "longrun"
      run                     # Service run script (bash, sources .env, configures git)
  system.md.example           # Example system.md for bootstrapping
```

### Implementation Changes in jiny-M

| # | Feature | File | Description |
|---|---------|------|-------------|
| 1 | `system.md` support | `src/services/opencode/prompt-builder.ts` | Read optional `<threadPath>/system.md`, append to system prompt |
| 2 | Plan/Build modes | `src/core/command-handler/handlers/ModeCommandHandler.ts` | `/plan` and `/build` commands, mode-override file, OpenCode agent enforcement |
| 3 | Deny `question` tool | `src/services/opencode/index.ts` | `permission: { "question": "deny" }` in opencode.json (headless mode) |
| 4 | Compiled reply-tool binary | `docker/Dockerfile` | `bun build --compile src/mcp/reply-tool.ts` alongside main binary |
| 5 | Common path fallback | `src/services/opencode/index.ts` | `getReplyToolCommand()` checks `/usr/local/bin/` for compiled binary |
| 6 | Startup health check | `src/cli/commands/monitor.ts` | Send startup email before starting inbound adapters |
| 7 | Docker setup | `docker/` | Dockerfile, s6 config, compose, .env, README, examples |
