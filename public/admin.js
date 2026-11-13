// Admin console: selfie review queue, reports/bans, audit log. Server enforces admin rights on every call.
'use strict';
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const panel = $('#panel');

async function api(method, url, body) {
  const res = await fetch('/api' + url, {
    method, credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-CSRF': '1' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Error'), { status: res.status });
  return data;
}
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 2500);
}
const when = (ts) => new Date(ts).toLocaleString();
const img = (src, label) => `<figure><div class="ph" style="background-image:url('${esc(src)}')"></div><figcaption>${label}</figcaption></figure>`;

async function selfies() {
  const list = await api('GET', '/admin/selfies');
  if (!list.length) return (panel.innerHTML = '<div class="empty"><div class="big">✅</div><p>No selfies waiting for review.</p></div>');
  panel.innerHTML = list.map((u) => `
    <div class="review" data-id="${esc(u.id)}">
      <div class="review-head"><b>${esc(u.name)}, ${esc(u.age)}</b> <span class="muted">@${esc(u.username)} · submitted ${when(u.submittedAt)}</span></div>
      <div class="pose">Asked to: <b>${esc(u.pose)}</b></div>
      <div class="compare">${img(u.photo, 'Profile photo')}${img(u.selfie, 'Live selfie')}</div>
      <p class="muted small">Approve only if it's clearly the same person, the pose matches, and it's a live photo (not a photo of a screen or print).</p>
      <div class="row"><button class="btn" data-d="approve">Approve</button><button class="btn danger" data-d="reject">Reject</button></div>
    </div>`).join('');
  panel.querySelectorAll('[data-d]').forEach((b) => (b.onclick = async () => {
    const card = b.closest('.review');
    let reason = '';
    if (b.dataset.d === 'reject') {
      reason = prompt('Reason (shown to the user):', 'Your selfie didn\'t match the requested pose — please try again.');
      if (!reason) return;
    }
    try { await api('POST', `/admin/selfies/${card.dataset.id}`, { decision: b.dataset.d, reason }); card.remove(); toast(b.dataset.d === 'approve' ? 'Approved' : 'Rejected'); }
    catch (e) { toast(e.message); }
  }));
}

async function reports() {
  const list = await api('GET', '/admin/reports');
  if (!list.length) return (panel.innerHTML = '<div class="empty"><div class="big">🕊️</div><p>No open reports.</p></div>');
  panel.innerHTML = list.map(({ user: u, reports: rs }) => `
    <div class="review" data-id="${esc(u.id)}">
      <div class="review-head"><b>${esc(u.name)}, ${esc(u.age)}</b> <span class="muted">@${esc(u.username)}</span>
        ${u.banned ? '<span class="tag bad">Banned</span>' : ''}${u.underReview ? '<span class="tag">Hidden — under review</span>' : ''}</div>
      ${u.photos?.length ? `<div class="pthumbs">${u.photos.map((ph, i) => `<figure><div class="ph" style="background-image:url('${esc(ph.url)}')"></div>
        <figcaption>${i === 0 ? 'Main · ' : ''}<button class="link" data-rmphoto="${esc(ph.id)}">Remove</button></figcaption></figure>`).join('')}</div>` : ''}
      <ul class="reports">${rs.map((r) => `<li><span class="muted small">${when(r.at)} · @${esc(r.from)}</span><br>${esc(r.reason || '(no reason given)')}</li>`).join('')}</ul>
      <div class="row">${u.banned ? '<button class="btn secondary" data-a="unban">Unban</button>'
        : '<button class="btn danger" data-a="ban">Ban</button><button class="btn secondary" data-a="clear">Dismiss reports</button>'}</div>
    </div>`).join('');
  panel.querySelectorAll('[data-rmphoto]').forEach((b) => (b.onclick = async () => {
    if (!confirm('Remove this photo from their profile? (Removing the main photo also resets their selfie check.)')) return;
    try { await api('POST', `/admin/users/${b.closest('.review').dataset.id}/photos/${b.dataset.rmphoto}/remove`); toast('Photo removed'); reports(); }
    catch (e) { toast(e.message); }
  }));
  panel.querySelectorAll('[data-a]').forEach((b) => (b.onclick = async () => {
    const id = b.closest('.review').dataset.id;
    let reason = '';
    if (b.dataset.a === 'ban') { reason = prompt('Ban reason (kept in the audit log):'); if (!reason) return; }
    try { await api('POST', `/admin/users/${id}/${b.dataset.a}`, { reason }); toast('Done'); reports(); }
    catch (e) { toast(e.message); }
  }));
}

async function audit() {
  const list = await api('GET', '/admin/audit?limit=300');
  panel.innerHTML = `<table class="audit"><thead><tr><th>When</th><th>Event</th><th>User</th><th>IP</th></tr></thead><tbody>
    ${list.map((a) => `<tr><td>${when(a.at)}</td><td>${esc(a.action)}${a.meta ? `<div class="muted small">${esc(JSON.stringify(a.meta))}</div>` : ''}</td>
      <td>${a.username ? '@' + esc(a.username) : '—'}</td><td class="muted">${esc(a.ip || '')}</td></tr>`).join('')}</tbody></table>`;
}

