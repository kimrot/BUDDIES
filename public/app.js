// Drinking Buddies — frontend (no build step). Hash-routed single page app.
'use strict';

const $ = (sel, el = document) => el.querySelector(sel);
const view = $('#view');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const DRINKS = ['Tusker', 'Guinness', 'Whitecap', 'Gin & tonic', 'Whiskey', 'Vodka', 'Wine', 'Cocktail', 'Cider', 'Soda / not drinking'];

let state = {
  me: null,
  dev: null, // dev-only: OTP code / email link echoed by the server when no SMS/email provider is set
  radius: Number(localGet('radius')) || 10,
};
let pollTimer = null;

function localGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function localSet(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* ignore */ } }

// Session is an httpOnly cookie (JS can't read it). X-CSRF marks requests as coming from our own page.
async function api(method, url, body) {
  const res = await fetch('/api' + url, {
    method,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-CSRF': '1' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && state.me) { state.me = null; stopNotifPoll(); location.hash = '#/login'; toast('Session expired — log in again'); }
  if (res.status === 403 && data.code === 'BANNED') { state.me = null; stopNotifPoll(); renderBanned(data.error); }
  if (!res.ok) { const e = new Error(data.error || 'Something went wrong'); e.code = data.code; e.status = res.status; e.data = data; throw e; }
  return data;
}
localSet('token', null); // tokens from older versions

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('show'), 2500);
}

