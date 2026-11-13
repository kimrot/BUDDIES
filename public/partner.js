// Partner bar dashboard: stats, deal-code redemption, match deal & promos, venue profile, team.
// Every action is authorised server-side; this page only renders what the API returns.
'use strict';

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const view = $('#view');
const fmtDay = (d) => new Date(d + 'T00:00:00').toLocaleDateString('en-KE', { month: 'short', day: 'numeric' });
const fmtTime = (t) => new Date(t).toLocaleString('en-KE', { weekday: 'short', hour: '2-digit', minute: '2-digit' });

let venues = [];
let current = null;
let tab = 'overview';

async function api(method, url, body) {
  const res = await fetch('/api' + url, {
    method, credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-CSRF': '1' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Something went wrong'), { status: res.status, code: data.code });
  return data;
}
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 2800);
}
function getLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('Location not supported'));
    navigator.geolocation.getCurrentPosition((p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => reject(new Error('Couldn\'t get location — enter it manually')), { enableHighAccuracy: true, timeout: 10000 });
  });
}

// ---------- boot ----------
async function boot() {
  try { venues = await api('GET', '/partner/venues'); }
  catch (e) {
    const msg = e.status === 401 ? 'Log in to Drinking Buddies first, then come back here.'
      : e.code === 'VERIFY_BASIC' ? 'Verify your phone and email in the app first.' : e.message;
    view.innerHTML = `<div class="empty"><div class="big">🔒</div><p>${esc(msg)}</p><a class="btn" href="/">Open the app</a></div>`;
    return;
  }
  const pick = $('#venuePick');
  pick.hidden = venues.length < 2;
  pick.innerHTML = venues.map((v) => `<option value="${esc(v.id)}">${esc(v.name)}</option>`).join('') + '<option value="__new">+ Add another venue</option>';
  pick.onchange = () => { if (pick.value === '__new') return renderApply(); select(pick.value); };
  if (!venues.length) return renderApply();
  select(current?.id && venues.some((v) => v.id === current.id) ? current.id : venues[0].id);
}

function select(vid) {
  current = venues.find((v) => v.id === vid);
  $('#venuePick').value = vid;
  render();
}

async function reloadVenue() {
  venues = await api('GET', '/partner/venues');
  current = venues.find((v) => v.id === current.id) || venues[0];
}

// ---------- apply ----------
function renderApply() {
  view.innerHTML = `
    <section class="pitch">
      <h1>Bring Buddies to your bar</h1>
      <p class="muted">Verified people pick where they're drinking tonight. Partner bars show up in that list, can offer a deal to people who match there, and see how many come in.</p>
      <div class="pitch-grid">
        <div><b>📍 Get picked</b><span class="muted small">Listed when people set where they're drinking. Featured bars show first.</span></div>
        <div><b>🎁 Match deals</b><span class="muted small">"20% off the first round" for pairs who match at your bar. Each pair gets a one-time code.</span></div>
        <div><b>📣 Quiet-night promos</b><span class="muted small">One push a day to verified people nearby who opted in to deals.</span></div>
      </div>
    </section>
    <form id="applyForm" class="card-form">
      <h2>Register your venue</h2>
      <div class="row"><label>Venue name<input name="name" required maxlength="60"></label><label>Area<input name="area" required maxlength="60" placeholder="e.g. Westlands"></label></div>
      <label>Street address<input name="address" required maxlength="160"></label>
      <label>Short description<textarea name="description" maxlength="400" placeholder="Rooftop bar, live music Fridays, great nyama choma…"></textarea></label>
      <div class="row"><label>Business KRA PIN<input name="kraPin" required maxlength="11" placeholder="P051234567X"></label><label>Contact phone<input name="contactPhone" type="tel" required placeholder="0712 345 678"></label></div>
      <label>Location <span class="muted small">— stand at the venue and tap the button, or paste coordinates</span>
        <div class="row"><input name="loc" placeholder="-1.2641, 36.8040" required><button type="button" class="btn secondary" id="locBtn" style="flex:none">📍 Use my location</button></div></label>
      <p class="muted small">We review every venue (business details and location) before it goes live — usually within one working day.</p>
      <div class="error" id="err"></div>
      <div class="row">${venues.length ? '<button type="button" class="btn secondary" id="cancel">Cancel</button>' : ''}<button class="btn">Submit for review</button></div>
    </form>`;
  $('#locBtn').onclick = async () => {
    try { const c = await getLocation(); $('[name=loc]').value = `${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}`; }
    catch (e) { $('#err').textContent = e.message; }
  };
  if ($('#cancel')) $('#cancel').onclick = () => select(venues[0].id);
  $('#applyForm').onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    const m = f.loc.match(/(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/);
    if (!m) return ($('#err').textContent = 'Location should look like: -1.2641, 36.8040');
    try {
      const v = await api('POST', '/partner/venues', { ...f, lat: Number(m[1]), lng: Number(m[2]) });
      current = v; tab = 'overview';
      toast('Submitted for review');
      boot();
    } catch (err) { $('#err').textContent = err.message; }
  };
}

