# Dopilot

Open-source, voice-controlled AI browser agent for Chrome and Brave. Users bring
their own Groq API key.

> **Status:** the AI agent works: tell it what to do and it observes pages, acts through
> validated tools, understands speech and screenshots, and asks before anything sensitive.

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

Simple instructions such as `Open a new tab and go to YouTube` or `Switch to GitHub, then return to the
previous tab` run straight away with no AI request, and need no key. Anything else goes to the AI. Both
pass the same permission and safety checks.

## Voice and vision

Press the microphone to speak: hold to talk, or tap to start and again to finish. Say "stop" to stop a
task. Chrome's speech service is used when it works. Brave has none, so turn on **Allow sending my voice
to Groq** in Settings. Short spoken replies can be turned on with the speaker button.

Ask things like `What is on my screen?` or `Click the blue button`. Dopilot reads the page first and
only uses a screenshot when it has to. It shows you the image, with password and card fields hidden, and
asks before sending it to Groq. Screenshots are not saved, and never go to Dopilot's backend.

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
pnpm audit --prod
```

## Deploying

Nothing here deploys by itself. The public product needs only the website and the extension:
agent runs and Groq requests already happen inside the extension, with each user's own key, and the
website never calls `apps/backend`. So no backend needs hosting for a first release. Its source stays
for local MCP work.

**Website (Vercel).** Import the repository with `apps/web` as the root directory; `apps/web/vercel.json`
holds the monorepo build. Set `NEXT_PUBLIC_DOPILOT_EXTENSION_IDS` to the extension's store ID. Vercel serves
it over HTTPS, which browsers need for microphone access. The website has no other settings or secrets.

**Extension (Chrome Web Store, which Brave also installs from).**

1. Choose the website's final domain, because the extension is built to talk to that origin only.
2. Build and check it. This stops if anything development-only is left in, and uploads nothing:

   ```bash
   DOPILOT_WEB_ORIGIN=https://your.domain pnpm release:extension
   ```

3. Upload `release/dopilot-<version>.zip`. The store then assigns the extension's permanent ID.
4. Set that ID in `NEXT_PUBLIC_DOPILOT_EXTENSION_IDS` and redeploy the website. Users never see or copy it.

Run `pnpm build` afterwards to return `apps/extension/dist` to a local build.

The extension ID comes from a signing key. The pinned key in `public/manifest.json` keeps local installs on
one fixed ID, and is removed from release builds because the store refuses it and assigns its own. Local
installs are unaffected. The website only talks to IDs it was built with, and the browser only lets a site
talk to an extension whose manifest names it, so both sides have to agree.

Before submitting, the store listing also needs a privacy policy address, screenshots, and a reason for
each permission:

| Permission            | Why                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------ |
| `activeTab`           | One-off access to a tab when the user invokes Dopilot                                |
| `scripting`           | Reads and uses a page only on sites the user has approved                            |
| `sidePanel`           | The main interface                                                                   |
| `storage`             | The user's key, settings and the current task                                        |
| `alarms`              | Ends tasks stuck waiting, even if the service worker has been stopped                |
| `api.groq.com`        | Sends requests directly to the AI provider the user chose                            |
| optional `tabs`       | Tab titles and addresses, when the user allows them                                  |
| optional site access  | Asked for one site at a time                                                         |
| optional `<all_urls>` | Browsers require this for screenshots, and Dopilot still limits it to approved sites |

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
