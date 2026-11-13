// External verification providers: SMS (Africa's Talking), email (Resend), ID/KYC (Smile ID).
// Each falls back to a dev implementation (console / mock) when its keys aren't set.
// server.js refuses to start in production unless every real provider is configured.

const crypto = require('crypto');

const env = process.env;

// ---------- SMS: Africa's Talking ----------
const sms = {
  name: env.AT_API_KEY && env.AT_USERNAME ? 'africastalking' : 'console',
  async send(to, message) {
    if (this.name === 'console') {
      console.log(`\n📱 [DEV SMS to ${to}] ${message}\n`);
      return;
    }
    const host = env.AT_USERNAME === 'sandbox' ? 'api.sandbox.africastalking.com' : 'api.africastalking.com';
    const body = new URLSearchParams({ username: env.AT_USERNAME, to, message });
    if (env.AT_SENDER_ID) body.set('from', env.AT_SENDER_ID);
    const res = await fetch(`https://${host}/version1/messaging`, {
      method: 'POST',
      headers: { apiKey: env.AT_API_KEY, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const data = await res.json().catch(() => ({}));
    const r = data?.SMSMessageData?.Recipients?.[0];
    if (!res.ok || !r || ![100, 101, 102].includes(r.statusCode)) {
      throw new Error(`SMS failed: ${r?.status || res.status}`);
    }
  },
};

// ---------- Email: Resend ----------
const email = {
  name: env.RESEND_API_KEY && env.EMAIL_FROM ? 'resend' : 'console',
  async send(to, subject, text) {
    if (this.name === 'console') {
      console.log(`\n📧 [DEV EMAIL to ${to}] ${subject}\n${text}\n`);
      return;
    }
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.EMAIL_FROM, to: [to], subject, text }),
    });
    if (!res.ok) throw new Error(`Email failed: ${res.status}`);
  },
};

// ---------- ID / KYC: Smile ID (Kenya, IPRS lookup) ----------
// Written against Smile ID's REST "ID verification" (Enhanced KYC) API. Test it with
// sandbox keys (SMILE_ENV=sandbox) before going live and check field names against
// their current docs.
const ID_TYPES = { NATIONAL_ID: 'National ID', PASSPORT: 'Passport', ALIEN_CARD: 'Alien ID' };

function ageFrom(dob, at = new Date()) {
  const d = new Date(dob + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return null;
  let age = at.getUTCFullYear() - d.getUTCFullYear();
  const m = at.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && at.getUTCDate() < d.getUTCDate())) age--;
  return age;
}

const kyc = {
  name: env.SMILE_PARTNER_ID && env.SMILE_API_KEY ? 'smileid' : 'mock',
  ID_TYPES,
  // Returns { ok, reason?, dob? }
  async verify({ idType, idNumber, firstName, lastName, dob, userId }) {
    if (this.name === 'mock') return mockVerify({ idType, idNumber, dob });

    const timestamp = new Date().toISOString();
    const signature = crypto.createHmac('sha256', env.SMILE_API_KEY)
      .update(timestamp + env.SMILE_PARTNER_ID + 'sid_request').digest('base64');
    const host = env.SMILE_ENV === 'production' ? 'api.smileidentity.com' : 'testapi.smileidentity.com';
    const res = await fetch(`https://${host}/v1/id_verification`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source_sdk: 'rest_api', source_sdk_version: '1.0.0',
        partner_id: env.SMILE_PARTNER_ID, timestamp, signature,
        country: 'KE', id_type: idType, id_number: idNumber,
        first_name: firstName, last_name: lastName, dob,
        partner_params: { job_id: crypto.randomUUID(), user_id: userId, job_type: 5 },
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`ID check failed: ${res.status}`);
    const a = data.Actions || {};
    if (a.Verify_ID_Number !== 'Verified') return { ok: false, reason: 'We couldn\'t find that ID number. Check it and try again.' };
    if (a.Names === 'No Match') return { ok: false, reason: 'The name doesn\'t match that ID.' };
    if (a.DOB === 'No Match') return { ok: false, reason: 'The date of birth doesn\'t match that ID.' };
    // Prefer the registry's DOB when it's returned.
    const regDob = /^\d{4}-\d{2}-\d{2}$/.test(data.DOB || '') ? data.DOB : dob;
    return { ok: true, dob: regDob };
  },
};

// Dev-only stand-in. Accepts plausible input; an ID number ending in 0000 simulates "not found".
function mockVerify({ idType, idNumber, dob }) {
  const formats = { NATIONAL_ID: /^\d{7,9}$/, PASSPORT: /^[A-Z]{1,2}\d{6,8}$/, ALIEN_CARD: /^\d{6,9}$/ };
  if (!formats[idType]?.test(idNumber)) return { ok: false, reason: 'That ID number doesn\'t look right.' };
  if (idNumber.endsWith('0000')) return { ok: false, reason: 'We couldn\'t find that ID number. (mock: numbers ending 0000 fail)' };
  return { ok: true, dob };
}

module.exports = { sms, email, kyc, ageFrom, ID_TYPES };