// ---------- venue shell ----------
function render() {
  clearInterval(billTimer);
  const v = current;
  const owner = v.role === 'owner';
  const banner = {
    pending: '<div class="vstatus pending">⏳ <b>Awaiting approval.</b> We\'re reviewing your venue. You can finish your deal and profile in the meantime.</div>',
    rejected: `<div class="vstatus bad">✕ <b>Not approved:</b> ${esc(v.note || '')}</div>`,
    suspended: `<div class="vstatus bad">⏸ <b>Suspended:</b> ${esc(v.note || '')}</div>`,
    active: '',
  }[v.status];
  const tabs = [['overview', 'Overview'], ['redeem', 'Redeem code'], ['deal', 'Deal & promos'], ['venue', 'Venue'], ...(owner ? [['team', 'Team'], ['billing', 'Billing']] : [])];
  if (!tabs.some(([k]) => k === tab)) tab = 'overview';
  view.innerHTML = `
    <div class="vhead"><div><h1>${esc(v.name)}</h1><div class="muted small">${esc(v.area)} · ${v.featured ? '<span class="tag gold">★ Featured</span>' : 'Basic listing'} · you're ${owner ? 'the owner' : 'staff'}</div></div></div>
    ${banner}
    <nav class="ptabs">${tabs.map(([k, l]) => `<button data-tab="${k}" class="${k === tab ? 'on' : ''}">${l}</button>`).join('')}</nav>
    <div id="panel"></div>`;
  view.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => { tab = b.dataset.tab; render(); }));
  ({ overview: renderOverview, redeem: renderRedeem, deal: renderDeal, venue: renderVenue, team: renderTeam, billing: renderBilling })[tab]();
}

// ---------- overview ----------
async function renderOverview() {
  const panel = $('#panel');
  panel.innerHTML = '<p class="muted">Loading…</p>';
  let s;
  try { s = await api('GET', `/partner/venues/${current.id}/stats?days=14`); }
  catch (e) { panel.innerHTML = `<p class="error">${esc(e.message)}</p>`; return; }
  panel.innerHTML = `
    <div class="tiles">
      <div class="tile hero"><span class="tile-label">Here now</span><span class="tile-value">${s.hereNow}</span><span class="tile-sub">Buddies checked in at your bar</span></div>
      <div class="tile"><span class="tile-label">Check-ins</span><span class="tile-value">${s.totals.checkins}</span><span class="tile-sub">last 14 days</span></div>
      <div class="tile"><span class="tile-label">Matches made here</span><span class="tile-value">${s.totals.matches}</span><span class="tile-sub">last 14 days</span></div>
      <div class="tile"><span class="tile-label">Deals redeemed</span><span class="tile-value">${s.totals.redemptions}</span><span class="tile-sub">last 14 days</span></div>
    </div>
    <section class="chart-card">
      <h3>Daily check-ins, last 14 days</h3>
      <div class="chart" id="chart"></div>
      <details class="small"><summary>Show as table</summary>
        <table class="audit"><thead><tr><th>Day</th><th>Check-ins</th><th>Matches</th><th>Redeemed</th></tr></thead>
        <tbody>${s.series.slice().reverse().map((d) => `<tr><td>${fmtDay(d.day)}</td><td>${d.checkins}</td><td>${d.matches}</td><td>${d.redemptions}</td></tr>`).join('')}</tbody></table></details>
    </section>
    <div class="two-col">
      <section class="chart-card"><h3>Recent redemptions</h3>${s.recentRedemptions.length
        ? `<ul class="plain">${s.recentRedemptions.map((r) => `<li><code>${esc(r.code)}</code> <span class="muted small">${fmtTime(r.at)} · by @${esc(r.by)}</span></li>`).join('')}</ul>`
        : '<p class="muted small">No deals redeemed yet.</p>'}</section>
      <section class="chart-card"><h3>Recent promos</h3>${s.promos.length
        ? `<ul class="plain">${s.promos.map((p) => `<li>${esc(p.text)}<br><span class="muted small">${fmtTime(p.at)} · sent to ${p.reach < 5 ? 'fewer than 5' : p.reach} people</span></li>`).join('')}</ul>`
        : '<p class="muted small">No promos sent yet.</p>'}</section>
    </div>
    <p class="muted small">We only ever show totals — never who checked in, matched or got a promo.</p>`;
  drawBars($('#chart'), s.series.map((d) => ({ label: fmtDay(d.day), value: d.checkins, d })));
}

