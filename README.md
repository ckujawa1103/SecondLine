# SecondLine

A second phone line you own: texts, calls, and transcribed voicemail, on a
number ported to Twilio.

Replaces a $13.79/month GoDaddy Conversations subscription with about $3.15/month
of infrastructure — and, more to the point, replaces a second line that stopped
being able to send texts.

---

## Why this exists

GoDaddy SmartLine (now Conversations) gave a second number without a second
phone. Then US carriers made A2P 10DLC registration mandatory for texting from
any non-mobile number, SmartLine started requiring business details to send a
reply, and a number used as a personal line has none to give.

Porting to Mint Mobile was the obvious escape and it failed — mobile carriers
routinely refuse inbound ports of VoIP numbers.

The thing worth understanding: **10DLC is a carrier mandate, not a GoDaddy
policy.** Changing providers does not escape it. What does escape it is Twilio's
**Sole Proprietor** brand, which is designed for individuals with no EIN: name,
address, email, and a one-time code to a real mobile number. No business, no tax
ID, no job title.

So: register as a sole proprietor, port the number to Twilio, and own the stack.

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
| Twilio number | $1.15/mo |
| A2P 10DLC campaign | $2.00/mo (+$19 one-time) |
| SMS | ~$0.011 per message, either direction |
| Voice | ~$0.0085/min inbound, ~$0.014/min outbound |
| Transcription | ~$0.0062/min |
| Cloudflare Workers, D1, R2 | $0 (free tier) |

**~$3.15/month fixed**, $4–6 with real use, against $13.79 today.

## Porting

**[→ docs/PORTING.md](docs/PORTING.md)**

Read it before touching anything. The short version: GoDaddy Conversations turns
out to run on Twilio, so this is a move within one carrier rather than a port
between two, and the first step is a question to Twilio's porting team rather
than a form. Getting that order wrong is what burned the previous attempt's
30-day unlock window.

```bash
npm run port:check     # portability lookup — free, read-only, safe to repeat
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
