/* CFS Destuffing Portal — customer view: only the signed-in customer's own containers. */
'use strict';
const CustomerApp = (() => {
let C = null, timer = null;
const REFRESH_MS = 30000;

function fresh(profile) {
  C = { me: profile, rows: [], loaded: false, updatedAt: null, err: '', company: '', q: '', st: new Set(), days: 30, sheet: null, files: [], fileErr: '', viewer: null, thumbs: {} };
}
async function load() {
  if (!C) return;
  try {
    const rows = await must(sb.rpc('customer_containers', { p_days: C.days }));
    const ORD = { in_progress: 0, queued: 1, awaiting: 2, completed: 3 };
    C.rows = rows.map(r => ({ ...r, arr: ms(r.cfs_arrival), started: ms(r.started_at), completed: ms(r.completed_at), duration_ms: r.duration_ms == null ? null : +r.duration_ms }))
      .sort((a, b) => ORD[a.status] - ORD[b.status] || (a.queue_position ?? 1e9) - (b.queue_position ?? 1e9) || (b.completed || 0) - (a.completed || 0) || (a.started || 0) - (b.started || 0));
    C.loaded = true; C.updatedAt = Date.now(); C.err = '';
    if (!C.company) { const c = await must(sb.from('customers').select('name').eq('code', C.me.customer_code).maybeSingle()); C.company = c?.name || C.me.customer_code; }
  } catch (e) { C.err = errMsg(e); }
  render();
}
function render() {
  if (!C || document.body.dataset.view !== 'customer') return;
  const ae = document.activeElement, fid = ae && ae.id; let sel = null; try { if (ae && ae.selectionStart != null) sel = [ae.selectionStart, ae.selectionEnd]; } catch (e) {}
  $('#app').innerHTML = `<header class="top"><div class="top-in"><div class="brand">${brandSvg}<div><h1>${esc(CFG.COMPANY_NAME || 'CFS Destuffing Portal')}</h1><p>Container status for ${esc(C.company || C.me.customer_code)}</p></div></div><div class="hdr-right"><span class="hdr-clock" id="hclock"></span>${meChip(C.me)}</div></div></header>
    <main id="main">${C.loaded ? vMain() : `<div class="skel">${C.err ? esc(C.err) : 'Loading your containers…'}</div>`}</main>${vSheet()}`;
  document.body.style.overflow = C.sheet ? 'hidden' : '';
  if (fid) { const el = document.getElementById(fid); if (el) { el.focus({ preventScroll: true }); try { if (sel) el.setSelectionRange(sel[0], sel[1]); } catch (e) {} } }
  tick();
}
function filtered() {
  const q = C.q.trim().toLowerCase();
  return C.rows.filter(r => (!C.st.size || C.st.has(r.status)) && (!q || [r.container_no, r.vessel, r.igm_no, r.item, r.consol, r.liner].some(x => String(x || '').toLowerCase().includes(q))));
}
function vMain() {
  const cnt = { awaiting: 0, queued: 0, in_progress: 0, completed: 0 }; C.rows.forEach(r => cnt[r.status]++);
  const list = filtered();
  const step = (k, cls, lbl, sub) => `<button class="step ${cls}" data-cact="st" data-st="${k}" aria-pressed="${C.st.has(k)}" style="${C.st.has(k) ? 'background:var(--surface-2)' : ''}"><span class="lbl">${lbl}</span><b>${cnt[k]}</b><small>${sub}</small></button>`;
  return `
  <section class="pipe" aria-label="Your containers by status">
    ${step('awaiting', 's1', 'Awaiting arrival', 'Not yet at the CFS')}
    ${step('queued', 's2', 'In queue', 'Waiting for destuffing')}
    ${step('in_progress', 's3', 'Destuffing now', 'Being unloaded')}
    ${step('completed', 's4', 'Completed', `Last ${C.days} days`)}
  </section>
  <section class="panel">
    <div class="sec-head"><div><h2>Your containers</h2><p>Destuffing runs strictly first-in, first-out by CFS arrival time. Queue positions update as containers ahead of yours are completed.</p></div>
      <div class="actions"><span class="updated">${C.err ? `<span class="iss bad">${esc(C.err)}</span>` : `Updated ${fmtT(C.updatedAt)}`}</span><button class="btn sm" data-cact="refresh">Refresh</button></div></div>
    <div class="toolbar">
      <div class="grow"><input type="search" id="cq" placeholder="Search container, IGM, vessel, item…" value="${esc(C.q)}" aria-label="Search your containers"></div>
      <select id="cdays" aria-label="Completed containers to show">${[[7,'Completed: last 7 days'],[30,'Completed: last 30 days'],[90,'Completed: last 90 days'],[365,'Completed: last 12 months']].map(([d, l]) => `<option value="${d}" ${C.days === d ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <button class="btn" data-cact="export">Export to Excel</button>
    </div>
    ${C.st.size ? `<div class="factive"><span>Showing ${[...C.st].map(s => ST[s]).join(', ')}</span><button class="btn sm ghost" data-cact="st-clear">Show all</button></div>` : ''}
    ${list.length ? `<div class="cards">${list.map(card).join('')}</div>` : `<div class="empty"><b>${C.rows.length ? 'No containers match this view.' : 'No containers yet.'}</b><span>${C.rows.length ? 'Clear the search or status filter.' : 'Containers appear here as soon as the CFS team adds them to inventory under your account.'}</span></div>`}
  </section>`;
}
function card(r) {
  let head;
  if (r.status === 'queued') head = `<b>Position ${r.queue_position ?? '—'}</b><span>of ${r.queue_total ?? '—'} in the destuffing queue · waiting <span data-since="${r.arr}">${dur(Date.now() - r.arr)}</span></span>`;
  else if (r.status === 'in_progress') head = `<b data-since="${r.started}" data-fmt="clock">${clock(Date.now() - r.started)}</b><span>destuffing since ${fmtT(r.started)}${r.mode ? ' · ' + MODES[r.mode] : ''}</span>`;
  else if (r.status === 'completed') head = `<b>Done</b><span>completed ${fmtT(r.completed)} · took ${dur(r.duration_ms)}${r.packages != null ? ` · ${r.packages} packages` : ''}</span>`;
  else head = `<span>Not yet arrived at the CFS. It joins the destuffing queue when it is gated in.</span>`;
  return `<article class="ccard ${esc(r.status)}">
    <div class="ccard-top"><div class="q-line"><span class="cno">${cnoHtml(r.container_no)}</span><span class="pill st-mode">${esc(r.size || '—')}</span>${pill(r.status)}</div>
      ${r.files ? `<button type="button" class="clip has" data-cact="files" data-id="${esc(r.id)}">${clipIcon}${r.files} photo${r.files > 1 ? 's/files' : '/file'}</button>` : ''}</div>
    <div class="headline">${head}</div>
    <dl class="kv"><div><dt>Vessel</dt><dd>${esc(r.vessel || '—')}</dd></div><div><dt>Liner</dt><dd>${esc(r.liner || '—')}</dd></div><div><dt>IGM No.</dt><dd>${esc(r.igm_no || '—')}</dd></div>
      <div><dt>Item</dt><dd>${esc(r.item || '—')}</dd></div><div><dt>Consol</dt><dd>${esc(r.consol || '—')}</dd></div><div><dt>Port</dt><dd>${esc(r.port || '—')}</dd></div>
      <div><dt>PNR date</dt><dd>${fmtD(r.pnr_date)}</dd></div><div><dt>CFS arrival</dt><dd>${r.arr ? fmtDT(r.arr) : 'Not arrived'}</dd></div></dl>
  </article>`;
}
function vSheet() {
  if (!C.sheet) return ''; const r = C.rows.find(x => x.id === C.sheet); if (!r) return '';
  let body;
  if (C.viewer) body = `<div class="viewer"><img src="${esc(C.viewer.url)}" alt="${esc(C.viewer.name)}"><div class="actions"><button class="btn" data-cact="viewer-close">Back to all files</button><button class="btn" data-cact="dl" data-path="${esc(C.viewer.path)}" data-name="${esc(C.viewer.name)}">Download</button></div></div>`;
  else if (C.fileErr) body = `<div class="note">${esc(C.fileErr)}</div>`;
  else if (!C.files) body = '<div class="skel">Loading…</div>';
  else body = `<div class="tiles">${C.files.map(f => { const img = /^image\//.test(f.type);
    return `<div class="tile"><button type="button" class="th" data-cact="open" data-path="${esc(f.path)}" data-name="${esc(f.name)}" data-img="${img ? 1 : 0}" aria-label="Open ${esc(f.name)}">${img && f.thumb ? `<img src="${esc(f.thumb)}" alt="">` : esc((f.name.split('.').pop() || 'FILE').toUpperCase().slice(0, 5))}</button><div class="tb"><span class="nm" title="${esc(f.name)}">${esc(f.name)}</span><span class="muted">${fsize(f.size)} · ${fmtT(f.at)}</span></div></div>`; }).join('')}</div>`;
  return `<div class="sheet" id="csheet-bg"><div class="sheet-in" role="dialog" aria-modal="true" aria-labelledby="csheet-h"><div class="sheet-h"><div style="display:grid;gap:6px;min-width:0"><h2 id="csheet-h">Photos &amp; files</h2><div class="q-line"><span class="cno">${cnoHtml(r.container_no)}</span>${pill(r.status)}</div></div><button class="btn ghost" data-cact="close" id="csheet-close">Close</button></div>${body}</div></div>`;
}
async function openFiles(id) {
  C.sheet = id; C.files = null; C.fileErr = ''; C.viewer = null; render();
  try { C.files = await must(sb.rpc('customer_attachments', { p_container: id })); } catch (e) { C.fileErr = errMsg(e); }
  render(); $('#csheet-close')?.focus({ preventScroll: true });
}
async function signedUrl(path, name, download) { const { data, error } = await sb.storage.from('attachments').createSignedUrl(path, 600, download ? { download: name } : undefined); if (error) throw error; return data.signedUrl; }
function exportXlsx() {
  if (!window.XLSX) return saveWorkbook(); const list = filtered();
  if (!list.length) return toast('Nothing to export in this view.', 'bad');
  const aoa = [['Container No.','Size','Status','Queue position','Vessel','Liner','IGM No.','Item','Consol','Port','PNR Date','CFS Arrival','Destuffing started','Completed','Duration (min)','Packages']];
  list.forEach(r => aoa.push([r.container_no, r.size, ST[r.status], r.status === 'queued' ? `${r.queue_position} of ${r.queue_total}` : '', r.vessel, r.liner, r.igm_no, r.item, r.consol, r.port, r.pnr_date ? fmtD(r.pnr_date) : '', r.arr ? fmtDT(r.arr) : '', r.started ? fmtDT(r.started) : '', r.completed ? fmtDT(r.completed) : '', r.duration_ms ? Math.round(r.duration_ms / 6e4) : '', r.packages ?? '']));
  const wb = XLSX.utils.book_new(), ws = XLSX.utils.aoa_to_sheet(aoa); ws['!cols'] = aoa[0].map(() => ({ wch: 18 })); XLSX.utils.book_append_sheet(wb, ws, 'Containers');
  const d = new Date(); saveWorkbook(`Containers_${C.me.customer_code}_${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}.xlsx`, wb);
}

const active = () => C && document.body.dataset.view === 'customer';
document.addEventListener('click', async e => {
  if (!active()) return;
  if (e.target.id === 'csheet-bg') { C.sheet = null; C.viewer = null; render(); return; }
  const b = e.target.closest('[data-cact]'); if (!b) return;
  const a = b.dataset.cact;
  try {
    if (a === 'refresh') load();
    else if (a === 'export') exportXlsx();
    else if (a === 'st') { const s = b.dataset.st; C.st.has(s) ? C.st.delete(s) : C.st.add(s); render(); }
    else if (a === 'st-clear') { C.st.clear(); render(); }
    else if (a === 'files') openFiles(b.dataset.id);
    else if (a === 'close') { C.sheet = null; C.viewer = null; render(); }
    else if (a === 'viewer-close') { C.viewer = null; render(); }
    else if (a === 'open') { if (b.dataset.img === '1') { C.viewer = { url: await signedUrl(b.dataset.path, b.dataset.name), path: b.dataset.path, name: b.dataset.name }; render(); } else location.href = await signedUrl(b.dataset.path, b.dataset.name, true); }
    else if (a === 'dl') location.href = await signedUrl(b.dataset.path, b.dataset.name, true);
  } catch (err) { toast(errMsg(err), 'bad'); }
});
document.addEventListener('input', e => { if (active() && e.target.id === 'cq') { C.q = e.target.value; render(); } });
document.addEventListener('change', e => { if (active() && e.target.id === 'cdays') { C.days = +e.target.value; load(); } });
document.addEventListener('keydown', e => { if (active() && e.key === 'Escape' && C.sheet) { if (C.viewer) C.viewer = null; else C.sheet = null; render(); } });
document.addEventListener('visibilitychange', () => { if (active() && !document.hidden) load(); });

return {
  start(profile) {
    if (C && C.me.id === profile.id) { C.me = profile; render(); return; }
    fresh(profile); render(); load();
    clearInterval(timer); timer = setInterval(() => { if (active() && !document.hidden) load(); }, REFRESH_MS);
  },
  stop() { clearInterval(timer); timer = null; C = null; },
};
})();