// Single-series bar chart (inline SVG): rounded 4px tops on the baseline, 2px gaps,
// recessive grid, hover tooltip on a full-height hit target. Redraws on resize.
function drawBars(el, data) {
  const draw = () => {
    const W = el.clientWidth || 600, H = 200, padL = 28, padB = 24, padT = 8;
    const max = Math.max(4, ...data.map((d) => d.value));
    const step = Math.ceil(max / 4);
    const top = step * 4;
    const plotW = W - padL, plotH = H - padB - padT;
    const band = plotW / data.length;
    const bw = Math.max(4, Math.min(36, band - 2 * Math.max(2, band * 0.18)));
    const y = (v) => padT + plotH - (v / top) * plotH;
    const grid = [0, 1, 2, 3, 4].map((i) => {
      const v = i * step;
      return `<line x1="${padL}" x2="${W}" y1="${y(v)}" y2="${y(v)}" class="gridline"/>
        <text x="${padL - 6}" y="${y(v) + 4}" text-anchor="end" class="axis-label">${v}</text>`;
    }).join('');
    const bars = data.map((d, i) => {
      const x = padL + i * band + (band - bw) / 2;
      const h = (d.value / top) * plotH;
      const yb = padT + plotH;
      const r = Math.min(4, h, bw / 2);
      const path = h <= 0 ? '' : `M${x},${yb} V${yb - h + r} Q${x},${yb - h} ${x + r},${yb - h} H${x + bw - r} Q${x + bw},${yb - h} ${x + bw},${yb - h + r} V${yb} Z`;
      const showLabel = i === 0 || i === data.length - 1 || i === Math.floor(data.length / 2);
      return `<g class="bar" data-i="${i}">
        <rect x="${padL + i * band}" y="${padT}" width="${band}" height="${plotH}" class="hit"/>
        ${path ? `<path d="${path}" class="mark"/>` : ''}
        ${showLabel ? (() => { // keep the end labels inside the plot
        const [ax, anchor] = i === 0 ? [x, 'start'] : i === data.length - 1 ? [x + bw, 'end'] : [x + bw / 2, 'middle'];
        return `<text x="${ax}" y="${H - 6}" text-anchor="${anchor}" class="axis-label">${esc(d.label)}</text>`;
      })() : ''}
      </g>`;
    }).join('');
    el.innerHTML = `<svg width="${W}" height="${H}" role="img" aria-label="Daily check-ins, last ${data.length} days">${grid}${bars}</svg><div class="tip" hidden></div>`;
    const tip = $('.tip', el);
    el.querySelectorAll('.bar').forEach((g) => {
      const d = data[g.dataset.i];
      g.onpointerenter = () => {
        g.classList.add('hover');
        tip.innerHTML = `<b>${esc(d.label)}</b><br>${d.value} check-in${d.value === 1 ? '' : 's'}<br><span class="muted">${d.d.matches} match${d.d.matches === 1 ? '' : 'es'} · ${d.d.redemptions} redeemed</span>`;
        tip.hidden = false;
        const i = Number(g.dataset.i);
        const cx = padL + i * band + band / 2;
        tip.style.left = Math.min(Math.max(cx - tip.offsetWidth / 2, 0), W - tip.offsetWidth) + 'px';
        tip.style.top = Math.max(0, y(d.value) - tip.offsetHeight - 8) + 'px';
      };
      g.onpointerleave = () => { g.classList.remove('hover'); tip.hidden = true; };
    });
  };
  draw();
  clearTimeout(drawBars.t);
  window.onresize = () => { clearTimeout(drawBars.t); drawBars.t = setTimeout(() => el.isConnected && draw(), 120); };
}

