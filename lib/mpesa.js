// M-Pesa via Safaricom Daraja: Lipa Na M-Pesa Online (STK push) + status query.
//   mode 'daraja'   — real API (MPESA_ENV=sandbox|production)
//   mode 'mock'     — development only: simulated payments (numbers ending 000 simulate "cancelled")
//   mode 'disabled' — production without keys: billing switched off
//
// Written against Daraja's documented STK push / query APIs. Test end-to-end with sandbox
// credentials (and a public https callback URL) before going live.

const crypto = require('crypto');

const env = process.env;
const configured = !!(env.MPESA_CONSUMER_KEY && env.MPESA_CONSUMER_SECRET && env.MPESA_SHORTCODE && env.MPESA_PASSKEY);
const mode = configured ? 'daraja' : env.NODE_ENV === 'production' ? 'disabled' : 'mock';
const BASE = env.MPESA_BASE_URL // override for tests against a fake Daraja server
  || (env.MPESA_ENV === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke');
const isTill = env.MPESA_TYPE === 'till'; // Buy Goods (till) vs Paybill

// Daraja timestamps are Kenyan local time (EAT, UTC+3), format YYYYMMDDHHmmss.
function timestamp() {
  const d = new Date(Date.now() + 3 * 3600e3);
  return d.toISOString().replace(/[-:T]/g, '').slice(0, 14);
}
const password = (ts) => Buffer.from(env.MPESA_SHORTCODE + env.MPESA_PASSKEY + ts).toString('base64');

let cachedToken = null;
async function token() {
  if (cachedToken && cachedToken.expires > Date.now()) return cachedToken.value;
  const auth = Buffer.from(`${env.MPESA_CONSUMER_KEY}:${env.MPESA_CONSUMER_SECRET}`).toString('base64');
  const res = await fetch(`${BASE}/oauth/v1/generate?grant_type=client_credentials`, { headers: { Authorization: `Basic ${auth}` } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error(`M-Pesa auth failed (${res.status})`);
  cachedToken = { value: data.access_token, expires: Date.now() + (Number(data.expires_in || 3599) - 60) * 1000 };
  return cachedToken.value;
}

async function call(path, body) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

// ---------- mock (dev) ----------
const mockResults = new Map(); // checkoutRequestId → { resultCode, resultDesc, amount, receipt, phone }
let mockOnResult = null;       // set by billing so simulated "callbacks" go through the same code path

// Phone must be 2547XXXXXXXX / 2541XXXXXXXX (Safaricom, no +).
async function stkPush({ phone, amount, accountRef, description, callbackUrl }) {
  if (mode === 'disabled') throw new Error('M-Pesa billing is not configured');
  if (mode === 'mock') {
    const checkoutRequestId = 'ws_CO_MOCK_' + crypto.randomBytes(6).toString('hex');
    setTimeout(() => {
      const cancelled = phone.endsWith('000');
      const r = cancelled
        ? { resultCode: '1032', resultDesc: 'Request cancelled by user' }
        : { resultCode: '0', resultDesc: 'The service request is processed successfully.', amount, phone,
            receipt: 'SIM' + crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 7) };
      mockResults.set(checkoutRequestId, r);
      mockOnResult?.({ checkoutRequestId, ...r });
    }, 3500);
    return { checkoutRequestId, merchantRequestId: 'MOCK', customerMessage: 'Success. Request accepted for processing' };
  }
  const ts = timestamp();
  const { ok, data } = await call('/mpesa/stkpush/v1/processrequest', {
    BusinessShortCode: env.MPESA_SHORTCODE,
    Password: password(ts),
    Timestamp: ts,
    TransactionType: isTill ? 'CustomerBuyGoodsOnline' : 'CustomerPayBillOnline',
    Amount: amount,
    PartyA: phone,
    PartyB: isTill ? env.MPESA_TILL : env.MPESA_SHORTCODE,
    PhoneNumber: phone,
    CallBackURL: callbackUrl,
    AccountReference: accountRef.slice(0, 12),
    TransactionDesc: description.slice(0, 13),
  });
  if (!ok || data.ResponseCode !== '0') throw new Error(data.errorMessage || data.ResponseDescription || 'M-Pesa request failed');
  return { checkoutRequestId: data.CheckoutRequestID, merchantRequestId: data.MerchantRequestID, customerMessage: data.CustomerMessage };
}

// Ask Safaricom for the outcome. Returns { resultCode: '0' | other | null (still processing), resultDesc }.
async function stkQuery(checkoutRequestId) {
  if (mode === 'mock') return mockResults.get(checkoutRequestId) || { resultCode: null, resultDesc: 'Processing' };
  if (mode === 'disabled') return { resultCode: null, resultDesc: 'Billing disabled' };
  const ts = timestamp();
  const { data } = await call('/mpesa/stkpushquery/v1/query', {
    BusinessShortCode: env.MPESA_SHORTCODE, Password: password(ts), Timestamp: ts, CheckoutRequestID: checkoutRequestId,
  });
  if (data.ResultCode === undefined || data.ResultCode === null) return { resultCode: null, resultDesc: data.errorMessage || 'Processing' };
  return { resultCode: String(data.ResultCode), resultDesc: data.ResultDesc || '' };
}

// Daraja callback body → flat result.
function parseCallback(body) {
  const cb = body?.Body?.stkCallback;
  if (!cb || typeof cb.CheckoutRequestID !== 'string') return null;
  const items = Object.fromEntries((cb.CallbackMetadata?.Item || []).map((i) => [i.Name, i.Value]));
  return {
    checkoutRequestId: cb.CheckoutRequestID,
    resultCode: String(cb.ResultCode),
    resultDesc: String(cb.ResultDesc || ''),
    amount: items.Amount !== undefined ? Number(items.Amount) : null,
    receipt: items.MpesaReceiptNumber ? String(items.MpesaReceiptNumber) : null,
    phone: items.PhoneNumber ? String(items.PhoneNumber) : null,
  };
}

// Friendly text for common STK result codes.
const RESULT_TEXT = {
  1: 'Not enough money in the M-Pesa account.',
  1032: 'The payment was cancelled on the phone.',
  1037: 'The phone couldn\'t be reached in time. Check it\'s on and try again.',
  2001: 'Wrong M-Pesa PIN entered.',
  1025: 'M-Pesa couldn\'t send the prompt. Try again.',
};
const resultText = (code, desc) => RESULT_TEXT[Number(code)] || desc || 'The payment didn\'t go through.';

module.exports = {
  mode, stkPush, stkQuery, parseCallback, resultText,
  onMockResult: (fn) => { mockOnResult = fn; },
};