// Coloured initials when someone has no photo.
function hue(str) { let h = 0; for (const c of String(str)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
function avatarStyle(u) {
  return u.photo
    ? `background-image:url('${esc(u.photo)}')`
    : `background:linear-gradient(135deg,hsl(${hue(u.name + u.id)},65%,45%),hsl(${(hue(u.name + u.id) + 50) % 360},70%,30%))`;
}
const initial = (u) => (u.photo ? '' : esc((u.name || '?')[0].toUpperCase()));
const distText = (d) => (d == null ? '' : d < 0.1 ? 'Under 100 m away' : d < 1 ? `${Math.round(d * 1000)} m away` : `${d} km away`);

// ---------- routing ----------
const routes = {
  '/login': renderAuth,
  '/out': renderStatus,
  '/swipe': renderSwipe,
  '/matches': renderMatches,
  '/chat': renderChat,
  '/profile': renderProfile,
  '/plus': renderPlus,
  '/likes': renderLikes,
};

// Pages that work without being logged in (links from emails).
const publicRoutes = {
  '/confirm-email': renderConfirmEmail,
  '/reset': renderReset,
  '/forgot': renderForgot,
};

async function router() {
  clearInterval(pollTimer);
  document.querySelectorAll('.overlay.sheet').forEach((o) => o.remove());
  const [, path, param] = location.hash.match(/^#(\/[^/]*)\/?(.*)$/) || [, '/swipe', ''];
  if (publicRoutes[path]) { showChrome(false); return publicRoutes[path](param); }
  if (!state.me) {
    try { state.me = await api('GET', '/me'); }
    catch (e) { if (e.code !== 'BANNED') { showChrome(false); renderAuth(); } return; }
  }
  // Everyone accepts the current consent first (new accounts do it at signup).
  if (!state.me.consent?.accepted) { showChrome(false); return renderConsent(); }
  // Phone + email must be verified before anything else.
  if (!state.me.verification.basic && path !== '/verify') return (location.hash = '#/verify');
  // Notifications agreed to at signup: subscribe once phone + email are verified.
  if (!pushChecked && pushSupported() && Notification.permission === 'granted') { pushChecked = true; subscribePush().catch(() => {}); }
  if (path === '/verify') { showChrome(false); return renderVerify(param); }
  showChrome(true, path);
  startNotifPoll();
  (routes[path] || renderSwipe)(param);
}

function showChrome(on, path = '') {
  $('#topbar').hidden = !on;
  $('#tabs').hidden = !on || path === '/chat';
  document.body.classList.toggle('no-tabs', $('#tabs').hidden);
  document.querySelectorAll('#tabs a').forEach((a) => a.classList.toggle('active', '/' + a.dataset.tab === path));
  if (on) updatePill();
}

function updatePill() {
  const pill = $('#statusPill');
  const s = state.me?.status;
  pill.classList.toggle('off', !s);
  pill.textContent = s ? `📍 ${s.joint} · 🍺 ${s.drink}` : "I'm going out →";
}
$('#statusPill').onclick = () => (location.hash = '#/out');

async function logout(callApi = true) {
  stopNotifPoll();
  if (callApi) {
    await disablePush().catch(() => {});
    await api('POST', '/logout').catch(() => {});
  }
  state.me = null;
  location.hash = '#/login';
  router();
}

// ---------- consent (text in /consent.html; version on the server) ----------
let pushChecked = false;
const CONSENT_BOXES = [
  { k: 'age', req: true, html: 'I am <b>18 or older</b>, and the date of birth I entered is true.' },
  { k: 'terms', req: true, html: 'I have read and agree to the <a href="/consent.html" target="_blank" rel="noopener">consent and community rules</a>.' },
  { k: 'idCheck', req: true, html: 'I agree that my <b>government ID</b> will be checked by Smile ID against the national registry to confirm who I am and my age.' },
  { k: 'location', req: true, html: 'I agree that my <b>location</b> is used to show me to people nearby while I\'m "out". Others see only a rounded distance.' },
  { k: 'deals', req: false, html: 'Send me deals from partner bars near me.' },
  { k: 'notify', req: false, html: 'Send me notifications when I get a match.' },
];

function consentBoxesHTML(prev = {}) {
  const box = (b) => `<label class="consent-box"><input type="checkbox" name="consent_${b.k}" ${b.req ? 'data-req' : ''} ${prev[b.k] ? 'checked' : ''}><span>${b.html}</span></label>`;
  return `<fieldset class="consent">
      <legend>Before you join</legend>
      <p class="muted small">Required</p>
      ${CONSENT_BOXES.filter((b) => b.req).map(box).join('')}
      <p class="muted small">Optional — you can change these later in Profile</p>
      ${CONSENT_BOXES.filter((b) => !b.req).map(box).join('')}
      <p class="muted small">You can withdraw your consent or delete your account at any time from your Profile.</p>
    </fieldset>`;
}

// Submit stays disabled until every required box is ticked.
function wireConsentBoxes(form) {
  const btn = form.querySelector('.btn');
  const update = () => { btn.disabled = [...form.querySelectorAll('input[data-req]')].some((i) => !i.checked); };
  form.querySelectorAll('.consent input').forEach((i) => (i.onchange = update));
  update();
}

const readConsent = (form) => Object.fromEntries(CONSENT_BOXES.map((b) => [b.k, !!form.querySelector(`[name="consent_${b.k}"]`)?.checked]));

function askNotifyPermission() {
  if (pushSupported() && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
}

// Existing accounts (and everyone, after the consent text changes) accept before going on.
function renderConsent() {
  const me = state.me;
  view.innerHTML = `
    <div class="hero"><div class="big">📜</div><h1>Our consent has been updated</h1>
      <p class="muted">Please read the <a href="/consent.html" target="_blank" rel="noopener">consent and community rules</a> and confirm to keep using Drinking Buddies.</p></div>
    <form id="consentForm">
      ${consentBoxesHTML({ deals: me.promoOptIn })}
      <div class="error" id="err"></div>
      <button class="btn">Agree and continue</button>
      <button type="button" class="btn secondary" id="consentLogout">Log out</button>
    </form>`;
  const form = $('#consentForm');
  wireConsentBoxes(form);
  $('#consentLogout').onclick = () => logout();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const consent = readConsent(form);
    if (consent.notify) askNotifyPermission();
    const btn = form.querySelector('.btn');
    btn.disabled = true;
    try {
      state.me = await api('POST', '/consent', { consent });
      router();
    } catch (err) { $('#err').textContent = err.message; btn.disabled = false; }
  };
}

// ---------- auth ----------
function renderAuth() {
  let mode = 'signup';
  const draw = () => {
    view.innerHTML = `
      <div class="hero"><div class="big">🍻</div><h1>Drinking Buddies</h1>
        <p class="muted">See who's out drinking near you. Swipe right, match, share a round.</p></div>
      <div class="segmented" style="margin-bottom:16px">
        <button type="button" data-m="signup" class="${mode === 'signup' ? 'on' : ''}">Sign up</button>
        <button type="button" data-m="login" class="${mode === 'login' ? 'on' : ''}">Log in</button>
      </div>
      <form id="authForm">
        <label>Username<input name="username" autocomplete="username" required maxlength="30"></label>
        ${mode === 'signup' ? `
          <div class="row">
            <label>First name<input name="name" required maxlength="40" autocomplete="given-name"></label>
            <label>Date of birth<input name="dob" type="date" required max="${maxDob()}"></label>
          </div>
          <label>Phone number<input name="phone" type="tel" required autocomplete="tel" placeholder="0712 345 678"></label>
          <label>Email<input name="email" type="email" required autocomplete="email"></label>` : ''}
        <label>Password<input name="password" type="password" autocomplete="${mode === 'signup' ? 'new-password' : 'current-password'}" required minlength="${mode === 'signup' ? 8 : 1}"></label>
        ${mode === 'signup'
          ? '<p class="muted small">At least 8 characters. We\'ll text you a code and email you a link to verify your account.</p>' + consentBoxesHTML()
          : '<a href="#/forgot" class="small">Forgot password?</a>'}
        <div class="error" id="err"></div>
        <button class="btn">${mode === 'signup' ? 'Create account' : 'Log in'}</button>
      </form>`;
    view.querySelectorAll('[data-m]').forEach((b) => (b.onclick = () => { mode = b.dataset.m; draw(); }));
    if (mode === 'signup') wireConsentBoxes($('#authForm'));
    $('#authForm').onsubmit = async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      const btn = e.target.querySelector('.btn');
      if (mode === 'signup') {
        f.consent = readConsent(e.target);
        for (const k of Object.keys(f)) if (k.startsWith('consent_')) delete f[k];
        if (f.consent.notify) askNotifyPermission(); // needs the click; subscribes once verified
      }
      btn.disabled = true;
      try {
        const { user, dev } = await api('POST', mode === 'signup' ? '/signup' : '/login', f);
        state.me = user;
        state.dev = dev || null;
        if (user.verification.basic && pushSupported() && Notification.permission === 'granted') subscribePush().catch(() => {});
        location.hash = !user.verification.basic ? '#/verify' : user.status ? '#/swipe' : '#/out';
        router();
      } catch (err) { $('#err').textContent = err.message; btn.disabled = false; }
    };
  };
  draw();
}

// ---------- "I'm out" status ----------
function renderStatus() {
  const s = state.me.status || {};
  let coords = s.lat != null ? { lat: s.lat, lng: s.lng } : null;
  view.innerHTML = `
    <h1>Where are you drinking?</h1>
    <p class="muted">Only your <b>distance</b> is shown to others — never your exact location.</p>
    <form id="statusForm">
      <label>Drinking joint<input name="joint" required maxlength="60" placeholder="e.g. The Tipsy Tap" value="${esc(s.joint)}"></label>
      <div class="venue-pick" id="venueList"></div>
      <label>What are you drinking?<input name="drink" required maxlength="40" placeholder="e.g. Tusker" value="${esc(s.drink)}"></label>
      <div class="chips" id="drinkChips">${DRINKS.map((d) => `<button type="button" class="chip" data-d="${esc(d)}">${esc(d)}</button>`).join('')}</div>
      <label>Out for
        <select name="hours">${[1, 2, 3, 4, 6, 8].map((h) => `<option value="${h}" ${h === 3 ? 'selected' : ''}>${h} hour${h > 1 ? 's' : ''}</option>`).join('')}</select>
      </label>
      <button type="button" class="btn secondary" id="locBtn">📍 ${coords ? 'Location set — update' : 'Use my location'}</button>
      <details><summary>Location not working? Enter it manually</summary>
        <input id="manualLoc" placeholder="lat, lng  e.g. -1.2864, 36.8172" style="margin-top:8px">
      </details>
      <div class="error" id="err"></div>
      <button class="btn">🍻 I'm out — show me buddies</button>
      ${state.me.status ? '<button type="button" class="btn danger" id="homeBtn">I\'m heading home</button>' : ''}
    </form>`;

  // Partner bars near you (needs a location). Picking one fills the joint with its official name.
  let venueId = s.venueId || null;
  const jointInput = view.querySelector('[name=joint]');
  let nearby = [];
  const drawVenues = () => {
    const el = $('#venueList');
    if (!el) return;
    el.innerHTML = nearby.length ? `<span class="muted small">Partner bars near you</span>` + nearby.map((v) => `
      <button type="button" class="venue-opt ${v.id === venueId ? 'on' : ''}" data-v="${esc(v.id)}">
        <span><b>${esc(v.name)}</b> ${v.featured ? '<span class="tag gold">★</span>' : ''}<br><small>${esc(v.area)} · ${distText(v.distanceKm).replace(' away', '')}</small></span>
        ${v.deal ? `<small class="deal-chip">🎁 ${esc(v.deal.title)}</small>` : ''}</button>`).join('') : '';
    el.querySelectorAll('[data-v]').forEach((b) => (b.onclick = () => {
      const v = nearby.find((x) => x.id === b.dataset.v);
      venueId = venueId === v.id ? null : v.id;
      if (venueId) jointInput.value = v.name;
      drawVenues();
    }));
  };
  const loadVenues = async () => {
    if (!coords) return;
    try { nearby = await api('GET', `/venues/nearby?lat=${coords.lat}&lng=${coords.lng}`); drawVenues(); } catch { /* optional */ }
  };
  jointInput.addEventListener('input', () => {
    const v = nearby.find((x) => x.id === venueId);
    if (v && jointInput.value.trim() !== v.name) { venueId = null; drawVenues(); }
  });
  loadVenues();

  const drinkInput = view.querySelector('[name=drink]');
  const syncChips = () => view.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c.dataset.d === drinkInput.value));
  view.querySelectorAll('.chip').forEach((c) => (c.onclick = () => { drinkInput.value = c.dataset.d; syncChips(); }));
  drinkInput.oninput = syncChips;
  syncChips();

  const locate = () => new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('Geolocation not supported'));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      (e) => reject(new Error(e.code === 1 ? 'Location permission denied' : 'Could not get your location')),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 },
    );
  });

  $('#locBtn').onclick = async () => {
    $('#locBtn').textContent = '📍 Locating…';
    try { coords = await locate(); $('#locBtn').textContent = '📍 Location set ✓'; $('#err').textContent = ''; loadVenues(); }
    catch (e) { $('#locBtn').textContent = '📍 Try again'; $('#err').textContent = e.message + (location.protocol === 'http:' && location.hostname !== 'localhost' ? ' (browsers need HTTPS for location)' : ''); }
  };

  if ($('#homeBtn')) $('#homeBtn').onclick = async () => {
    state.me = await api('DELETE', '/me/status');
    updatePill();
    toast('Get home safe! 🏠');
    location.hash = '#/matches';
  };

  $('#statusForm').onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    const manual = $('#manualLoc').value.match(/(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/);
    if (manual) coords = { lat: Number(manual[1]), lng: Number(manual[2]) };
    if (!coords) {
      try { coords = await locate(); } catch (err) { $('#err').textContent = err.message + ' — or enter it manually below.'; return; }
    }
    try {
      state.me = await api('PUT', '/me/status', { ...f, hours: Number(f.hours), ...coords, venueId });
      updatePill();
      location.hash = '#/swipe';
    } catch (err) { $('#err').textContent = err.message; }
  };
}

