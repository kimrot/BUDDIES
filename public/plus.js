// Buddies Plus, Boosts, "who liked you" and upsells. Loaded before app.js; uses its helpers at call time.
'use strict';

const kesFmt = (n) => 'KES ' + Number(n).toLocaleString('en-KE');
const fmtDay = (t) => new Date(t).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' });
const inTime = (t) => { const m = Math.max(1, Math.round((t - Date.now()) / 60e3)); return m < 90 ? `${m} min` : `${Math.round(m / 60)} h`; };
let plusPoll = null;
window.addEventListener('hashchange', () => clearInterval(plusPoll));

// ---------- profile card ----------
function plusCardHTML(me) {
  return me.plus?.active
    ? `<a class="plus-card on" href="#/plus"><span><b>✨ Buddies Plus</b><br><small class="muted">Active until ${fmtDay(me.plus.until)} · ${me.boosts} Boost${me.boosts === 1 ? '' : 's'}</small></span><span>›</span></a>`
    : `<a class="plus-card" href="#/plus"><span><b>✨ Get Buddies Plus</b><br><small class="muted">Unlimited likes · see who likes you · 50 km · undo${me.boosts ? ` · ${me.boosts} Boost${me.boosts === 1 ? '' : 's'}` : ''}</small></span><span class="plus-cta">From KES 149</span></a>`;
}

// ---------- upsell sheet ----------
function showUpsell(reason, resetAt) {
  const copy = {
    likes: ['You\'re out of likes for today 💛', `Free accounts get ${state.me.likes?.limit || 25} likes a day.${resetAt ? ` More in ${inTime(resetAt)}.` : ''} Buddies Plus gives you unlimited likes.`],
    rewind: ['Undo that pass ↩', 'Swiped left too fast? Buddies Plus lets you bring back the last person you passed on.'],
    boost: ['Out of Boosts 🚀', 'A Boost puts you at the top of nearby feeds for 30 minutes while you\'re out. Monthly Plus comes with 2.'],
    likesList: ['See who likes you 👀', 'Buddies Plus shows everyone who already liked you, so you can match instantly.'],
  }[reason];
  const el = document.createElement('div');
  el.className = 'overlay sheet';
  el.innerHTML = `<div class="sheet-body">
    <h2>${copy[0]}</h2><p class="muted">${copy[1]}</p>
    <div class="row"><a class="btn secondary" href="#/plus/${reason === 'boost' ? 'boost_5' : 'plus_month'}" style="text-align:center;text-decoration:none">${reason === 'boost' ? 'Buy Boosts' : 'See plans'}</a>
      <button class="btn secondary" id="later">Not now</button></div></div>`;
  document.body.appendChild(el);
  el.onclick = (e) => { if (e.target === el || e.target.id === 'later' || e.target.tagName === 'A') el.remove(); };
}

// ---------- boosts ----------
function drawBoost() {
  const b = $('#boostBtn');
  if (!b) return;
  const active = state.me.boostUntil && state.me.boostUntil > Date.now();
  b.classList.toggle('active', !!active);
  $('#boostCount').textContent = active ? inTime(state.me.boostUntil).replace(' min', 'm') : state.me.boosts ? state.me.boosts : '';
}

async function useBoost() {
  if (state.me.boostUntil && state.me.boostUntil > Date.now()) return toast(`🚀 You're boosted for ${inTime(state.me.boostUntil)} more`);
  if (!state.me.verification.full) return showVerifyNudge();
  if (!state.me.boosts) return showUpsell('boost');
  if (!confirm(`Use a Boost? You'll be at the top of nearby feeds for 30 minutes. (${state.me.boosts} left)`)) return;
  try {
    state.me = await api('POST', '/boost');
    drawBoost();
    toast('🚀 Boosted for 30 minutes');
  } catch (e) { toast(e.message); }
}