async function venues() {
  const list = await api('GET', '/admin/venues');
  if (!list.length) return (panel.innerHTML = '<div class="empty"><div class="big">🍺</div><p>No partner venues yet.</p></div>');
  const tagFor = { pending: '<span class="tag gold">Pending review</span>', active: '<span class="tag">Active</span>', suspended: '<span class="tag bad">Suspended</span>', rejected: '<span class="tag bad">Rejected</span>' };
  panel.innerHTML = list.map((v) => `
    <div class="review" data-id="${esc(v.id)}">
      <div class="review-head"><b>${esc(v.name)}</b> ${tagFor[v.status]} ${v.featuredUntil ? `<span class="tag gold">★ Featured to ${new Date(v.featuredUntil).toLocaleDateString('en-KE')}</span>` : ''}
        <div class="muted small">${esc(v.area)} · ${esc(v.address)} · owner @${esc(v.owner)} · applied ${when(v.createdAt)}</div></div>
      <div class="small">KRA PIN <code>${esc(v.kraPin)}</code> · ☎ ${esc(v.contactPhone)} ·
        <a href="https://www.google.com/maps/search/?api=1&query=${v.lat},${v.lng}" target="_blank" rel="noopener">check location on map</a> ·
        ${v.checkins30} check-ins (30 d)</div>
      ${v.note ? `<div class="warn small">${esc(v.note)}</div>` : ''}
      <div class="row">${
        v.status === 'pending' ? '<button class="btn" data-a="approve">Approve</button><button class="btn danger" data-a="reject">Reject</button>'
        : v.status === 'active' ? `<button class="btn secondary" data-a="gift">🎁 Gift Featured days</button>${v.featuredUntil ? '<button class="btn secondary" data-a="unfeature">End Featured</button>' : ''}<button class="btn danger" data-a="suspend">Suspend</button>`
        : v.status === 'suspended' ? '<button class="btn secondary" data-a="unsuspend">Reinstate</button>' : ''}</div>
    </div>`).join('');
  panel.querySelectorAll('[data-a]').forEach((b) => (b.onclick = async () => {
    const id = b.closest('.review').dataset.id, a = b.dataset.a;
    const body = {};
    if (a === 'gift') { body.days = Number(prompt('Gift how many Featured days? (1–90)', '30')); if (!body.days) return; }
    if (a === 'unfeature' && !confirm('End Featured now? Paid time will be lost — refund via M-Pesa separately if needed.')) return;
    if (a === 'reject' || a === 'suspend') { body.reason = prompt(a === 'reject' ? 'Reason (shown to the venue):' : 'Suspension reason (shown to the venue):'); if (!body.reason) return; }
    if (a === 'approve' && !confirm('Checked the KRA PIN, phone and map location?')) return;
    try { await api('POST', `/admin/venues/${id}/${a}`, body); toast('Done'); venues(); } catch (e) { toast(e.message); }
  }));
}

async function payments() {
  const d = await api('GET', '/admin/payments');
  const kes = (n) => 'KES ' + Number(n).toLocaleString('en-KE');
  const label = { paid: '✅ Paid', pending: '⏳ Pending', failed: '✕ Failed', expired: '⌛ Timed out', review: '⚠ Needs review', gift: '🎁 Gift' };
  panel.innerHTML = `
    <div class="tiles">
      <div class="tile hero"><span class="tile-label">Revenue this month</span><span class="tile-value">${kes(d.revenueThisMonth)}</span></div>
      <div class="tile"><span class="tile-label">All time</span><span class="tile-value">${kes(d.revenueAllTime)}</span></div>
      <div class="tile"><span class="tile-label">Featured bars · Plus members</span><span class="tile-value">${d.featuredNow} · ${d.plusNow}</span>
        <span class="tile-sub">This month: Featured ${kes(d.byKindThisMonth.featured)} · Plus ${kes(d.byKindThisMonth.plus)} · Boosts ${kes(d.byKindThisMonth.boosts)}</span></div>
      <div class="tile"><span class="tile-label">Needs review</span><span class="tile-value">${d.needsReview}</span><span class="tile-sub">amount mismatch / duplicate receipt</span></div>
    </div>
    ${d.mode !== 'daraja' ? `<div class="vstatus">M-Pesa mode: <b>${esc(d.mode)}</b>${d.mode === 'mock' ? ' — simulated payments, no money moves.' : ' — set MPESA_* to take payments.'}</div>` : ''}
    <table class="audit"><thead><tr><th>When</th><th>For</th><th>Item</th><th>Amount</th><th>Status</th><th>M-Pesa ref</th></tr></thead><tbody>
    ${d.payments.map((p) => `<tr><td>${when(p.createdAt)}<div class="muted small">@${esc(p.by)}</div></td><td>${p.venue ? '🍺 ' + esc(p.venue) : '👤 @' + esc(p.by)}</td><td>${esc(p.plan)}</td>
      <td>${p.amount ? kes(p.amount) : '—'}</td><td>${label[p.status] || esc(p.status)}${p.note ? `<div class="warn small">${esc(p.note)}</div>` : ''}${p.message ? `<div class="muted small">${esc(p.message)}</div>` : ''}</td>
      <td>${esc(p.receipt || '')}<div class="muted small">${esc(p.phone || '')}</div></td></tr>`).join('') || '<tr><td colspan="6" class="muted">No payments yet.</td></tr>'}</tbody></table>`;
}

const tabs = { selfies, venues, payments, reports, audit };
async function show(t) {
  document.querySelectorAll('#tabs-admin button').forEach((b) => b.classList.toggle('on', b.dataset.t === t));
  panel.innerHTML = '<p class="muted">Loading…</p>';
  try { await tabs[t](); }
  catch (e) {
    panel.innerHTML = `<div class="empty"><div class="big">🔒</div><p>${e.status === 401 ? 'Log in to the app first.' : esc(e.message)}</p>
      <p class="muted small">Admins are listed in the ADMIN_USERS setting and need a verified phone.</p><a class="btn" href="/">Open the app</a></div>`;
  }
}
document.querySelectorAll('#tabs-admin button').forEach((b) => (b.onclick = () => show(b.dataset.t)));
show('selfies');
