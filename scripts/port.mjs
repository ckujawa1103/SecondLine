#!/usr/bin/env node
// Port a number into Twilio: check, submit, watch.
//
//   node scripts/port.mjs lookup   [+1815...]   carrier of record + line type
//   node scripts/port.mjs check    [+1815...]   portability lookup, read-only
//   node scripts/port.mjs submit               upload doc + create port-in
//   node scripts/port.mjs status               poll the request
//
// Credentials come from the environment, never from a file in this repo:
//
//   TWILIO_ACCOUNT_SID=AC...
//   TWILIO_API_KEY=SK...        preferred — revocable without rotating the
//   TWILIO_API_SECRET=...       account auth token
//   TWILIO_AUTH_TOKEN=...       fallback if no API key is set
//
// Everything specific to this port — PIN, account number, service address —
// lives in port-info.json, which .gitignore excludes because this repo is
// public. See docs/PORTING.md for where each field comes from.

import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';

const NUMBERS = 'https://numbers.twilio.com/v1';
const UPLOAD = 'https://numbers-upload.twilio.com/v1';
const LOOKUPS = 'https://lookups.twilio.com/v2';

const INFO_PATH = new URL('../port-info.json', import.meta.url);
const STATE_PATH = new URL('../port-state.json', import.meta.url);

/* ---------- credentials ---------- */

function auth() {
  const { TWILIO_ACCOUNT_SID, TWILIO_API_KEY, TWILIO_API_SECRET, TWILIO_AUTH_TOKEN } = process.env;

  if (!TWILIO_ACCOUNT_SID) die('TWILIO_ACCOUNT_SID is not set.');

  // An API key can be revoked on its own. The auth token cannot — rotating it
  // breaks every deployed Worker secret at the same time.
  const user = TWILIO_API_KEY || TWILIO_ACCOUNT_SID;
  const pass = TWILIO_API_KEY ? TWILIO_API_SECRET : TWILIO_AUTH_TOKEN;

  if (!pass) {
    die('Set TWILIO_API_KEY + TWILIO_API_SECRET (preferred), or TWILIO_AUTH_TOKEN.');
  }
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: auth(),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }

  if (!res.ok) {
    // Twilio's error bodies carry the useful part — a bare status code here
    // would cost a support round-trip to diagnose.
    const detail = data?.message || data?.detail || text.slice(0, 400);
    die(`${method} ${url}\n  HTTP ${res.status}: ${detail}`);
  }
  return data;
}

/* ---------- check ---------- */

async function check(argv) {
  const info = await loadInfo({ optional: true });
  const number = argv[0] || info?.phone_number;
  if (!number) die('Pass a number, or set phone_number in port-info.json.');

  const r = await api('GET', `${NUMBERS}/Porting/Portability/PhoneNumber/${encodeURIComponent(number)}`);

  console.log(`\n  ${r.phone_number}`);
  console.log(`  portable         ${r.portable ? 'yes' : 'NO'}`);
  console.log(`  number type      ${r.number_type}`);
  console.log(`  country          ${r.country}`);
  console.log(`  PIN + account #  ${r.pin_and_account_number_required ? 'required' : 'not required'}`);

  if (!r.portable) {
    console.log(`\n  not portable: ${r.not_portable_reason} (code ${r.not_portable_reason_code})`);
  }

  // The number already sitting in a Twilio account is the expected result here
  // and not a failure — GoDaddy Conversations runs on Twilio, so the number is
  // in GoDaddy's account today. It does mean the self-serve port-in path may
  // not apply; see docs/PORTING.md step 1.
  if (r.account_sid) {
    const mine = r.account_sid === process.env.TWILIO_ACCOUNT_SID;
    console.log(`\n  already in a Twilio account: ${r.account_sid}${mine ? ' (yours)' : ' (not yours)'}`);
    if (!mine) {
      console.log('  -> this is an account-to-account move. Confirm the path with');
      console.log('     porting@twilio.com before submitting anything.');
    }
  }
  console.log();
}

/* ---------- lookup ---------- */

/**
 * What the gaining carrier's porting system will see.
 *
 * A wireless port-in of a number flagged VoIP is legal — the FCC requires
 * intermodal porting — but carriers reject on their own policy, and that is
 * the most likely reason the 2025 Mint attempt died. Worth $0.005 to know
 * before a rejection costs a week.
 */
async function lookup(argv) {
  const info = await loadInfo({ optional: true });
  const number = argv[0] || info?.phone_number;
  if (!number) die('Pass a number, or set phone_number in port-info.json.');

  const r = await api(
    'GET',
    `${LOOKUPS}/PhoneNumbers/${encodeURIComponent(number)}?Fields=line_type_intelligence,caller_name`,
  );

  const line = r.line_type_intelligence || {};

  console.log(`\n  ${r.phone_number}  ${r.national_format || ''}`);
  console.log(`  valid            ${r.valid ? 'yes' : 'NO'}`);
  console.log(`  carrier          ${line.carrier_name || 'unknown'}`);
  console.log(`  line type        ${line.type || 'unknown'}`);
  if (r.caller_name?.caller_name) console.log(`  CNAM             ${r.caller_name.caller_name}`);
  if (line.error_code) console.log(`  lookup error     ${line.error_code}`);

  // fixedVoip / nonFixedVoip is the flag that makes wireless carriers balk.
  if (line.type && String(line.type).toLowerCase().includes('voip')) {
    console.log('\n  Flagged VoIP. A wireless port-in is legal but carrier policy');
    console.log('  decides. Submit the losing carrier CSR values EXACTLY — the');
    console.log('  subscriber name, address and ZIP on the port form must match the');
    console.log('  carrier of record above, not your own name and home address.');
    console.log('  A mismatch here is an automatic rejection. See docs/PORTING.md.');
  }
  console.log();
}