// ---------- who liked you ----------
async function renderLikes() {
  view.innerHTML = '<h2>Who likes you</h2><div id="likesBody"><p class="muted">Loading…</p></div>';
  let l;
  try { l = await api('GET', '/likes'); } catch (e) { $('#likesBody').innerHTML = `<p class="error">${esc(e.message)}</p>`; return; }
  const body = $('#likesBody');
  if (!l.count) { body.innerHTML = '<div class="empty"><div class="big">💛</div><p>No new likes yet. Go out, set your spot and they\'ll come.</p></div>'; return; }
  if (!l.plus) {
    body.innerHTML = `<div class="likes-grid">${Array.from({ length: Math.min(l.count, 6) }, () => '<div class="like-tile blur"></div>').join('')}</div>
      <div class="center"><p><b>${l.count} ${l.count === 1 ? 'person has' : 'people have'} already liked you.</b></p>
      <a class="btn" href="#/plus/plus_month" style="display:inline-block;text-decoration:none">See who with Buddies Plus</a></div>`;
    return;
  }
  body.innerHTML = `<p class="muted small">Like them back to match instantly.</p><div class="likes-grid">${l.people.map((p) => `
    <div class="like-tile" data-id="${esc(p.id)}" style="${avatarStyle(p)}">${p.photo ? '' : `<span class="ini">${initial(p)}</span>`}
      <div class="lt-info"><b>${esc(p.name)}, ${esc(p.age)}</b> ${p.verified ? '<span class="vbadge sm">✓</span>' : ''}
        <small>${p.out ? `${esc(p.joint)} · ${distText(p.distanceKm)}` : 'Not out right now'}</small></div>
      <div class="lt-actions"><button class="round small nope" data-act="pass" aria-label="Pass">✕</button><button class="round small like" data-act="like" aria-label="Like back">♥</button></div>
    </div>`).join('')}</div>`;
  body.querySelectorAll('[data-act]').forEach((b) => (b.onclick = async () => {
    const tile = b.closest('.like-tile');
    if (b.dataset.act === 'like' && !state.me.verification.full) return showVerifyNudge();
    try {
      const { match } = await api('POST', '/swipe', { targetId: tile.dataset.id, dir: b.dataset.act });
      tile.remove();
      if (match) showMatch(match);
    } catch (e) { toast(e.message); }
  }));
}

