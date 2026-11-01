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

**Permissions.** The manifest requests `activeTab`, `scripting`, `sidePanel`, `storage` and
Groq host access. It grants no site access. The agent asks for each site, by exact origin, the
first time a task needs it, and for the optional `tabs` permission when it needs tab titles.
Both are requested from a click in extension-owned UI, and sites can be removed in settings.
Query strings and fragments are removed before tab information leaves the worker, including
from titles.

**Blocked pages.** Navigation accepts only `http` and `https`, without embedded credentials.
Commands refuse tabs showing internal browser or extension pages. Browsers hide tab
addresses until `tabs` is allowed, so before that this tab check cannot apply.

**Destructive actions.** Closing a tab needs confirmation in extension-owned UI: inline in
the side panel, or a popup window for website requests. The website can neither answer the
popup nor claim to have confirmed, since its schema has no such field.

**AI-generated actions.** Model output is untrusted. Each call must pass `validateToolCall`,
which uses strict schemas and a closed tool list, so no code or CSS selectors can be sent. Page
elements are reached only through references the content script issued itself, tied to one
loaded document, and rechecked before each use.

**Approvals.** `assessToolCall` decides what needs approval, from facts the content script
collects from the live page, never from anything the model reports. It covers purchases, sending
messages, account changes, deletions, uploads and form submissions, except searches. Keys that
activate a control, and links that lead to the same places, get the same rules as clicks. The
check runs again after approval, so a page that changed needs fresh approval, and one approval
covers one action. Answers are accepted only from extension pages.

**Always refused.** Typing into password, card or code fields, solving CAPTCHAs, submitting graded
quizzes or assessments, and using internal browser pages. Reading a quiz question is allowed.

**Prompt injection.** Webpages can contain text written to manipulate the model. Page-sourced
results are wrapped as untrusted data, and the system prompt says only the user gives instructions,
but that cannot fully prevent injection. The real limits are the closed tool list, per-site
permissions and approvals, all enforced by code the model cannot influence, so a fully fooled model
still cannot act without the user. Unusually long addresses need approval, since they could carry
page data to another site. Field values are never read, and card numbers and tokens are removed from
page text before it reaches the model.

**Runaway runs.** Each task is limited to 15 actions, 5 minutes, 3 failures in a row and 30 AI
requests. Repeated calls are refused, and the Stop button aborts immediately.

**Logs.** The backend redacts credential headers and `apiKey` fields. It has no
Groq key setting.

## Agent loop

`AgentRunner` in `packages/agent-core` is a state machine: observe, ask the model, validate, check
safety, execute, repeat. It knows nothing about browsers or Groq, which sit behind `AgentToolbox` and
`ModelClient`.

Manifest V3 can stop a service worker at any time, so every step is saved to `chrome.storage.session`
before it starts. When a worker starts, it picks up any active run. A tool call that was in flight
is not repeated, because it may already have happened: the model is told the outcome is unknown and
looks again. While waiting for approval nothing runs at all, and the answer re-enters the loop.

Exact commands such as `new tab` run directly without AI, to save quota. Anything else goes to the
agent. Requests stay small: older page observations shrink to stubs, conversation history is bounded,
and tool definitions leave out limits that are enforced anyway.

Groq's model list does not say which models support tools, so `rankToolModels` goes by name, and a
model that turns out to be unavailable or unable to use tools is skipped at run time.

## MCP

`packages/mcp-tools` registers the same tool catalog on an official MCP v2 `McpServer`, with execution
behind `BrowserToolExecutor`. There is one implementation of each tool, in the extension.

```text
MCP client ──stdio──▶ apps/backend/src/mcp/stdio.ts ◀──long poll── Extension service worker
                      127.0.0.1:4319, token required                 same checks as the agent
```

The extension stays installable without Node.js: it only connects outward, and only after a person
pastes the server's token in settings. The token lasts for the browser session. The bridge binds to
loopback, requires the token and checks the Host header against DNS rebinding. MCP has no way to show a
prompt, so anything needing approval or an ungranted site is refused.

## Voice

Voice input will use the browser's Web Speech APIs and must fall back to text where
they are unavailable, since support varies by browser. Check this in Brave
specifically, because speech recognition may not work there.

## Persistence

There is no database. Backend logic lives behind `services/`, so storage can be added
later without changing routes.
