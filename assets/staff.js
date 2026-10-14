/* CFS Destuffing Portal — staff portal (operations, supervisors, superadmin). */
'use strict';
const StaffApp = (() => {
const COLS = [
  { k: 'containerNo', db: 'container_no', label: 'Container No.', short: 'Container No.', w: 150, mono: true },
  { k: 'size', db: 'size', label: 'Container Size', short: 'Size', w: 72, list: 'sizes' },
  { k: 'customer', db: 'customer_code', label: 'Customer Code', short: 'Customer', w: 110, list: 'custlist', mono: true },
  { k: 'consol', db: 'consol', label: 'Consol', short: 'Consol', w: 130 },
  { k: 'vessel', db: 'vessel', label: 'Vessel Name', short: 'Vessel', w: 160 },
  { k: 'liner', db: 'liner', label: 'Liner', short: 'Liner', w: 120 },
  { k: 'port', db: 'port', label: 'Port', short: 'Port', w: 100 },
  { k: 'pnrDate', db: 'pnr_date', label: 'PNR Date', short: 'PNR Date', w: 140, type: 'date' },
  { k: 'igmNo', db: 'igm_no', label: 'IGM No.', short: 'IGM No.', w: 110, mono: true },
  { k: 'item', db: 'item', label: 'Item', short: 'Item', w: 170 },
  { k: 'cfsArrival', db: 'cfs_arrival', label: 'CFS Arrival Date & Time', short: 'CFS Arrival', w: 200, type: 'datetime-local' },
];
const STORD = { in_progress: 0, queued: 1, awaiting: 2, completed: 3 };
const ACTIVE_ST = () => new Set(['awaiting', 'queued', 'in_progress']);
const FFIELDS = [['status','Status'],['customer','Customer'],['liner','Liner'],['vessel','Vessel'],['consol','Consol'],['port','Port'],['size','Size'],['item','Item']];
const ALIASES = [['pnrDate',/pnr/i],['igmNo',/igm/i],['cfsArrival',/arriv|gate.?in|cfs/i],['size',/size|type|teu/i],['customer',/customer|importer|client|\bcha\b/i],['containerNo',/container|cntr|ctr|box/i],['consol',/consol/i],['vessel',/vessel|ship|voy/i],['liner',/liner|line|carrier/i],['port',/port|pod/i],['item',/item|cargo|commodity|desc/i]];

let S;
function fresh(profile) {
  S = { me: profile, uid: profile.id, live: false, loaded: false, ch: null, viewAs: null,
    containers: new Map(), overrides: new Map(), profiles: new Map(), customers: new Map(), audit: [],
    atts: new Map(), attCount: new Map(), thumbs: {}, doneAll: null,
    tab: 'dash', edits: {}, newRows: [], nseq: 0, q: '', confirmDel: null, open: null, form: {},
    doneRange: 'today', busy: false, gridKeys: [], runAll: false, f: null, dd: null, ddq: '',
    attFor: null, attBusy: '', attDel: null, viewer: null };
  resetFilters();
}
function resetFilters() { S.f = { status: ACTIVE_ST(), customer: new Set(), liner: new Set(), vessel: new Set(), consol: new Set(), port: new Set(), size: new Set(), item: new Set(), arrFrom: '', arrTo: '', pnrFrom: '', pnrTo: '', files: '', unsaved: false }; S.dd = null; S.ddq = ''; }

/* ---------- roles ---------- */
function role() { return S.viewAs || S.me.role; }
const can = { inv: () => ['superadmin','ops','both'].includes(role()), sup: () => ['superadmin','supervisor','both'].includes(role()), admin: () => role() === 'superadmin' };
const canAttach = () => ['superadmin','both','ops','supervisor'].includes(role());
const canDelAtt = a => canAttach() && (a.by === S.uid || can.admin() || can.inv());
function who(uid) { if (!uid) return '—'; const p = S.profiles.get(uid); const n = p ? (p.full_name || p.email) : 'Team member'; return esc(uid === S.uid ? `${n} (you)` : n); }

/* ---------- row mapping ---------- */
function fromRow(r) {
  return { id: r.id, containerNo: r.container_no || '', size: r.size || '', customer: r.customer_code || '', consol: r.consol || '', vessel: r.vessel || '',
    liner: r.liner || '', port: r.port || '', pnrDate: r.pnr_date || '', igmNo: r.igm_no || '', item: r.item || '', cfsArrival: localInput(r.cfs_arrival),
    status: r.status, mode: r.mode, bay: r.bay, crew: r.crew, startRemarks: r.start_remarks, startedAt: ms(r.started_at), startedBy: r.started_by,
    queuePos: r.queue_pos, bypass: r.bypass, completedAt: ms(r.completed_at), durationMs: r.duration_ms == null ? null : +r.duration_ms, completedBy: r.completed_by,
    packages: r.packages, endRemarks: r.end_remarks, sample: r.sample, createdAt: ms(r.created_at), createdBy: r.created_by };
}
function toDbVal(k, v) { if (k === 'cfsArrival') return v ? toISO(v) : null; if (k === 'pnrDate') return v || null; if (k === 'customer') return v || null; return v ?? ''; }
const ovFrom = r => ({ id: r.container_id, at: ms(r.at), by: r.by, reason: r.reason });
function attFrom(r) { const a = { ...r, cid: r.container_id, at: ms(r.at) }; if (r.thumb) S.thumbs[r.id] = r.thumb; delete a.thumb; return a; }
const arrMs = c => ms(c.cfsArrival);

/* ---------- FIFO (mirror of the server's order; the server enforces it) ---------- */
function fifo() {
  return [...S.containers.values()].filter(c => c.status === 'queued').sort((a, b) => {
    const pa = S.overrides.get(a.id), pb = S.overrides.get(b.id);
    if (!!pa !== !!pb) return pa ? -1 : 1;
    if (pa && pb && pa.at !== pb.at) return pa.at - pb.at;
    return (arrMs(a) || 0) - (arrMs(b) || 0) || (a.createdAt || 0) - (b.createdAt || 0) || a.containerNo.localeCompare(b.containerNo);
  });
}
const running = () => [...S.containers.values()].filter(c => c.status === 'in_progress').sort((a, b) => a.startedAt - b.startedAt);

/* ---------- data ---------- */
async function fetchAll(build) { let out = [], from = 0; for (;;) { const d = await must(build().range(from, from + 999)); out = out.concat(d); if (d.length < 1000) break; from += 1000; } return out; }
async function loadAll() {
  try {
    const since = new Date(Date.now() - 31 * 864e5).toISOString();
    const [act, done, ov, pr, cu, au, at] = await Promise.all([
      fetchAll(() => sb.from('containers').select('*').neq('status', 'completed').order('created_at')),
      fetchAll(() => sb.from('containers').select('*').eq('status', 'completed').gte('completed_at', since).order('completed_at')),
      must(sb.from('overrides').select('*')),
      must(sb.from('profiles').select('*')),
      must(sb.from('customers').select('*').order('code')),
      must(sb.from('audit').select('*').order('at', { ascending: false }).limit(300)),
      fetchAll(() => sb.from('attachments').select('id,container_id,container_no,name,type,size,path,stage,customer_visible,by,at').order('at')),
    ]);
    S.containers = new Map([...act, ...done].map(r => [r.id, fromRow(r)]));
    S.overrides = new Map(ov.map(r => [r.container_id, ovFrom(r)]));
    S.profiles = new Map(pr.map(r => [r.id, r]));
    S.customers = new Map(cu.map(r => [r.code, r]));
    S.audit = au.map(r => ({ ...r, at: ms(r.at) }));
    S.atts = new Map(at.map(r => [r.id, attFrom(r)])); recount();
    S.loaded = true; S.doneAll = null; scheduleRender();
  } catch (e) { toast('Could not load data: ' + errMsg(e), 'bad'); }
}
function recount() { const m = new Map(); S.atts.forEach(a => m.set(a.cid, (m.get(a.cid) || 0) + 1)); S.attCount = m; }
function subscribe() {
  const on = (table, fn) => ({ table, fn });
  const handlers = [
    on('containers', p => { if (p.eventType === 'DELETE') S.containers.delete(p.old.id); else S.containers.set(p.new.id, fromRow(p.new)); }),
    on('overrides', p => { if (p.eventType === 'DELETE') S.overrides.delete(p.old.container_id); else S.overrides.set(p.new.container_id, ovFrom(p.new)); }),
    on('attachments', p => { if (p.eventType === 'DELETE') S.atts.delete(p.old.id); else S.atts.set(p.new.id, attFrom(p.new)); recount(); }),
    on('audit', p => { if (p.eventType === 'INSERT') S.audit = [{ ...p.new, at: ms(p.new.at) }, ...S.audit].slice(0, 300); }),
    on('customers', p => { if (p.eventType === 'DELETE') S.customers.delete(p.old.code); else S.customers.set(p.new.code, p.new); }),
    on('profiles', p => { if (p.eventType === 'DELETE') { S.profiles.delete(p.old.id); return; } S.profiles.set(p.new.id, p.new);
      if (p.new.id === S.uid && (p.new.role !== S.me.role || p.new.customer_code !== S.me.customer_code)) { S.me = p.new; route(); } }),
  ];
  let ch = sb.channel('cfs-staff');
  handlers.forEach(h => { ch = ch.on('postgres_changes', { event: '*', schema: 'public', table: h.table }, p => { h.fn(p); scheduleRender(); }); });
  S.ch = ch.subscribe(st => {
    if (st === 'SUBSCRIBED') { S.live = true; loadAll(); }
    else if (['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(st)) S.live = false;
    scheduleRender();
  });
}
async function log(action, c, detail) { try { await must(sb.from('audit').insert({ action, container_no: c?.containerNo || '', container_id: c?.id || null, detail: detail || '' })); } catch (e) {} }

/* ---------- sample data ---------- */
function genSample(now, uid) {
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647; const pick = a => a[Math.floor(rnd() * a.length)];
  const pre = ['MSCU','MAEU','CMAU','ONEU','HLXU','EGHU','TGHU','SEGU'];
  const cn = () => { const b = pick(pre) + String(Math.floor(rnd() * 1e6)).padStart(6, '0'); return b + checkDigit(b); };
  const vessels = ['MSC ARIANE V.FX241W','MAERSK KENSINGTON V.442E','CMA CGM VERDI V.0IN3RE','ONE HARMONY V.071W','EVER LUCID V.1129-018W'];
  const liners = ['MSC','Maersk','CMA CGM','ONE','Hapag-Lloyd','Evergreen'];
  const consols = ['Globelink','Shipco Transport','ECU Worldwide','CWT Globelink','Vanguard Logistics','Direct LCL'];
  const items = ['Auto components','Readymade garments','Machinery spares','Consumer electronics','Ceramic tiles','Pharma packaging','Textile machinery','Household goods'];
  const ports = ['INMAA','INMAA','INKAT','INENR'], custs = ['DEMO-A','DEMO-B'], modes = Object.keys(MODES), min = 6e4;
  const base = () => ({ container_no: cn(), size: pick(['20','40','40HC','20','40HC']), customer_code: pick(custs), consol: pick(consols), vessel: pick(vessels), liner: pick(liners),
    port: pick(ports), pnr_date: localInput(now - 864e5 * (1 + Math.floor(rnd() * 3))).slice(0, 10), igm_no: String(2300000 + Math.floor(rnd() * 99999)), item: pick(items), sample: true });
  const iso = t => new Date(t).toISOString(), rows = []; let t = 0;
  for (let i = 0; i < 6; i++) { const arr = now - (30 - i * 3.3) * 36e5, st = arr + (25 + rnd() * 90) * min, d = Math.round((55 + rnd() * 95) * min);
    rows.push({ ...base(), cfs_arrival: iso(arr), status: 'completed', mode: pick(modes), bay: 'Bay ' + (1 + Math.floor(rnd() * 6)), crew: 4 + Math.floor(rnd() * 6), started_at: iso(st), started_by: uid, completed_at: iso(st + d), duration_ms: d, completed_by: uid, queue_pos: 1, created_at: iso(now - 40 * 36e5 + (t++) * 1000) }); }
  [[9.2, 74, 'mechanical', 'Bay 2'], [8.1, 27, 'combined', 'Bay 4']].forEach(([h, m, mo, bay]) => rows.push({ ...base(), cfs_arrival: iso(now - h * 36e5), status: 'in_progress', mode: mo, bay, crew: 6, started_at: iso(now - m * min), started_by: uid, queue_pos: 1, created_at: iso(now - 40 * 36e5 + (t++) * 1000) }));
  [7.4, 6.6, 5.2, 4.9, 3.1, 2.4, 1.2, 0.4].forEach(h => rows.push({ ...base(), cfs_arrival: iso(now - h * 36e5), status: 'queued', created_at: iso(now - 40 * 36e5 + (t++) * 1000) }));
  for (let i = 0; i < 4; i++) rows.push({ ...base(), cfs_arrival: null, status: 'awaiting', created_at: iso(now - 40 * 36e5 + (t++) * 1000) });
  return rows;
}
async function loadSample() {
  if (!can.admin()) return;
  try {
    await must(sb.from('customers').upsert([{ code: 'DEMO-A', name: 'Demo Importer A' }, { code: 'DEMO-B', name: 'Demo Importer B' }], { onConflict: 'code', ignoreDuplicates: true }));
    const rows = genSample(Date.now(), S.uid); await must(sb.from('containers').insert(rows));
    await log('Sample data loaded', null, rows.length + ' example containers');
    toast('Loaded 20 example containers for customers DEMO-A and DEMO-B. Remove them with "Clear sample data".', 'ok');
  } catch (e) { toast(errMsg(e), 'bad'); }
}
async function clearSample() {
  if (!can.admin()) return; const list = [...S.containers.values()].filter(c => c.sample);
  try {
    const paths = [...S.atts.values()].filter(a => list.some(c => c.id === a.cid)).map(a => a.path);
    if (paths.length) await sb.storage.from('attachments').remove(paths);
    await must(sb.from('containers').delete().eq('sample', true));
    await log('Sample data cleared', null, list.length + ' example containers removed'); toast(`Removed ${list.length} example containers.`, 'ok');
  } catch (e) { toast(errMsg(e), 'bad'); }
}

/* ---------- rendering ---------- */
let rq = 0; function scheduleRender() { if (rq || !S) return; rq = requestAnimationFrame(() => { rq = 0; render(); }); }
function shell() {
  $('#app').innerHTML = `<header class="top"><div class="top-in"><div class="brand">${brandSvg}<div><h1>${esc(CFG.COMPANY_NAME || 'CFS Destuffing Portal')}</h1><p>Import inventory · FIFO job queue · live destuffing clock</p></div></div><div class="hdr-right" id="hdr-right"></div></div><nav class="tabs" id="tabs" aria-label="Sections"></nav></header>
  <main id="main"><div class="skel">Loading live data…</div></main>
  <datalist id="sizes"><option value="20"></option><option value="40"></option><option value="40HC"></option><option value="45"></option></datalist><datalist id="custlist"></datalist><div id="sheet"></div>`;
}
function render() {
  if (!S || !$('#main')) return;
  const ae = document.activeElement, fid = ae && ae.id; let sel = null; try { if (ae && ae.selectionStart != null) sel = [ae.selectionStart, ae.selectionEnd]; } catch (e) {}
  const gw = $('.grid-wrap'), gs = gw ? [gw.scrollLeft, gw.scrollTop] : null;
  $('#hdr-right').innerHTML = vHeader(); $('#tabs').innerHTML = vTabs();
  $('#custlist').innerHTML = [...S.customers.values()].map(c => `<option value="${esc(c.code)}">${esc(c.name)}</option>`).join('');
  if (!S.loaded) return;
  const v = { dash: vDash, inv: vInv, queue: vQueue, done: vDone, audit: vAudit, team: vTeam }[S.tab] || vDash;
  $('#main').innerHTML = v();
  $('#sheet').innerHTML = vSheet(); document.body.style.overflow = S.attFor ? 'hidden' : '';
  const ngw = $('.grid-wrap'); if (ngw && gs) { ngw.scrollLeft = gs[0]; ngw.scrollTop = gs[1]; }
  if (fid) { const el = document.getElementById(fid); if (el && el !== document.activeElement) { el.focus({ preventScroll: true }); try { if (sel) el.setSelectionRange(sel[0], sel[1]); } catch (e) {} } }
  tick();
}
function vHeader() {
  const sync = S.live ? '<span class="chip live"><span class="dot"></span>Live</span>' : '<span class="chip demo"><span class="dot"></span>Reconnecting</span>';
  const sel = S.me.role === 'superadmin'
    ? `<select id="viewas" aria-label="View the portal as">${['superadmin','both','ops','supervisor','readonly'].map(k => `<option value="${k === 'superadmin' ? '' : k}" ${(S.viewAs || '') === (k === 'superadmin' ? '' : k) ? 'selected' : ''}>${k === 'superadmin' ? 'Role: Superadmin' : 'Preview as: ' + ROLES[k]}</option>`).join('')}</select>`
    : `<span class="chip">${esc(ROLES[role()])}</span>`;
  return `${sync}${sel}<span class="hdr-clock" id="hclock"></span>${meChip(S.me)}`;
}
function vTabs() {
  const q = fifo().length, rn = running().length, pend = [...S.profiles.values()].filter(p => p.role === 'pending').length;
  const t = [['dash','Dashboard',rn ? `<span class="ct hot">${rn} live</span>` : ''],['inv','Inventory',''],['queue','Job queue',q ? `<span class="ct">${q}</span>` : ''],['done','Completed',''],['audit','Audit log','']];
  if (can.admin()) t.push(['team','Users & customers', pend ? `<span class="ct hot">${pend} new</span>` : '']);
  return t.map(([k, l, c]) => `<button class="tab" data-tab="${k}" ${S.tab === k ? 'aria-current="page"' : ''}>${l}${c}</button>`).join('');
}
function attBtn(c) { const n = S.attCount.get(c.id) || 0; return `<button type="button" class="clip ${n ? 'has' : ''}" data-act="att" data-id="${esc(c.id)}" aria-label="Photos and files for ${esc(c.containerNo)}: ${n}">${clipIcon}${n || (canAttach() ? 'Add' : '0')}</button>`; }
const custName = code => S.customers.get(code)?.name || code;

/* --- dashboard --- */
function vDash() {
  const all = [...S.containers.values()], cnt = { awaiting: 0, queued: 0, in_progress: 0, completed: 0 }; all.forEach(c => cnt[c.status] != null && cnt[c.status]++);
  const t0 = dayStart(), today = all.filter(c => c.status === 'completed' && c.completedAt >= t0);
  const startedToday = all.filter(c => c.startedAt >= t0 && c.cfsArrival);
  const avgD = today.length ? today.reduce((s, c) => s + c.durationMs, 0) / today.length : null;
  const avgW = startedToday.length ? startedToday.reduce((s, c) => s + (c.startedAt - arrMs(c)), 0) / startedToday.length : null;
  const q = fifo(), runs = running(), over = runs.filter(c => Date.now() - c.startedAt > SLA_MIN * 6e4).length;
  const modeCt = { manual: 0, mechanical: 0, combined: 0 }; [...today, ...runs].forEach(c => c.mode in modeCt && modeCt[c.mode]++); const mt = Object.values(modeCt).reduce((a, b) => a + b, 0);
  const headWait = q[0] && arrMs(q[0]) ? `<span data-since="${arrMs(q[0])}">${dur(Date.now() - arrMs(q[0]))}</span>` : '—';
  return `
  <section class="pipe" aria-label="Container flow">
    <button class="step s1" data-tab="inv" data-filter="awaiting"><span class="lbl">Awaiting arrival</span><b>${cnt.awaiting}</b><small>No CFS arrival time yet</small></button>
    <button class="step s2" data-tab="queue"><span class="lbl">In job queue</span><b>${cnt.queued}</b><small>Head has waited ${headWait}</small></button>
    <button class="step s3" data-tab="dash"><span class="lbl">Destuffing now</span><b>${cnt.in_progress}</b><small>Clock running</small></button>
    <button class="step s4" data-tab="done"><span class="lbl">Completed today</span><b>${today.length}</b><small>${cnt.completed} in the last 31 days</small></button>
  </section>
  <div class="cols">
    <section class="panel" aria-labelledby="h-run">
      <div class="sec-head"><div><h2 id="h-run">Destuffing now</h2><p>Longest-running first. Target ${SLA_MIN / 60} h per container.</p></div>${runs.length ? `<span class="chip">${runs.length} running${over ? ` · ${over} over target` : ''}</span>` : ''}</div>
      ${runs.length ? `<div class="rlist">${(S.runAll ? runs : runs.slice(0, 5)).map(rRow).join('')}</div>${runs.length > 5 ? `<button class="btn sm more" data-act="run-all">${S.runAll ? 'Show first 5' : `Show all ${runs.length} running`}</button>` : ''}` : `<div class="empty"><b>No container is being destuffed.</b><span>Start the job at position 1 of the queue to begin the clock.</span></div>`}
    </section>
    <section class="panel" aria-labelledby="h-next">
      <div class="sec-head"><div><h2 id="h-next">Next in FIFO</h2><p>Ordered by CFS arrival time. Only position 1 can be started.</p></div><button class="btn sm" data-tab="queue">Full queue (${q.length})</button></div>
      ${q.length ? `<div class="qlist">${q.slice(0, 5).map((c, i) => qCard(c, i, false)).join('')}</div>` : `<div class="empty"><b>The queue is empty.</b><span>Containers join the queue once their CFS arrival date and time is entered in Inventory.</span></div>`}
    </section>
  </div>
  <section class="panel" aria-labelledby="h-today">
    <h2 id="h-today">Today's performance</h2>
    <div class="stats">
      <div class="stat"><span>Containers destuffed</span><b>${today.length}</b></div>
      <div class="stat"><span>Average destuffing time</span><b>${avgD != null ? dur(avgD) : '—'}</b></div>
      <div class="stat"><span>Average wait, arrival to start</span><b>${avgW != null ? dur(avgW) : '—'}</b></div>
      <div class="stat"><span>Over ${SLA_MIN / 60} h target</span><b>${today.filter(c => c.durationMs > SLA_MIN * 6e4).length}</b></div>
    </div>
    <div style="display:grid;gap:6px"><span class="fl">Destuffing mode, today (completed + running)</span>
      <div class="split" role="img" aria-label="Mode split">${mt ? Object.entries(modeCt).map(([k, v], i) => v ? `<i style="width:${v / mt * 100}%;background:var(--m${i + 1})"></i>` : '').join('') : ''}</div>
      <div class="legend">${Object.entries(modeCt).map(([k, v], i) => `<span style="--c:var(--m${i + 1})">${MODES[k]} · ${v}</span>`).join('')}</div>
    </div>
  </section>`;
}
function rRow(c) {
  const el = Date.now() - c.startedAt, open = S.open?.id === c.id ? S.open.type : null;
  return `<article class="rr ${el > SLA_MIN * 6e4 ? 'over' : ''}" data-run="${c.startedAt}">
    <div class="q-main">
      <div class="q-line"><span class="cno">${cnoHtml(c.containerNo)}</span><span class="pill st-mode">${esc(c.size || '—')}</span><span class="pill st-mode">${MODES[c.mode] || '—'}</span>${c.bypass ? `<span class="pill st-prio" title="${esc(c.bypass.reason)}">FIFO bypass</span>` : ''}${attBtn(c)}</div>
      <div class="q-sub"><span>Started <b>${fmtT(c.startedAt)}</b></span><span>${esc(c.bay || 'No bay')}${c.crew != null ? ` · crew ${esc(c.crew)}` : ''}</span><span>by ${who(c.startedBy)}</span><span>${esc(c.customer ? custName(c.customer) : c.item)}</span></div>
      <div class="sla thin"><i data-sla="${c.startedAt}"></i></div>
    </div>
    <div class="rr-side"><div class="clock sm" data-since="${c.startedAt}" data-fmt="clock">${clock(el)}</div>
      ${open ? '' : `<div class="actions">${can.admin() ? `<button class="btn ghost sm" data-act="open-requeue" data-id="${esc(c.id)}">Requeue</button>` : ''}${can.sup() ? `<button class="btn live sm" data-act="open-done" data-id="${esc(c.id)}">Complete</button>` : ''}</div>`}</div>
    ${open === 'done' ? doneForm(c) : open === 'requeue' ? requeueForm(c) : ''}
  </article>`;
}
function qCard(c, i, full) {
  const head = i === 0, pr = S.overrides.get(c.id), open = S.open?.id === c.id ? S.open.type : null, a = arrMs(c);
  let acts = '';
  if (head && can.sup()) acts += `<button class="btn primary" data-act="open-start" data-id="${esc(c.id)}">Start destuffing</button>`;
  else if (head) acts += `<span class="lock">Next to start</span>`;
  else if (can.admin() && can.sup()) acts += `<button class="btn sm" data-act="open-bypass" data-id="${esc(c.id)}">Start out of turn</button>`;
  else acts += `<span class="lock">${lockIcon} Locked by FIFO · waits for position ${i}</span>`;
  if (can.admin() && !head) acts += pr ? `<button class="btn ghost sm" data-act="unprio" data-id="${esc(c.id)}">Remove priority</button>` : `<button class="btn ghost sm" data-act="open-prio" data-id="${esc(c.id)}">Move to front</button>`;
  else if (can.admin() && head && pr) acts += `<button class="btn ghost sm" data-act="unprio" data-id="${esc(c.id)}">Remove priority</button>`;
  const form = open === 'start' ? startForm(c, false, i) : open === 'bypass' ? startForm(c, true, i) : open === 'prio' ? prioForm(c) : '';
  return `<article class="q ${head ? 'head' : ''} ${pr ? 'prio' : ''}">
    <div class="pos">${i + 1}<small>${head ? 'Next' : 'FIFO'}</small></div>
    <div class="q-main">
      <div class="q-line"><span class="cno">${cnoHtml(c.containerNo)}</span><span class="pill st-mode">${esc(c.size || '—')}</span>${attBtn(c)}${pr ? `<span class="pill st-prio" title="${esc(pr.reason || '')}">Priority by superadmin</span>` : ''}</div>
      <div class="q-sub"><span>Arrived <b>${fmtT(c.cfsArrival)}</b></span><span>Waiting <b>${a ? `<span data-since="${a}">${dur(Date.now() - a)}</span>` : '—'}</b></span>${c.customer ? `<span>${esc(custName(c.customer))}</span>` : ''}${full ? `<span>${esc(c.liner || '—')} · ${esc(c.vessel || '—')}</span><span>${esc(c.item || '—')} · ${esc(c.consol || '')}</span><span>IGM ${esc(c.igmNo || '—')}</span>` : `<span>${esc(c.item || '')}</span>`}</div>
      ${pr && full ? `<div class="note info">Moved to front: ${esc(pr.reason || 'no reason given')} — ${who(pr.by)}, ${fmtT(pr.at)}</div>` : ''}
      ${form || `<div class="actions">${acts}</div>`}
    </div></article>`;
}
const fv = k => esc(S.form[k] ?? '');
function startForm(c, bypass, i) {
  return `<form class="jobform" data-form="start" data-id="${esc(c.id)}" data-bypass="${bypass ? 1 : 0}">
    ${bypass ? `<div class="note">This container is at position ${i + 1}. Starting it skips ${i} container${i > 1 ? 's' : ''} ahead of it in FIFO. Your reason is saved to the audit log.</div>` : ''}
    <div class="fl" id="ml-${esc(c.id)}">Destuffing mode</div>
    <div class="seg" role="radiogroup" aria-labelledby="ml-${esc(c.id)}">${Object.entries(MODES).map(([k, l]) => `<label><input type="radio" name="mode" id="f-mode-${k}" value="${k}" ${S.form.mode === k ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div>
    <div class="row2"><label>Bay / dock<input id="f-bay" name="bay" value="${fv('bay')}" placeholder="e.g. Bay 3"></label><label>Crew size<input id="f-crew" name="crew" type="number" min="0" inputmode="numeric" value="${fv('crew')}"></label></div>
    <label>Remarks<input id="f-remarks" name="remarks" value="${fv('remarks')}" placeholder="Optional"></label>
    ${bypass ? `<label>Reason for bypassing FIFO (required)<textarea id="f-reason" name="reason" required>${fv('reason')}</textarea></label>` : ''}
    <div class="actions"><button type="submit" class="btn primary">Start clock</button><button type="button" class="btn" data-act="att" data-id="${esc(c.id)}">${clipIcon} Add photos (optional)</button><button type="button" class="btn ghost" data-act="cancel">Cancel</button></div>
  </form>`;
}
function doneForm(c) {
  return `<form class="jobform" data-form="done" data-id="${esc(c.id)}">
    <div class="row2"><label>Packages destuffed<input id="f-pkgs" name="pkgs" type="number" min="0" inputmode="numeric" value="${fv('pkgs')}" placeholder="Optional"></label><label>Remarks<input id="f-remarks" name="remarks" value="${fv('remarks')}" placeholder="Optional"></label></div>
    <div class="actions"><button type="submit" class="btn live">Stop clock and complete</button><button type="button" class="btn" data-act="att" data-id="${esc(c.id)}">${clipIcon} Add photos (optional)</button><button type="button" class="btn ghost" data-act="cancel">Cancel</button></div></form>`;
}
function requeueForm(c) {
  return `<form class="jobform" data-form="requeue" data-id="${esc(c.id)}"><div class="note">The clock is discarded and the container goes back to the queue at its FIFO position.</div>
    <label>Reason (required)<textarea id="f-reason" name="reason" required>${fv('reason')}</textarea></label>
    <div class="actions"><button type="submit" class="btn danger">Return to queue</button><button type="button" class="btn ghost" data-act="cancel">Cancel</button></div></form>`;
}
function prioForm(c) {
  return `<form class="jobform" data-form="prio" data-id="${esc(c.id)}"><div class="note info">Moves this container to the front of the queue so the supervisor can start it next. Recorded in the audit log.</div>
    <label>Reason (required)<textarea id="f-reason" name="reason" required placeholder="e.g. Customs examination order, perishable cargo">${fv('reason')}</textarea></label>
    <div class="actions"><button type="submit" class="btn primary">Move to front</button><button type="button" class="btn ghost" data-act="cancel">Cancel</button></div></form>`;
}

/* --- queue tab --- */
function vQueue() {
  const q = fifo();
  return `<section class="panel"><div class="sec-head"><div><h2>Destuffing job queue</h2><p>Strict FIFO by CFS arrival date and time. Supervisors can start only position 1. Starting out of turn or moving a container to the front needs a superadmin, and every bypass is logged.</p></div>
    <span class="chip">${q.length} waiting · ${running().length} running</span></div>
    ${q.length ? `<div class="qlist">${q.map((c, i) => qCard(c, i, true)).join('')}</div>` : `<div class="empty"><b>No containers are waiting.</b><span>Enter a CFS arrival date and time in Inventory to put a container in the queue.</span><button class="btn" data-tab="inv">Go to inventory</button></div>`}
  </section>`;
}

/* --- inventory grid --- */
const cellId = (key, k) => 'g-' + key.replace(/[^A-Za-z0-9_-]/g, '_') + '-' + k;
function newRow() { const k = 'n' + (++S.nseq); S.newRows.push(k); return k; }
const rowBlank = k => !S.edits[k] || COLS.every(c => !S.edits[k][c.k]);
function ensureBlank() { if (!can.inv()) return; let n = 0; for (let i = S.newRows.length - 1; i >= 0 && rowBlank(S.newRows[i]); i--) n++; while (n++ < 3) newRow(); }
function rowVals(key) { const c = key[0] === 'c' ? S.containers.get(key.slice(2)) : null, e = S.edits[key] || {}, o = {}; COLS.forEach(col => o[col.k] = e[col.k] !== undefined ? e[col.k] : (c?.[col.k] ?? '')); return o; }
function numCounts() { const m = {}, add = n => { if (n) m[n] = (m[n] || 0) + 1; }; for (const c of S.containers.values()) { if (c.status === 'completed') continue; add(S.edits['c:' + c.id]?.containerNo ?? c.containerNo); } S.newRows.forEach(k => add(S.edits[k]?.containerNo)); return m; }
function rowIssues(key, counts) {
  const v = rowVals(key); if (key[0] === 'n' && rowBlank(key)) return { blank: true, errs: [], warns: [] };
  const errs = [], warns = [];
  if (!v.containerNo) errs.push('Container number is required');
  else { if (counts[v.containerNo] > 1) errs.push('Duplicate container number'); const r = iso6346(v.containerNo); if (r === 'format') warns.push('Not ISO 6346 format (4 letters + 7 digits)'); else if (r === 'check') warns.push('Check digit does not match'); }
  if (v.customer && !S.customers.has(v.customer)) errs.push(`Unknown customer code ${v.customer}`);
  if (!v.customer) warns.push('No customer: not visible on the customer portal');
  const t = toDate(v.cfsArrival); if (t && t.getTime() > Date.now() + 36e5) warns.push('Arrival is in the future');
  return { errs, warns };
}
function cellLocked(key, k) {
  if (!can.inv()) return 'role'; if (key[0] === 'n') return false;
  const c = S.containers.get(key.slice(2)); if (!c) return 'gone';
  if (c.status === 'in_progress' || c.status === 'completed') return 'job';
  if (k === 'cfsArrival' && c.cfsArrival && !can.admin()) return 'arr';
  return false;
}
function canDelete(key) { if (key[0] === 'n') return !rowBlank(key); const c = S.containers.get(key.slice(2)); if (!c) return false; if (c.status === 'awaiting') return can.inv(); if (c.status === 'queued') return can.admin(); return false; }
function statusCell(key, counts) {
  const c = key[0] === 'c' ? S.containers.get(key.slice(2)) : null, iss = rowIssues(key, counts);
  let h = c ? pill(c.status) : (iss.blank ? '<span class="muted">New row</span>' : '<span class="pill st-new">New</span>');
  if (iss.errs.length) h += `<span class="iss bad" title="${esc(iss.errs.join('; '))}">${esc(iss.errs[0])}</span>`;
  else if (iss.warns.length) h += `<span class="iss warn" title="${esc(iss.warns.join('; '))}">${esc(iss.warns[0])}</span>`;
  return h;
}
function gridRows() {
  const q = S.q.trim().toLowerCase(), f = S.f;
  let list = [...S.containers.values()].filter(c => {
    const key = 'c:' + c.id;
    if (f.unsaved) return !!S.edits[key];
    for (const [k] of FFIELDS) if (f[k].size && !f[k].has(k === 'status' ? c.status : (c[k] || ''))) return false;
    if (f.arrFrom || f.arrTo) { const d = (c.cfsArrival || '').slice(0, 10); if (!d || (f.arrFrom && d < f.arrFrom) || (f.arrTo && d > f.arrTo)) return false; }
    if (f.pnrFrom || f.pnrTo) { const d = (c.pnrDate || '').slice(0, 10); if (!d || (f.pnrFrom && d < f.pnrFrom) || (f.pnrTo && d > f.pnrTo)) return false; }
    if (f.files) { const n = S.attCount.get(c.id) || 0; if (f.files === 'with' ? !n : n) return false; }
    if (q && ![c.containerNo, c.vessel, c.consol, c.igmNo, c.item, c.liner, c.port, c.customer, custName(c.customer)].some(x => String(x || '').toLowerCase().includes(q))) return false;
    return true; });
  list.sort((a, b) => (STORD[a.status] - STORD[b.status]) || (a.cfsArrival || '9').localeCompare(b.cfsArrival || '9') || (a.createdAt || 0) - (b.createdAt || 0));
  return [...list.map(c => 'c:' + c.id), ...(can.inv() ? S.newRows : [])];
}
function pendingCount() { return Object.keys(S.edits).filter(k => !(k[0] === 'n' && rowBlank(k))).length; }
function vInv() {
  ensureBlank(); const keys = gridRows(); S.gridKeys = keys; const counts = numCounts(), pc = pendingCount(), hasSample = [...S.containers.values()].some(c => c.sample);
  const rows = keys.map((key, i) => {
    const v = rowVals(key), iss = rowIssues(key, counts), c = key[0] === 'c' ? S.containers.get(key.slice(2)) : null;
    const cells = COLS.map(col => { const lock = cellLocked(key, col.k), dirty = S.edits[key] && S.edits[key][col.k] !== undefined;
      const title = lock === 'arr' ? 'Only a superadmin can change an arrival time once it is saved (it sets the FIFO position)' : lock === 'job' ? 'Locked: destuffing has started' : '';
      return `<td class="c-${col.k}${col.mono ? ' mono' : ''}${dirty ? ' dirty' : ''}" ${title ? `title="${esc(title)}"` : ''}><input id="${cellId(key, col.k)}" data-key="${esc(key)}" data-col="${col.k}" type="${col.type || 'text'}" value="${esc(v[col.k])}" ${col.list ? `list="${col.list}"` : ''} ${lock ? 'disabled' : ''} aria-label="${esc(col.label)}, row ${i + 1}" autocomplete="off" spellcheck="false" style="min-width:${col.w}px"></td>`; });
    cells.splice(1, 0, `<td class="stc" id="st-${cellId(key, 's')}">${statusCell(key, counts)}</td>`);
    const act = (c ? attBtn(c) + ' ' : '') + (S.confirmDel === key ? `<button class="btn sm danger" data-act="del-yes" data-key="${esc(key)}">Delete</button> <button class="btn sm ghost" data-act="del-no">Keep</button>` : canDelete(key) ? `<button class="x" data-act="del" data-key="${esc(key)}" aria-label="Delete row ${i + 1}" title="Delete row">×</button>` : '');
    return `<tr data-row="${esc(key)}" class="${iss.errs.length ? 'err' : ''}"><td class="rn">${i + 1}</td>${cells.join('')}<td class="act">${act}</td></tr>`;
  }).join('');
  const head = `<tr><th class="rn">#</th>${COLS.map((c, i) => `<th class="c-${c.k}">${c.short}</th>${i === 0 ? '<th>Status</th>' : ''}`).join('')}<th>Files</th></tr>`;
  return `<section class="panel">
    <div class="sec-head"><div><h2>Container inventory</h2><p>A container joins the destuffing queue as soon as its CFS arrival date and time is filled in. Blank arrival means it has not reached the CFS yet. The customer code decides which customer sees the container on their portal.</p></div></div>
    <div class="toolbar">
      <div class="grow"><input type="search" id="inv-q" placeholder="Search container, customer, vessel, consol, IGM, item…" value="${esc(S.q)}" aria-label="Search inventory"></div>
      ${can.inv() ? `<button class="btn" data-act="add-rows">+ 5 rows</button><label class="btn file-btn">Upload Excel / CSV<input type="file" id="inv-file" accept=".xlsx,.xls,.csv"></label>` : ''}
      <button class="btn" data-act="template">Download template</button><button class="btn" data-act="export-inv">Export this view</button>
      ${can.admin() ? (hasSample ? `<button class="btn ghost" data-act="sample-clear">Clear sample data</button>` : `<button class="btn ghost" data-act="sample-load">Load sample data</button>`) : ''}
    </div>
    ${vFilters(keys.filter(k => k[0] === 'c').length, pc)}
    ${can.inv() ? `<p class="hint">Type straight into the grid like a spreadsheet. Copy rows from Excel and paste into any cell with <kbd>Ctrl</kbd>+<kbd>V</kbd>. <kbd>Enter</kbd> moves down, <kbd>Ctrl</kbd>+<kbd>S</kbd> saves. Dates are read day-first (13-10-2026 14:30).</p>` : `<p class="hint">${lockIcon} Your role can view the inventory but not edit it.</p>`}
    ${keys.length ? `<div class="grid-wrap"><table class="grid"><thead>${head}</thead><tbody>${rows}</tbody></table></div>` : `<div class="empty"><b>No containers match this view.</b><span>Change the filters or search.</span></div>`}
    ${pc ? `<div class="savebar" id="savebar"><span><b>${pc}</b> row${pc > 1 ? 's' : ''} with unsaved changes</span><div class="actions"><button class="btn ghost sm" data-act="discard">Discard</button><button class="btn primary" data-act="save">Save changes</button></div></div>` : ''}
  </section>`;
}
const sameSet = (a, b) => a.size === b.size && [...a].every(x => b.has(x));
function fCount() { const f = S.f; let n = 0; for (const [k] of FFIELDS) if (k === 'status' ? !sameSet(f.status, ACTIVE_ST()) : f[k].size) n++; if (f.arrFrom || f.arrTo) n++; if (f.pnrFrom || f.pnrTo) n++; if (f.files) n++; if (f.unsaved) n++; return n; }
function optsFor(k) {
  const m = new Map();
  if (k === 'status') { S.containers.forEach(c => m.set(c.status, (m.get(c.status) || 0) + 1)); return Object.keys(ST).map(v => [v, ST[v], m.get(v) || 0]); }
  S.containers.forEach(c => { const v = c[k]; if (v) m.set(v, (m.get(v) || 0) + 1); });
  return [...m].sort((a, b) => String(a[0]).localeCompare(String(b[0]))).map(([v, n]) => [v, k === 'customer' ? `${v} · ${custName(v)}` : v, n]);
}
function vFilters(n, pc) {
  const f = S.f, dateOn = !!(f.arrFrom || f.arrTo || f.pnrFrom || f.pnrTo || f.files);
  const btns = FFIELDS.map(([k, l]) => { const sel = f[k].size, on = sel && !(k === 'status' && sameSet(f.status, ACTIVE_ST())); return `<button type="button" class="fbtn ${on ? 'on' : ''}" data-act="dd" data-k="${k}" aria-expanded="${S.dd === k}">${l}${k === 'status' && !sel ? ' · all' : ''}${sel ? ` <b>${sel}</b>` : ''}</button>`; }).join('')
    + `<button type="button" class="fbtn ${dateOn ? 'on' : ''}" data-act="dd" data-k="dates" aria-expanded="${S.dd === 'dates'}">Dates &amp; files</button>`
    + `<button type="button" class="fbtn ${f.unsaved ? 'on' : ''}" data-act="f-unsaved" aria-pressed="${f.unsaved}">Unsaved only${pc ? ` <b>${pc}</b>` : ''}</button>`;
  let panel = '';
  if (S.dd === 'dates') {
    const d = (id, l) => `<label>${l}<input type="date" id="f-${id}" data-fd="${id}" value="${esc(f[id])}"></label>`;
    panel = `<div class="fpanel"><div class="dates">${d('arrFrom', 'CFS arrival from')}${d('arrTo', 'CFS arrival to')}${d('pnrFrom', 'PNR date from')}${d('pnrTo', 'PNR date to')}
      <label>Photos &amp; files<select id="f-files" data-fd="files"><option value="">Any</option><option value="with" ${f.files === 'with' ? 'selected' : ''}>With attachments</option><option value="without" ${f.files === 'without' ? 'selected' : ''}>Without attachments</option></select></label></div>
      <div class="fpanel-h"><span class="muted">A date range leaves out containers with that date blank.</span><div class="actions"><button type="button" class="btn sm ghost" data-act="f-clear" data-k="dates">Clear</button><button type="button" class="btn sm" data-act="dd" data-k="dates">Done</button></div></div></div>`;
  } else if (S.dd) {
    const k = S.dd, label = FFIELDS.find(x => x[0] === k)[1], all = optsFor(k), q = S.ddq.trim().toLowerCase(), list = q ? all.filter(o => String(o[1]).toLowerCase().includes(q)) : all;
    panel = `<div class="fpanel"><div class="fpanel-h">${all.length > 8 ? `<input type="search" id="dd-q" placeholder="Find ${label.toLowerCase()}…" value="${esc(S.ddq)}" aria-label="Find ${label}">` : `<span class="fl">${label}: pick one or more${k === 'status' ? ' (none picked = all)' : ''}</span>`}
      <div class="actions"><button type="button" class="btn sm ghost" data-act="f-all" data-k="${k}">Select ${q ? 'shown' : 'all'}</button><button type="button" class="btn sm ghost" data-act="f-clear" data-k="${k}">Clear</button><button type="button" class="btn sm" data-act="dd" data-k="${k}">Done</button></div></div>
      <div class="opts" role="group" aria-label="${label}">${list.length ? list.map(([v, l, c], i) => `<label class="opt"><input type="checkbox" id="fo-${k}-${i}" data-fk="${k}" value="${esc(v)}" ${f[k].has(v) ? 'checked' : ''}><span>${esc(l)}<i>${c}</i></span></label>`).join('') : '<span class="muted">No values to pick yet.</span>'}</div></div>`;
  }
  const nf = fCount();
  return `<div class="filters" role="group" aria-label="Filters">${btns}</div>${panel}<div class="factive"><span>Showing <b>${n}</b> of ${S.containers.size} containers${nf ? ` · ${nf} filter${nf > 1 ? 's' : ''} applied` : ' · active containers'}</span>${nf ? `<button type="button" class="btn sm ghost" data-act="f-reset">Reset filters</button>` : ''}</div>`;
}
function setEdit(key, k, v) {
  const c = key[0] === 'c' ? S.containers.get(key.slice(2)) : null, base = c ? (c[k] ?? '') : '';
  S.edits[key] = S.edits[key] || {};
  if (v === base) delete S.edits[key][k]; else S.edits[key][k] = v;
  if (!Object.keys(S.edits[key]).length) delete S.edits[key];
}
function refreshRow(key) {
  const counts = numCounts(), st = document.getElementById('st-' + cellId(key, 's')); if (st) st.innerHTML = statusCell(key, counts);
  const tr = st?.closest('tr'); if (tr) tr.classList.toggle('err', rowIssues(key, counts).errs.length > 0);
  const pc = pendingCount(), bar = $('#savebar');
  if (!!bar !== !!pc) scheduleRender(); else if (bar) { const b = bar.querySelector('b'); if (b) b.textContent = pc; }
}
function normalize(k, v) {
  if (v == null) return '';
  if (k === 'containerNo') return String(v).toUpperCase().replace(/[\s-]/g, '');
  if (k === 'customer') return String(v).toUpperCase().trim();
  if (k === 'size') { const s = String(v).toUpperCase().replace(/['’"\s]|FT|FEET/g, ''); return /^40(HC|HQ|H)$/.test(s) ? '40HC' : s; }
  if (k === 'cfsArrival') return parseDT(v);
  if (k === 'pnrDate') { const r = parseDT(v); return r ? r.slice(0, 10) : r; }
  return String(v).trim();
}
async function saveGrid() {
  if (S.busy) return; const counts = numCounts(), errs = [], ops = [];
  for (const key of Object.keys(S.edits)) {
    if (key[0] === 'n' && rowBlank(key)) continue;
    const iss = rowIssues(key, counts), label = rowVals(key).containerNo || 'a new row';
    iss.errs.forEach(e => errs.push(`${label}: ${e}`));
    if (key[0] === 'c') { const c = S.containers.get(key.slice(2)); if (!c) continue; for (const k of Object.keys(S.edits[key])) if (cellLocked(key, k)) errs.push(`${c.containerNo}: ${COLS.find(x => x.k === k).short} is locked for your role`); }
    ops.push(key);
  }
  if (errs.length) { toast(errs[0] + (errs.length > 1 ? ` (+${errs.length - 1} more)` : ''), 'bad'); return; }
  if (!ops.length) return;
  S.busy = true; let added = 0, updated = 0; const failed = [];
  for (const key of ops) {
    const ed = S.edits[key];
    try {
      if (key[0] === 'n') {
        const v = rowVals(key), body = {}; COLS.forEach(c => body[c.db] = toDbVal(c.k, v[c.k]));
        const row = await must(sb.from('containers').insert(body).select().single()); S.containers.set(row.id, fromRow(row)); added++;
      } else {
        const c = S.containers.get(key.slice(2)), body = {}; for (const k of Object.keys(ed)) { const col = COLS.find(x => x.k === k); body[col.db] = toDbVal(k, ed[k]); }
        const row = await must(sb.from('containers').update(body).eq('id', c.id).select().single()); S.containers.set(row.id, fromRow(row)); updated++;
        if ('cfsArrival' in ed && c.cfsArrival) await log('Arrival time changed', c, `${fmtDT(c.cfsArrival)} → ${ed.cfsArrival ? fmtDT(ed.cfsArrival) : 'blank'} (changes FIFO position)`);
      }
      delete S.edits[key]; S.newRows = S.newRows.filter(k => k !== key);
    } catch (e) { failed.push(`${rowVals(key).containerNo || 'New row'}: ${errMsg(e)}`); }
  }
  if (added || updated) await log('Inventory saved', null, `${added} added, ${updated} updated`);
  if (failed.length) toast(`Saved ${added + updated}. Not saved: ${failed[0]}${failed.length > 1 ? ` (+${failed.length - 1} more)` : ''}`, 'bad');
  else { toast(`Saved: ${added} added, ${updated} updated.`, 'ok'); S.f.unsaved = false; }
  S.busy = false; render();
}
async function deleteRow(key) {
  S.confirmDel = null;
  if (key[0] === 'n') { delete S.edits[key]; S.newRows = S.newRows.filter(k => k !== key); render(); return; }
  const c = S.containers.get(key.slice(2)); if (!c || !canDelete(key)) return;
  try {
    const paths = attsOf(c.id).map(a => a.path); if (paths.length) await sb.storage.from('attachments').remove(paths);
    await must(sb.from('containers').delete().eq('id', c.id)); S.containers.delete(c.id); delete S.edits[key];
    await log('Container deleted', c, ST[c.status]); toast(`Deleted ${c.containerNo}.`, 'ok'); render();
  } catch (e) { toast(errMsg(e), 'bad'); }
}
function applyPaste(startKey, startCol, matrix) {
  const keys = S.gridKeys, ci = COLS.findIndex(c => c.k === startCol); let ri = keys.indexOf(startKey), skipped = 0, bad = 0;
  matrix.forEach((cells, i) => {
    let key = keys[ri + i]; if (!key) { key = newRow(); keys.push(key); }
    cells.forEach((raw, j) => { const col = COLS[ci + j]; if (!col) return; if (cellLocked(key, col.k)) { skipped++; return; }
      let v = normalize(col.k, raw); if (v === null) { bad++; v = ''; } setEdit(key, col.k, v); });
  });
  render();
  toast(`Pasted ${matrix.length} row${matrix.length > 1 ? 's' : ''}.` + (skipped ? ` ${skipped} locked cells skipped.` : '') + (bad ? ` ${bad} dates could not be read.` : ''), bad ? 'bad' : 'ok');
}
async function onUpload(file) {
  if (!file) return; if (!window.XLSX) { toast('The spreadsheet reader is still loading. Try again in a moment.', 'bad'); return; }
  try {
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' }), ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
    const hi = rows.findIndex(r => r.some(x => /container|cntr/i.test(String(x))));
    if (hi < 0) { toast('No header row with "Container No." found. Use the template.', 'bad'); return; }
    const map = {}, used = new Set(); rows[hi].forEach((h, i) => { const a = ALIASES.find(([k, re]) => !used.has(k) && re.test(String(h))); if (a) { map[i] = a[0]; used.add(a[0]); } });
    S.newRows = S.newRows.filter(k => !rowBlank(k));
    const byNo = new Map([...S.containers.values()].filter(c => c.status !== 'completed').map(c => [c.containerNo, c]));
    let nNew = 0, nUpd = 0, bad = 0, skipped = 0;
    for (const r of rows.slice(hi + 1)) {
      const o = {}; for (const [i, k] of Object.entries(map)) { let v = normalize(k, r[i]); if (v === null) { bad++; v = ''; } o[k] = v; }
      if (!Object.values(o).some(Boolean)) continue;
      const ex = o.containerNo && byNo.get(o.containerNo);
      if (ex) { const key = 'c:' + ex.id; let any = false; for (const [k, v] of Object.entries(o)) { if (!v || v === (ex[k] || '')) continue; if (cellLocked(key, k)) { skipped++; continue; } setEdit(key, k, v); any = true; } if (any) nUpd++; }
      else { const key = newRow(); for (const [k, v] of Object.entries(o)) setEdit(key, k, v); nNew++; }
    }
    S.f.unsaved = true; render();
    toast(`Loaded ${nNew} new and ${nUpd} updated containers. Review, then Save.` + (bad ? ` ${bad} dates could not be read.` : '') + (skipped ? ` ${skipped} locked values skipped.` : ''), bad ? 'bad' : 'ok');
  } catch (e) { toast('Could not read that file: ' + (e.message || e), 'bad'); }
}
function downloadTemplate() {
  if (!window.XLSX) return saveWorkbook();
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([COLS.map(c => c.label), ['MSCU1234566','40HC','CUST01','Globelink','MSC ARIANE V.FX241W','MSC','INMAA','12-10-2026','2345678','Auto components','13-10-2026 14:30'], ['MAEU7654320','20','CUST02','Shipco Transport','MAERSK KENSINGTON V.442E','Maersk','INKAT','12-10-2026','2345679','Readymade garments','']]);
  ws['!cols'] = COLS.map(c => ({ wch: Math.max(12, Math.round(c.w / 7)) })); XLSX.utils.book_append_sheet(wb, ws, 'Inventory');
  const codes = [...S.customers.values()].map(c => [c.code, c.name]);
  const ins = XLSX.utils.aoa_to_sheet([['How to fill this template'], [''], ['1. Keep the header row as it is. One container per row; delete the two example rows.'], ['2. Container No.: 4 letters + 7 digits (ISO 6346), e.g. MSCU1234566.'], ['3. Container Size: 20, 40, 40HC or 45.'], ['4. Customer Code: must match a code in the portal (list below). It decides which customer sees the container.'], ['5. Dates are day-first: 13-10-2026 or 13/10/2026. CFS arrival takes a time too: 13-10-2026 14:30.'], ['6. Leave CFS Arrival blank if the container has not reached the CFS. Filled in = it joins the destuffing queue (FIFO by this time).'], ['7. Uploading a container number that already exists updates that container instead of adding a duplicate.'], ['8. After upload, review the highlighted cells in the portal and click Save changes.'], [''], ['Customer codes'], ...codes]);
  ins['!cols'] = [{ wch: 110 }, { wch: 40 }]; XLSX.utils.book_append_sheet(wb, ins, 'Instructions');
  saveWorkbook('CFS_Inventory_Template.xlsx', wb);
}
function exportInv() {
  if (!window.XLSX) return saveWorkbook(); const q = fifo();
  const rows = S.gridKeys.filter(k => k[0] === 'c').map(k => S.containers.get(k.slice(2))).filter(Boolean);
  if (!rows.length) return toast('No containers in this view to export.', 'bad');
  const aoa = [[...COLS.map(c => c.label), 'Customer Name', 'Status', 'Queue position', 'Mode', 'Started', 'Completed', 'Duration (min)', 'Attachments']];
  rows.forEach(c => aoa.push([...COLS.map(col => col.k === 'cfsArrival' ? (c.cfsArrival ? fmtDT(c.cfsArrival) : '') : col.k === 'pnrDate' ? (c.pnrDate ? fmtD(c.pnrDate) : '') : c[col.k] || ''), c.customer ? custName(c.customer) : '', ST[c.status] || c.status, c.status === 'queued' ? q.findIndex(x => x.id === c.id) + 1 : '', MODES[c.mode] || '', c.startedAt ? fmtDT(c.startedAt) : '', c.completedAt ? fmtDT(c.completedAt) : '', c.durationMs ? Math.round(c.durationMs / 6e4) : '', S.attCount.get(c.id) || 0]));
  const wb = XLSX.utils.book_new(), ws = XLSX.utils.aoa_to_sheet(aoa); ws['!cols'] = aoa[0].map(() => ({ wch: 18 })); XLSX.utils.book_append_sheet(wb, ws, 'Inventory');
  const d = new Date(); saveWorkbook(`CFS_Inventory_${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}.xlsx`, wb);
}

/* --- completed --- */
function doneList() {
  const r = S.doneRange;
  if (r === 'all') return (S.doneAll || []).slice().sort((a, b) => b.completedAt - a.completedAt);
  const from = r === 'today' ? dayStart() : r === 'yday' ? dayStart(-1) : r === '7d' ? dayStart(-6) : dayStart(-29), to = r === 'yday' ? dayStart() : Infinity;
  return [...S.containers.values()].filter(c => c.status === 'completed' && c.completedAt >= from && c.completedAt < to).sort((a, b) => b.completedAt - a.completedAt);
}
let doneLoading = false;
async function loadDoneAll() {
  if (doneLoading) return; doneLoading = true;
  try { const rows = await fetchAll(() => sb.from('containers').select('*').eq('status', 'completed').order('completed_at', { ascending: false })); S.doneAll = rows.map(fromRow); }
  catch (e) { S.doneAll = []; toast(errMsg(e), 'bad'); }
  finally { doneLoading = false; render(); }
}
function vDone() {
  if (S.doneRange === 'all' && !S.doneAll) setTimeout(loadDoneAll);
  const list = doneList(), avg = list.length ? list.reduce((s, c) => s + c.durationMs, 0) / list.length : null, w = list.filter(arrMs), avgW = w.length ? w.reduce((s, c) => s + (c.startedAt - arrMs(c)), 0) / w.length : null;
  return `<section class="panel"><div class="sec-head"><div><h2>Completed destuffing</h2><p>Every closed job with its clock time, mode and who started and closed it.</p></div>
    <div class="toolbar"><select id="done-range" aria-label="Date range">${[['today','Today'],['yday','Yesterday'],['7d','Last 7 days'],['30d','Last 30 days'],['all','All time']].map(([k, l]) => `<option value="${k}" ${S.doneRange === k ? 'selected' : ''}>${l}</option>`).join('')}</select><button class="btn" data-act="export-done">Export</button></div></div>
    ${S.doneRange === 'all' && !S.doneAll ? '<div class="skel">Loading full history…</div>' : `
    <div class="stats"><div class="stat"><span>Jobs</span><b>${list.length}</b></div><div class="stat"><span>Average destuffing time</span><b>${avg != null ? dur(avg) : '—'}</b></div><div class="stat"><span>Average wait before start</span><b>${avgW != null ? dur(avgW) : '—'}</b></div><div class="stat"><span>FIFO bypasses</span><b>${list.filter(c => c.bypass).length}</b></div></div>
    ${list.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Container</th><th>Customer</th><th>Size</th><th>Mode</th><th>Arrived</th><th>Started</th><th>Completed</th><th>Duration</th><th>Started by</th><th>Closed by</th><th>Notes</th></tr></thead><tbody>
    ${list.slice(0, 1000).map(c => `<tr><td class="cno" style="font-size:13px">${cnoHtml(c.containerNo)}</td><td>${esc(c.customer || '—')}</td><td>${esc(c.size)}</td><td>${MODES[c.mode] || '—'}</td><td class="n">${fmtT(c.cfsArrival)}</td><td class="n">${fmtT(c.startedAt)}</td><td class="n">${fmtT(c.completedAt)}</td><td class="n" style="${c.durationMs > SLA_MIN * 6e4 ? 'color:var(--bad);font-weight:600' : ''}">${dur(c.durationMs)}</td><td>${who(c.startedBy)}</td><td>${who(c.completedBy)}</td><td>${S.containers.has(c.id) ? attBtn(c) : ''} ${c.bypass ? `<span class="pill st-prio" title="${esc(c.bypass.reason)}">Bypass</span> ` : ''}${c.packages != null ? esc(c.packages) + ' pkgs ' : ''}${esc(c.endRemarks || '')}</td></tr>`).join('')}
    </tbody></table></div>${list.length > 1000 ? '<p class="hint">Showing the latest 1,000. Export to see all.</p>' : ''}` : `<div class="empty"><b>No completed jobs in this period.</b></div>`}`}</section>`;
}
function exportDone() {
  if (!window.XLSX) return saveWorkbook(); const list = doneList();
  const aoa = [['Container No.','Customer','Size','Liner','Vessel','Item','Mode','Bay','Crew','CFS Arrival','Started','Completed','Duration (min)','Wait before start (min)','Packages','FIFO bypass reason','Remarks']];
  list.forEach(c => aoa.push([c.containerNo, c.customer, c.size, c.liner, c.vessel, c.item, MODES[c.mode] || '', c.bay || '', c.crew ?? '', fmtDT(c.cfsArrival), fmtDT(c.startedAt), fmtDT(c.completedAt), Math.round(c.durationMs / 6e4), arrMs(c) ? Math.round((c.startedAt - arrMs(c)) / 6e4) : '', c.packages ?? '', c.bypass?.reason || '', c.endRemarks || '']));
  const wb = XLSX.utils.book_new(), ws = XLSX.utils.aoa_to_sheet(aoa); ws['!cols'] = aoa[0].map(() => ({ wch: 18 })); XLSX.utils.book_append_sheet(wb, ws, 'Completed');
  saveWorkbook(`CFS_Destuffing_${S.doneRange}.xlsx`, wb);
}

/* --- audit --- */
function vAudit() {
  return `<section class="panel"><div class="sec-head"><div><h2>Audit log</h2><p>Job starts and closures, FIFO bypasses, priority changes, arrival-time edits, inventory saves and access changes. Latest 300 entries.</p></div></div>
  ${S.audit.length ? `<div>${S.audit.map(a => `<div class="audit-row"><span class="t">${fmtDT(a.at)}</span><div><span class="a ${/bypass|priority|front|arrival time|returned|access/i.test(a.action) ? 'byp' : ''}">${esc(a.action)}</span>${a.container_no ? ` · <span class="mono">${esc(a.container_no)}</span>` : ''} · ${who(a.by)}${a.detail ? `<div class="muted">${esc(a.detail)}</div>` : ''}</div></div>`).join('')}</div>` : `<div class="empty"><b>Nothing recorded yet.</b></div>`}</section>`;
}

/* --- users & customers --- */
function vTeam() {
  if (!can.admin()) return `<section class="panel"><div class="empty"><b>Only a superadmin can manage users.</b></div></section>`;
  const order = { pending: 0, customer: 2 }, people = [...S.profiles.values()].sort((a, b) => (order[a.role] ?? 1) - (order[b.role] ?? 1) || (a.full_name || a.email || '').localeCompare(b.full_name || b.email || ''));
  const cust = [...S.customers.values()], cnt = new Map(), ucnt = new Map();
  S.containers.forEach(c => c.customer && c.status !== 'completed' && cnt.set(c.customer, (cnt.get(c.customer) || 0) + 1));
  S.profiles.forEach(p => p.customer_code && ucnt.set(p.customer_code, (ucnt.get(p.customer_code) || 0) + 1));
  const custOpts = sel => `<option value="">Pick customer…</option>` + cust.map(c => `<option value="${esc(c.code)}" ${sel === c.code ? 'selected' : ''}>${esc(c.code)} · ${esc(c.name)}</option>`).join('');
  return `<section class="panel"><div class="sec-head"><div><h2>Users</h2><p>Anyone can create an account from the sign-in page. New accounts wait here until you give them a role. Staff roles see all containers; a <b>Customer</b> sees only containers with their customer code.</p></div></div>
  <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Customer</th><th>Joined</th></tr></thead><tbody>
  ${people.map(p => { const self = p.id === S.uid; return `<tr class="${p.role === 'pending' ? 'pending' : ''}"><td>${esc(p.full_name || '—')}${self ? ' (you)' : ''}</td><td>${esc(p.email || '')}</td>
    <td><select data-role-uid="${esc(p.id)}" aria-label="Role for ${esc(p.email || '')}" ${self ? 'disabled title="You cannot change your own role"' : ''}>${['pending','superadmin','both','ops','supervisor','readonly','customer'].map(k => `<option value="${k}" ${p.role === k ? 'selected' : ''}>${ROLES[k]}</option>`).join('')}</select></td>
    <td>${p.role === 'customer' ? `<select data-cust-uid="${esc(p.id)}" aria-label="Customer for ${esc(p.email || '')}">${custOpts(p.customer_code)}</select>${p.customer_code ? '' : ' <span class="iss bad">Pick a customer</span>'}` : '<span class="muted">—</span>'}</td>
    <td class="n">${fmtD(p.created_at)}</td></tr>`; }).join('')}
  </tbody></table></div></section>
  <section class="panel"><div class="sec-head"><div><h2>Customers</h2><p>The customer code goes in the Customer column of the inventory. Codes use capital letters, digits, - or _.</p></div></div>
  <form class="inline-form" data-form="cust-add"><label>Code<input id="c-code" name="code" required maxlength="30" placeholder="e.g. ABCIMP" style="text-transform:uppercase"></label><label style="flex:1 1 220px">Customer name<input id="c-name" name="name" required placeholder="e.g. ABC Imports Pvt Ltd"></label><button class="btn primary" type="submit">Add customer</button></form>
  ${cust.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Code</th><th>Name</th><th>Active containers</th><th>Users</th><th></th></tr></thead><tbody>
  ${cust.map(c => `<tr><td class="mono">${esc(c.code)}</td><td><input type="text" id="cn-${esc(c.code)}" data-cust-name="${esc(c.code)}" value="${esc(c.name)}" aria-label="Name for ${esc(c.code)}" style="width:100%"></td><td class="n">${cnt.get(c.code) || 0}</td><td class="n">${ucnt.get(c.code) || 0}</td><td>${S.confirmDel === 'cust:' + c.code ? `<button class="btn sm danger" data-act="cust-del-yes" data-code="${esc(c.code)}">Delete</button> <button class="btn sm ghost" data-act="del-no">Keep</button>` : `<button class="btn sm ghost" data-act="cust-del" data-code="${esc(c.code)}">Delete</button>`}</td></tr>`).join('')}
  </tbody></table></div>` : `<div class="empty"><b>No customers yet.</b><span>Add one above, then put its code on that customer's containers.</span></div>`}</section>`;
}

/* ---------- photos & files ---------- */
const MAXB = 10 * 1024 * 1024, OKEXT = ['jpg','jpeg','png','webp','gif','pdf','docx','xlsx','pptx','csv','txt','zip'];
const attsOf = cid => [...S.atts.values()].filter(a => a.cid === cid).sort((a, b) => a.at - b.at);
const isImg = a => /^image\//.test(a?.type || '');
async function shrink(file, max, q) {
  const url = URL.createObjectURL(file);
  try { const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight)), cv = document.createElement('canvas');
    cv.width = Math.round(img.naturalWidth * s); cv.height = Math.round(img.naturalHeight * s); const g = cv.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height); g.drawImage(img, 0, 0, cv.width, cv.height);
    const blob = await new Promise(r => cv.toBlob(r, 'image/jpeg', q)); return { blob, dataUrl: cv.toDataURL('image/jpeg', q) };
  } finally { URL.revokeObjectURL(url); }
}
async function addFiles(cid, files) {
  const c = S.containers.get(cid); if (!c || !canAttach() || !files?.length) return; const done = [];
  for (const f of files) {
    const ext = (f.name.split('.').pop() || '').toLowerCase(), img = /^image\//.test(f.type) && !/svg/.test(f.type);
    let blob = f, type = f.type, name = f.name, thumb = null;
    S.attBusy = `Uploading ${f.name}…`; render();
    try {
      if (img) { const big = await shrink(f, 1600, 0.75); blob = big.blob; type = 'image/jpeg'; name = name.replace(/\.[^.]+$/, '') + '.jpg'; thumb = (await shrink(f, 240, 0.6)).dataUrl; }
      else if (!OKEXT.includes(ext)) { toast(`${f.name}: this file type is not supported. Use photos, PDF, Word, Excel, PowerPoint, CSV, text or ZIP.`, 'bad'); continue; }
      if (!type) type = { pdf: 'application/pdf', csv: 'text/csv', txt: 'text/plain', zip: 'application/zip' }[ext] || 'application/octet-stream';
      if (blob.size > MAXB) { toast(`${f.name} is ${fsize(blob.size)}. Files must be 10 MB or smaller.`, 'bad'); continue; }
      const path = `${cid}/${(crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36))}-${name.replace(/[^\w.\-]+/g, '_').slice(-80)}`;
      await must(sb.storage.from('attachments').upload(path, blob, { contentType: type, upsert: false }));
      try { const row = await must(sb.from('attachments').insert({ container_id: cid, container_no: c.containerNo, name, type, size: blob.size, path, thumb, stage: c.status }).select().single()); S.atts.set(row.id, attFrom(row)); recount(); }
      catch (e) { await sb.storage.from('attachments').remove([path]); throw e; }
      done.push(name);
    } catch (e) { toast(img && !e?.message ? `${f.name}: this photo format cannot be read here. Use JPG or PNG.` : `${f.name}: ${errMsg(e)}`, 'bad'); }
  }
  S.attBusy = ''; render();
  if (done.length) { await log('Photos/files added', c, done.join(', ')); toast(`Added ${done.length} file${done.length > 1 ? 's' : ''} to ${c.containerNo}.`, 'ok'); }
}
async function loadThumbs(cid) {
  const need = attsOf(cid).filter(a => isImg(a) && !(a.id in S.thumbs)); if (!need.length) return;
  try { const rows = await must(sb.from('attachments').select('id,thumb').in('id', need.map(a => a.id))); rows.forEach(r => S.thumbs[r.id] = r.thumb || ''); } catch (e) {}
  scheduleRender();
}
async function signed(a, download) { const { data, error } = await sb.storage.from('attachments').createSignedUrl(a.path, 600, download ? { download: a.name } : undefined); if (error) throw error; return data.signedUrl; }
async function viewAtt(id) {
  const a = S.atts.get(id); if (!a) return;
  try { if (isImg(a)) { S.viewer = { id, url: await signed(a) }; render(); } else { location.href = await signed(a, true); } }
  catch (e) { toast(errMsg(e), 'bad'); }
}
async function deleteAtt(id) {
  const a = S.atts.get(id); if (!a) return;
  await must(sb.from('attachments').delete().eq('id', id)); await sb.storage.from('attachments').remove([a.path]);
  S.atts.delete(id); recount(); await log('Photo/file deleted', { containerNo: a.container_no, id: a.cid }, a.name);
}
function closeSheet() { S.viewer = null; S.attFor = null; S.attDel = null; render(); }
function vSheet() {
  if (!S.attFor) return ''; const c = S.containers.get(S.attFor); if (!c) { S.attFor = null; return ''; }
  const list = attsOf(c.id); let body;
  if (S.viewer) { const a = S.atts.get(S.viewer.id);
    body = `<div class="viewer"><img src="${esc(S.viewer.url)}" alt="${esc(a?.name || 'Photo')}"><div class="actions"><button type="button" class="btn" data-act="viewer-close">Back to all files</button><button type="button" class="btn" data-act="att-dl" data-aid="${esc(S.viewer.id)}">Download</button><span class="muted">${esc(a?.name || '')} · ${fsize(a?.size)}</span></div></div>`;
  } else {
    body = (canAttach() ? `<div class="drop" id="att-drop"><div class="actions"><label class="btn primary file-btn">Take photo<input type="file" id="att-cam" accept="image/*" capture="environment"></label><label class="btn file-btn">Choose photos or files<input type="file" id="att-files" multiple accept="image/*,.pdf,.docx,.xlsx,.pptx,.csv,.txt,.zip"></label></div><span class="hint">Optional. Add as many as you need, or drop files here. Photos are resized to 1600 px; other files up to 10 MB. Tick "Customer can see" to share a file on the customer portal.</span></div>` : `<p class="hint">${lockIcon} Your role can view attachments but not add them.</p>`)
      + (S.attBusy ? `<div class="note info">${esc(S.attBusy)}</div>` : '')
      + (list.length ? `<div class="tiles">${list.map(a => { const ext = (a.name.split('.').pop() || 'file').toUpperCase(), th = S.thumbs[a.id];
        return `<div class="tile"><button type="button" class="th" data-act="att-view" data-aid="${esc(a.id)}" aria-label="Open ${esc(a.name)}">${isImg(a) ? (th ? `<img src="${esc(th)}" alt="">` : 'Photo') : esc(ext.slice(0, 5))}</button>
          <div class="tb"><span class="nm" title="${esc(a.name)}">${esc(a.name)}</span><span class="muted">${fsize(a.size)} · ${fmtT(a.at)}</span><span class="muted">${who(a.by)}${a.stage ? ' · ' + (ST[a.stage] || '') : ''}</span>
          <label class="vis"><input type="checkbox" id="vis-${esc(a.id)}" data-vis="${esc(a.id)}" ${a.customer_visible ? 'checked' : ''} ${canAttach() ? '' : 'disabled'}>Customer can see</label></div>
          <div class="ta">${S.attDel === a.id ? `<button type="button" class="btn sm danger" data-act="att-del-yes" data-aid="${esc(a.id)}">Delete</button><button type="button" class="btn sm ghost" data-act="att-del-no">Keep</button>` : (isImg(a) ? '' : `<button type="button" class="btn sm" data-act="att-view" data-aid="${esc(a.id)}">Download</button>`) + (canDelAtt(a) ? `<button type="button" class="btn sm ghost" data-act="att-del" data-aid="${esc(a.id)}">Delete</button>` : '')}</div></div>`; }).join('')}</div>`
        : `<div class="empty"><b>No photos or files yet.</b><span>Seal photos, damage, survey reports or tally sheets can be attached at any stage.</span></div>`);
  }
  return `<div class="sheet" id="sheet-bg"><div class="sheet-in" role="dialog" aria-modal="true" aria-labelledby="sheet-h">
    <div class="sheet-h"><div style="display:grid;gap:6px;min-width:0"><h2 id="sheet-h">Photos &amp; files · ${list.length}</h2><div class="q-line"><span class="cno">${cnoHtml(c.containerNo)}</span>${pill(c.status)}<span class="muted">${esc(c.customer || '')} · ${esc(c.size || '')} · ${esc(c.item || '')}</span></div></div><button type="button" class="btn ghost" data-act="att-close" id="att-close">Close</button></div>
    ${body}</div></div>`;
}

/* ---------- job actions (server enforces FIFO and roles) ---------- */
async function startJob(id, bypass, fd) {
  const c = S.containers.get(id); if (!fd.mode) return toast('Choose a destuffing mode first.', 'bad');
  const r = await must(sb.rpc('start_job', { p_id: id, p_mode: fd.mode, p_bay: fd.bay || '', p_crew: fd.crew !== '' && fd.crew != null ? +fd.crew : null, p_remarks: fd.remarks || '', p_reason: fd.reason || '' }));
  S.open = null; S.form = {}; toast(`Clock started for ${c?.containerNo || 'container'}${r?.position > 1 ? ` (out of turn, position ${r.position})` : ''}.`, 'ok');
}
async function completeJob(id, fd) {
  const c = S.containers.get(id);
  const r = await must(sb.rpc('complete_job', { p_id: id, p_packages: fd.pkgs !== '' && fd.pkgs != null ? +fd.pkgs : null, p_remarks: fd.remarks || '' }));
  S.open = null; S.form = {}; const nx = fifo().filter(x => x.id !== id)[0];
  toast(`${c?.containerNo} completed in ${dur(r?.duration_ms)}.` + (nx ? ` Next in FIFO: ${nx.containerNo}.` : ''), 'ok');
}
async function requeueJob(id, fd) { await must(sb.rpc('requeue_job', { p_id: id, p_reason: fd.reason || '' })); S.open = null; S.form = {}; toast('Returned to the queue.', 'ok'); }
async function prioritise(id, fd) {
  const c = S.containers.get(id); if (!(fd.reason || '').trim()) return toast('Enter a reason.', 'bad');
  await must(sb.from('overrides').insert({ container_id: id, reason: fd.reason.trim() }));
  await log('Moved to front of queue', c, fd.reason.trim()); S.open = null; S.form = {}; toast(`${c.containerNo} moved to the front.`, 'ok');
}

/* ---------- events (bound once; ignored unless staff view is active) ---------- */
const active = () => S && document.body.dataset.view === 'staff';
document.addEventListener('click', e => {
  if (!active()) return;
  if (e.target.id === 'sheet-bg') { closeSheet(); return; }
  const b = e.target.closest('[data-act],[data-tab]'); if (!b) return;
  if (b.dataset.tab) { S.tab = b.dataset.tab; S.open = null; S.form = {}; S.confirmDel = null; if (b.dataset.filter) { resetFilters(); S.f.status = new Set([b.dataset.filter]); } render(); return; }
  const id = b.dataset.id, act = b.dataset.act, aid = b.dataset.aid, k = b.dataset.k;
  if (act.startsWith('open-')) { S.open = { type: act.slice(5), id }; S.form = {}; render(); const f = $('form[data-form] input,form[data-form] textarea'); if (f) f.focus({ preventScroll: true }); return; }
  const fns = {
    cancel: () => { S.open = null; S.form = {}; render(); },
    unprio: async () => { const c = S.containers.get(id); try { await must(sb.from('overrides').delete().eq('container_id', id)); await log('Priority removed', c, ''); toast('Priority removed.', 'ok'); } catch (err) { toast(errMsg(err), 'bad'); } },
    'add-rows': () => { for (let i = 0; i < 5; i++) newRow(); render(); },
    save: saveGrid, discard: () => { S.edits = {}; S.newRows = []; S.f.unsaved = false; render(); },
    del: () => { S.confirmDel = b.dataset.key; render(); }, 'del-no': () => { S.confirmDel = null; render(); }, 'del-yes': () => deleteRow(b.dataset.key),
    template: downloadTemplate, 'export-inv': exportInv, 'export-done': exportDone, 'sample-load': loadSample, 'sample-clear': clearSample,
    'run-all': () => { S.runAll = !S.runAll; render(); },
    att: () => { S.attFor = id; S.attBusy = ''; S.attDel = null; S.viewer = null; render(); loadThumbs(id); setTimeout(() => $('#att-close')?.focus({ preventScroll: true })); },
    'att-close': closeSheet, 'viewer-close': () => { S.viewer = null; render(); },
    'att-view': () => viewAtt(aid),
    'att-dl': async () => { const a = S.atts.get(aid); if (a) try { location.href = await signed(a, true); } catch (err) { toast(errMsg(err), 'bad'); } },
    'att-del': () => { S.attDel = aid; render(); }, 'att-del-no': () => { S.attDel = null; render(); },
    'att-del-yes': async () => { S.attDel = null; try { await deleteAtt(aid); toast('Deleted.', 'ok'); render(); } catch (err) { toast(errMsg(err), 'bad'); } },
    dd: () => { S.dd = S.dd === k ? null : k; S.ddq = ''; render(); },
    'f-clear': () => { if (k === 'dates') Object.assign(S.f, { arrFrom: '', arrTo: '', pnrFrom: '', pnrTo: '', files: '' }); else S.f[k] = new Set(); render(); },
    'f-all': () => { const q = S.ddq.trim().toLowerCase(); optsFor(k).filter(o => !q || String(o[1]).toLowerCase().includes(q)).forEach(o => S.f[k].add(o[0])); render(); },
    'f-reset': () => { resetFilters(); render(); },
    'f-unsaved': () => { S.f.unsaved = !S.f.unsaved; render(); },
    'cust-del': () => { S.confirmDel = 'cust:' + b.dataset.code; render(); },
    'cust-del-yes': async () => { S.confirmDel = null; try { await must(sb.from('customers').delete().eq('code', b.dataset.code)); S.customers.delete(b.dataset.code); await log('Customer deleted', null, b.dataset.code); toast('Customer deleted.', 'ok'); } catch (err) { toast(err.code === '23503' ? 'This customer still has containers. Change or delete them first.' : errMsg(err), 'bad'); } render(); },
  };
  (fns[act] || (() => {}))();
});
document.addEventListener('submit', async e => {
  if (!active()) return;
  const f = e.target.closest('form[data-form]'); if (!f) return; e.preventDefault(); if (S.busy) return;
  const fd = Object.fromEntries(new FormData(f)); S.busy = true; f.querySelectorAll('button').forEach(x => x.disabled = true);
  try {
    const id = f.dataset.id;
    if (f.dataset.form === 'cust-add') {
      const code = fd.code.trim().toUpperCase().replace(/\s+/g, '');
      if (!/^[A-Z0-9][A-Z0-9_-]{0,29}$/.test(code)) throw { message: 'Use capital letters, digits, - or _ for the code (up to 30).' };
      const row = await must(sb.from('customers').insert({ code, name: fd.name.trim() }).select().single()); S.customers.set(row.code, row);
      await log('Customer added', null, `${code} · ${fd.name.trim()}`); toast(`Added customer ${code}.`, 'ok');
    } else {
      const fn = { start: () => startJob(id, f.dataset.bypass === '1', fd), done: () => completeJob(id, fd), requeue: () => requeueJob(id, fd), prio: () => prioritise(id, fd) }[f.dataset.form];
      if (fn) await fn();
    }
  } catch (err) { toast(err.code === '23505' ? 'That customer code already exists.' : errMsg(err), 'bad'); }
  finally { S.busy = false; render(); }
});
document.addEventListener('input', e => {
  if (!active()) return; const t = e.target;
  if (t.matches('.grid input')) {
    const key = t.dataset.key, k = t.dataset.col; let v = t.value;
    if (k === 'containerNo' || k === 'customer') { const up = k === 'containerNo' ? v.toUpperCase().replace(/\s/g, '') : v.toUpperCase(); if (up !== v) { const p = t.selectionStart; t.value = up; try { t.setSelectionRange(p, p); } catch (x) {} } v = up.trim(); }
    const wasBlank = key[0] === 'n' && rowBlank(key);
    setEdit(key, k, v); t.closest('td').classList.toggle('dirty', !!(S.edits[key] && S.edits[key][k] !== undefined));
    if (wasBlank && !rowBlank(key)) scheduleRender(); else refreshRow(key); return;
  }
  const f = t.closest('form[data-form]'); if (f && t.name) { S.form[t.name] = t.value; return; }
  if (t.id === 'inv-q') { S.q = t.value; scheduleRender(); }
  if (t.id === 'dd-q') { S.ddq = t.value; scheduleRender(); }
});
document.addEventListener('change', async e => {
  if (!active()) return; const t = e.target;
  if (t.id === 'viewas') { S.viewAs = t.value || null; S.open = null; if (S.tab === 'team' && !can.admin()) S.tab = 'dash'; render(); }
  else if (t.id === 'done-range') { S.doneRange = t.value; render(); }
  else if (t.id === 'inv-file') { onUpload(t.files[0]); t.value = ''; }
  else if (t.id === 'att-cam' || t.id === 'att-files') { const fs = [...t.files]; t.value = ''; addFiles(S.attFor, fs); }
  else if (t.dataset.fk) { const set = S.f[t.dataset.fk]; t.checked ? set.add(t.value) : set.delete(t.value); render(); }
  else if (t.dataset.fd) { S.f[t.dataset.fd] = t.value; render(); }
  else if (t.dataset.vis) { try { await must(sb.from('attachments').update({ customer_visible: t.checked }).eq('id', t.dataset.vis)); const a = S.atts.get(t.dataset.vis); if (a) a.customer_visible = t.checked; toast(t.checked ? 'Shared with the customer.' : 'Hidden from the customer.', 'ok'); } catch (err) { t.checked = !t.checked; toast(errMsg(err), 'bad'); } }
  else if (t.dataset.roleUid) {
    const uid = t.dataset.roleUid, p = S.profiles.get(uid), patch = { role: t.value }; if (t.value !== 'customer') patch.customer_code = null;
    try { await must(sb.from('profiles').update(patch).eq('id', uid)); Object.assign(p, patch); await log('User access changed', null, `${p.email}: ${ROLES[t.value]}`); toast(t.value === 'customer' ? 'Now pick which customer they belong to.' : 'Access updated.', 'ok'); render(); }
    catch (err) { toast(errMsg(err), 'bad'); render(); }
  }
  else if (t.dataset.custUid) {
    const uid = t.dataset.custUid, p = S.profiles.get(uid);
    try { await must(sb.from('profiles').update({ customer_code: t.value || null }).eq('id', uid)); p.customer_code = t.value || null; await log('User access changed', null, `${p.email}: customer ${t.value || 'none'}`); toast('Customer link updated.', 'ok'); render(); }
    catch (err) { toast(errMsg(err), 'bad'); render(); }
  }
  else if (t.dataset.custName) {
    try { await must(sb.from('customers').update({ name: t.value.trim() }).eq('code', t.dataset.custName)); toast('Customer name saved.', 'ok'); } catch (err) { toast(errMsg(err), 'bad'); }
  }
  else if (t.closest('form[data-form]') && t.name) S.form[t.name] = t.value;
});
document.addEventListener('keydown', e => {
  if (!active()) return; const t = e.target;
  if (e.key === 'Escape' && S.attFor) { if (S.viewer) { S.viewer = null; render(); } else closeSheet(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && S.tab === 'inv') { e.preventDefault(); saveGrid(); return; }
  if (!t.matches?.('.grid input')) return;
  const dir = (e.key === 'ArrowDown' || (e.key === 'Enter' && !e.shiftKey)) ? 1 : (e.key === 'ArrowUp' || (e.key === 'Enter' && e.shiftKey)) ? -1 : 0;
  if (!dir || (t.type !== 'text' && e.key.startsWith('Arrow'))) return;
  e.preventDefault(); const keys = S.gridKeys; let i = keys.indexOf(t.dataset.key) + dir;
  while (i >= 0 && i < keys.length) { const el = document.getElementById(cellId(keys[i], t.dataset.col)); if (el && !el.disabled) { el.focus(); try { el.select(); } catch (x) {} return; } i += dir; }
});
document.addEventListener('paste', e => {
  if (!active()) return; const t = e.target.closest?.('.grid input'); if (!t) return;
  const txt = (e.clipboardData?.getData('text/plain') || '').replace(/\r/g, '');
  if (!/[\t\n]/.test(txt.replace(/\n+$/, ''))) return;
  e.preventDefault(); const rows = txt.split('\n'); while (rows.length && !rows[rows.length - 1].trim()) rows.pop();
  const m = rows.map(r => r.split('\t')); if (m.length && /container|cntr/i.test(m[0].join(' '))) m.shift();
  if (m.length) applyPaste(t.dataset.key, t.dataset.col, m);
});
document.addEventListener('dragover', e => { if (!active()) return; const d = e.target.closest?.('#att-drop'); if (!d) return; e.preventDefault(); d.classList.add('over'); });
document.addEventListener('dragleave', e => { const d = e.target.closest?.('#att-drop'); if (d) d.classList.remove('over'); });
document.addEventListener('drop', e => { if (!active()) return; const d = e.target.closest?.('#att-drop'); if (!d) return; e.preventDefault(); d.classList.remove('over'); addFiles(S.attFor, [...(e.dataTransfer?.files || [])]); });
window.addEventListener('beforeunload', e => { if (active() && pendingCount()) { e.preventDefault(); e.returnValue = ''; } });

return {
  start(profile) {
    if (S && S.uid === profile.id && S.ch) { S.me = profile; render(); return; }
    fresh(profile); shell(); subscribe();
  },
  stop() { if (S?.ch) sb.removeChannel(S.ch); S = null; },
};
})();