// ---------- Plus & Boosts store (M-Pesa) ----------
async function renderPlus(preselect) {
  clearInterval(plusPoll);
  view.innerHTML = '<p class="muted">Loading…</p>';
  let b;
  try { b = await api('GET', '/billing'); } catch (e) { view.innerHTML = `<p class="error">${esc(e.message)}</p>`; return; }
  const plus = b.products.filter((p) => p.days), boosts = b.products.filter((p) => p.boosts);
  let sel = b.products.some((p) => p.id === preselect) ? preselect : 'plus_month';
  const week = plus.find((p) => p.id === 'plus_week'), month = plus.find((p) => p.id === 'plus_month');
  const save = week && month ? Math.round((1 - month.amount / (week.amount * 30 / 7)) * 100) : 0;
  const prodCard = (p, sub) => `<button type="button" class="plan ${p.id === sel ? 'on' : ''}" data-p="${p.id}">
    <span class="plan-name">${esc(p.days ? (p.days === 7 ? '1 week' : '1 month') : p.name)}</span>
    <span class="plan-price">${kesFmt(p.amount)}</span><span class="muted small">${sub}</span></button>`;

  view.innerHTML = `
    <a href="#/profile" class="back-link">‹ Profile</a>
    <section class="plus-hero ${b.plus.active ? 'on' : ''}">
      <h1>✨ Buddies Plus</h1>
      ${b.plus.active ? `<p><b>Active until ${fmtDay(b.plus.until)}.</b> Buying more adds time on top.</p>` : '<p class="muted">More matches on the nights you go out.</p>'}
      <ul class="perks">
        <li>💛 <b>Unlimited likes</b> <span class="muted">(free: ${state.me.likes?.limit || 25} a day)</span></li>
        <li>👀 <b>See who likes you</b> and match instantly</li>
        <li>📍 <b>Find buddies up to 50 km</b> away <span class="muted">(free: 10 km)</span></li>
        <li>↩ <b>Undo</b> your last pass</li>
        <li>🚀 <b>2 Boosts</b> with the monthly plan</li>
      </ul>
    </section>
    <form id="buyForm" class="card-form">
      <h3>Buddies Plus</h3>
      <div class="plans">${plus.map((p) => prodCard(p, p.id === 'plus_month' ? `${save > 0 ? `Save ${save}% · ` : ''}+2 Boosts` : '7 days')).join('')}</div>
      <h3>Boosts <span class="muted small">— you have ${b.boosts}</span></h3>
      <p class="muted small" style="margin:0">Top of nearby feeds for 30 minutes while you're out.</p>
      <div class="plans">${boosts.map((p) => prodCard(p, p.boosts > 1 ? `${kesFmt(Math.round(p.amount / p.boosts))} each` : '30 minutes')).join('')}</div>
      ${b.mode === 'disabled' ? '<div class="vstatus">Payments aren\'t switched on yet.</div>' : `
      <label>M-Pesa number<input name="phone" type="tel" required value="${esc(b.defaultPhone)}" placeholder="0712 345 678" autocomplete="tel"></label>
      ${b.mode === 'mock' ? '<div class="devhint">🛠 Dev mode — M-Pesa is simulated (no money moves). A number ending in 000 simulates a cancelled payment.</div>' : ''}
      <div class="error" id="perr"></div>
      <button class="btn mpesa" id="payBtn"></button>
      <p class="muted small center">You'll get an M-Pesa prompt on your phone. One-off payment — nothing renews automatically.</p>`}
    </form>
    <div id="payState"></div>
    ${b.payments.length ? `<section class="chart-card"><h3>Your purchases</h3><ul class="plain">${b.payments.map((p) => `
      <li><b>${esc(p.plan)}</b> · ${kesFmt(p.amount)} <span class="muted small">· ${fmtDay(p.createdAt)} · ${
        { paid: '✅ Paid', pending: '⏳ Waiting', failed: '✕ Failed', expired: '⌛ Timed out', review: '⚠ Under review' }[p.status] || esc(p.status)}${p.receipt ? ` · ${esc(p.receipt)}` : ''}</span>
        ${p.message ? `<br><small class="muted">${esc(p.message)}</small>` : ''}</li>`).join('')}</ul></section>` : ''}`;

  const prodById = (pid) => b.products.find((p) => p.id === pid);
  const syncBtn = () => { if ($('#payBtn')) $('#payBtn').textContent = `Pay ${kesFmt(prodById(sel).amount)} with M-Pesa`; };
  view.querySelectorAll('[data-p]').forEach((btn) => (btn.onclick = () => {
    sel = btn.dataset.p;
    view.querySelectorAll('[data-p]').forEach((x) => x.classList.toggle('on', x === btn));
    syncBtn();
  }));
  syncBtn();
  if (b.mode === 'disabled') return;
  if (b.pending) watchUserPayment(b.pending);

  $('#buyForm').onsubmit = async (e) => {
    e.preventDefault();
    $('#perr').textContent = '';
    $('#payBtn').disabled = true;
    try {
      const r = await api('POST', '/billing/pay', { productId: sel, phone: e.target.phone.value });
      watchUserPayment(r.payment);
    } catch (err) { $('#perr').textContent = err.message; $('#payBtn').disabled = false; }
  };
}

function watchUserPayment(p) {
  const form = $('#buyForm'), box = $('#payState');
  form.hidden = true;
  const started = Date.now();
  const draw = (pay) => {
    if (pay.status === 'pending') {
      box.innerHTML = `<div class="paywait card-form"><div class="spinner" aria-hidden="true"></div>
        <h2>Check your phone</h2><p>Enter your M-Pesa PIN on <b>${esc(pay.phone)}</b> to pay <b>${kesFmt(pay.amount)}</b> for ${esc(pay.plan)}.</p>
        <p class="muted small">Waiting for M-Pesa… ${Math.round((Date.now() - started) / 1000)}s</p></div>`;
      return;
    }
    clearInterval(plusPoll);
    if (pay.status === 'paid') {
      box.innerHTML = `<div class="result ok">✅ <b>Payment received${pay.receipt ? ` — M-Pesa ${esc(pay.receipt)}` : ''}</b><br>
        <span class="small">${pay.periodEnd ? `Buddies Plus is on until ${fmtDay(pay.periodEnd)}.` : ''} ${pay.boosts ? `${pay.boosts} Boost${pay.boosts === 1 ? '' : 's'} added.` : ''}</span></div>`;
      api('GET', '/me').then((m) => { state.me = m; });
      toast(pay.periodEnd ? '✨ Welcome to Buddies Plus' : '🚀 Boosts added');
      setTimeout(() => location.hash.startsWith('#/plus') && renderPlus(), 3000);
    } else {
      box.innerHTML = `<div class="result bad">⛔ <b>${esc(pay.message || 'The payment didn\'t go through.')}</b><br>
        <span class="small">No money was taken. <button class="link" id="retry">Try again</button></span></div>`;
      $('#retry').onclick = () => renderPlus();
    }
  };
  draw(p);
  clearInterval(plusPoll);
  plusPoll = setInterval(async () => {
    try { draw((await api('GET', `/billing/payments/${p.id}`)).payment); } catch { /* keep trying */ }
  }, 2500);
}
