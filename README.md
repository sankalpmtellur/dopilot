# Dopilot

Open-source, voice-controlled AI browser agent for Chrome and Brave. Users bring
their own Groq API key.

> **Status:** the website, side panel, Groq key management and explicit browser commands
> work. Natural-language understanding, the autonomous agent and voice are not built yet.

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

Add your Groq key under Settings in the side panel. Browser commands work without one.

## Commands

Commands are matched exactly and never interpreted by AI. Type `help` to list them:
`new tab`, `open <address>`, `list tabs`, `switch to tab <n>`, `reload`, `go back`,
`go forward`, `close tab`, `close tab <n>`.

## Checks

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm format:check
pnpm build
pnpm verify:extension  # needs pnpm dev:web running; drives real Chrome and Brave with throwaway profiles
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
