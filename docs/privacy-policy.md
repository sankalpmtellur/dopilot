# Dopilot Privacy Policy (draft)

**Draft, not yet legal advice or a final policy.** Replace the bracketed items and have it reviewed before
publishing. Effective date: [date]. Contact: [email address].

Dopilot is an open-source browser extension that carries out instructions in your browser using an AI
model. This policy describes what the extension itself does with your data.

## The short version

Dopilot has no servers or accounts of its own, and no analytics or advertising code. When you use AI features,
data you ask it to work with goes directly from your browser to Groq, using your own Groq API key.

## What is stored on your device

Stored in your browser profile until you remove it or uninstall the extension:

- Your Groq API key. It is **not encrypted**, so anyone or anything with access to your browser profile could
  read it. Use a key you can revoke.
- Your settings, including model choices and task limits, and information about available Groq models.
- The list of sites you have allowed.

Stored only for the current browser session:

- Your conversation, the current task and an activity history of what Dopilot did.

Screenshots are held in memory only while the task that needed them runs, and are not written to storage.

## What is sent to Groq

Instructions that can run without AI send nothing. Otherwise, to carry out a task, these can be sent to Groq,
a third-party AI provider:

- Your instruction, and short summaries of up to six earlier instructions and answers in the conversation.
- Page information from tabs Dopilot uses: page text, titles, headings, addresses without their query strings,
  and the names of buttons, links and fields. Values typed into form fields are not read. Dopilot removes
  text that looks like card numbers or common token formats, but this filtering can miss things.
- Tab titles and addresses, if you have allowed tab details.
- Screenshots, only after you have seen the image and agreed. Password, card and code fields it can detect
  are covered first, but detection is not perfect, so check the preview.
- Voice recordings, only if you turn on sending your voice to Groq.

Groq handles this data under its own terms and privacy policy, available at https://groq.com/privacy-policy/.
Dopilot's developer does not receive it. Page content you send may include personal or sensitive
information, so avoid tasks on pages you would not want sent to Groq.

## Other services

If you use browser speech recognition, your browser may send audio to its own speech service under its own
terms. Dopilot does not control this. Press the microphone to record. Dopilot does not listen otherwise.

## Permissions

Dopilot asks for access to a site the first time a task needs it. Tab details and screenshot access are
optional, and requested only when needed. You can remove site access in Dopilot's settings or your browser's
extension settings.

## How data is not used

Dopilot's developer does not collect, sell or share your data, because it never reaches them. Dopilot does not
use your data for advertising or creditworthiness decisions.

## Your choices

- Remove your key and settings in Dopilot's settings, or uninstall the extension to delete its stored data.
- Delete or revoke your key with Groq at any time.
- Contact Groq about data it has processed.

## Children

Dopilot is not directed at children under 13. [Confirm the appropriate age for your audience.]

## Changes

Changes to this policy will be published at this address with a new effective date.
