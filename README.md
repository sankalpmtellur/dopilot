# Dopilot

Open-source, voice-controlled AI browser agent for Chrome and Brave. Users bring
their own Groq API key.

> **Status:** the AI agent works: tell it what to do and it observes pages, acts through
> validated tools, and asks before anything sensitive. Voice and vision are not built yet.

## Requirements

- Node.js 22.13 or newer
- pnpm 12 (`npm install -g pnpm`)

## Setup

```bash
pnpm install
cp .env.example .env
```

## Development

```bash
pnpm dev            # everything, in watch mode
pnpm dev:web        # http://localhost:3000
pnpm dev:backend    # http://127.0.0.1:4000
pnpm dev:extension  # rebuilds apps/extension/dist on change
```

Health checks: `GET http://127.0.0.1:4000/health` and `GET http://localhost:3000/api/health`.

## Load the extension

1. Run `pnpm build`, or `pnpm dev:extension`.
2. Open `chrome://extensions` or `brave://extensions` and turn on **Developer mode**.
3. Choose **Load unpacked** and select `apps/extension/dist`.
4. Click the Dopilot toolbar icon to open the side panel.
5. Open http://localhost:3000. The website finds the extension by itself.

## Using the agent

Add your Groq API key under Settings in the side panel, then type what you want:

- `Open Wikipedia and search for artificial intelligence, then scroll to the history section`
- `Switch to my GitHub tab`
- `Read the question displayed on this page`

Dopilot shows each step, and you can stop it at any time. It asks before using a new site and
before anything sensitive, such as sending, buying or deleting. It will not enter passwords, solve
CAPTCHAs or submit graded quizzes. Choose a model in Settings, or leave it on Automatic.

Exact commands run instantly, without AI or a key. Type `help` to list them: `new tab`,
`open <address>`, `list tabs`, `switch to tab <n>`, `reload`, `go back`, `go forward`, `close tab`,
`close tab <n>`.

## MCP (local development)

Build first, then point an MCP client at the server. It prints a token to stderr:

```bash
node apps/backend/dist/mcp/stdio.js
```

Paste the token under Settings, Developer: local MCP bridge. Calls use the same permission and
safety checks as the agent, and anything needing approval is refused.

## Checks

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm format:check
pnpm build
pnpm verify:extension  # needs pnpm dev:web running; drives real Chrome and Brave with throwaway profiles, with Groq stubbed
```

## Layout

```text
apps/web            Next.js site and settings
apps/backend        Fastify API, which never receives user API keys
apps/extension      Manifest V3 service worker, content script and side panel
packages/shared     Zod message schemas
packages/agent-core Agent contracts, execution limits, untrusted-content handling
packages/browser-tools  Tool catalog and call validation
packages/mcp-tools  MCP v2 adapter for the tool catalog
packages/ui         React components and theme shared by the website and extension
```

See [docs/architecture.md](docs/architecture.md) for boundaries and the security model.
