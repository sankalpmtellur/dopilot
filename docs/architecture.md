# Architecture

Dopilot's privileged work happens in the browser extension. The website is a
front door, and the backend is optional and never sees a user's API key.

```text
 Web app (Next.js)            Extension (Manifest V3)                    Groq API
 settings, onboarding         ┌──────────────────────────────────┐
        │                     │ Side panel: conversation, stop,  │
        │ externally_         │             confirmations        │
        │ connectable         │        │ runtime messages        │
        │ + Zod validation    │        ▼                         │
        └────────────────────▶│ Service worker: agent loop,      │──HTTPS──▶
                              │   tabs, scripting, API key       │  user's key
 Backend (Fastify)            │        │ tabs.sendMessage        │
 health today, no user keys   │        ▼                         │
                              │ Content script: page interaction │
                              └──────────────────────────────────┘
```

## Boundaries

| Concern                         | Location                 | Rule                                                      |
| ------------------------------- | ------------------------ | --------------------------------------------------------- |
| Web interface and settings      | `apps/web`               | No privileged access. Talks to the extension by message.  |
| Browser interaction             | `apps/extension`         | The only code that calls `chrome.*` privileged APIs.      |
| AI model communication          | `extension/src/lib`      | The Groq SDK stays behind the `ModelClient` interface.    |
| Agent reasoning and limits      | `packages/agent-core`    | No browser APIs and no provider SDKs.                     |
| Tool definitions and validation | `packages/browser-tools` | Declares tools. Does not execute them.                    |
| MCP integration                 | `packages/mcp-tools`     | Adapts the tool catalog to the MCP v2 server SDK.         |
| Message schemas                 | `packages/shared`        | Zod schema for every message crossing a process boundary. |

The loop runs in the service worker. Browsers can stop idle Manifest V3 workers,
so a long run must keep its state in `chrome.storage.session` and be able to resume.

## Web-to-extension communication

Ordinary pages cannot call extension APIs. The only path is
`chrome.runtime.sendMessage(extensionId, message)`, and it is guarded three times:

1. The browser only exposes it to origins in the manifest's `externally_connectable`.
2. The service worker checks `sender.origin` against `ALLOWED_WEB_ORIGINS`.
3. The message must match the strict `ExternalRequestSchema`.

A compromised page on an allowed origin can send anything the schema permits, so
that schema must never include commands that act on the browser without
confirmation inside the extension's own UI. To go live, add the production origin
in both the manifest and `ALLOWED_WEB_ORIGINS`.

## Security model

**API keys.** Users bring their own Groq key. It is stored with `chrome.storage.local`,
restricted to trusted extension contexts so content scripts cannot read it, and
sent only to `api.groq.com`. The extension's CSP also limits page connections to
that host. This storage is not encrypted: the device owner, and malware with access
to the browser profile, can read it. Users should use a key they can revoke. Keys
should be entered in the side panel, not on the website, so they never enter a
webpage's context.

**Permissions.** The manifest requests `activeTab`, `scripting`, `sidePanel`,
`storage` and Groq host access. Access to other sites is optional and requested per
site at runtime. Content scripts are injected on demand, not on every page.

**AI-generated actions.** Model output is untrusted. Each call must pass
`validateToolCall`, which uses strict schemas and a closed tool list. Tools marked
`sensitive` require user confirmation, enforced by code rather than by the prompt.

**Prompt injection.** Webpages can contain text written to manipulate the model.
`wrapUntrustedContent` marks page text as data, but delimiters cannot fully prevent
injection. The real limits are the closed tool list, per-site permissions and
confirmations, which must stay outside the model's control.

**Runaway runs.** `ExecutionGuard` enforces step, time and repeated-call limits and
honours an `AbortSignal`, which is what the stop control will trigger.

**Logs.** The backend redacts credential headers and `apiKey` fields. It has no
Groq key setting.

## MCP

`packages/mcp-tools` registers the tool catalog on an official MCP v2 `McpServer`.
Execution sits behind `BrowserToolExecutor`. The backend creates a server but
exposes no transport yet, because reaching the browser needs a secure bridge to the
extension. That bridge must apply the same permissions and confirmations as the agent.

## Voice

Voice input will use the browser's Web Speech APIs and must fall back to text where
they are unavailable, since support varies by browser. Check this in Brave
specifically, because speech recognition may not work there.

## Persistence

There is no database. Backend logic lives behind `services/`, so storage can be added
later without changing routes.
