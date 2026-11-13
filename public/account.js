// Account verification + security screens. Loaded before app.js; uses its helpers ($, api, esc, toast…)
// at call time.
'use strict';

let activeStream = null; // camera stream for the selfie step — stopped whenever we navigate away
window.addEventListener('hashchange', () => { activeStream?.getTracks().forEach((t) => t.stop()); activeStream = null; });

function maxDob() {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 18);
  return d.toISOString().slice(0, 10);
}

// Dev mode only: the server echoes OTP codes / email links when no SMS/email provider is configured.
function devHintHTML(kind) {
  const d = state.dev;
  if (kind === 'code' && d?.code) return `<div class="devhint">🛠 Dev mode — SMS not configured. Your code is <b>${esc(d.code)}</b></div>`;
  if (kind === 'link' && d?.link) {
    const hash = d.link.slice(d.link.indexOf('#'));
    return `<div class="devhint">🛠 Dev mode — email not configured. <a href="${esc(hash)}">Open the email link</a></div>`;
  }
  return '';
}
const mergeDev = (dev) => { if (dev) state.dev = { ...state.dev, ...dev }; };

function renderBanned(msg) {
  showChrome(false);
  view.innerHTML = `<div class="hero"><div class="big">🚫</div><h1>Account suspended</h1>
    <p class="muted">${esc(msg || 'This account has been suspended.')}</p>
    <p class="muted small">If you think this is a mistake, contact support.</p></div>`;
}

// ---------- verification hub ----------
function stepHTML(n, title, done, body, locked) {
  return `<div class="step ${done ? 'done' : ''} ${locked ? 'locked' : ''}">
    <div class="step-n">${done ? '✓' : n}</div>
    <div class="step-body"><div class="step-title">${title}</div>${body}</div></div>`;
}

let resendUntil = { phone: 0, email: 0 };