// ---------- redeem ----------
function renderRedeem() {
  $('#panel').innerHTML = `
    <form id="redeemForm" class="card-form redeem">
      <h2>Redeem a match deal</h2>
      <p class="muted">Matched Buddies show a code in their chat. Type it here to confirm it's real and mark it used.</p>
      <div class="code-in"><span>BUDDY-</span><input name="code" maxlength="6" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="7KQ3XF" required></div>
      <button class="btn" ${current.status !== 'active' ? 'disabled' : ''}>Check & redeem</button>
      <div id="result"></div>
      ${current.status !== 'active' ? '<p class="muted small">Redeeming opens once your venue is approved.</p>' : ''}
    </form>`;
  const input = $('[name=code]');
  input.oninput = () => { input.value = input.value.toUpperCase().replace(/^BUDDY-?/, '').replace(/[^A-Z0-9]/g, ''); };
  input.focus();
  $('#redeemForm').onsubmit = async (e) => {
    e.preventDefault();
    const out = $('#result');
    try {
      const r = await api('POST', `/partner/venues/${current.id}/redeem`, { code: input.value });
      out.innerHTML = `<div class="result ok">✅ <b>Valid — ${esc(r.deal)}</b><br><span class="small">${esc(r.note)}</span></div>`;
      input.value = '';
    } catch (err) {
      out.innerHTML = `<div class="result bad">⛔ <b>${esc(err.message)}</b><br><span class="small">Don't apply the deal.</span></div>`;
    }
  };
}

// ---------- deal & promos ----------
async function renderDeal() {
  const v = current, owner = v.role === 'owner';
  const d = v.deal;
  $('#panel').innerHTML = `
    <div class="two-col">
      <form id="dealForm" class="card-form">
        <h2>Match deal</h2>
        <p class="muted small">Shown on the cards of people checked in at your bar, and as a one-time code to pairs who match. One redemption per pair.</p>
        <label>Title<input name="title" maxlength="60" value="${esc(d.title)}" placeholder="20% off your first round" ${owner ? '' : 'disabled'}></label>
        <label>Details<textarea name="details" maxlength="200" placeholder="For both of you. Valid until midnight. Not with other offers." ${owner ? '' : 'disabled'}>${esc(d.details)}</textarea></label>
        <label class="switch"><input type="checkbox" name="active" ${d.active ? 'checked' : ''} ${owner ? '' : 'disabled'}> Deal is live</label>
        <div class="preview"><span class="muted small">How it looks on a card:</span><div class="deal-chip">🎁 ${esc(d.title || 'Your deal title')}</div></div>
        ${owner ? '<button class="btn">Save deal</button>' : '<p class="muted small">Only the owner can change the deal.</p>'}
      </form>
      <form id="promoForm" class="card-form">
        <h2>Quiet-night promo</h2>
        <p class="muted small">Send one push notification a day to verified people who are out within <span id="radius">3</span> km and opted in to partner deals.</p>
        <div class="reach" id="reach">Checking who's nearby…</div>
        <label>Message<textarea name="text" maxlength="120" required placeholder="Live band starts 9pm — first Tusker on us for Buddies 🍻" ${owner ? '' : 'disabled'}></textarea></label>
        <div class="muted small" id="count">0 / 120</div>
        <div class="error" id="perr"></div>
        ${owner ? '<button class="btn" id="sendPromo">Send promo</button>' : '<p class="muted small">Only the owner can send promos.</p>'}
        <p class="muted small">Promos go only to people who said yes to deals. Keep them about your venue and events — no "drink more" offers.</p>
      </form>
    </div>`;
  const title = $('[name=title]');
  title.oninput = () => { $('.deal-chip').textContent = '🎁 ' + (title.value || 'Your deal title'); };
  const text = $('[name=text]');
  text.oninput = () => { $('#count').textContent = `${text.value.length} / 120`; };

  $('#dealForm').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      current = { ...current, ...(await api('PUT', `/partner/venues/${v.id}/deal`, { title: f.title.value, details: f.details.value, active: f.active.checked })) };
      venues = venues.map((x) => (x.id === current.id ? current : x));
      toast('Deal saved');
    } catch (err) { toast(err.message); }
  };

  try {
    const r = await api('GET', `/partner/venues/${v.id}/promo`);
    $('#radius').textContent = r.radiusKm;
    $('#reach').innerHTML = `📣 Right now this would reach <b>${esc(r.reachText)}</b>.`;
    const wait = r.nextPromoAt - Date.now();
    if (wait > 0 && $('#sendPromo')) {
      $('#sendPromo').disabled = true;
      $('#perr').textContent = `Next promo available ${fmtTime(r.nextPromoAt)}.`;
    }
    if (v.status !== 'active' && $('#sendPromo')) { $('#sendPromo').disabled = true; $('#perr').textContent = 'Promos open once your venue is approved.'; }
  } catch (e) { $('#reach').textContent = e.message; }

  $('#promoForm').onsubmit = async (e) => {
    e.preventDefault();
    if (!confirm('Send this promo now? You can send one every 24 hours.')) return;
    try {
      const r = await api('POST', `/partner/venues/${v.id}/promo`, { text: text.value });
      toast(`Promo sent to ${r.reachText}`);
      await reloadVenue(); renderDeal();
    } catch (err) { $('#perr').textContent = err.message; }
  };
}