// ---------- swipe ----------
async function renderSwipe() {
  if (!state.me.status) return (location.hash = '#/out');
  const maxR = state.me.radiusMax || 10;
  if (state.radius > maxR) state.radius = maxR;
  view.innerHTML = `
    ${pushPromptHTML()}
    <a class="likes-banner" id="likesBanner" href="#/likes" hidden></a>
    <div class="radius"><label for="radius">Within</label> <input type="range" id="radius" min="1" max="${maxR}" value="${state.radius}"> <b id="radiusVal">${state.radius} km</b>
      ${state.me.plus?.active ? '' : '<a href="#/plus" class="small plus-link">Plus: 50 km</a>'}</div>
    <div class="deck" id="deck"><div class="card skeleton" aria-hidden="true"></div></div>
    <div class="actions">
      <button class="round small rewind" id="rewindBtn" aria-label="Undo last pass" title="Undo last pass (Plus)">↩</button>
      <button class="round nope" id="nopeBtn" aria-label="Pass">✕</button>
      <button class="round like" id="likeBtn" aria-label="Like">♥</button>
      <button class="round small boost" id="boostBtn" aria-label="Boost" title="Boost: top of nearby feeds for 30 min">🚀<i id="boostCount"></i></button>
    </div>
    <div class="likes-left" id="likesLeft"></div>
    <div class="sr-only" id="srSwipe" aria-live="polite"></div>`;

  bindPushPrompt();
  drawBoost();
  api('GET', '/likes').then((l) => {
    const b = $('#likesBanner');
    if (!b || !l.count) return;
    b.hidden = false;
    b.innerHTML = `<span class="hearts">${l.plus ? l.people.slice(0, 3).map((p) => `<i class="thumb mini" style="${avatarStyle(p)}">${initial(p)}</i>`).join('') : '<i class="thumb mini blur"></i><i class="thumb mini blur"></i>'}</span>
      <span><b>${l.count} ${l.count === 1 ? 'person likes' : 'people like'} you</b><br><small class="muted">${l.plus ? 'Tap to see who' : 'See who with Buddies Plus'}</small></span><span>›</span>`;
  }).catch(() => {});

  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const buzz = (pattern) => { try { navigator.vibrate?.(pattern); } catch { /* unsupported */ } };
  const say = (msg) => { const el = $('#srSwipe'); if (el) el.textContent = msg; };
  let people = [];          // the deck, top card first
  const inFlight = new Set(); // swiped this session; server may not have recorded it yet
  let busy = false;         // a card is mid-animation
  let loading = false;

  async function load({ append = false } = {}) {
    if (loading) return;
    loading = true;
    try {
      const list = (await api('GET', `/feed?radius=${state.radius}`)).filter((p) => !inFlight.has(p.id));
      if (append) {
        const have = new Set(people.map((p) => p.id));
        people.push(...list.filter((p) => !have.has(p.id)));
      } else people = list;
    } catch (e) {
      if (e.code === 'NOT_OUT') { state.me.status = null; updatePill(); location.hash = '#/out'; return; }
      if (!append) toast(e.message);
    } finally { loading = false; }
    if (!append || !$('#deck .card.top')) draw(); else drawStack();
  }

  const r = $('#radius');
  r.oninput = () => ($('#radiusVal').textContent = r.value + ' km');
  r.onchange = () => { state.radius = Number(r.value); localSet('radius', r.value); load(); };

  const fmtMin = (m) => (m < 60 ? `${m} min` : `${Math.round(m / 30) / 2} h`.replace('.5 h', '½ h'));
  function tagsHTML(p) {
    const t = [];
    if (p.sameBar) t.push('<span class="tag-pill same">🍻 Same bar as you</span>');
    if (p.sameDrink) t.push(`<span class="tag-pill drink">Also on ${esc(p.drink)}</span>`);
    if (p.hereForMin !== null && p.hereForMin <= 15) t.push('<span class="tag-pill time">Just arrived</span>');
    else if (p.leavesInMin !== null && p.leavesInMin <= 30) t.push('<span class="tag-pill time soon">Leaving soon</span>');
    return t.length ? `<div class="tags">${t.join('')}</div>` : '';
  }
  function cardHTML(p, depth) {
    const label = `${p.name}, ${p.age}. ${distText(p.distanceKm)}. At ${p.joint}, drinking ${p.drink}.${p.sameBar ? ' Same bar as you.' : ''}`;
    return `<div class="card depth-${depth} ${depth === 0 ? 'top' : ''}" data-id="${esc(p.id)}" ${depth === 0
      ? `tabindex="0" role="group" aria-roledescription="profile card" aria-label="${esc(label)}"` : 'aria-hidden="true"'}>
      <div class="photo ${p.photo ? '' : 'avatar'}" style="${avatarStyle(p)}">${initial(p)}</div>
      ${p.photos?.length > 1 ? `<div class="pbars" aria-hidden="true">${p.photos.map((_, i) => `<i class="${i === 0 ? 'on' : ''}"></i>`).join('')}</div>` : ''}
      <div class="dist">📍 ${distText(p.distanceKm)}</div>
      <div class="stamp like" aria-hidden="true">CHEERS</div><div class="stamp nope" aria-hidden="true">NOPE</div>
      <div class="info">
        ${tagsHTML(p)}
        <div class="name">${esc(p.name)} <small>${esc(p.age)}</small> ${p.verified ? '<span class="vbadge" title="Phone, email, selfie and ID verified">✓</span>' : ''}</div>
        <div class="meta"><span>🏠 At <b>${esc(p.joint)}</b>${p.venue ? '<span class="partner">PARTNER</span>' : ''}</span><span>🍺 Drinking <b>${esc(p.drink)}</b></span>
          ${p.venue?.deal ? `<span>🎁 <b>${esc(p.venue.deal.title)}</b> if you match</span>` : ''}</div>
        ${p.bio ? `<div class="bio">${esc(p.bio)}</div>` : ''}
        <div class="more">
          ${p.hereForMin !== null ? `<span>🕒 Here ${p.hereForMin <= 15 ? 'since just now' : `about ${fmtMin(p.hereForMin)}`}${p.leavesInMin !== null ? ` · out ~${fmtMin(Math.max(15, p.leavesInMin))} more` : ''}</span>` : ''}
          ${p.venue?.deal?.details ? `<span class="muted">${esc(p.venue.deal.details)}</span>` : ''}
        </div>
        <button type="button" class="more-btn" aria-label="Show more about ${esc(p.name)}" tabindex="-1">ⓘ</button>
      </div></div>`;
  }

  // Cards are stacked bottom-to-top so the top card is last in the DOM.
  function drawStack() {
    const deck = $('#deck');
    deck.innerHTML = people.slice(0, 3).map((p, i) => cardHTML(p, i)).reverse().join('');
    const top = deck.querySelector('.card.top');
    if (top) {
      attachDrag(top);
      people[0].photos?.slice(1).forEach((u) => { new Image().src = u; }); // preload the rest of their photos
    }
  }

  // Show photo i of the card's person (tap left/right edge or ↓ to cycle).
  function stepPhoto(card, delta, wrap = false) {
    const p = people.find((x) => x.id === card.dataset.id);
    const n = p?.photos?.length || 0;
    if (n < 2) return false;
    const cur = Number(card.dataset.idx || 0);
    const next = wrap ? (cur + delta + n) % n : cur + delta;
    if (next < 0 || next >= n) { // bump at the ends
      card.classList.remove('bump-l', 'bump-r'); void card.offsetWidth;
      card.classList.add(delta < 0 ? 'bump-l' : 'bump-r');
      return true;
    }
    card.dataset.idx = next;
    card.querySelector('.photo').style.backgroundImage = `url('${p.photos[next]}')`;
    card.querySelectorAll('.pbars i').forEach((b, i) => b.classList.toggle('on', i === next));
    say(`Photo ${next + 1} of ${n}`);
    return true;
  }

  function draw() {
    const deck = $('#deck');
    if (!deck) return;
    clearInterval(pollTimer);
    const btns = [$('#nopeBtn'), $('#likeBtn')];
    drawLikesLeft();
    if (!people.length) {
      btns.forEach((b) => (b.disabled = true));
      const tips = [];
      if (state.radius < maxR) tips.push(`<button class="btn secondary" id="wider">Search ${Math.min(maxR, Math.max(state.radius * 2, 5))} km</button>`);
      else if (!state.me.plus?.active) tips.push('<a class="btn secondary" href="#/plus/plus_month">Search up to 50 km with Plus</a>');
      if (state.me.verification.full && !(state.me.boostUntil > Date.now())) tips.push('<button class="btn secondary" id="emptyBoost">🚀 Boost so people find you</button>');
      deck.innerHTML = `<div class="empty"><div class="big">🍺</div>
        <p><b>You've seen everyone out within ${state.radius} km.</b></p>
        <p class="muted small">People keep heading out — we'll check again every 30 seconds.</p>
        <div class="empty-actions">${tips.join('')}</div><button class="link" id="reload">Refresh now</button></div>`;
      $('#reload').onclick = () => load();
      if ($('#wider')) $('#wider').onclick = () => { state.radius = Math.min(maxR, Math.max(state.radius * 2, 5)); r.value = state.radius; r.oninput(); localSet('radius', state.radius); load(); };
      if ($('#emptyBoost')) $('#emptyBoost').onclick = () => useBoost();
      pollTimer = setInterval(() => { if (document.visibilityState === 'visible') load(); }, 30000);
      return;
    }
    btns.forEach((b) => (b.disabled = false));
    drawStack();
  }

  function drawLikesLeft() {
    const el = $('#likesLeft');
    const lk = state.me.likes;
    if (!el) return;
    const left = lk?.limit ? Math.max(0, lk.limit - lk.used) : null;
    el.innerHTML = left !== null && left <= 5
      ? `💛 ${left} like${left === 1 ? '' : 's'} left today · <a href="#/plus/plus_month">Get unlimited</a>` : '';
  }

  const nextCard = () => $('#deck .card.depth-1');
  const setNextProgress = (p) => { // the card underneath grows as you drag the top one away
    const n = nextCard();
    if (!n) return;
    n.style.transform = `scale(${0.95 + 0.05 * p}) translateY(${12 * (1 - p)}px)`;
    n.style.filter = `brightness(${0.75 + 0.25 * p})`;
  };
  const setButtonHint = (dx) => {
    $('#likeBtn').style.transform = dx > 0 ? `scale(${1 + Math.min(dx / 400, 0.18)})` : '';
    $('#nopeBtn').style.transform = dx < 0 ? `scale(${1 + Math.min(-dx / 400, 0.18)})` : '';
  };
  const resetCard = (card) => {
    card.style.transition = reduceMotion ? 'none' : 'transform .3s cubic-bezier(.2,.9,.3,1.2)';
    card.style.transform = '';
    card.querySelectorAll('.stamp').forEach((s) => (s.style.opacity = 0));
    const n = nextCard();
    if (n) { n.style.transition = 'transform .3s, filter .3s'; n.style.transform = ''; n.style.filter = ''; }
    setButtonHint(0);
  };

  // Animate the top card off-screen. opts.vx/vy carry flick velocity (px/ms).
  function flyOut(card, dir, { dy = 0, vx = 0, vy = 0 } = {}) {
    const sign = dir === 'like' ? 1 : -1;
    const speed = Math.abs(vx);
    const ms = reduceMotion ? 0 : Math.round(Math.max(180, Math.min(340, 340 - speed * 120)));
    const x = sign * (window.innerWidth + card.offsetWidth);
    const y = dy + vy * ms;
    card.style.transition = ms ? `transform ${ms}ms cubic-bezier(.3,.6,.4,1), opacity ${ms}ms` : 'none';
    card.style.transform = `translate(${x}px, ${y}px) rotate(${sign * 30}deg)`;
    card.style.opacity = '0';
    const n = nextCard();
    if (n) { n.style.transition = ms ? `transform ${ms}ms, filter ${ms}ms` : 'none'; setNextProgress(1); }
    setButtonHint(0);
    return new Promise((res) => setTimeout(res, ms));
  }

  async function swipe(dir, card, motion) {
    if (busy) return;
    card = card || $('#deck .card.top');
    if (!card || !people.length) return;
    if (dir === 'like' && !state.me.verification.full) { resetCard(card); return showVerifyNudge(); }
    const lk = state.me.likes;
    if (dir === 'like' && lk?.limit && lk.used >= lk.limit) { resetCard(card); return showUpsell('likes', lk.resetAt); }

    busy = true;
    const p = people.shift();
    inFlight.add(p.id);
    if (!motion && !reduceMotion) { // button / keyboard: show the stamp first, then throw the card
      card.querySelector(`.stamp.${dir === 'like' ? 'like' : 'nope'}`).style.opacity = 1;
      card.style.transition = 'transform .12s';
      card.style.transform = `rotate(${dir === 'like' ? 6 : -6}deg)`;
      await new Promise((res) => setTimeout(res, 120));
    }
    buzz(dir === 'like' ? 15 : 8);
    say(`${dir === 'like' ? 'Liked' : 'Passed on'} ${p.name}`);
    const flown = flyOut(card, dir, motion);
    const sent = api('POST', '/swipe', { targetId: p.id, dir }).then((r) => ({ r }), (e) => ({ e }));
    await flown;
    busy = false;
    draw();
    if (people.length < 3) load({ append: true });

    const { r: res, e: err } = await sent;
    if (err) {
      inFlight.delete(p.id);
      if (err.code === 'LIKE_LIMIT') {
        state.me.likes = { ...lk, used: lk.limit, resetAt: err.data.resetAt };
        showUpsell('likes', err.data.resetAt);
      } else toast(err.status ? err.message : 'Couldn\'t reach the server — card put back');
      people.unshift(p);
      draw();
      return;
    }
    if (dir === 'like' && lk?.limit) { lk.used++; drawLikesLeft(); }
    if (res.match) { buzz([30, 60, 30]); showMatch(res.match); }
  }

  function attachDrag(card) {
    let sx = 0, sy = 0, dx = 0, dy = 0, t0 = 0, dragging = false, grabTop = true, crossed = false;
    let lastX = 0, lastY = 0, lastT = 0, vx = 0, vy = 0;
    const like = $('.stamp.like', card), nope = $('.stamp.nope', card);
    const threshold = () => card.offsetWidth * 0.3;

    card.onpointerdown = (e) => {
      if (busy || e.button > 0) return;
      if (e.target.closest('.more-btn')) return;
      const rect = card.getBoundingClientRect();
      dragging = true; crossed = false;
      sx = lastX = e.clientX; sy = lastY = e.clientY; t0 = lastT = performance.now();
      dx = dy = vx = vy = 0;
      grabTop = e.clientY - rect.top < rect.height / 2; // grabbing the bottom tilts the other way
      card.setPointerCapture(e.pointerId);
      card.style.transition = 'none';
      const n = nextCard();
      if (n) n.style.transition = 'none';
    };
    card.onpointermove = (e) => {
      if (!dragging) return;
      const t = performance.now();
      dx = e.clientX - sx; dy = e.clientY - sy;
      if (t > lastT) { vx = 0.7 * vx + 0.3 * ((e.clientX - lastX) / (t - lastT)); vy = 0.7 * vy + 0.3 * ((e.clientY - lastY) / (t - lastT)); }
      lastX = e.clientX; lastY = e.clientY; lastT = t;
      card.style.transform = `translate(${dx}px, ${dy * 0.4}px) rotate(${(dx / 18) * (grabTop ? 1 : -1)}deg)`;
      const prog = Math.min(1, Math.abs(dx) / threshold());
      like.style.opacity = dx > 0 ? prog : 0;
      nope.style.opacity = dx < 0 ? prog : 0;
      setNextProgress(prog);
      setButtonHint(dx);
      if (prog >= 1 && !crossed) { crossed = true; buzz(6); } else if (prog < 1) crossed = false;
    };
    const end = () => {
      if (!dragging) return;
      dragging = false;
      const quick = performance.now() - t0 < 250;
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6 && quick) { // a tap: edges flip photos, middle shows details
        resetCard(card);
        const rect = card.getBoundingClientRect(), fx = (sx - rect.left) / rect.width;
        const inPhoto = !card.classList.contains('expanded') && sy - rect.top < rect.height * 0.62;
        if (inPhoto && fx < 0.3 && stepPhoto(card, -1)) return;
        if (inPhoto && fx > 0.7 && stepPhoto(card, 1)) return;
        return toggleMore(card);
      }
      const flick = Math.abs(vx) > 0.6 && Math.abs(dx) > 40 && Math.sign(vx) === Math.sign(dx);
      if (Math.abs(dx) > threshold() || flick) return swipe(dx > 0 ? 'like' : 'pass', card, { dy: dy * 0.4, vx, vy: vy * 0.4 });
      resetCard(card);
    };
    card.onpointerup = end;
    card.onpointercancel = end;
    card.querySelector('.more-btn').onclick = () => toggleMore(card);
  }

  function toggleMore(card) {
    const open = card.classList.toggle('expanded');
    card.querySelector('.more-btn').setAttribute('aria-expanded', open);
  }

  $('#likeBtn').onclick = () => swipe('like');
  $('#nopeBtn').onclick = () => swipe('pass');
  $('#rewindBtn').onclick = async () => {
    if (busy) return;
    if (!state.me.plus?.active) return showUpsell('rewind');
    try {
      const res = await api('POST', '/swipe/rewind');
      inFlight.delete(res.user.id);
      people = [res.user, ...people.filter((p) => p.id !== res.user.id)];
      draw();
      const top = $('#deck .card.top');
      if (top && !reduceMotion) top.classList.add('fly-in');
      say(`Brought back ${res.user.name}`);
      buzz(10);
    } catch (e) { toast(e.message); }
  };
  $('#boostBtn').onclick = () => useBoost();
  document.onkeydown = (e) => {
    if (!location.hash.startsWith('#/swipe') || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target.closest?.('input, textarea, select, [contenteditable]') || document.querySelector('.overlay')) return;
    const top = $('#deck .card.top');
    if (e.key === 'ArrowRight') { e.preventDefault(); swipe('like'); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); swipe('pass'); }
    else if ((e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') && top) { e.preventDefault(); toggleMore(top); }
    else if (e.key === 'ArrowDown' && top) { e.preventDefault(); stepPhoto(top, 1, true); } // next photo, wrapping
    else if (e.key === 'Backspace' || e.key === 'z') $('#rewindBtn').click();
  };
  load();
}