async function renderVerify(param) {
  if (param === 'selfie') return renderVerifySelfie();
  if (param === 'id') return renderVerifyId();
  const me = state.me;
  const v = me.verification;
  const sub = (s) => `<div class="muted small">${s}</div>`;

  const phoneBody = v.phone ? sub(esc(me.phone)) : `
    ${sub(me.phone ? `We texted a 6-digit code to <b>${esc(me.phone)}</b>` : 'Add your phone number')}
    ${devHintHTML('code')}
    ${me.phone ? `<form id="otpForm" class="inline">
      <input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="\\d{6}" maxlength="6" placeholder="123456" required>
      <button class="btn">Verify</button></form>` : ''}
    <div class="links"><button type="button" class="link" id="resendOtp" data-k="phone">Resend code</button>
      <details><summary>Change number</summary><form id="phoneForm" class="inline">
        <input name="phone" type="tel" placeholder="0712 345 678" required><button class="btn secondary">Send code</button></form></details></div>`;

  const emailBody = v.email ? sub(esc(me.email)) : `
    ${sub(me.email ? `We emailed a link to <b>${esc(me.email)}</b>. Open it on any device.` : 'Add your email')}
    ${devHintHTML('link')}
    <div class="links"><button type="button" class="link" id="resendEmail" data-k="email">Resend email</button>
      <details><summary>Change email</summary><form id="emailForm" class="inline">
        <input name="email" type="email" required><button class="btn secondary">Send link</button></form></details></div>`;

  const selfieBody = {
    none: `${sub('A live selfie copying a random pose, checked by our team against your profile photo.')}
      ${v.selfieNote ? `<div class="warn small">${esc(v.selfieNote)}</div>` : ''}
      <a class="btn secondary sm" href="#/verify/selfie">Take selfie</a>`,
    pending: sub('⏳ In review — usually within a few hours. We\'ll let you know.'),
    approved: sub('Approved'),
    rejected: `<div class="warn small">Not approved: ${esc(v.selfieNote || '')}</div><a class="btn secondary sm" href="#/verify/selfie">Try again</a>`,
  }[v.selfie];

  const idBody = v.id === 'verified' ? sub('Verified') : `
    ${sub('Checked against the national registry. We never store your ID number.')}
    ${v.id === 'failed' && v.idNote ? `<div class="warn small">${esc(v.idNote)}</div>` : ''}
    <a class="btn secondary sm" href="#/verify/id">Verify ID</a>`;

  view.innerHTML = `
    <h1>Verify your account</h1>
    <p class="muted">Everyone on Drinking Buddies is verified, so you know who you're meeting.</p>
    <div class="steps">
      ${stepHTML(1, 'Phone number', v.phone, phoneBody)}
      ${stepHTML(2, 'Email', v.email, emailBody)}
      <div class="unlock">🔓 Unlocks going out & browsing</div>
      ${stepHTML(3, 'Selfie check', v.selfie === 'approved', v.basic ? selfieBody : sub('After steps 1–2'), !v.basic)}
      ${stepHTML(4, 'Government ID', v.id === 'verified', v.basic ? idBody : sub('After steps 1–2'), !v.basic)}
      <div class="unlock">🔓 Unlocks liking, matching, chat & drink offers</div>
    </div>
    <div class="error" id="err"></div>
    ${v.basic ? `<a class="btn" href="${me.status ? '#/swipe' : '#/out'}" style="display:block;text-align:center;text-decoration:none">Continue to the app</a>` : ''}
    <button type="button" class="link" id="vLogout" style="display:block;margin:16px auto 0">Log out</button>`;

  const err = (m) => { $('#err').textContent = m || ''; };
  const refresh = (user) => { if (user) state.me = user; renderVerify(); };
  $('#vLogout').onclick = () => logout();

  // resend buttons with a cooldown
  const tickResend = () => {
    for (const b of view.querySelectorAll('[data-k]')) {
      const left = Math.ceil((resendUntil[b.dataset.k] - Date.now()) / 1000);
      b.disabled = left > 0;
      b.textContent = (b.dataset.k === 'phone' ? 'Resend code' : 'Resend email') + (left > 0 ? ` (${left}s)` : '');
    }
  };
  tickResend();
  clearInterval(pollTimer); // renderVerify re-renders itself; never leave an old timer running
  pollTimer = setInterval(async () => {
    if (!state.me || !location.hash.startsWith('#/verify')) return clearInterval(pollTimer);
    tickResend();
    // Email may be confirmed on another device — pick it up.
    if (!state.me.verification.email && Date.now() % 4000 < 1000) {
      try { const u = await api('GET', '/me'); if (u.verification.email) { toast('Email confirmed ✓'); refresh(u); } } catch { /* ignore */ }
    }
  }, 1000);

  const send = async (kind, body) => {
    err();
    try {
      const r = await api('POST', `/verify/${kind}/send`, body);
      mergeDev(r.dev);
      resendUntil[kind] = Date.now() + 60e3;
      toast(kind === 'phone' ? `Code sent to ${r.phone}` : `Link sent to ${r.email}`);
      refresh(await api('GET', '/me'));
    } catch (e) { err(e.message); }
  };
  $('#resendOtp') && ($('#resendOtp').onclick = () => send('phone', {}));
  $('#resendEmail') && ($('#resendEmail').onclick = () => send('email', {}));
  $('#phoneForm') && ($('#phoneForm').onsubmit = (e) => { e.preventDefault(); send('phone', { phone: e.target.phone.value }); });
  $('#emailForm') && ($('#emailForm').onsubmit = (e) => { e.preventDefault(); send('email', { email: e.target.email.value }); });
  $('#otpForm') && ($('#otpForm').onsubmit = async (e) => {
    e.preventDefault();
    err();
    try { const u = await api('POST', '/verify/phone', { code: e.target.code.value.trim() }); toast('Phone verified ✓'); refresh(u); }
    catch (e2) { err(e2.message); }
  });
}