// ---------- venue profile ----------
function renderVenue() {
  const v = current, owner = v.role === 'owner', locked = v.status !== 'pending';
  $('#panel').innerHTML = `
    <form id="venueForm" class="card-form">
      <h2>Venue details</h2>
      <div class="row">
        <label>Venue name<input name="name" value="${esc(v.name)}" ${locked || !owner ? 'readonly' : ''}></label>
        <label>Area<input name="area" value="${esc(v.area)}" ${owner ? '' : 'readonly'}></label>
      </div>
      <label>Street address<input name="address" value="${esc(v.address)}" ${owner ? '' : 'readonly'}></label>
      <label>Description<textarea name="description" maxlength="400" ${owner ? '' : 'readonly'}>${esc(v.description)}</textarea></label>
      <div class="row">
        <label>Contact phone<input name="contactPhone" value="${esc(v.contactPhone)}" ${owner ? '' : 'readonly'}></label>
        <label>Location<input value="${v.lat.toFixed(5)}, ${v.lng.toFixed(5)}" readonly></label>
      </div>
      ${locked ? '<p class="muted small">Name and location are locked after approval so guests always find the right place. Contact us to change them.</p>' : ''}
      <p class="muted small">Plan: <b>${v.featured ? 'Featured — shown first in "Where are you drinking?"' : 'Basic listing'}</b>. Contact us to upgrade.</p>
      ${owner ? '<button class="btn">Save</button>' : ''}
    </form>`;
  $('#venueForm').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const f = Object.fromEntries(new FormData(e.target));
      if (locked) delete f.name;
      current = await api('PUT', `/partner/venues/${v.id}`, f);
      venues = venues.map((x) => (x.id === current.id ? current : x));
      toast('Saved'); render();
    } catch (err) { toast(err.message); }
  };
}

// ---------- billing (M-Pesa) ----------
let billTimer = null;
const kesFmt = (n) => 'KES ' + Number(n).toLocaleString('en-KE');
const fmtDate = (t) => new Date(t).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' });
const STATUS_LABEL = { paid: '✅ Paid', pending: '⏳ Waiting for PIN', failed: '✕ Failed', expired: '⌛ Timed out', review: '⚠ Under review', gift: '🎁 Gift' };

