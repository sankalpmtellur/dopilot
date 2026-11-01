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
| Shared interface                | `packages/ui`            | React components and console state, with no browser APIs. |

The loop runs in the service worker. Browsers can stop idle Manifest V3 workers,
so a long run must keep its state in `chrome.storage.session` and be able to resume.

## Web-to-extension communication

Ordinary pages cannot call extension APIs. The only path is
`chrome.runtime.sendMessage(extensionId, message)`, and it is guarded in layers:

1. The browser only exposes it to origins in the manifest's `externally_connectable`.
2. The service worker checks `sender.origin` against `ALLOWED_WEB_ORIGINS`.
3. The message must match the strict `ExternalRequestSchema`, whose commands are a closed list.
4. The worker validates again before acting, for example revalidating URLs.
5. Each command needs a new request ID, and commands are rate limited.

Requests carry unique IDs, and the website applies timeouts and can cancel. To go live,
add the production origin in both the manifest and `ALLOWED_WEB_ORIGINS`.

The manifest's `key` is a public key that pins the extension ID, so the website can find
unpacked installs. Its private key was discarded. Remove `key` when publishing to a store,
which assigns its own ID, and update `NEXT_PUBLIC_DOPILOT_EXTENSION_ID`.

"Current tab" means the active tab in the side panel. The website is always the active
tab while in use, so there it means the most recently used other tab.

## Security model

**API keys.** Users bring their own Groq key. Extension pages write it straight to
`chrome.storage.local`, so it never appears in a message, and the worker reads it from
there for the connection test. Storage is restricted to trusted extension contexts, so
content scripts cannot read it, and the extension's CSP limits connections to
`api.groq.com`. The website only ever sees a masked value, and links to the extension's
settings page for changes. That page is not web-accessible, so the website cannot frame it.
This storage is not encrypted: the device owner, and malware with access to the browser
profile, can read it. Users should use a key they can revoke.

**Connection test.** Listing models is authenticated and uses no tokens. It only runs on
an explicit click, never retries, and maps errors to fixed states, so API error text
is discarded.

**Permissions.** The manifest requests `sidePanel`, `storage` and Groq host access. Tab
commands need nothing more. Tab titles and addresses need the optional `tabs` permission,
which is only requested from a click in extension settings. Query strings and fragments
are removed before tab information leaves the worker, including from titles. Add
`scripting` and per-site host access when page interaction is built.

**Blocked pages.** Navigation accepts only `http` and `https`, without embedded credentials.
Commands refuse tabs showing internal browser or extension pages. Browsers hide tab
addresses until `tabs` is allowed, so before that this tab check cannot apply.

**Destructive actions.** Closing a tab needs confirmation in extension-owned UI: inline in
the side panel, or a popup window for website requests. The website can neither answer the
popup nor claim to have confirmed, since its schema has no such field.

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