function showMatch(match) {
  const u = match.user;
  const el = document.createElement('div');
  el.className = 'overlay';
  el.innerHTML = `
    <h1>It's a match! 🍻</h1>
    <div class="faces">
      <div class="face thumb" style="${avatarStyle(state.me)}">${initial(state.me)}</div>
      <div class="face thumb" style="${avatarStyle(u)}">${initial(u)}</div>
    </div>
    <p>You and <b>${esc(u.name)}</b> both want a drinking buddy.</p>
    ${u.out ? `<p class="muted">${esc(u.name)} is at <b>${esc(u.joint)}</b> having <b>${esc(u.drink)}</b> · ${distText(u.distanceKm)}</p>` : ''}
    <button class="btn" id="goChat" style="width:100%;max-width:320px">Say hi & plan the round</button>
    <button class="btn secondary" id="keep" style="width:100%;max-width:320px">Keep swiping</button>`;
  document.body.appendChild(el);
  const done = () => { el.remove(); markSeen(match.id); };
  $('#goChat', el).onclick = () => { done(); location.hash = '#/chat/' + match.id; };
  $('#keep', el).onclick = done;
}

// ---------- notifications ----------
// In-app: poll for matches made while the app is open → popup + badge on the Matches tab.
// Background: Web Push via the service worker (sw.js), so the phone buzzes when the app is closed.
let notifTimer = null;
const popupShown = new Set();