async function renderBilling() {
  const panel = $('#panel');
  panel.innerHTML = '<p class="muted">Loading…</p>';
  let b;
  try { b = await api('GET', `/partner/venues/${current.id}/billing`); }
  catch (e) { panel.innerHTML = `<p class="error">${esc(e.message)}</p>`; return; }
  const daysLeft = b.featuredUntil ? Math.ceil((b.featuredUntil - Date.now()) / 86400e3) : 0;
  const month = b.plans.find((p) => p.id === 'month'), week = b.plans.find((p) => p.id === 'week');
  const saving = month && week ? Math.round((1 - month.amount / (week.amount * 30 / 7)) * 100) : 0;
  let planId = 'month';

  panel.innerHTML = `
    <section class="plan-status ${b.featured ? 'on' : ''}">
      ${b.featured
        ? `<div><b>★ Featured until ${fmtDate(b.featuredUntil)}</b><div class="muted small">${daysLeft} day${daysLeft === 1 ? '' : 's'} left. Paying now adds time on top.</div></div>`
        : '<div><b>Basic listing</b><div class="muted small">Go Featured to appear first when Buddies pick where they\'re drinking, with a ★ badge.</div></div>'}
    </section>
    ${b.mode === 'disabled' ? '<div class="vstatus">Online payments aren\'t switched on yet. Contact us to upgrade.</div>' : `
    <form id="payForm" class="card-form">
      <h2>${b.featured ? 'Extend Featured' : 'Upgrade to Featured'}</h2>
      <ul class="benefits small"><li>Top of "Partner bars near you" in the app</li><li>★ Featured badge on your listing</li><li>Same deals, promos and stats as today</li></ul>
      <div class="plans">${b.plans.map((p) => `
        <button type="button" class="plan ${p.id === planId ? 'on' : ''}" data-plan="${p.id}">
          <span class="plan-name">${p.days === 7 ? '1 week' : '1 month'}</span>
          <span class="plan-price">${kesFmt(p.amount)}</span>
          <span class="muted small">${p.id === 'month' && saving > 0 ? `Save ${saving}% vs weekly` : `${p.days} days`}</span>
        </button>`).join('')}</div>
      <label>M-Pesa number<input name="phone" type="tel" required value="${esc(b.defaultPhone)}" placeholder="0712 345 678" autocomplete="tel"></label>
      ${b.mode === 'mock' ? '<div class="devhint">🛠 Dev mode — M-Pesa is simulated (no money moves). A number ending in 000 simulates a cancelled payment.</div>' : ''}
      <div class="error" id="perr"></div>
      <button class="btn mpesa" id="payBtn">Pay ${kesFmt(b.plans.find((p) => p.id === planId).amount)} with M-Pesa</button>
      <p class="muted small">You'll get an M-Pesa prompt on your phone. Enter your PIN to confirm. Featured starts as soon as the payment goes through.</p>
    </form>
    <div id="payState"></div>`}
    <section class="chart-card">
      <h3>Payment history</h3>
      ${b.payments.length ? `<table class="audit"><thead><tr><th>Date</th><th>Plan</th><th>Amount</th><th>Status</th><th></th></tr></thead><tbody>
        ${b.payments.map((p) => `<tr><td>${fmtDate(p.createdAt)}</td><td>${esc(p.plan)}${p.periodEnd ? `<div class="muted small">to ${fmtDate(p.periodEnd)}</div>` : ''}</td>
          <td>${p.amount ? kesFmt(p.amount) : '—'}</td><td>${STATUS_LABEL[p.status] || esc(p.status)}${p.message ? `<div class="muted small">${esc(p.message)}</div>` : ''}${p.receipt ? `<div class="muted small">${esc(p.receipt)}</div>` : ''}</td>
          <td>${p.status === 'paid' ? `<button class="link" data-receipt="${esc(p.id)}">Receipt</button>` : ''}</td></tr>`).join('')}</tbody></table>`
        : '<p class="muted small">No payments yet.</p>'}
    </section>`;

  panel.querySelectorAll('[data-receipt]').forEach((btn) => (btn.onclick = () => showReceipt(btn.dataset.receipt)));
  if (b.mode === 'disabled') return;
  panel.querySelectorAll('[data-plan]').forEach((btn) => (btn.onclick = () => {
    planId = btn.dataset.plan;
    panel.querySelectorAll('[data-plan]').forEach((x) => x.classList.toggle('on', x === btn));
    $('#payBtn').textContent = `Pay ${kesFmt(b.plans.find((p) => p.id === planId).amount)} with M-Pesa`;
  }));
  if (b.pending) watchPayment(b.pending);

  $('#payForm').onsubmit = async (e) => {
    e.preventDefault();
    $('#perr').textContent = '';
    $('#payBtn').disabled = true;
    try {
      const r = await api('POST', `/partner/venues/${current.id}/billing/pay`, { planId, phone: e.target.phone.value });
      watchPayment(r.payment);
    } catch (err) {
      $('#perr').textContent = err.message;
      $('#payBtn').disabled = false;
    }
  };
}

