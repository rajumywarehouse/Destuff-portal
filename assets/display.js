/* CFS Destuffing Portal — warehouse display screen (role "portal"; staff can open it with #display).
   Shows the live destuffing jobs and the overall job queue with no customer information,
   plus a "check your container" box. Data comes only from display_board() / display_lookup(). */
'use strict';
const DisplayApp = (() => {
let D = null, timer = null, clearTimer = null;
const REFRESH_MS = 15000, LOOKUP_CLEAR_MS = 90000, MAX_QUEUE = 18;

function fresh(profile) { D = { me: profile, run: [], queue: [], total: 0, loaded: false, err: '', updatedAt: null, q: '', result: null, busy: false }; }
async function load() {
  if (!D) return;
  try {
    const rows = await must(sb.rpc('display_board'));
    D.run = rows.filter(r => r.kind === 'running').map(r => ({ ...r, started: ms(r.started_at) })).sort((a, b) => a.started - b.started);
    D.queue = rows.filter(r => r.kind === 'queued').sort((a, b) => a.pos - b.pos);
    D.total = D.queue.length; D.loaded = true; D.err = ''; D.updatedAt = Date.now();
  } catch (e) { D.err = errMsg(e); }
  render();
}
function render() {
  if (!D || document.body.dataset.view !== 'display') return;
  const ae = document.activeElement, fid = ae && ae.id;
  $('#app').innerHTML = `<div class="disp">
    <header class="disp-top"><div class="brand">${brandSvg}<div><h1>${esc(CFG.COMPANY_NAME || 'CFS Destuffing Portal')}</h1><p>Import LCL job queue and destuffing status</p></div></div>
      <div class="hdr-right"><span class="disp-clock" id="hclock"></span>${themeBtn()}<button class="btn sm ghost" data-dact="fs">Full screen</button>${D.me.role === 'portal' ? '<button class="btn sm ghost" data-act="signout">Sign out</button>' : '<a class="btn sm ghost" href="#">Back to portal</a>'}</div></header>
    <form class="disp-look" data-dform="look"><label for="d-q">Check your container</label>
      <div class="disp-look-row"><input id="d-q" name="q" value="${esc(D.q)}" placeholder="Enter full container number, e.g. MSCU1234566" autocomplete="off" autocapitalize="characters" spellcheck="false" required minlength="4"><button class="btn primary" type="submit" ${D.busy ? 'disabled' : ''}>Check</button></div>
      ${D.result ? vResult() : ''}</form>
    ${!D.loaded ? `<div class="skel">${D.err ? esc(D.err) : 'Loading…'}</div>` : `<div class="disp-grid">
      <section class="disp-panel"><h2>Destuffing now <span class="disp-count">${D.run.length}</span></h2>
        ${D.run.length ? `<div class="disp-runs">${D.run.map(r => `<article class="disp-run" data-run="${r.started}">
          <div class="disp-cno">${cnoHtml(r.container_no)}</div>
          <div class="disp-clockbig" data-since="${r.started}" data-fmt="clock">${clock(Date.now() - r.started)}</div>
          <dl class="disp-kv"><div><dt>Size</dt><dd>${esc(r.size || '—')}</dd></div><div><dt>Mode</dt><dd>${esc(MODES[r.mode] || '—')}</dd></div><div><dt>Dock</dt><dd>${esc(r.bay || '—')}</dd></div><div><dt>Started</dt><dd>${fmtT(r.started)}</dd></div></dl>
        </article>`).join('')}</div>` : '<div class="empty"><b>No container is being destuffed right now.</b></div>'}
      </section>
      <section class="disp-panel"><h2>Job queue <span class="disp-count">${D.total}</span></h2>
        ${D.queue.length ? `<ol class="disp-queue">${D.queue.slice(0, MAX_QUEUE).map(r => `<li class="${r.pos === 1 ? 'next' : ''}"><span class="disp-pos">${r.pos}</span><span class="disp-cno sm">${cnoHtml(r.container_no)}</span><span class="pill st-mode">${esc(r.size || '—')}</span>${r.pos === 1 ? '<span class="pill st-queued">Next</span>' : ''}</li>`).join('')}</ol>${D.queue.length > MAX_QUEUE ? `<p class="hint">+ ${D.queue.length - MAX_QUEUE} more in the queue</p>` : ''}` : '<div class="empty"><b>The queue is empty.</b></div>'}
      </section></div>
      <p class="updated" style="text-align:center">${D.err ? `<span class="iss bad">${esc(D.err)}</span>` : `Updated ${fmtT(D.updatedAt)} · refreshes every ${REFRESH_MS / 1000} seconds`}</p>`}
  </div>`;
  if (fid) { const el = document.getElementById(fid); if (el) el.focus({ preventScroll: true }); }
  tick();
}
function vResult() {
  const r = D.result;
  if (r.none) return `<div class="note">No container found for <b class="mono">${esc(r.q)}</b>. Check the full number (4 letters + 7 digits) or ask the CFS office. <button type="button" class="btn sm ghost" data-dact="clear">Clear</button></div>`;
  const disp = r.on_hold && (r.status === 'queued' || r.status === 'awaiting') ? 'hold' : r.status;
  const line = disp === 'hold' ? 'On hold. Please contact the CFS office.'
    : r.status === 'awaiting' ? 'Not yet arrived at the CFS.'
    : r.status === 'queued' ? `Waiting for destuffing: position ${r.queue_position} of ${r.queue_total} in the job queue.`
    : r.status === 'in_progress' ? `Destuffing started on ${fmtDT(r.started_at)}.`
    : `Destuffing completed on ${fmtDT(r.completed_at)}.`;
  return `<div class="disp-result ${esc(disp)}"><div class="q-line"><span class="disp-cno sm">${cnoHtml(r.container_no)}</span><span class="pill st-mode">${esc(r.size || '—')}</span>${pill(disp)}</div>
    <p class="disp-line">${esc(line)}</p>
    <dl class="disp-kv"><div><dt>Arrived at CFS</dt><dd>${r.cfs_arrival ? fmtDT(r.cfs_arrival) : 'Not yet'}</dd></div><div><dt>Destuffing started</dt><dd>${r.started_at ? fmtDT(r.started_at) : '—'}</dd></div><div><dt>Destuffing completed</dt><dd>${r.completed_at ? fmtDT(r.completed_at) : '—'}</dd></div></dl>
    <button type="button" class="btn sm ghost" data-dact="clear">Clear</button></div>`;
}
async function lookup(q) {
  q = String(q || '').toUpperCase().replace(/[\s-]/g, ''); D.q = q; if (q.length < 4) return;
  D.busy = true; render();
  try { const rows = await must(sb.rpc('display_lookup', { p_no: q })); D.result = rows[0] || { none: true, q }; }
  catch (e) { D.result = null; toast(errMsg(e), 'bad'); }
  finally { D.busy = false; render(); clearTimeout(clearTimer); clearTimer = setTimeout(() => { if (D) { D.result = null; D.q = ''; render(); } }, LOOKUP_CLEAR_MS); }
}
const active = () => D && document.body.dataset.view === 'display';
document.addEventListener('submit', e => { if (!active()) return; const f = e.target.closest('form[data-dform="look"]'); if (!f) return; e.preventDefault(); lookup(new FormData(f).get('q')); });
document.addEventListener('input', e => { if (active() && e.target.id === 'd-q') D.q = e.target.value; });
document.addEventListener('click', async e => {
  if (!active()) return; const b = e.target.closest('[data-dact]'); if (!b) return;
  if (b.dataset.dact === 'clear') { D.result = null; D.q = ''; render(); $('#d-q')?.focus(); }
  if (b.dataset.dact === 'fs') { try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); } catch (err) { toast('Full screen is not available in this browser. Press F11 instead.', 'bad'); } }
});
document.addEventListener('visibilitychange', () => { if (active() && !document.hidden) load(); });

return {
  start(profile) {
    if (D && D.me.id === profile.id) { D.me = profile; render(); return; }
    fresh(profile); render(); load();
    clearInterval(timer); timer = setInterval(() => { if (active() && !document.hidden) load(); }, REFRESH_MS);
  },
  stop() { clearInterval(timer); clearTimeout(clearTimer); timer = null; D = null; },
};
})();
