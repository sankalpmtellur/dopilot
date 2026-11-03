# Dopilot

Open-source, voice-controlled AI browser agent for Chrome and Brave. Users bring
their own Groq API key.

> **Status:** version 1.0.0, not yet published. Tell it what to do and it observes pages, acts through
> validated tools, understands speech and screenshots, and asks before actions that look consequential.
> See [CHANGELOG.md](CHANGELOG.md) and [the privacy policy](docs/privacy-policy.md).

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
4. Click the Dopilot toolbar icon to open the side panel. That is all the extension needs.
5. Optional, for local development only: open http://localhost:3000. The website finds the extension by itself.

## Using the agent

The side panel opens with a short setup guide and example instructions. Add your Groq API key there or
under Settings, then type what you want:

- `Open Wikipedia and search for artificial intelligence, then scroll to the history section`
- `Switch to my GitHub tab`
- `Read the question displayed on this page`

Dopilot shows each step, and you can stop it at any time. It asks before using a new site and
before actions that look consequential, such as sending, buying, deleting or answering a dialog. It goes
by labels in common languages and by the page's structure, which cannot catch everything, so keep an eye
on tasks on sites that matter. It will not enter passwords, solve CAPTCHAs or submit graded quizzes.
Choose a model and per-task AI limits in Settings.

Exact commands run instantly, without AI or a key. Type `help` to list them: `new tab`,
`open <address>`, `list tabs`, `switch to tab <n>`, `reload`, `go back`, `go forward`, `close tab`,
`close tab <n>`.

Simple instructions such as `Open 10 new tabs`, `Open YouTube, then open GitHub`, `Scroll down 5 times` or
`Switch to GitHub, then return to the previous tab` run straight away with no AI request, and need no key.
Finding a tab by name needs the optional tab details permission, which Dopilot asks for when needed; `switch
to tab 2` never does. Anything else goes to the AI. Both pass the same permission and safety checks.

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
pnpm release:extension && pnpm verify:package  # builds the store ZIP, then checks it and runs it in both browsers
pnpm audit --prod
```

## Deploying

Nothing here deploys by itself. The public product needs only the website and the extension: agent
runs and Groq requests happen inside the extension with each user's own key, and the website never calls
`apps/backend`. **Render is not needed.** The backend's source stays for local MCP work.

### Website (Vercel)

Import the GitHub repository, with these project settings. `apps/web/vercel.json` already holds the commands.

| Setting                                  | Value                                                                 |
| ---------------------------------------- | --------------------------------------------------------------------- |
| Framework preset                         | Next.js                                                               |
| Root Directory                           | `apps/web`                                                            |
| Include files outside the root directory | On (the default)                                                      |
| Install Command                          | `cd ../.. && pnpm install --frozen-lockfile`                          |
| Build Command                            | `cd ../.. && pnpm build:packages && pnpm --filter @dopilot/web build` |
| Output Directory                         | Leave as the default (`.next`)                                        |
| Node.js version                          | 22.x or newer                                                         |

No environment variables are needed for the manual ZIP, and no Groq key or other secret belongs on Vercel. Two
optional ones exist, both public and fixed at build time, so redeploy after changing one:

| Environment variable                         | Value                                                              |
| -------------------------------------------- | ------------------------------------------------------------------ |
| `NEXT_PUBLIC_DOPILOT_EXTENSION_IDS`          | A store listing's ID. Defaults to the manual ZIP's pinned ID.      |
| `NEXT_PUBLIC_DOPILOT_EXTENSION_DOWNLOAD_URL` | Where visitors get the ZIP. Defaults to the latest GitHub release. |

Vercel serves HTTPS, which browsers need for microphone access.

Only the origin the extension was built for can connect, so preview deployments show "Extension not connected".
Browsers do not allow a wildcard on `vercel.app`.

### Extension (manual ZIP)

By default a release build stands alone and trusts no website: `pnpm release:extension`. To connect the website,
build for its final origin. Either way this stops if anything development-only is left in, and uploads nothing:

```bash
DOPILOT_WEB_ORIGIN=https://dopilot.vercel.app DOPILOT_KEEP_KEY=1 pnpm release:extension
```

Then run `pnpm build` to return `apps/extension/dist` to a local build. The result is
`release/dopilot-<version>.zip`, which can be attached to a GitHub release. If the website's address changes,
build and share the ZIP again.

To install it:

1. Unzip it to a folder you will keep. The browser loads from that folder each time it starts.
2. Open `chrome://extensions` or `brave://extensions` and turn on Developer mode.
3. Choose **Load unpacked** and select the folder, the one directly containing `manifest.json`.
4. Open the Dopilot website. It connects by itself. Add a Groq key in the extension's settings.

To update, replace the folder's contents and press reload on the extension's card. Extensions installed this
way do not update automatically, and the browser may remind users that developer-mode extensions are enabled.

The pinned key is what gives every manual install the same ID. It is public, and its private key was discarded,
so this ZIP cannot become a signed `.crx`. For a store, leave out `DOPILOT_KEEP_KEY`, because stores refuse a key
and assign their own ID, then add that ID to `NEXT_PUBLIC_DOPILOT_EXTENSION_IDS`. A store listing also needs a
privacy policy address, screenshots, and a reason for each permission:

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

### Checking both together

`pnpm verify:production` needs a built ZIP and a production website build. It runs them against each other over
HTTPS in real browsers, with a local certificate and every address pointed at this machine.

## License

MIT. See [LICENSE](LICENSE). The extension and website include third-party software under its own licenses,
listed in `THIRD_PARTY_NOTICES.txt` and `third-party-notices.txt`. Run `pnpm notices` after changing dependencies.

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

See [docs/architecture.md](docs/architecture.md) for boundaries and the security model, and
[docs/chrome-web-store.md](docs/chrome-web-store.md) for publishing.

Keep your working copy out of folders that sync files, such as a Desktop folder in iCloud Drive. Sync can
slow builds down and leave copies like `background 2.js` in the build, which `pnpm release:extension` refuses.