function startNotifPoll() {
  if (notifTimer) return;
  checkNotifications();
  notifTimer = setInterval(checkNotifications, 8000);
}
function stopNotifPoll() { clearInterval(notifTimer); notifTimer = null; setBadge(0); }

async function checkNotifications() {
  if (!state.me?.verification.basic) return;
  let data;
  try { data = await api('GET', '/notifications'); } catch { return; }
  setBadge(data.matches.length);
  const inChat = location.hash.startsWith('#/chat/');
  for (const m of data.matches) {
    if (popupShown.has(m.id)) continue;
    if (inChat && location.hash.endsWith(m.id)) { markSeen(m.id); continue; }
    if (document.querySelector('.overlay')) break; // one popup at a time
    popupShown.add(m.id);
    showMatch(m);
  }
}

function markSeen(matchId) {
  api('POST', `/matches/${encodeURIComponent(matchId)}/seen`).then(checkNotifications).catch(() => {});
}

function setBadge(n) {
  const tab = document.querySelector('#tabs a[data-tab=matches]');
  let b = tab.querySelector('.badge');
  if (!n) { b?.remove(); } else {
    if (!b) { b = document.createElement('i'); b.className = 'badge'; tab.appendChild(b); }
    b.textContent = n > 9 ? '9+' : n;
  }
  if (navigator.setAppBadge) (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {});
}

