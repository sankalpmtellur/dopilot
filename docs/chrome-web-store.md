# Publishing to the Chrome Web Store

Everything needed for a submission, apart from what only the publisher can do. Do not treat a claim here
as tested unless the release notes say so.

## Build and check

```bash
pnpm release:extension
pnpm verify:package
```

Upload `release/dopilot-<version>.zip`. This build trusts no website, has no `key`, and leaves out the local
MCP bridge. Run `pnpm build` afterwards to return to a development build.

## Store listing

**Name:** Dopilot

**Summary (132 characters at most):** Tell your browser what to do. An open-source AI agent for tabs and pages, using your own Groq key.

**Category:** Tools

**Single purpose:** Carry out the user's browser instructions, such as managing tabs and using web pages, from a side panel.

**Description:**

Dopilot is an open-source AI agent for your browser. Say what you want in your own words, and it does it in
your real tabs while you watch.

What it can do:
• Open, switch and organize tabs: "Open YouTube, GitHub and Wikipedia in separate tabs"
• Move around sites: "Open Wikipedia and search for artificial intelligence, then scroll to the history section"
• Read pages for you: "Summarize this page"
• Carry out several steps: click, type, choose options and scroll
• Take voice instructions, and understand what is on screen using screenshots you approve

You stay in control:
• Every step is shown as it happens, and Stop is always in reach
• It asks before using a new site
• It asks before actions that look consequential, such as buying, sending, deleting or answering a dialog. It
cannot recognize every such action, so keep an eye on tasks on sites that matter
• It will not type passwords or card numbers, solve CAPTCHAs or submit graded quizzes

Bring your own key:
AI tasks use your own Groq API key, and requests go directly from your browser to Groq. Dopilot has no servers
or accounts of its own. Page content you ask it to work with is sent to Groq, so see the privacy policy.
Simple tab commands run instantly with no AI and no key.

Works in Chrome and other Chromium browsers such as Brave. Brave has no built-in speech service, so voice there
uses Groq if you turn that on. Source code is on GitHub under the MIT license.

**Links:** homepage and support: `https://github.com/sankalpmtellur/dopilot`. Privacy policy: [public address].

## Permission justifications

| Permission                                  | Justification                                                                                                                                                            |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `activeTab`                                 | Gives one-off access to the current tab when the user invokes Dopilot from the toolbar or shortcut.                                                                      |
| `scripting`                                 | Adds Dopilot's own packaged script to a page, only on sites the user approved, to read it and carry out instructions.                                                    |
| `sidePanel`                                 | The side panel is the extension's main interface.                                                                                                                        |
| `storage`                                   | Keeps the user's Groq key, settings and approved sites on the device, and the current task for the session.                                                              |
| `alarms`                                    | Ends tasks that are stuck while one is running, even if the browser has stopped the service worker.                                                                      |
| Host: `https://api.groq.com/*`              | Sends AI requests directly to the AI provider, using the user's own key.                                                                                                 |
| Optional `tabs`                             | Requested when needed, to find tabs by title or address.                                                                                                                 |
| Optional hosts: `http://*/*`, `https://*/*` | Requested one exact site at a time, when a task first needs that site. Users choose where the extension works, so sites cannot be listed in advance.                     |
| Optional `<all_urls>`                       | Browsers require it for screenshots outside `activeTab`. Requested only for a screenshot the user asks for. Dopilot still limits page access to sites the user approved. |

**Remote code:** No. All code is in the package. Requests to Groq carry data only.

## Data disclosure form

Answer from `docs/privacy-policy.md`. Likely categories, to confirm when filling in the form:

- Authentication information: the user's Groq API key, stored on the device and sent only to Groq.
- Website content: page text and screenshots, sent to Groq for the user's task.
- Web history: tab titles and addresses, when allowed and used for a task.
- User activity: instructions and the session activity history.
- Personal communications or other categories: page content can contain anything the user asks Dopilot to read.

The limited-use statements can be certified only by the publisher, who must confirm they are accurate.

## Assets the publisher must supply

| Asset              | Requirement                    | Status                                                                      |
| ------------------ | ------------------------------ | --------------------------------------------------------------------------- |
| Store icon         | 128×128 PNG                    | In the package: `icons/128.png`. Check it looks right at store size.        |
| Screenshots        | 1 to 5, at 1280×800 or 640×400 | Needed. Show real use: panel with a running task, an approval and settings. |
| Small promo tile   | 440×280                        | Needed.                                                                     |
| Marquee promo tile | 1400×560                       | Optional.                                                                   |
| Demo video         | YouTube link                   | Optional, and worthwhile for an agent.                                      |

Check the current requirements in the developer dashboard when submitting, as they can change.

## Submission checklist

- [ ] Real Groq smoke test passed with a real key, in Chrome and Brave.
- [ ] Toolbar icon, Alt+Shift+D and the real permission prompts checked by hand.
- [ ] Built outside any file-syncing folder, then `pnpm release:extension` and `pnpm verify:package` passed.
- [ ] Privacy policy reviewed, its brackets filled in, and published at a public address.
- [ ] Developer account registered, with its one-time fee paid and contact email verified.
- [ ] Listing, permission justifications and data disclosure entered and checked for accuracy.
- [ ] Screenshots and promo tile uploaded.
- [ ] Test instructions for reviewers: they will need a Groq key, or to use the commands that need no AI.
- [ ] Submit only after the owner approves. Expect broad optional host access to draw extra review.