/* ---------- submit ---------- */

async function submit() {
  const info = await loadInfo();
  requireFields(info, [
    'phone_number', 'pin', 'customer_type', 'customer_name', 'account_number',
    'address', 'authorized_representative', 'authorized_representative_email',
    'document_path',
  ]);

  // Refuse to submit against a number Twilio already says is unportable —
  // a rejected request costs days, and the check is free.
  const portability = await api(
    'GET',
    `${NUMBERS}/Porting/Portability/PhoneNumber/${encodeURIComponent(info.phone_number)}`,
  );
  if (!portability.portable) {
    die(`${info.phone_number} is not portable right now: ${portability.not_portable_reason}\n` +
        '  If the GoDaddy unlock was recent, give it a day and re-run `port:check`.');
  }

  const documentSid = await uploadDocument(info.document_path);
  console.log(`  document uploaded: ${documentSid}`);

  const body = {
    documents: [documentSid],
    phone_numbers: [{ phone_number: info.phone_number, pin: info.pin }],
    losing_carrier_information: {
      customer_type: info.customer_type,
      customer_name: info.customer_name,
      account_number: info.account_number,
      account_telephone_number: info.account_telephone_number || info.phone_number,
      address: info.address,
      authorized_representative: info.authorized_representative,
      authorized_representative_email: info.authorized_representative_email,
    },
    notification_emails: info.notification_emails || [info.authorized_representative_email],
    ...(info.target_port_in_date ? { target_port_in_date: info.target_port_in_date } : {}),
  };

  const r = await api('POST', `${NUMBERS}/Porting/PortIn`, body);

  await writeFile(STATE_PATH, JSON.stringify({
    port_in_request_sid: r.port_in_request_sid,
    submitted_at: new Date().toISOString(),
  }, null, 2) + '\n');

  console.log(`\n  submitted: ${r.port_in_request_sid}`);
  console.log(`  status:    ${r.status}`);
  console.log('\n  Twilio is emailing the LOA to');
  console.log(`  ${info.authorized_representative_email} for signature.`);
  console.log('  Nothing moves until that is signed — it cannot be automated.\n');
}

async function uploadDocument(path) {
  const file = await readFile(new URL(`../${path}`, import.meta.url)).catch(() => {
    die(`Cannot read ${path}. Point document_path at the GoDaddy renewal receipt.`);
  });

  const form = new FormData();
  form.append('document_type', 'utility_bill');
  form.append('friendly_name', `SecondLine port-in proof — ${basename(path)}`);
  form.append('File', new Blob([file]), basename(path));

  const res = await fetch(`${UPLOAD}/Documents`, {
    method: 'POST',
    headers: { Authorization: auth() },
    body: form,
  });

  const data = await res.json().catch(() => null);
  if (!res.ok) die(`Document upload failed — HTTP ${res.status}: ${data?.message || ''}`);
  return data.sid;
}

/* ---------- status ---------- */

async function status(argv) {
  let sid = argv[0];
  if (!sid) {
    const state = await readJson(STATE_PATH);
    sid = state?.port_in_request_sid;
  }
  if (!sid) die('No port-in request SID. Pass one, or run `submit` first.');

  const r = await api('GET', `${NUMBERS}/Porting/PortIn/${sid}`);

  console.log(`\n  ${sid}`);
  console.log(`  status        ${r.status}`);
  if (r.target_port_in_date) console.log(`  target date   ${r.target_port_in_date}`);

  for (const n of r.phone_numbers || []) {
    console.log(`\n  ${n.phone_number}`);
    console.log(`    status      ${n.status}`);
    if (n.port_out_pin) console.log(`    port-out pin on file`);
    // The rejection reason is the entire diagnostic. Most rejections are a name
    // or address that does not match the losing carrier's record exactly.
    if (n.rejection_reason) console.log(`    rejected    ${n.rejection_reason}`);
  }

  if (r.status === 'waiting-for-signature') {
    console.log('\n  Waiting on the LOA signature email. Check spam.');
  }
  if (r.status === 'action-required') {
    console.log('\n  Twilio needs something. The reason above is the whole story —');
    console.log('  usually a mismatch against the losing carrier CSR.');
  }
  console.log();
}

/* ---------- helpers ---------- */

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; }
}

async function loadInfo({ optional = false } = {}) {
  const info = await readJson(INFO_PATH);
  if (!info && !optional) {
    die('port-info.json not found. Copy port-info.example.json and fill it in\n' +
        '  from the sources listed in docs/PORTING.md. It is gitignored.');
  }
  return info;
}

function requireFields(obj, fields) {
  const missing = fields.filter((f) => !obj[f]);
  if (missing.length) die(`port-info.json is missing: ${missing.join(', ')}`);
}

function die(msg) {
  console.error(`\n  ${msg}\n`);
  process.exit(1);
}

/* ---------- main ---------- */

const [cmd, ...argv] = process.argv.slice(2);
const commands = { lookup, check, submit, status };

if (!commands[cmd]) {
  console.error('\n  usage: node scripts/port.mjs <lookup|check|submit|status>\n');
  process.exit(1);
}

await commands[cmd](argv);