const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

function urlB64ToUint8Array(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function enablePush() {
  if (!pushSupported()) throw new Error(/iPhone|iPad/.test(navigator.userAgent)
    ? 'On iPhone, add the app to your Home Screen first (Share → Add to Home Screen)'
    : 'This browser doesn\'t support notifications');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Notifications are blocked — allow them in your browser settings');
  await subscribePush();
}

async function subscribePush() {
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    const { publicKey } = await api('GET', '/push/key');
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(publicKey) });
  }
  await api('POST', '/push/subscribe', { subscription: sub.toJSON() });
}

async function disablePush() {
  if (!pushSupported()) return;
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  await api('POST', '/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
  await sub.unsubscribe();
}

function pushPromptHTML() {
  if (!pushSupported() || Notification.permission !== 'default' || localGet('pushPromptDismissed')) return '';
  return `<div class="banner" id="pushPrompt"><span>🔔 Get notified when someone matches you</span>
    <button class="btn" id="pushOn">Turn on</button><button class="x" id="pushX" aria-label="Dismiss">✕</button></div>`;
}
function bindPushPrompt() {
  const el = $('#pushPrompt');
  if (!el) return;
  $('#pushOn').onclick = async () => {
    try { await enablePush(); toast('Notifications on 🔔'); el.remove(); }
    catch (e) { toast(e.message); }
  };
  $('#pushX').onclick = () => { localSet('pushPromptDismissed', '1'); el.remove(); };
}

// Service worker asks us to check right away (a push arrived while the app was open).
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (e) => { if (e.data === 'check-notifications') checkNotifications(); });
}

// ---------- matches ----------
async function renderMatches() {
  view.innerHTML = '<h2>Your drinking buddies</h2><div class="list" id="list"></div>';
  const list = await api('GET', '/matches');
  const el = $('#list');
  if (!list.length) {
    el.innerHTML = `<div class="empty"><div class="big">💬</div><p>No matches yet.</p><a class="btn" href="#/swipe" style="display:inline-block;text-decoration:none">Start swiping</a></div>`;
    return;
  }
  el.innerHTML = list.map((m) => `
    <a class="item" href="#/chat/${esc(m.id)}">
      <div class="thumb" style="${avatarStyle(m.user)}">${initial(m.user)}</div>
      <div class="txt">
        <div><b>${esc(m.user.name)}</b> ${m.unseen ? '<span class="new">NEW</span>' : ''}<span class="muted">${m.user.out ? '· ' + distText(m.user.distanceKm) : '· gone home'}</span></div>
        <div class="muted">${m.last ? esc((m.last.from === state.me.id ? 'You: ' : '') + m.last.text)
          : m.user.out ? `At ${esc(m.user.joint)} · ${esc(m.user.drink)}` : 'Say hi 👋'}</div>
      </div>
    </a>`).join('');
}