// ---------- selfie ----------
async function renderVerifySelfie() {
  const me = state.me;
  if (!me.photo) {
    view.innerHTML = `
      <a href="#/verify" class="back-link">‹ Back</a>
      <h1>Add a profile photo first</h1>
      <p class="muted">We compare your selfie with your profile photo. Use a clear photo of your face.</p>
      <div class="profile-photo" id="pp" style="${avatarStyle(me)}">${initial(me)}</div>
      <input type="file" id="ppFile" accept="image/*" hidden>
      <button class="btn" id="ppBtn">Choose photo</button>`;
    $('#ppBtn').onclick = $('#pp').onclick = () => $('#ppFile').click();
    $('#ppFile').onchange = async (e) => {
      if (!e.target.files[0]) return;
      try { state.me = await api('PUT', '/me', { photo: await resizeImage(e.target.files[0], 600) }); renderVerifySelfie(); }
      catch (err) { toast(err.message); }
    };
    return;
  }

  let challenge;
  try { challenge = await api('POST', '/verify/selfie/challenge'); }
  catch (e) { toast(e.message); return (location.hash = '#/verify'); }

  view.innerHTML = `
    <a href="#/verify" class="back-link">‹ Back</a>
    <h1>Selfie check</h1>
    <div class="pose">Copy this pose:<b>${esc(challenge.pose)}</b></div>
    <div class="cam"><video id="video" autoplay playsinline muted></video><img id="shot" hidden alt="Your selfie"></div>
    <div class="error" id="err"></div>
    <div class="row" id="camBtns"><button class="btn" id="snap" disabled>📸 Take photo</button></div>
    <p class="muted small">Your selfie is only seen by our verification team and is deleted after review.</p>`;

  const video = $('#video');
  try {
    activeStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 720 } }, audio: false });
    video.srcObject = activeStream;
    $('#snap').disabled = false;
  } catch (e) {
    $('#err').textContent = 'We need your camera for this step. Allow camera access' +
      (location.protocol === 'http:' && location.hostname !== 'localhost' ? ' (phones need HTTPS for the camera).' : '.');
    return;
  }

  let dataUrl = null;
  const showLive = () => {
    $('#shot').hidden = true; video.hidden = false;
    $('#camBtns').innerHTML = '<button class="btn" id="snap">📸 Take photo</button>';
    $('#snap').onclick = snap;
  };
  const snap = () => {
    const c = document.createElement('canvas');
    const scale = Math.min(1, 720 / Math.max(video.videoWidth, video.videoHeight));
    c.width = Math.round(video.videoWidth * scale); c.height = Math.round(video.videoHeight * scale);
    c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
    dataUrl = c.toDataURL('image/jpeg', 0.85);
    $('#shot').src = dataUrl; $('#shot').hidden = false; video.hidden = true;
    $('#camBtns').innerHTML = '<button class="btn secondary" id="retake">Retake</button><button class="btn" id="submit">Submit</button>';
    $('#retake').onclick = showLive;
    $('#submit').onclick = submit;
  };
  const submit = async () => {
    $('#submit').disabled = true;
    try {
      state.me = await api('POST', '/verify/selfie', { challengeId: challenge.challengeId, image: dataUrl });
      toast('Selfie submitted — we\'ll review it soon');
      location.hash = '#/verify';
    } catch (e) { $('#err').textContent = e.message; $('#submit').disabled = false; }
  };
  $('#snap').onclick = snap;
}

