# Porting (815) 287-0166 to US Mobile

This repository is **public**. The port-out PIN, the GoDaddy customer number,
and the service address are deliberately not written down here. They live in
two emails in the owner's Gmail, cited below by subject line, and in
`port-info.json`, which `.gitignore` excludes.

---

## Two tracks, different destinations

The plan split once it became clear that a personal line and an app line want
opposite things.

| | **(815) 287-0166** | **App numbers** |
|---|---|---|
| Destination | US Mobile, Warp (Verizon) | Twilio |
| Becomes | A real mobile line, eSIM | VoIP, API-controlled |
| Messaging class | P2P — no registration at all | A2P — 10DLC required |
| Group texts, iMessage, RCS | Native | Not available |
| Registration | None | LLC + EIN, Standard brand |

The 815 number stops being a software problem and becomes a second eSIM on the
owner's handset, on Verizon rather than Mint's T-Mobile, which also buys network
redundancy. Everything in this repository then serves the *app* numbers.

### Why not keep it on Twilio

Two independent reasons, either sufficient:

**Group MMS is closed.** Twilio limited Group MMS to existing accounts on
15 March 2022. Accounts created after that get an error, and the changelog
states no timeline and no process for gaining access. A new Twilio account
cannot do group texting at all — and the owner uses group texts on this number
daily.

**10DLC is the wrong category.** Registering a personal line as a business
brand to text friends is a category error, and it caps throughput, requires
campaign registration, and attaches business-message affordances like
unsubscribe handling to ordinary conversations.

A consumer mobile line has none of these problems because it is P2P.

---

## The obstacle: the number is flagged VoIP

Every US number carries a line type — mobile, landline, or VoIP — in the
national database. This one is VoIP, because GoDaddy Conversations is itself
built on Twilio.

FCC rules require intermodal porting, so VoIP-to-wireless is legal and carriers
must honor it. In practice individual carriers reject on their own policy, and
**that is almost certainly what killed the 2025 Mint attempt** — Mint is a
T-Mobile MVNO and mobile carriers routinely refuse inbound VoIP ports.

US Mobile is the chosen destination specifically because their porting guide
lists VoIP sources — Google Voice, magicJack, Vonage, netTALK, Line2 — as
routine cases with documented instructions, rather than treating them as
exceptions.

Confirm what the gaining carrier will see before submitting anything:

```bash
npm run port:lookup
```

Costs about half a cent and reports the carrier of record and line type
straight from the database the porting system reads.

## The likely second cause, and the fix

GoDaddy's 2025 email was explicit that the underlying carrier wants the
Customer Service Record submitted **exactly**:

```
Company name: Twilio Inc
Address:      548 Market St #14510, San Francisco, CA 94104
PIN:          (see email — not recorded here)
```

A port form filled in with the owner's own name and Wilmette address does not
match that record, and a mismatch is an automatic rejection. Filling in your
own details is the natural thing to do and it is wrong here.

**On the US Mobile port form, the billing ZIP is 94104, not the owner's.** That
single field may be the entire difference between this attempt and the last one.

GoDaddy also stated there is no specific account number for porting out, and
that the GoDaddy customer number should be used instead. It is on every renewal
receipt.

---

## Order of operations

The 2025 attempt unlocked the number first, then went looking for a carrier, and
let the 30-day eligibility window lapse unused. Carrier first, then unlock, then
submit immediately.

### Step 1 — Pick the plan · owner

US Mobile, Warp (Verizon). Warp is the point: Mint runs on T-Mobile, so putting
this line on Verizon means one dead network never takes out both. US Mobile can
switch a line between Warp, Dark Star (AT&T), and Light Speed (T-Mobile) later,
so this is reversible.

Buy the plan but **do not** let it assign a new number if the flow offers to —
choose the transfer path so the port is attached from the start.

### Step 2 — Preflight · agent

```bash
npm run port:lookup
```

Confirms carrier of record and line type. Expect VoIP. That is not a blocker,
it is the thing that tells us to submit CSR values rather than personal ones.

### Step 3 — Unlock the number · owner

