#!/usr/bin/env node
// Watch A2P 10DLC registration state.
//
//   node scripts/a2p.mjs status
//
// This script deliberately does NOT register anything.
//
// Twilio exposes a full A2P registration API, but only to ISVs registering on
// behalf of their own customers. A direct customer registering a Sole
// Proprietor brand for themselves is routed to the Console tool, and the final
// submit is not available over the API — the same shape of trap as the Trust
// Hub submit hit during the Mint Voicemail build, where everything except the
// last click was scriptable.
//
// So registration is a console flow (docs/PORTING.md has the click path), and
// this script covers the part that actually benefits from automation: polling
// approval state over the days it takes, without logging into anything.
//
// Env: TWILIO_ACCOUNT_SID plus either TWILIO_API_KEY/TWILIO_API_SECRET or
// TWILIO_AUTH_TOKEN.

const MESSAGING = 'https://messaging.twilio.com/v1';

function auth() {
  const { TWILIO_ACCOUNT_SID, TWILIO_API_KEY, TWILIO_API_SECRET, TWILIO_AUTH_TOKEN } = process.env;
  if (!TWILIO_ACCOUNT_SID) die('TWILIO_ACCOUNT_SID is not set.');
  const user = TWILIO_API_KEY || TWILIO_ACCOUNT_SID;
  const pass = TWILIO_API_KEY ? TWILIO_API_SECRET : TWILIO_AUTH_TOKEN;
  if (!pass) die('Set TWILIO_API_KEY + TWILIO_API_SECRET, or TWILIO_AUTH_TOKEN.');
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

async function api(url) {
  const res = await fetch(url, { headers: { Authorization: auth() } });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* ignore */ }
  if (!res.ok) die(`GET ${url}\n  HTTP ${res.status}: ${data?.message || text.slice(0, 300)}`);
  return data;
}

async function status() {
  const brands = await api(`${MESSAGING}/a2p/BrandRegistrations?PageSize=20`);
  const list = brands?.data || [];

  if (!list.length) {
    console.log('\n  No brand registered yet.');
    console.log('  Console -> Messaging -> Regulatory Compliance -> A2P 10DLC.');
    console.log('  See docs/PORTING.md for the full click path.\n');
    return;
  }

  for (const b of list) {
    console.log(`\n  brand ${b.sid}`);
    console.log(`    type            ${b.brand_type}${b.brand_type === 'SOLE_PROPRIETOR' ? '' : '  <- expected SOLE_PROPRIETOR'}`);
    console.log(`    status          ${b.status}`);
    if (b.identity_status) console.log(`    identity        ${b.identity_status}`);
    // The OTP is the step people miss: the brand sits in PENDING until the
    // code texted to the owner's mobile is entered. It is not automatic.
    console.log(`    mobile OTP      ${b.russell_3p_status || b.identity_status === 'VERIFIED' ? 'done' : 'check console'}`);
    if (b.failure_reason) console.log(`    failure         ${b.failure_reason}`);
  }

  const services = await api('https://messaging.twilio.com/v1/Services?PageSize=20');
  for (const svc of services?.services || []) {
    const campaign = await api(`${MESSAGING}/Services/${svc.sid}/Compliance/Usa2p`).catch(() => null);
    if (!campaign) continue;
    console.log(`\n  campaign on ${svc.friendly_name} (${svc.sid})`);
    console.log(`    status          ${campaign.campaign_status}`);
    console.log(`    use case        ${campaign.us_app_to_person_usecase}`);
    if (campaign.errors?.length) {
      console.log(`    errors          ${JSON.stringify(campaign.errors).slice(0, 300)}`);
    }
  }

  console.log('\n  Sole Proprietor campaigns carry exactly one phone number.');
  console.log('  Prove texting on a throwaway number before moving the slot.\n');
}

function die(msg) {
  console.error(`\n  ${msg}\n`);
  process.exit(1);
}

const cmd = process.argv[2] || 'status';
if (cmd !== 'status') {
  console.error('\n  usage: node scripts/a2p.mjs status');
  console.error('  Registration is a console flow — see docs/PORTING.md.\n');
  process.exit(1);
}

await status();
