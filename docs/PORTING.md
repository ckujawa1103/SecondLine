# Porting (815) 287-0166 out of GoDaddy Conversations

This repository is **public**. The port-out PIN, the GoDaddy customer number,
and the service address are deliberately *not* written down here. They live in
two emails in the owner's Gmail, cited below by subject line, and in the
`port-info.json` file that `.gitignore` excludes.

---

## The finding that changes everything

GoDaddy released a Customer Service Record for this number on 8 May 2025. The
subscriber of record on it is not GoDaddy:

```
Company name: Twilio Inc
Address:      548 Market St #14510, San Francisco, CA 94104
PIN:          (see email — not recorded here)
```

**GoDaddy Conversations is itself built on Twilio.** The number already lives on
Twilio's network, inside GoDaddy's Twilio account.

Two consequences, and they point in opposite directions:

**Good:** this is a VoIP-to-VoIP move within one carrier's footprint, not a
VoIP-to-wireless port. It avoids the class of rejection that most likely killed
the 2025 Mint attempt — mobile carriers routinely refuse inbound ports of VoIP
numbers, and Mint is a T-Mobile MVNO.

**Awkward:** a standard port-in assumes the losing carrier is somebody else.
Twilio's own guidance is that numbers already hosted on Twilio and moving
between unrelated Twilio accounts are handled by the porting team directly,
not by the self-serve Port In API. Twilio also documents that the API "cannot
transfer existing Twilio numbers between accounts."

So the first move is a question to Twilio, not a form.

---

## Why the 2025 attempt failed, most likely

The record shows this sequence:

| Date | Event |
|---|---|
| 7 May 2025 | Port-out code requested from `portout@vms.godaddy.com` |
| 7 May 2025 | "Number Unlock Request Received" — 1–3 business days quoted |
| 8 May 2025 | "Port Out Request Complete" — number eligible, CSR released |
| 13 May 2025 | Mint ticket L2403307 sent back to GoDaddy |
| — | No completion email. Number is still on Conversations today. |

Two plausible causes, not mutually exclusive:

1. **Mint refused a VoIP number.** The common case, and unfixable at Mint.
2. **The LOA did not match the CSR.** GoDaddy's email is explicit that the
   carrier wants "Twilio Inc" and the San Francisco address submitted *exactly*
   as the current subscriber. A port form filled in with the owner's own name
   and home address mismatches the record and gets rejected.

The second one matters for us too. Whatever we submit has to carry the CSR
values, not the owner's — while the supporting bill will show the owner's name.
That tension is exactly what the Twilio question below needs to resolve.

**The unlock window has long since expired.** GoDaddy re-locks a number 30 days
after unlocking, and that was sixteen months ago. A fresh unlock is required.

---

## Order of operations

The 2025 attempt burned its 30-day window waiting on a carrier. Do not repeat
that. **Ask Twilio first; unlock second; submit immediately.**

### Step 1 — Ask Twilio how they want this done · owner + agent

Open a case with `porting@twilio.com` before touching GoDaddy. State plainly:
the number, that the CSR names Twilio Inc as subscriber of record, that it is a
GoDaddy Conversations line, and ask whether they want

- a standard Port In request carrying the CSR values, or
- an internal account-to-account transfer, or
- a hosted-number arrangement.

Also ask **what proof-of-ownership document they will accept**, given the
monthly GoDaddy renewal receipt shows the owner's name while the CSR shows
Twilio's. Getting this answer in writing before submitting is the single
highest-value step in the whole process.

Nothing else in this runbook should start until this is answered.

### Step 2 — Re-request the unlock from GoDaddy · owner

One line, from the Gmail address on the account, to `portout@vms.godaddy.com`.
A draft is prepared; see the 2025 thread for the exact wording that worked.
Expect 1–3 business days and a fresh CSR email.

Do this only once Step 1 has an answer, so the 30-day clock starts against a
plan rather than against a question.

### Step 3 — Check portability · agent

```bash
npm run port:check
```

Hits Twilio's Portability API and reports whether the number is portable, its
number type, and whether it already sits in a Twilio account. Read-only, free,
and safe to run repeatedly — run it before and after the unlock to confirm the
unlock actually landed.

### Step 4 — Submit · agent, with one click from the owner

```bash
npm run port:submit
```

Uploads the proof-of-ownership document, builds the port-in request from
`port-info.json`, and submits it. Twilio emails an electronic LOA to the
authorized representative for signature — **that click is the owner's and cannot
be automated.** The port does not move until it is signed.

### Step 5 — Watch it · agent

```bash
npm run port:status
```