One line to `portout@vms.godaddy.com` from the Gmail address on the account.
The draft is already prepared; the 2025 wording that worked was simply asking
for a port-out code for the number.

Expect an acknowledgement within minutes and the CSR email in 1–3 business days.
**The unlock expires after 30 days**, so send this only once the US Mobile
account is ready to receive the port.

### Step 4 — Submit the port · owner

In the US Mobile app or web flow, using values from the fresh CSR email, not
from memory and not from this file:

| Field | Value |
|---|---|
| Number | (815) 287-0166 |
| Account number | GoDaddy customer number, from any renewal receipt |
| Transfer PIN | From the CSR email |
| Account holder name | **The CSR company name, not the owner's** |
| Billing address / ZIP | **The CSR address, ZIP 94104** |

If the form rejects a company name because it expects an individual, that is the
moment to open a US Mobile support chat rather than guessing — tell them the
number is a VoIP line whose CSR names a different subscriber, and give them the
CSR verbatim. Guessing produces a rejection and another week.

### Step 5 — Watch for rejection · owner + agent

Wireless ports usually complete within one business day; VoIP-sourced ports run
longer. A rejection comes back with a reason code, and the reason is nearly
always a field mismatch against the CSR. Send it over and it can be diagnosed
against the record above.

### Step 6 — Only then, cancel GoDaddy · owner

GoDaddy's warning, verbatim: *"Porting away a number does not automatically
cancel it from your account. You will want to keep your plan active until the
number has fully ported. Canceled Conversations plans cannot be restored and
your port can be rejected by the carrier for being a canceled/inactive
number."*

Once calls and texts arrive on the eSIM, call **480-366-3550** to remove it.
Cancelling early loses the number permanently. At $13.79/month, one month of
overlap is cheap insurance.

---

## Track B: app numbers on Twilio

Unaffected by any of the above, and can proceed in parallel.

App numbers are bought from Twilio directly — no porting, no CSR, no unlock.
What they do need is A2P 10DLC registration before they can send texts, and
that is where the LLC matters.

| | Sole Proprietor | LLC + EIN (Standard) |
|---|---|---|
| Phone numbers | 1, hard cap | Many, across campaigns |
| Brands per tax ID | — | 5 |
| Throughput | 1 msg/sec | Substantially higher |
| Monthly | $2 | ~$11 per campaign |

A number per project is structurally impossible on a Sole Proprietor brand, so
the LLC is the enabling decision, not a nicety. Twilio also blocks holders of an
EIN from registering as Sole Proprietor at all, so the two are mutually
exclusive and the LLC has to come first.

**Two timing traps.** Brand vetting checks the EIN against public business
records, so a freshly filed LLC and a same-day EIN can fail vetting simply by
not having propagated yet. Register the brand once the Illinois filing is
visible in state records, and expect the EIN to need a few days. Register the
brand name **exactly** as the LLC's registered legal name — a near-miss fails
vetting.

Registration itself is a console flow, not an API call, for direct customers:

1. Console → Messaging → Regulatory Compliance → A2P 10DLC.
2. Create the Customer Profile using the **business** profile this time, with
   the EIN. (The individual profile is the Sole Proprietor path and is now the
   wrong one.)
3. Register the brand as **Standard**, legal name matching the LLC exactly.
4. Create a Messaging Service, register a campaign against it.
5. Attach numbers to the Messaging Service.

Then poll from here rather than refreshing the console for days:

```bash
npm run a2p:status
```

For any number that later needs porting *into* Twilio rather than buying fresh:

```bash
npm run port:check     # portability, free and read-only
npm run port:submit    # upload proof, create request, email the LOA
npm run port:status
```

---

## Costs after the split

| | |
|---|---|
| US Mobile, 815 line | ~$10–25/mo depending on plan |
| GoDaddy Conversations | $0 — cancelled after the port |
| Twilio number, per app | $1.15/mo |
| A2P campaign | ~$11/mo, shared across app numbers |
| Illinois LLC | ~$150 to form, $75/yr |

The 815 line lands roughly where SmartLine was, and buys group texting,
iMessage, RCS, and a second network. The app numbers carry their own cost and
were never part of the $13.79.