// ---------- chat ----------
async function renderChat(matchId) {
  let data;
  try { data = await api('GET', `/matches/${encodeURIComponent(matchId)}`); }
  catch (e) { toast(e.message); return (location.hash = '#/matches'); }
  const u = data.user;
  let lastAt = 0;
  markSeen(matchId);

  view.innerHTML = `
    <div class="chat">
      <div class="chat-head">
        <a href="#/matches" class="back" aria-label="Back">‹</a>
        <div class="thumb" style="${avatarStyle(u)};width:44px;height:44px;font-size:1.1rem">${initial(u)}</div>
        <div class="txt"><b>${esc(u.name)}, ${esc(u.age)}</b> ${u.verified ? '<span class="vbadge sm">✓</span>' : ''}<div class="muted" style="font-size:.85rem">${u.out ? distText(u.distanceKm) : 'Gone home'}</div></div>
        <button class="btn secondary" id="menuBtn" style="padding:8px 12px" aria-label="Options">⋯</button>
      </div>
      ${u.out ? `<div class="meetup">
        <span>🏠 <b>${esc(u.joint)}</b><br><span class="muted">🍺 ${esc(u.drink)}</span></span>
        <a class="btn" style="text-decoration:none;padding:9px 14px;font-size:.85rem" target="_blank" rel="noopener"
           href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(u.joint)}">Directions</a>
      </div>` : ''}
      ${(data.deals || []).map((d) => `<div class="deal-card">
        <span>🎁 <b>${esc(d.venueName)}</b>: ${esc(d.title)}</span>
        ${d.details ? `<span class="muted small">${esc(d.details)}</span>` : ''}
        ${d.redeemed ? '<span class="ok">✓ Redeemed — cheers!</span>'
          : `<span class="small">Show this code at the bar:</span><span class="code">${esc(d.code)}</span><span class="muted small">One use for the two of you · valid 24 h</span>`}
      </div>`).join('')}
      <div class="msgs" id="msgs"></div>
      <form class="composer" id="composer">
        <button type="button" class="btn secondary buy" id="buyBtn" title="Buy ${esc(u.name)} a drink" aria-label="Buy ${esc(u.name)} a drink">🍺</button>
        <input name="text" placeholder="Send a message…" autocomplete="off" maxlength="1000">
        <button class="btn">Send</button>
      </form>
    </div>`;

  const msgs = $('#msgs');
  const offerHTML = (m) => {
    const mine = m.from === state.me.id;
    const head = mine ? `You offered ${esc(u.name)} a` : `${esc(u.name)} wants to buy you a`;
    const body = {
      pending: mine
        ? '<div class="muted">Waiting for an answer…</div>'
        : `<div class="row"><button class="btn" data-act="accept">Accept 🍻</button><button class="btn secondary" data-act="decline">No thanks</button></div>`,
      accepted: `<div class="ok">🍻 Accepted! ${mine ? 'Pay at the bar when you meet.' : 'Your drink is on them — cheers!'}</div>`,
      declined: '<div class="muted">Declined</div>',
    }[m.state];
    return `<div class="offer-title">${head}</div><div class="offer-drink">🍺 ${esc(m.drink)}</div>
      ${m.note ? `<div class="offer-note">“${esc(m.note)}”</div>` : ''}${body}`;
  };
  const append = (list) => {
    for (const m of list) {
      lastAt = Math.max(lastAt, m.at, m.updatedAt || 0);
      let div = msgs.querySelector(`[data-id="${CSS.escape(m.id)}"]`);
      if (!div) {
        div = document.createElement('div');
        div.dataset.id = m.id;
        msgs.appendChild(div);
      }
      div.className = 'msg' + (m.from === state.me.id ? ' mine' : '') + (m.kind === 'drink' ? ' offer' : '');
      if (m.kind === 'drink') {
        div.innerHTML = offerHTML(m);
        div.querySelectorAll('[data-act]').forEach((b) => (b.onclick = async () => {
          try { append([await api('POST', `/matches/${matchId}/drinks/${m.id}`, { action: b.dataset.act })]); }
          catch (err) { toast(err.message); }
        }));
      } else {
        div.textContent = m.text;
      }
    }
    msgs.scrollTop = msgs.scrollHeight;
  };

  $('#buyBtn').onclick = () => {
    const sheet = document.createElement('div');
    sheet.className = 'overlay sheet';
    sheet.innerHTML = `
      <form class="sheet-body" id="offerForm">
        <h2>Buy ${esc(u.name)} a drink 🍺</h2>
        <label>Drink<input name="drink" required maxlength="40" value="${esc(u.out ? u.drink : '')}" placeholder="e.g. Tusker"></label>
        <div class="chips">${DRINKS.map((d) => `<button type="button" class="chip" data-d="${esc(d)}">${esc(d)}</button>`).join('')}</div>
        <label>Add a note (optional)<input name="note" maxlength="140" placeholder="First round's on me!"></label>
        <p class="muted" style="font-size:.8rem;margin:0">You'll pay at the bar when you meet.</p>
        <div class="row"><button type="button" class="btn secondary" id="cancelOffer">Cancel</button><button class="btn">Send offer</button></div>
      </form>`;
    document.body.appendChild(sheet);
    const input = $('[name=drink]', sheet);
    const sync = () => sheet.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c.dataset.d === input.value));
    sheet.querySelectorAll('.chip').forEach((c) => (c.onclick = () => { input.value = c.dataset.d; sync(); }));
    input.oninput = sync; sync();
    sheet.onclick = (e) => { if (e.target === sheet) sheet.remove(); };
    $('#cancelOffer', sheet).onclick = () => sheet.remove();
    $('#offerForm', sheet).onsubmit = async (e) => {
      e.preventDefault();
      try {
        const msg = await api('POST', `/matches/${matchId}/drinks`, Object.fromEntries(new FormData(e.target)));
        if (!msgs.querySelector('.msg')) msgs.innerHTML = '';
        append([msg]);
        sheet.remove();
        toast(`Offer sent to ${u.name} 🍺`);
      } catch (err) { toast(err.message); }
    };
  };
  if (!data.messages.length) msgs.innerHTML = `<p class="muted center" style="margin:auto">You matched with ${esc(u.name)}! Suggest a meeting spot, or tap 🍺 to buy them a drink.<br><small>Meet in public, watch your drink, and let a friend know where you are.</small></p>`;
  append(data.messages);

  $('#composer').onsubmit = async (e) => {
    e.preventDefault();
    const input = e.target.text;
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    if (!lastAt) msgs.innerHTML = '';
    try { append([await api('POST', `/matches/${matchId}/messages`, { text })]); }
    catch (err) { toast(err.message); input.value = text; }
  };

  $('#menuBtn').onclick = async () => {
    const choice = prompt(`Type:\n1 — Unmatch ${u.name}\n2 — Report ${u.name}`);
    if (choice === '1' && confirm(`Unmatch ${u.name}? You won't see each other again.`)) {
      await api('DELETE', `/matches/${matchId}`);
      toast('Unmatched'); location.hash = '#/matches';
    } else if (choice === '2') {
      const reason = prompt('What happened?');
      if (reason) { await api('POST', '/report', { userId: u.id, reason }); toast('Thanks — we\'ll review this.'); }
    }
  };

  pollTimer = setInterval(async () => {
    try {
      const d = await api('GET', `/matches/${encodeURIComponent(matchId)}?after=${lastAt}`);
      if (d.messages.length && !lastAt) msgs.innerHTML = '';
      append(d.messages);
    } catch { clearInterval(pollTimer); }
  }, 2500);
}