// ---------- government ID ----------
function renderVerifyId() {
  view.innerHTML = `
    <a href="#/verify" class="back-link">‹ Back</a>
    <h1>Verify your ID</h1>
    <p class="muted">We check your details against the national registry through our verification partner.
      We only keep the result — never your ID number. Your display name will be set from your ID.</p>
    <form id="idForm">
      <label>ID type<select name="idType">
        <option value="NATIONAL_ID">National ID</option><option value="PASSPORT">Passport</option><option value="ALIEN_CARD">Alien ID</option>
      </select></label>
      <label>ID number<input name="idNumber" required maxlength="15" autocomplete="off" inputmode="text"></label>
      <div class="row">
        <label>First name<input name="firstName" required maxlength="40" value="${esc(state.me.name)}"></label>
        <label>Last name<input name="lastName" required maxlength="40"></label>
      </div>
      <label>Date of birth<input name="dob" type="date" required max="${maxDob()}" value="${esc(state.me.dob || '')}"></label>
      <p class="muted small">Enter your names exactly as they appear on your ID.</p>
      <div class="error" id="err"></div>
      <button class="btn">Verify ID</button>
    </form>`;
  $('#idForm').onsubmit = async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('.btn');
    btn.disabled = true; btn.textContent = 'Checking…';
    try {
      state.me = await api('POST', '/verify/id', Object.fromEntries(new FormData(e.target)));
      toast('ID verified ✓');
      location.hash = '#/verify';
    } catch (err) {
      if (err.data?.user) state.me = err.data.user;
      $('#err').textContent = err.message;
      btn.disabled = false; btn.textContent = 'Verify ID';
    }
  };
}

// "You need to be verified to like" prompt on the swipe screen.
function showVerifyNudge() {
  const v = state.me.verification;
  const row = (label, ok, pending) => `<li>${ok ? '✅' : pending ? '⏳' : '⬜'} ${label}${pending && !ok ? ' <span class="muted">(in review)</span>' : ''}</li>`;
  const el = document.createElement('div');
  el.className = 'overlay sheet';
  el.innerHTML = `<div class="sheet-body">
    <h2>Get verified to start liking 💛</h2>
    <p class="muted">Only verified people can like and match — that's how we keep everyone safe.</p>
    <ul class="checklist">${row('Phone', v.phone)}${row('Email', v.email)}${row('Selfie check', v.selfie === 'approved', v.selfie === 'pending')}${row('Government ID', v.id === 'verified')}</ul>
    <div class="row"><button class="btn secondary" id="later">Later</button><a class="btn" href="#/verify" style="text-align:center;text-decoration:none">Verify now</a></div></div>`;
  document.body.appendChild(el);
  el.onclick = (e) => { if (e.target === el || e.target.id === 'later' || e.target.tagName === 'A') el.remove(); };
}

// ---------- email links (no login needed) ----------
async function renderConfirmEmail(token) {
  view.innerHTML = '<div class="hero"><div class="big">📧</div><h1>Confirming your email…</h1></div>';
  try {
    await api('POST', '/verify/email/confirm', { token });
    state.me = null; // refetch on next route
    history.replaceState(null, '', '/#/verify'); // drop the token from the address bar / history
    view.innerHTML = `<div class="hero"><div class="big">✅</div><h1>Email confirmed</h1>
      <p class="muted">You can close this tab, or continue here.</p></div>
      <a class="btn" href="#/verify" style="display:block;text-align:center;text-decoration:none">Continue</a>`;
  } catch (e) {
    view.innerHTML = `<div class="hero"><div class="big">⚠️</div><h1>Link didn't work</h1><p class="muted">${esc(e.message)}</p></div>
      <a class="btn" href="#/verify" style="display:block;text-align:center;text-decoration:none">Back to the app</a>`;
  }
}

function renderForgot() {
  view.innerHTML = `
    <a href="#/login" class="back-link">‹ Back to log in</a>
    <h1>Reset your password</h1>
    <p class="muted">Enter the email on your account. If it's verified, we'll send you a reset link.</p>
    <form id="forgotForm">
      <label>Email<input name="email" type="email" required autocomplete="email"></label>
      <div id="msg"></div>
      <button class="btn">Send reset link</button>
    </form>`;
  $('#forgotForm').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const r = await api('POST', '/password/forgot', { email: e.target.email.value });
      state.dev = r.dev || null;
      $('#msg').innerHTML = `<p class="ok">${esc(r.message)}</p>${devHintHTML('link').replace('Open the email link', 'Open the reset link')}`;
    } catch (err) { $('#msg').innerHTML = `<p class="error">${esc(err.message)}</p>`; }
  };
}