Statuses are `pending`, `in-progress`, `waiting-for-signature`,
`action-required`, `completed`, `expired`, `canceled`. `action-required` means
the losing carrier rejected something and the reason text is the whole story —
usually a name or address mismatch against the CSR.

Twilio requires a minimum of 7 days' notice, so a realistic total is 2–4 weeks
from Step 1.

### Step 6 — Only now, cancel Conversations · owner

GoDaddy's own warning, verbatim: *"Porting away a number does not automatically
cancel it from your account. You will want to keep your plan active until the
number has fully ported. Canceled Conversations plans cannot be restored and
your port can be rejected by the carrier for being a canceled/inactive
number."*

Once calls and texts are confirmed arriving at SecondLine, call GoDaddy at
**480-366-3550** to remove the number. Cancelling early loses the number
permanently. At $13.79/month, one extra month of overlap is cheap insurance.

---

## A2P 10DLC runs in parallel, and starts now

Texting from the number requires A2P 10DLC registration. This is a US carrier
mandate, not a Twilio or GoDaddy policy — it is the same requirement that made
SmartLine start demanding business details.

The escape hatch is the **Sole Proprietor** brand, for individuals with no EIN:

| | |
|---|---|
| Needs | Name, address, email, and an OTP to a real mobile number |
| Does not need | EIN, business name, job title, website |
| Cost | $4 brand + $15 campaign vetting, one-time; $2/month |
| Limit | **One phone number per campaign**, forever |
| Throughput | Low daily caps — fine for personal use, useless for marketing |

The OTP must go to a **mobile** number. A VoIP or Twilio number is rejected, so
verification uses the owner's Mint line.

**Registration is a console flow, not an API call.** Twilio publishes a full
A2P registration API, but only for ISVs registering on behalf of their
customers. A direct customer registering their own Sole Proprietor brand is
routed to the Console tool and the final submit is not exposed over the API —
the same shape as the Trust Hub trap from the Mint Voicemail build, where
everything except the last click was scriptable.

The click path, in order:

1. **Console → Messaging → Regulatory Compliance → A2P 10DLC → Start.**
2. Create a **Starter Customer Profile.** Choose the *individual* profile, not
   the business one — the business form demands a job position and an EIN that
   a personal line does not have. This is the same fork that cost time on the
   voicemail build.
3. Register the **brand**, brand type Sole Proprietor. Name, address, email,
   and a mobile number for the OTP.
4. **Enter the OTP.** It is texted to the mobile number given. The brand sits
   in `PENDING` until this is done, with no prompt — this is the step people
   miss.
5. Create a **Messaging Service**, then register a **campaign** against it.
6. Attach the phone number to the Messaging Service.

Then poll from here rather than refreshing the console for days:

```bash
npm run a2p:status
```

**Register against a throwaway Twilio number first.** Registration takes days
and can be rejected. Finding that out on a $1.15 test number is free; finding it
out after the port means the ported number sits there unable to text. Once
approved and proven, the campaign's one number slot is moved to the real number.

Sequenced against the port, that gives:

```
week 0   Twilio porting question      A2P brand + campaign on test number
week 1   GoDaddy unlock                A2P approval expected
week 2   submit port + sign LOA        texting proven on test number
week 3   port completes                move campaign to the ported number
week 4   confirm, then cancel GoDaddy
```

---

## What the port form needs

Collected in `port-info.json`, which is gitignored. Fill it from the sources
named — never retype from memory, because a single transposed digit is a
rejection and another week.

| Field | Source |
|---|---|
| Phone number | +18152870166 |
| Customer type | Individual |
| Customer name | The CSR value, pending Twilio's answer in Step 1 |
| Service address | The CSR value, pending Twilio's answer in Step 1 |
| Account number | GoDaddy customer number, on every renewal receipt |
| PIN | Gmail: "Conversations Port Out Request Complete", 8 May 2025 |
| Authorized rep | Account holder's name and Gmail address |
| Proof document | Most recent GoDaddy renewal receipt showing the number |

Useful reference points, all from the owner's Gmail:

- **Current bill:** Conversations Deluxe, $12.99 + $0.80 regulatory fee =
  $13.79/month, renewing on the 16th–18th, billed via PayPal.
- **Losing carrier contact:** `portout@vms.godaddy.com` for unlocks,
  480-366-3550 for cancellation.
- **Prior attempt:** Mint ticket L2403307, abandoned.

## What this replaces

$13.79/month today. Roughly $3.15/month fixed on SecondLine — $1.15 for the
number, $2 for the A2P campaign — plus about a cent per message and two cents
per call minute. Break-even against the one-time $19 of A2P fees lands inside
the second month.
