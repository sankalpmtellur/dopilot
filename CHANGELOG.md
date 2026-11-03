# Changelog

## 1.0.0 (not yet released)

First public version.

### Added

- Natural-language browser control from a docked side panel, using your own Groq API key.
- Tab commands and simple instructions that run instantly with no AI request and no key.
- Reading pages, clicking, typing, choosing options, scrolling and waiting for content.
- Voice input and short spoken replies. Screenshot understanding, with consent for each site.
- First-run setup, example instructions, live step-by-step progress and an activity history.
- Per-task limits on AI requests and tokens.
- `pnpm verify:package`, which checks the store ZIP and runs it in Chrome and Brave.

### Fixed since the first internal audit

- "Open X, then open Y" no longer loses the first site.
- One approval no longer covers a whole list of addresses. Every flagged address is shown.
- More sensitive actions ask first, including money movement, confirmation dialogs, payment pages and
  common non-English labels. This reduces risk but cannot catch everything.
- Repeating an action that is working no longer fails. Repeating one that changes nothing still stops.
- Addresses carrying data the user did not type need approval, even on a site the user named.

### Changed

- Release builds trust no website unless one is named when building. Local MCP is left out by default.

### Known limits

- Works in Chrome and Brave on desktop. Other browsers are untested.
- Clicks and typing are simulated, so some sites may ignore them. Embedded frames cannot be used.
- The API key is stored unencrypted in the browser profile.
