#!/usr/bin/env node
// Provision a Twilio number and wire it to this Worker.
//
//   node scripts/number.mjs search 815
//   node scripts/number.mjs buy +18157064125 --label "Quest" \
//        --email chris@questwatersports.com --forward +16319424439
//   node scripts/number.mjs list
//   node scripts/number.mjs point +18158002292      re-point webhooks here
//
// Credentials from the environment. An API key is strongly preferred over the
// account auth token: the auth token also verifies webhook signatures on every
// deployed Worker, so rotating it takes those down at the same instant.
//
//   TWILIO_ACCOUNT_SID=AC...
//   TWILIO_API_KEY=SK...      preferred
//   TWILIO_API_SECRET=...
//   TWILIO_AUTH_TOKEN=...     fallback
//   APP_BASE_URL=https://secondline.<subdomain>.workers.dev
//
// Buying a number is a recurring charge, so `buy` prints what it is about to
// do and requires --yes to actually spend money.

const API = 'https://api.twilio.com/2010-04-01';

function auth() {
  const { TWILIO_ACCOUNT_SID, TWILIO_API_KEY, TWILIO_API_SECRET, TWILIO_AUTH_TOKEN } = process.env;
  if (!TWILIO_ACCOUNT_SID) die('TWILIO_ACCOUNT_SID is not set.');
  const user = TWILIO_API_KEY || TWILIO_ACCOUNT_SID;
  const pass = TWILIO_API_KEY ? TWILIO_API_SECRET : TWILIO_AUTH_TOKEN;
  if (!pass) die('Set TWILIO_API_KEY + TWILIO_API_SECRET (preferred), or TWILIO_AUTH_TOKEN.');
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

const sid = () => process.env.TWILIO_ACCOUNT_SID;

async function api(method, path, form) {
  const res = await fetch(`${API}/Accounts/${sid()}${path}`, {
    method,
    headers: {
      Authorization: auth(),
      ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    ...(form ? { body: new URLSearchParams(form) } : {}),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!res.ok) die(`${method} ${path}\n  HTTP ${res.status}: ${data?.message || text.slice(0, 300)}`);
  return data;
}

/* ---------- commands ---------- */

async function search([areaCode]) {
  if (!areaCode) die('Pass an area code, e.g. `search 815`.');
  const qs = new URLSearchParams({
    AreaCode: areaCode, SmsEnabled: 'true', VoiceEnabled: 'true', PageSize: '15',
  });
  const r = await api('GET', `/AvailablePhoneNumbers/US/Local.json?${qs}`);

  console.log();
  for (const n of r.available_phone_numbers || []) {
    const c = n.capabilities || {};
    const caps = [c.voice && 'voice', (c.SMS ?? c.sms) && 'sms', (c.MMS ?? c.mms) && 'mms']
      .filter(Boolean).join(' ');
    console.log(`  ${n.phone_number}  ${n.locality || ''}, ${n.region || ''}  [${caps}]`);
  }
  console.log('\n  Buy one with:  node scripts/number.mjs buy <number> --label "..." --yes\n');
}

async function buy([number, ...rest]) {
  if (!number) die('Pass the number to buy, e.g. `buy +18157064125`.');

  const opts = parseFlags(rest);
  const base = (process.env.APP_BASE_URL || '').replace(/\/+$/, '');
  if (!base) {
    die('APP_BASE_URL is not set. The number needs somewhere to send webhooks —\n' +
        '  deploy the Worker first, then set APP_BASE_URL to its URL.');
  }

  console.log(`\n  Buying   ${number}`);
  console.log(`  Label    ${opts.label || '(none)'}`);
  console.log(`  Email    ${opts.email || '(falls back to OWNER_EMAIL)'}`);
  console.log(`  Forward  ${opts.forward || '(straight to voicemail)'}`);
  console.log(`  Webhooks ${base}/twilio/{voice,message}`);
  console.log('\n  This is a recurring charge (~$1.15/month).');

  if (!opts.yes) {
    console.log('  Re-run with --yes to purchase.\n');
    return;
  }

  const bought = await api('POST', '/IncomingPhoneNumbers.json', {
    PhoneNumber: number,
    FriendlyName: opts.label || 'SecondLine',
    VoiceUrl: `${base}/twilio/voice`,
    VoiceMethod: 'POST',
    StatusCallback: `${base}/twilio/call-status`,
    StatusCallbackMethod: 'POST',
    SmsUrl: `${base}/twilio/message`,
    SmsMethod: 'POST',
  });

  console.log(`\n  Purchased ${bought.phone_number}  (${bought.sid})`);
  printRow(bought, opts);
}

/** Re-point an existing number's webhooks at this Worker. */
async function point([number]) {
  if (!number) die('Pass the number to re-point.');
  const base = (process.env.APP_BASE_URL || '').replace(/\/+$/, '');
  if (!base) die('APP_BASE_URL is not set.');

  const list = await api('GET', `/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(number)}`);
  const found = (list.incoming_phone_numbers || [])[0];
  if (!found) die(`${number} is not in this account.`);

  console.log(`\n  ${found.phone_number} currently points at:`);
  console.log(`    voice -> ${found.voice_url || '(none)'}`);
  console.log(`    sms   -> ${found.sms_url || '(none)'}`);
  console.log(`\n  Re-pointing to ${base} ...`);

  const updated = await api('POST', `/IncomingPhoneNumbers/${found.sid}.json`, {
    VoiceUrl: `${base}/twilio/voice`,
    VoiceMethod: 'POST',
    StatusCallback: `${base}/twilio/call-status`,
    StatusCallbackMethod: 'POST',
    SmsUrl: `${base}/twilio/message`,
    SmsMethod: 'POST',
  });

  console.log(`  done: ${updated.voice_url}\n`);
}

async function list() {
  const r = await api('GET', '/IncomingPhoneNumbers.json?PageSize=50');
  console.log();
  for (const n of r.incoming_phone_numbers || []) {
    console.log(`  ${n.phone_number}  ${n.friendly_name || ''}`);
    console.log(`     voice -> ${n.voice_url || '(none)'}`);
    console.log(`     sms   -> ${n.sms_url || '(none)'}`);
  }
  console.log();
}

/**
 * The D1 row is printed rather than inserted: this script holds Twilio
 * credentials, not Cloudflare ones, and having it reach into the database
 * would mean handing it a second set of keys it does not otherwise need.
 */
function printRow(bought, opts) {
  const id = Math.random().toString(36).slice(2, 12);
  const sql =
    `INSERT INTO numbers (id, e164, label, twilio_sid, forward_to, notify_email, ` +
    `greeting_mode, greeting_text, created_at) VALUES (` +
    `'${id}', '${bought.phone_number}', ${q(opts.label)}, '${bought.sid}', ` +
    `${q(opts.forward)}, ${q(opts.email)}, 'tts', ${q(opts.greeting)}, ` +
    `unixepoch());`;

  console.log('\n  Add it to the database:\n');
  console.log(`    cd worker && npx wrangler d1 execute secondline --remote \\`);
  console.log(`      --command "${sql.replace(/"/g, '\\"')}"`);

  console.log('\n  Then, on the phone whose calls should land here, dial:\n');
  console.log(`    **004*${bought.phone_number.replace('+1', '')}#`);
  console.log('\n  That forwards only unanswered, busy and unreachable calls.');
  console.log('  ##004# undoes it completely.\n');
}

const q = (v) => (v ? `'${String(v).replace(/'/g, "''")}'` : 'NULL');

function parseFlags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--yes') out.yes = true;
    else if (a.startsWith('--')) out[a.slice(2)] = argv[++i];
  }
  return out;
}

function die(msg) {
  console.error(`\n  ${msg}\n`);
  process.exit(1);
}

const [cmd, ...argv] = process.argv.slice(2);
const commands = { search, buy, list, point };
if (!commands[cmd]) {
  console.error('\n  usage: node scripts/number.mjs <search|buy|list|point>\n');
  process.exit(1);
}
await commands[cmd](argv);
