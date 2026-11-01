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

Requests carry unique IDs, and the website applies timeouts and can cancel.

The manifest's `key` is a public key that pins the extension ID, so the website can find
unpacked installs. Its private key was discarded. A release build (`pnpm release:extension`)
takes the website's origin as a setting, writes it to both the manifest and
`ALLOWED_WEB_ORIGINS`, and removes `key` and every development origin. The store assigns its
own ID, which goes in the website's `NEXT_PUBLIC_DOPILOT_EXTENSION_IDS`. See the README.

A task may not use a tab showing Dopilot's website. Those tabs are recognized by address, or
by having messaged the extension, since addresses stay hidden without the tabs permission.

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

### Staying responsive

No step of the loop can hold it open. Each Groq request, safety check and tool call runs under its own
time limit and its own abort signal, and Stop cancels whichever one is running. An abandoned step's result
is ignored. Messages to pages have time limits too, so a frozen page costs seconds, not a stuck task.

- **An action is never retried automatically.** If its outcome is unknown, for example because the page
  stopped answering, the model is told so and must look before acting again. Only reads are retried.
- **Nothing acts after Stop.** The run is checked again immediately before every action, and tool code
  checks its signal before each side effect. Each run has its own loop, so one stuck after Stop cannot
  block the next task.
- **One copy of a run.** All entry points share a single loaded run, because a worker woken by Stop also
  resumes, and separate copies would let Stop end one while the other kept acting.
- **A watchdog alarm** wakes the worker every 30 seconds to end unanswered approvals after 5 minutes,
  pick up a run whose worker died, and end a loop with no progress for 2 minutes.
- **Progress, not call counts.** Looking at a page again after an action worked is progress. Repeating the
  same look, actions that change nothing, and a task that keeps failing in different ways all end it.

### Instructions that need no AI

`parseSimpleInstruction` recognizes clauses like opening a known site, switching tabs or scrolling. If any
clause is not understood exactly, the whole instruction goes to the AI, so it never guesses. Recognized
instructions become ordinary tool calls that take the same route through validation, policy and approval.
If a step fails, the AI takes over if there is a key, with the steps so far as its context.

### Choosing a model

Groq's model list has no capability field, so capability comes from the model's name and from what Groq
has actually refused. The list is cached for a day. The user's selected model is used while it works, and
is kept when Groq refuses it, since that may be an outage. Whether another model may stand in is the user's
setting, and they are told when one does. A model that cannot call tools is never used for the agent.

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

## Vision

Vision uses the same agent and loop. The main model stays a text model with tools, and asks for
sight through tools. A separate vision model answers, and only its text comes back, so the main model
never receives an image. The system prompt steers it to the DOM tools first, since a screenshot costs
far more. Tasks are limited to 5 images, an unchanged page is not captured twice, and a repeated
question about one screenshot is answered from memory.

**Grounding.** `get_visual_page_context` sends a screenshot with numbered boxes over the page's real
controls, plus a list of their roles, names and colours. The model's answer only counts if it names a
box that exists, and the result is a normal element ref for `click_element`, with all its checks. For
things with no element, such as a canvas, it may report a point, which gets an ID. `click_visual_target`
takes only that ID, so the main model cannot pass coordinates at all. Before clicking, it compares tab,
address, window size, scroll position, age and a fingerprint of the on-screen controls with the
screenshot, and stops if any differ. It scales the point to page coordinates, finds what is really
there, and applies the usual safety policy to that element. Contents of embedded frames cannot be
inspected or clicked, and Dopilot says so.

**Permissions.** Browsers only allow `captureVisibleTab` with `activeTab` or `<all_urls>`. Clicking the
toolbar icon grants `activeTab` for that tab, until it navigates. Otherwise Dopilot asks for `<all_urls>`,
which is optional and can be removed. That permission would make every per-site check succeed, so
`authorizedSites` records what the user really approved, and that list decides while it is held.

**Privacy.** Only the visible, authorized, non-private tab can be captured, and never internal pages or
CAPTCHAs. Password, card and code fields, and frames that look like payment forms, are painted over
before anything else sees the image. Before an image is sent, the user sees it and agrees, once per site
per task, or for every image on payment-like pages. Images are held in the worker's memory, never in
storage or tool results, and are dropped when the task ends. The website has no way to request them.

## Voice

Voice is push-to-talk: hold to talk, or tap to start and tap to finish. Nothing listens otherwise, and the
microphone is released as soon as a recording ends. Transcripts go through the normal command pipeline,
so exact commands stay free and instant, and anything else goes to the agent. Saying "stop" is handled
locally, without any AI.

Chromium's speech API is used when it works, and is free. Brave ships the API without a speech service, so
there it fails with a network error. The fallback records with `MediaRecorder` and sends the audio to Groq's
speech-to-text, but only if the user turned that on in extension settings. The website can use it through
the bridge, but cannot turn it on. Recordings are limited to 20 seconds and are never stored.

Browsers may not show a microphone prompt inside a side panel, so settings can ask from a normal tab.

Spoken replies are off by default. They use `speechSynthesis`, announce the first action and a short result,
and stop for new input or the Stop button. An answer that may contain page content is never read aloud: Dopilot
says the answer is on screen instead.

## Persistence

There is no database. Backend logic lives behind `services/`, so storage can be added
later without changing routes.