// ---------- profile ----------
function renderProfile() {
  const me = state.me;
  view.innerHTML = `
    <form id="profileForm">
      <div class="photo-grid" id="photoGrid">${photoGridHTML(me)}</div>
      <input type="file" id="file" accept="image/*" multiple hidden>
      <p class="muted small center" style="margin:0">@${esc(me.username)} · ${esc(me.age)} · <span id="photoCount">${me.photoList.length}/${me.maxPhotos}</span> photos.
        Your <b>main</b> photo is checked against your verification selfie, so changing it means a new selfie check.</p>
      <label>Name<input name="name" value="${esc(me.name)}" maxlength="40" ${me.nameLocked ? 'readonly title="Set from your verified ID"' : ''}>${me.nameLocked ? '<small>✓ From your verified ID</small>' : ''}</label>
      <label>About you<textarea name="bio" maxlength="300" placeholder="Football fan, karaoke lover, one-drink-wonder…">${esc(me.bio)}</textarea></label>
      <button class="btn">Save</button>
      <div class="setting"><span>🔔 Match notifications<br><small class="muted" id="pushState"></small></span>
        <button type="button" class="btn secondary" id="pushToggle"></button></div>
      <label class="setting switch-row"><span>🎁 Deals from partner bars nearby<br><small class="muted">Up to one notification a day per bar, only while you're out. Off by default.</small></span>
        <input type="checkbox" id="promoOpt" ${me.promoOptIn ? 'checked' : ''}></label>
      <a class="setting" href="/partner.html" style="text-decoration:none;color:inherit"><span>🍺 Own or manage a bar?<br><small class="muted">Open Buddies for Business</small></span><span style="color:var(--accent)">›</span></a>
      ${plusCardHTML(me)}
      ${verificationSummaryHTML(me)}
      ${me.isAdmin ? '<a class="btn secondary center" href="/admin.html" style="text-decoration:none">🛡️ Admin</a>' : ''}
      <button type="button" class="btn secondary" id="logout">Log out</button>
    </form>
    ${securitySectionHTML()}`;
  bindSecuritySection();

  const drawPush = async () => {
    const btn = $('#pushToggle'), st = $('#pushState');
    if (!btn) return;
    const reg = pushSupported() && await navigator.serviceWorker.getRegistration();
    const on = !!(reg && Notification.permission === 'granted' && await reg.pushManager.getSubscription());
    st.textContent = !pushSupported() ? 'Not supported here (on iPhone, add to Home Screen first)'
      : Notification.permission === 'denied' ? 'Blocked in browser settings' : on ? 'On' : 'Off';
    btn.textContent = on ? 'Turn off' : 'Turn on';
    btn.disabled = !pushSupported() && !/iPhone|iPad/.test(navigator.userAgent);
    btn.onclick = async () => {
      try { on ? await disablePush() : await enablePush(); toast(on ? 'Notifications off' : 'Notifications on 🔔'); }
      catch (e) { toast(e.message); }
      drawPush();
    };
  };
  drawPush();
  $('#promoOpt').onchange = async (e) => {
    try { state.me = await api('PUT', '/me', { promoOptIn: e.target.checked }); toast(e.target.checked ? 'You\'ll get deals from bars near you' : 'Partner deals off'); }
    catch (err) { toast(err.message); e.target.checked = !e.target.checked; }
  };

  bindPhotoGrid();
  $('#logout').onclick = () => logout();
  $('#profileForm').onsubmit = async (e) => {
    e.preventDefault();
    state.me = await api('PUT', '/me', Object.fromEntries(new FormData(e.target)));
    toast('Saved ✓');
  };
}

// Downscale to keep uploads small (stored inline in the DB for the MVP).
// Downscale + re-encode as JPEG (also strips EXIF, including GPS), stepping quality down
// until it fits the server's ~350 KB limit.
function resizeImage(file, max) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      let q = 0.85, out = c.toDataURL('image/jpeg', q);
      while (out.length > 470_000 && q > 0.4) { q -= 0.1; out = c.toDataURL('image/jpeg', q); }
      if (out.length > 490_000) return reject(new Error('That photo is too large — try another'));
      resolve(out);
    };
    img.onerror = () => reject(new Error('Could not read that image'));
    img.src = URL.createObjectURL(file);
  });
}

// ---------- profile photos (up to 6) ----------
function photoGridHTML(me) {
  const slots = [];
  me.photoList.forEach((ph, i) => slots.push(`
    <div class="pslot" style="background-image:url('${esc(ph.url)}')" data-id="${esc(ph.id)}">
      ${i === 0 ? '<span class="main-tag">Main</span>' : `<button type="button" class="pmain" data-main="${esc(ph.id)}" aria-label="Make this your main photo">★</button>`}
      <button type="button" class="pdel" data-del="${esc(ph.id)}" aria-label="Remove photo ${i + 1}">✕</button>
    </div>`));
  for (let i = me.photoList.length; i < me.maxPhotos; i++) {
    slots.push(`<button type="button" class="pslot add" data-add aria-label="Add a photo">${i === 0 ? '<span>＋<br><small>Add your main photo</small></span>' : '＋'}</button>`);
  }
  return slots.join('');
}

function bindPhotoGrid() {
  const grid = $('#photoGrid');
  const verifiedSelfie = () => ['approved', 'pending'].includes(state.me.verification.selfie);
  const refresh = (m) => {
    state.me = m;
    grid.innerHTML = photoGridHTML(m);
    if ($('#photoCount')) $('#photoCount').textContent = `${m.photoList.length}/${m.maxPhotos}`;
    bindPhotoGrid();
  };
  grid.querySelectorAll('[data-add]').forEach((b) => (b.onclick = () => $('#file').click()));
  $('#file').onchange = async (e) => {
    const files = [...e.target.files].slice(0, state.me.maxPhotos - state.me.photoList.length);
    e.target.value = '';
    for (const [i, f] of files.entries()) {
      try {
        toast(`Uploading ${i + 1} of ${files.length}…`);
        refresh(await api('POST', '/me/photos', { image: await resizeImage(f, 1080) }));
      } catch (err) { toast(err.message); break; }
    }
    if (files.length) toast(files.length === 1 ? 'Photo added' : `${files.length} photos added`);
  };
  grid.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => {
    const isMain = state.me.photoList[0]?.id === b.dataset.del;
    if (!confirm(isMain && verifiedSelfie() ? 'Remove your main photo? You\'ll need a new selfie check to keep liking and matching.' : 'Remove this photo?')) return;
    try { refresh(await api('DELETE', `/me/photos/${b.dataset.del}`)); } catch (err) { toast(err.message); }
  }));
  grid.querySelectorAll('[data-main]').forEach((b) => (b.onclick = async () => {
    if (verifiedSelfie() && !confirm('Make this your main photo? We check your selfie against your main photo, so you\'ll need a new selfie check.')) return;
    const ids = state.me.photoList.map((p) => p.id);
    const order = [b.dataset.main, ...ids.filter((x) => x !== b.dataset.main)];
    try { refresh(await api('PUT', '/me/photos/order', { ids: order })); toast('Main photo updated'); } catch (err) { toast(err.message); }
  }));
}

window.addEventListener('hashchange', router);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
router();
