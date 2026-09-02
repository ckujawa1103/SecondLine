# SecondLine

A phone number per project, on Twilio: texts, calls, and transcribed voicemail,
managed from one app.

---

## Why this exists

This started as a replacement for GoDaddy SmartLine, which had stopped being
able to send texts without business details a personal number does not have.
Building that on Twilio turned out to be the wrong shape, for two reasons found
while verifying:

**Twilio closed Group MMS to new accounts in March 2022.** Existing accounts are
grandfathered; new ones get an error, with no published path in. Group texting
on a Twilio number was never going to work.

**10DLC is the wrong category for a personal line.** Registering yourself as a
business brand to text friends caps throughput and attaches unsubscribe
handling to ordinary conversations.

So the personal number goes to a real mobile carrier as a second eSIM, where
group texts, iMessage, and RCS all work natively and no registration exists —
see [docs/PORTING.md](docs/PORTING.md).

What is left is the part that genuinely wants software: **a number per
project.** Each app gets its own Twilio number with its own inbox, voicemail,
and transcripts, all in one place. That is A2P messaging, where 10DLC is the
correct category rather than an imposition.

## What it does

- **Texts** — send and receive SMS and MMS in threaded conversations
- **Calls** — ring through to your real phone, or answer in the app
- **Outbound** — an in-app dialer over WebRTC, plus a call-me-then-bridge
  fallback for when a browser microphone is not an option
- **Voicemail** — recorded, stored, and transcribed, carried over from
  [Mint-Voicemail](https://github.com/ckujawa1103/Mint-Voicemail)
- **Notifications** — web push, with the transcript in the body
- **Passkey sign-in** — single user by construction, with two failsafes

## Costs

| | |
|---|---|
| Twilio number, per project | $1.15/mo |
| A2P 10DLC campaign | ~$11/mo, shared across every number |
| SMS | ~$0.011 per message, either direction |
| Voice | ~$0.0085/min inbound, ~$0.014/min outbound |
| Transcription | ~$0.0062/min |
| Cloudflare Workers, D1, R2 | $0 (free tier) |

The campaign fee is per campaign, not per number, so the marginal cost of the
second and third project number is $1.15 each.

## Porting

**[→ docs/PORTING.md](docs/PORTING.md)**

Covers both tracks: moving (815) 287-0166 to a US Mobile eSIM on Verizon, and
registering app numbers on Twilio under a Standard A2P brand.

The short version for the 815 line: the number is flagged VoIP because GoDaddy
Conversations runs on Twilio, and its Customer Service Record names a different
subscriber entirely. Submitting your own name and ZIP on the port form is an
automatic rejection — which is the most likely reason the 2025 Mint attempt
failed.

```bash
npm run port:lookup    # carrier of record + line type, ~$0.005
npm run port:check     # portability into Twilio — free, read-only
npm run port:submit    # upload proof, create the request, email the LOA
npm run port:status    # watch it
npm run a2p:status     # watch 10DLC approval
```

Credentials come from the environment. Use a revocable API key, not the account
auth token:

```bash
export TWILIO_ACCOUNT_SID=AC...
export TWILIO_API_KEY=SK...
export TWILIO_API_SECRET=...
```

## Layout

```
worker/       Cloudflare Worker — Twilio webhooks, auth, API, static app
  src/
    index.js       router
    util.js        crypto, rate limiting, HTTP helpers
    auth.js        passkeys, magic links, recovery codes, sessions
    transcribe.js  pluggable speech-to-text
    notify.js      web push
scripts/
  port.mjs         portability check, port-in submission, status
  a2p.mjs          10DLC registration monitor
docs/
  PORTING.md       the runbook
```

## Relationship to Mint-Voicemail

Mint-Voicemail stays deployed and untouched — it handles unanswered calls to the
Mint line and is a system that already works. SecondLine reuses its proven
pieces (`auth.js`, `util.js`, `transcribe.js`, `notify.js` are carried over
close to verbatim) and serves its own app from the Worker on a single origin,
which removes the GitHub Pages, CORS, and WebAuthn RP-ID traps documented in
that project's session log.

The schema is multi-number from the first migration. That is the whole point of
registering as a business rather than a sole proprietor: a Sole Proprietor A2P
brand is capped at exactly one phone number, forever.