// Show "check your phone" and poll until the payment settles.
function watchPayment(p) {
  const form = $('#payForm'), box = $('#payState');
  if (form) form.hidden = true;
  const started = Date.now();
  const draw = (pay, featuredUntil) => {
    if (pay.status === 'pending') {
      const secs = Math.round((Date.now() - started) / 1000);
      box.innerHTML = `<div class="paywait card-form"><div class="spinner" aria-hidden="true"></div>
        <h2>Check your phone</h2><p>Enter your M-Pesa PIN on <b>${esc(pay.phone)}</b> to pay <b>${kesFmt(pay.amount)}</b>.</p>
        <p class="muted small">Waiting for M-Pesa… ${secs}s</p></div>`;
      return;
    }
    clearInterval(billTimer);
    if (pay.status === 'paid') {
      box.innerHTML = `<div class="result ok">✅ <b>Payment received${pay.receipt ? ` — M-Pesa ${esc(pay.receipt)}` : ''}</b><br>
        <span class="small">${esc(current.name)} is Featured until ${fmtDate(featuredUntil || pay.periodEnd)}.</span></div>`;
      toast('You\'re Featured ★');
      reloadVenue().then(() => setTimeout(render, 2500));
    } else {
      box.innerHTML = `<div class="result bad">⛔ <b>${esc(pay.message || 'The payment didn\'t go through.')}</b><br>
        <span class="small">No money was taken. <button class="link" id="retry">Try again</button></span></div>`;
      $('#retry').onclick = () => renderBilling();
    }
  };
  draw(p);
  clearInterval(billTimer);
  billTimer = setInterval(async () => {
    try {
      const r = await api('GET', `/partner/venues/${current.id}/billing/payments/${p.id}`);
      draw(r.payment, r.featuredUntil);
    } catch { /* keep trying */ }
  }, 3000);
}

async function showReceipt(pid) {
  let r;
  try { r = await api('GET', `/partner/venues/${current.id}/billing/payments/${pid}/receipt`); }
  catch (e) { return toast(e.message); }
  const el = document.createElement('div');
  el.className = 'overlay receipt-overlay';
  el.innerHTML = `<div class="receipt" id="receipt">
      <div class="receipt-head"><b>🍻 Drinking Buddies</b><span>Receipt ${esc(r.number)}</span></div>
      <table>
        <tr><td>Billed to</td><td>${esc(r.venue.name)}<br><span class="muted">${esc(r.venue.address)}, ${esc(r.venue.area)}<br>KRA PIN ${esc(r.venue.kraPin)}</span></td></tr>
        <tr><td>Item</td><td>${esc(r.plan)}</td></tr>
        <tr><td>Period</td><td>${fmtDate(r.periodStart)} – ${fmtDate(r.periodEnd)}</td></tr>
        <tr><td>Paid</td><td>${new Date(r.paidAt).toLocaleString('en-KE')}</td></tr>
        <tr><td>Method</td><td>M-Pesa ${esc(r.phone || '')}</td></tr>
        <tr><td>M-Pesa ref</td><td><b>${esc(r.receipt || '—')}</b></td></tr>
        <tr class="total"><td>Total</td><td>${kesFmt(r.amount)}</td></tr>
      </table>
      <p class="muted small">This is a payment receipt, not a KRA eTIMS tax invoice.</p>
      <div class="row noprint"><button class="btn secondary" id="closeR">Close</button><button class="btn" id="printR">Print / save PDF</button></div>
    </div>`;
  document.body.appendChild(el);
  $('#closeR', el).onclick = () => el.remove();
  $('#printR', el).onclick = () => window.print();
  el.onclick = (e) => { if (e.target === el) el.remove(); };
}

// ---------- team ----------
function renderTeam() {
  const v = current;
  $('#panel').innerHTML = `
    <section class="card-form">
      <h2>Team</h2>
      <p class="muted small">Staff can redeem codes and see stats. Only owners can change the deal, send promos or manage the team. Staff need a verified Buddies account.</p>
      <ul class="plain team">${v.members.map((m) => `<li><span>@${esc(m.username)} <span class="tag">${m.role}</span></span>
        ${m.role === 'staff' ? `<button class="link" data-rm="${esc(m.uid)}">Remove</button>` : ''}</li>`).join('')}</ul>
      <form id="staffForm" class="row"><input name="username" placeholder="Their Buddies username" required><button class="btn" style="flex:none">Add staff</button></form>
    </section>`;
  $('#staffForm').onsubmit = async (e) => {
    e.preventDefault();
    try { current = await api('POST', `/partner/venues/${v.id}/staff`, { username: e.target.username.value }); toast('Added'); renderTeam(); }
    catch (err) { toast(err.message); }
  };
  view.querySelectorAll('[data-rm]').forEach((b) => (b.onclick = async () => {
    if (!confirm('Remove this person from your team?')) return;
    try { current = await api('DELETE', `/partner/venues/${v.id}/staff/${b.dataset.rm}`); renderTeam(); }
    catch (err) { toast(err.message); }
  }));
}

boot();
