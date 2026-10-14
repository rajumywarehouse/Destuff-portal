/* CFS Destuffing Portal — shared core: helpers, Supabase client, sign-in, routing by role. */
'use strict';
const CFG = window.CFS_CONFIG || {};
const SLA_MIN = +CFG.SLA_MINUTES || 120;
const MODES = { manual: 'Manual', mechanical: 'Mechanical', combined: 'Manual + Mechanical' };
const ST = { awaiting: 'Awaiting arrival', queued: 'In queue', in_progress: 'Destuffing', completed: 'Completed' };
const ROLES = { superadmin: 'Superadmin', both: 'Operations + Supervisor', ops: 'Operations team', supervisor: 'Warehouse supervisor', readonly: 'Read only', customer: 'Customer', pending: 'Waiting for approval' };
const MONS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

/* ---------- helpers ---------- */
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const p2 = n => String(n).padStart(2, '0');
const isoDT = (Y, M, D, h = 0, m = 0) => `${Y}-${p2(M)}-${p2(D)}T${p2(h)}:${p2(m)}`;
function toDate(v) { if (v == null || v === '') return null; const d = new Date(v); return isNaN(d) ? null : d; }
function fmtDT(v) { const d = toDate(v); if (!d) return '—'; return `${p2(d.getDate())} ${MONS[d.getMonth()]} ${d.getFullYear()}, ${p2(d.getHours())}:${p2(d.getMinutes())}`; }
function fmtT(v) { const d = toDate(v); if (!d) return '—'; const t = `${p2(d.getHours())}:${p2(d.getMinutes())}`; return d.toDateString() === new Date().toDateString() ? t : `${p2(d.getDate())} ${MONS[d.getMonth()]}, ${t}`; }
function fmtD(s) { if (!s) return '—'; const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]} ${MONS[+m[2]-1]} ${m[1]}` : esc(s); }
function dur(ms) { ms = Math.max(0, ms || 0); const m = Math.floor(ms / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24); if (d) return `${d}d ${h % 24}h`; if (h) return `${h}h ${p2(m % 60)}m`; return `${m}m`; }
function clock(ms) { const s = Math.max(0, Math.floor(ms / 1000)); return `${p2(Math.floor(s / 3600))}:${p2(Math.floor(s / 60) % 60)}:${p2(s % 60)}`; }
const dayStart = (off = 0) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + off); return d.getTime(); };
const ms = v => { const d = toDate(v); return d ? d.getTime() : null; };
/* timestamptz <-> the "YYYY-MM-DDTHH:mm" local value used by datetime-local inputs */
function localInput(v) { const d = toDate(v); return d ? isoDT(d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()) : ''; }
function toISO(local) { const d = toDate(local); return d ? d.toISOString() : null; }
function fsize(b) { if (b == null) return ''; return b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB'; }

const MONIDX = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 };
/* Excel serials and day-first text dates → "YYYY-MM-DDTHH:mm"; "" for blank; null if unreadable */
function parseDT(v) {
  if (v == null || v === '') return '';
  if (v instanceof Date && !isNaN(v)) return isoDT(v.getFullYear(), v.getMonth() + 1, v.getDate(), v.getHours(), v.getMinutes());
  if (typeof v === 'number') { if (v < 1) return null; const d = new Date(Math.round((v - 25569) * 864e5)); return isoDT(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes()); }
  let s = String(v).trim(); if (!s) return '';
  if (/^\d+(\.\d+)?$/.test(s) && +s > 20000 && +s < 80000) return parseDT(+s);
  let h = 0, mi = 0; const tm = s.match(/(\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?\s*([ap])?\.?\s*m?\.?\s*$/i);
  if (tm) { h = +tm[1]; mi = +tm[2]; const ap = (tm[3] || '').toLowerCase(); if (ap === 'p' && h < 12) h += 12; if (ap === 'a' && h === 12) h = 0; s = s.slice(0, tm.index).replace(/[T,\s]+$/, '').trim(); }
  let Y, M, D, m;
  if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/))) [Y, M, D] = [+m[1], +m[2], +m[3]];
  else if ((m = s.match(/^(\d{1,2})[-/. ](\d{1,2})[-/. ](\d{2,4})$/))) [D, M, Y] = [+m[1], +m[2], +m[3]];
  else if ((m = s.match(/^(\d{1,2})[-/. ]([A-Za-z]{3})[A-Za-z]*[-/., ]+(\d{2,4})$/))) [D, M, Y] = [+m[1], MONIDX[m[2].toLowerCase()], +m[3]];
  else return null;
  if (Y < 100) Y += 2000; if (!M || M > 12 || !D || D > 31 || h > 23 || mi > 59) return null;
  return isoDT(Y, M, D, h, mi);
}
/* ISO 6346 container check digit */
const ISO_MAP = (() => { const m = {}; let v = 10; for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') { if (v % 11 === 0) v++; m[ch] = v++; } return m; })();
function checkDigit(s10) { let sum = 0; for (let i = 0; i < 10; i++) sum += (i < 4 ? ISO_MAP[s10[i]] : +s10[i]) * 2 ** i; return sum % 11 % 10; }
function iso6346(no) { const s = String(no || '').toUpperCase(); if (!/^[A-Z]{3}[UJZR]\d{7}$/.test(s)) return 'format'; return checkDigit(s.slice(0, 10)) === +s[10] ? 'ok' : 'check'; }
function cnoHtml(n) { n = String(n || ''); if (iso6346(n) === 'ok') return `${esc(n.slice(0, 10))}<span class="cd">${esc(n[10])}</span>`; return esc(n) || '—'; }
const pill = st => `<span class="pill st-${esc(st)}">${ST[st] || esc(st)}</span>`;

function toast(msg, kind) {
  const t = document.createElement('div'); t.className = 'toast ' + (kind || ''); t.textContent = msg;
  $('#toasts').appendChild(t); setTimeout(() => t.remove(), kind === 'bad' ? 7000 : 4000);
}
function errMsg(e) {
  if (!e) return 'Something went wrong. Try again.';
  if (e.code === '23505') return 'That container number already exists in active inventory.';
  if (e.code === '23503') return 'That customer code does not exist. Add it under Users & customers first.';
  if (e.code === '42501' || /row-level security/i.test(e.message || '')) return 'Your access level does not allow this change.';
  if (e.code === '23514') return 'One of the values is not allowed: ' + (e.message || '');
  return e.message || String(e);
}
/* Supabase returns {data, error}; turn errors into exceptions */
async function must(p) { const r = await p; if (r.error) throw r.error; return r.data; }
function saveBlob(name, blob) {
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
function saveWorkbook(name, wb) {
  if (!window.XLSX) { toast('The spreadsheet tool is still loading. Try again in a moment.', 'bad'); return; }
  XLSX.writeFile(wb, name);
}
const brandSvg = '<svg width="34" height="26" viewBox="0 0 34 26" aria-hidden="true"><rect x="1" y="3" width="32" height="20" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M7 7v12M12 7v12M17 7v12M22 7v12M27 7v12" stroke="currentColor" stroke-width="1.6" opacity=".55"/><rect x="1" y="3" width="32" height="4" fill="currentColor" opacity=".15"/></svg>';
const lockIcon = '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><rect x="2" y="5.5" width="8" height="5.5" rx="1" fill="currentColor"/><path d="M4 5.5V4a2 2 0 0 1 4 0v1.5" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>';
const clipIcon = '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M8.5 3.5 4.3 7.7a1 1 0 0 0 1.4 1.4l4.5-4.5a2 2 0 0 0-2.8-2.8L2.8 6.3a3 3 0 0 0 4.2 4.2L10.5 7" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>';
function meChip(p) {
  const n = p.full_name || p.email || 'You', ini = n.split(/\s+/).map(x => x[0]).join('').slice(0, 2).toUpperCase();
  return `<span class="me"><span class="av">${esc(ini)}</span><span class="nm" title="${esc(p.email || '')}">${esc(n)}</span></span><button class="btn sm" data-act="signout">Sign out</button>`;
}
/* live clocks shared by both portals */
function tick() {
  const n = Date.now();
  document.querySelectorAll('[data-since]').forEach(el => { const v = n - (+el.dataset.since); el.textContent = el.dataset.fmt === 'clock' ? clock(v) : dur(v); });
  document.querySelectorAll('[data-sla]').forEach(el => { el.style.width = Math.min(100, (n - (+el.dataset.sla)) / (SLA_MIN * 6e4) * 100) + '%'; });
  document.querySelectorAll('[data-run]').forEach(el => el.classList.toggle('over', n - (+el.dataset.run) > SLA_MIN * 6e4));
  const h = $('#hclock'); if (h) { const d = new Date(); h.textContent = `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`; }
}
setInterval(tick, 1000);

/* ---------- Supabase + sign-in ---------- */
const configured = CFG.SUPABASE_URL && !/YOUR-PROJECT/.test(CFG.SUPABASE_URL) && CFG.SUPABASE_ANON_KEY && !/YOUR-ANON/.test(CFG.SUPABASE_ANON_KEY);
const sb = configured && window.supabase ? window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY) : null;
const APP = { session: null, profile: null, mode: null, authTab: 'in', authMsg: null, recovering: false };
document.title = CFG.COMPANY_NAME || 'CFS Destuffing Portal';

function vSetup() {
  return `<div class="setup panel"><h2>Finish setup</h2>
    <p>This portal is not connected to its database yet. Open <code>assets/config.js</code> and fill in <code>SUPABASE_URL</code> and <code>SUPABASE_ANON_KEY</code> from Supabase → Project Settings → API, then redeploy.</p>
    <p class="muted">See README.md, steps 1 to 4.</p></div>`;
}
function vAuth() {
  const t = APP.recovering ? 'reset' : APP.authTab, msg = APP.authMsg;
  const brand = `<div class="brand">${brandSvg}<div><h1>${esc(CFG.COMPANY_NAME || 'CFS Destuffing Portal')}</h1><p>Container destuffing status for staff and customers</p></div></div>`;
  let body;
  if (t === 'reset') body = `<form data-auth="newpass"><label>New password<input id="a-pass" name="password" type="password" minlength="8" autocomplete="new-password" required></label><button class="btn primary" type="submit">Set new password</button></form>`;
  else if (t === 'forgot') body = `<form data-auth="forgot"><label>Email<input id="a-email" name="email" type="email" autocomplete="email" required></label><button class="btn primary" type="submit">Email me a reset link</button><button type="button" class="linkbtn" data-auth-tab="in">Back to sign in</button></form>`;
  else body = `<div class="auth-tabs" role="tablist"><button type="button" data-auth-tab="in" ${t === 'in' ? 'aria-current="page"' : ''}>Sign in</button><button type="button" data-auth-tab="up" ${t === 'up' ? 'aria-current="page"' : ''}>Create account</button></div>
    ${t === 'up'
      ? `<form data-auth="up"><label>Full name<input id="a-name" name="full_name" autocomplete="name" required></label><label>Company (customers)<input id="a-company" name="company" autocomplete="organization" placeholder="Optional"></label><label>Email<input id="a-email" name="email" type="email" autocomplete="email" required></label><label>Password<input id="a-pass" name="password" type="password" minlength="8" autocomplete="new-password" required></label><button class="btn primary" type="submit">Create account</button><p class="hint">New accounts are approved by the CFS team before they can see any data.</p></form>`
      : `<form data-auth="in"><label>Email<input id="a-email" name="email" type="email" autocomplete="email" required></label><label>Password<input id="a-pass" name="password" type="password" autocomplete="current-password" required></label><button class="btn primary" type="submit">Sign in</button><button type="button" class="linkbtn" data-auth-tab="forgot">Forgot password?</button></form>`}`;
  return `<div class="auth"><div class="auth-card">${brand}${msg ? `<div class="note ${msg.kind === 'ok' ? 'ok' : ''}">${esc(msg.text)}</div>` : ''}${body}</div></div>`;
}
function vPending() {
  const p = APP.profile;
  return `<div class="auth"><div class="auth-card"><div class="brand">${brandSvg}<div><h1>${esc(CFG.COMPANY_NAME || 'CFS Destuffing Portal')}</h1></div></div>
    <div class="note info">Your account <b>${esc(p?.email || '')}</b> is waiting for approval. The CFS team will give you access as staff or link it to your company as a customer. Sign in again once they confirm.</div>
    <div class="actions"><button class="btn" data-act="recheck">Check again</button><button class="btn ghost" data-act="signout">Sign out</button></div></div></div>`;
}
function showFrame(html) { document.body.dataset.view = 'frame'; $('#app').innerHTML = html; }

async function loadProfile() {
  const uid = APP.session?.user?.id; if (!uid) return null;
  const { data, error } = await sb.from('profiles').select('*').eq('id', uid).maybeSingle();
  if (error) { toast(errMsg(error), 'bad'); return null; }
  return data;
}
async function route() {
  if (!sb) { showFrame(vSetup()); return; }
  if (APP.recovering || !APP.session) { stopAll(); showFrame(vAuth()); return; }
  APP.profile = await loadProfile();
  const role = APP.profile?.role || 'pending';
  if (role === 'pending' || (role === 'customer' && !APP.profile.customer_code)) { stopAll(); showFrame(vPending()); return; }
  const mode = role === 'customer' ? 'customer' : 'staff';
  if (APP.mode !== mode) { stopAll(); APP.mode = mode; }
  document.body.dataset.view = mode;
  if (mode === 'customer') CustomerApp.start(APP.profile); else StaffApp.start(APP.profile);
}
function stopAll() { APP.mode = null; try { StaffApp.stop(); } catch (e) {} try { CustomerApp.stop(); } catch (e) {} }

document.addEventListener('click', async e => {
  const b = e.target.closest('[data-auth-tab],[data-act="signout"],[data-act="recheck"]'); if (!b) return;
  if (b.dataset.authTab) { APP.authTab = b.dataset.authTab; APP.authMsg = null; showFrame(vAuth()); return; }
  if (b.dataset.act === 'signout') { await sb.auth.signOut(); return; }
  if (b.dataset.act === 'recheck') route();
});
document.addEventListener('submit', async e => {
  const f = e.target.closest('form[data-auth]'); if (!f) return; e.preventDefault();
  const fd = Object.fromEntries(new FormData(f)), btn = f.querySelector('button[type=submit]'); btn.disabled = true;
  try {
    if (f.dataset.auth === 'in') {
      const { error } = await sb.auth.signInWithPassword({ email: fd.email.trim(), password: fd.password });
      if (error) throw error;
    } else if (f.dataset.auth === 'up') {
      const name = fd.full_name.trim() + (fd.company?.trim() ? ` (${fd.company.trim()})` : '');
      const { data, error } = await sb.auth.signUp({ email: fd.email.trim(), password: fd.password, options: { data: { full_name: name }, emailRedirectTo: location.origin + location.pathname } });
      if (error) throw error;
      if (!data.session) { APP.authTab = 'in'; APP.authMsg = { kind: 'ok', text: 'Account created. Open the confirmation link we emailed you, then sign in.' }; showFrame(vAuth()); }
    } else if (f.dataset.auth === 'forgot') {
      const { error } = await sb.auth.resetPasswordForEmail(fd.email.trim(), { redirectTo: location.origin + location.pathname });
      if (error) throw error;
      APP.authTab = 'in'; APP.authMsg = { kind: 'ok', text: 'If that email has an account, a reset link is on its way.' }; showFrame(vAuth());
    } else if (f.dataset.auth === 'newpass') {
      const { error } = await sb.auth.updateUser({ password: fd.password });
      if (error) throw error;
      APP.recovering = false; toast('Password updated.', 'ok'); route();
    }
  } catch (err) {
    APP.authMsg = { kind: 'bad', text: /Invalid login/i.test(err.message) ? 'Email or password is wrong.' : errMsg(err) };
    showFrame(vAuth());
  } finally { btn.disabled = false; }
});

if (sb) {
  let lastUid;
  sb.auth.onAuthStateChange((event, session) => {
    APP.session = session;
    if (event === 'PASSWORD_RECOVERY') APP.recovering = true;
    const uid = session?.user?.id || null;
    if (event === 'TOKEN_REFRESHED' && uid === lastUid) return;
    if (event === 'SIGNED_IN' && uid === lastUid && APP.mode) return;   // tab refocus
    lastUid = uid;
    setTimeout(route);
  });
} else route();