function renderReset(token) {
  history.replaceState(null, '', '/#/reset'); // keep the token out of history
  view.innerHTML = `
    <h1>Choose a new password</h1>
    <form id="resetForm">
      <label>New password<input name="password" type="password" required minlength="8" autocomplete="new-password"></label>
      <label>Repeat it<input name="again" type="password" required minlength="8" autocomplete="new-password"></label>
      <div class="error" id="err"></div>
      <button class="btn">Set password</button>
    </form>`;
  $('#resetForm').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    if (f.password.value !== f.again.value) return ($('#err').textContent = 'Passwords don\'t match');
    try {
      await api('POST', '/password/reset', { token, password: f.password.value });
      view.innerHTML = `<div class="hero"><div class="big">🔐</div><h1>Password changed</h1>
        <p class="muted">You've been logged out everywhere. Log in with your new password.</p></div>
        <a class="btn" href="#/login" style="display:block;text-align:center;text-decoration:none">Log in</a>`;
    } catch (err) { $('#err').textContent = err.message; }
  };
}

// ---------- profile: verification summary + security ----------
function verificationSummaryHTML(me) {
  const v = me.verification;
  const s = { none: 'Not done', pending: 'In review', approved: '✓', rejected: 'Not approved', verified: '✓', failed: 'Failed' };
  return `<a class="verify-card ${v.full ? 'ok' : ''}" href="#/verify">
    <div><b>${v.full ? '✓ Fully verified' : 'Verification'}</b>
      <div class="muted small">Phone ${v.phone ? '✓' : '✗'} · Email ${v.email ? '✓' : '✗'} · Selfie ${s[v.selfie]} · ID ${s[v.id]}</div></div>
    <span>${v.full ? '' : 'Finish ›'}</span></a>`;
}

function securitySectionHTML() {
  return `<details class="security"><summary>🔐 Security & account</summary>
    <form id="pwForm">
      <h3>Change password</h3>
      <input name="current" type="password" placeholder="Current password" required autocomplete="current-password">
      <input name="next" type="password" placeholder="New password (8+ characters)" required minlength="8" autocomplete="new-password">
      <button class="btn secondary">Change password</button>
    </form>
    <button type="button" class="btn secondary" id="logoutAll">Log out of all devices</button>
    <form id="delForm">
      <h3>Delete account</h3>
      <p class="muted small">Permanently deletes your profile, photos, matches and messages. This can't be undone.</p>
      <input name="password" type="password" placeholder="Your password" required autocomplete="current-password">
      <button class="btn danger">Delete my account</button>
    </form></details>`;
}

function bindSecuritySection() {
  $('#pwForm').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('POST', '/me/password', { current: e.target.current.value, next: e.target.next.value });
      e.target.reset();
      toast('Password changed — other devices logged out');
    } catch (err) { toast(err.message); }
  };
  $('#logoutAll').onclick = async () => {
    if (!confirm('Log out of every device, including this one?')) return;
    await disablePush().catch(() => {});
    await api('POST', '/logout-all').catch(() => {});
    state.me = null; stopNotifPoll();
    location.hash = '#/login';
  };
  $('#delForm').onsubmit = async (e) => {
    e.preventDefault();
    if (!confirm('Delete your account permanently?')) return;
    try {
      await disablePush().catch(() => {});
      await api('DELETE', '/me', { password: e.target.password.value });
      state.me = null; stopNotifPoll();
      location.hash = '#/login';
      toast('Your account has been deleted');
    } catch (err) { toast(err.message); }
  };
}
