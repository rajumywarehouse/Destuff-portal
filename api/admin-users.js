/* Vercel serverless function: superadmin-only user management (no emails are ever sent).
   Needs two Environment Variables in Vercel → Project → Settings → Environment Variables:
     SUPABASE_URL               e.g. https://abcd.supabase.co
     SUPABASE_SERVICE_ROLE_KEY  the secret service_role key (never put this in the website files)
   Optional: LOGIN_DOMAIN (default "cfs.local") — must match LOGIN_DOMAIN in assets/config.js. */
'use strict';

const ROLES = ['pending', 'superadmin', 'both', 'ops', 'supervisor', 'readonly', 'customer'];
const ID_RE = /^[a-z0-9][a-z0-9._-]{2,29}$/;

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

module.exports = async function handler(req, res) {
  const BASE = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  const DOMAIN = (process.env.LOGIN_DOMAIN || 'cfs.local').toLowerCase();
  if (req.method !== 'POST') return send(res, 405, { error: 'Use POST.' });
  if (!BASE || !KEY) return send(res, 500, { error: 'User management is not set up yet. Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in Vercel → Settings → Environment Variables, then redeploy.' });

  const api = async (path, opts = {}) => {
    const r = await fetch(BASE + path, { ...opts, headers: { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', ...(opts.headers || {}) } });
    const text = await r.text(); let data = null; try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
    return { ok: r.ok, status: r.status, data };
  };
  const errText = d => (d && (d.msg || d.message || d.error_description || d.error)) || 'Unknown error';
  const audit = (by, action, detail) => api('/rest/v1/audit', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ by, action, detail }) });

  try {
    /* 1. Who is calling? Must be a signed-in superadmin. */
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) return send(res, 401, { error: 'Sign in first.' });
    const me = await api('/auth/v1/user', { headers: { Authorization: 'Bearer ' + token } });
    if (!me.ok || !me.data?.id) return send(res, 401, { error: 'Your session has expired. Sign in again.' });
    const prof = await api(`/rest/v1/profiles?id=eq.${encodeURIComponent(me.data.id)}&select=role`);
    if (!prof.ok || prof.data?.[0]?.role !== 'superadmin') return send(res, 403, { error: 'Only a superadmin can manage users.' });
    const callerId = me.data.id;

    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    body = body || {};
    const action = body.action;

    /* 2. Actions */
    if (action === 'create') {
      const username = String(body.username || '').trim().toLowerCase();
      const password = String(body.password || '');
      const fullName = String(body.full_name || '').trim().slice(0, 120);
      const role = String(body.role || '');
      const customer = body.customer_code ? String(body.customer_code).trim().toUpperCase() : null;
      if (!ID_RE.test(username)) return send(res, 400, { error: 'User ID must be 3–30 characters: lowercase letters, digits, dot, dash or underscore, starting with a letter or digit.' });
      if (password.length < 8) return send(res, 400, { error: 'Password must be at least 8 characters.' });
      if (!fullName) return send(res, 400, { error: 'Enter the person\'s name.' });
      if (!ROLES.includes(role) || role === 'pending') return send(res, 400, { error: 'Pick a role.' });
      if (role === 'customer' && !customer) return send(res, 400, { error: 'Pick which customer this login belongs to.' });
      if (customer) {
        const c = await api(`/rest/v1/customers?code=eq.${encodeURIComponent(customer)}&select=code`);
        if (!c.ok || !c.data?.length) return send(res, 400, { error: `Customer code ${customer} does not exist.` });
      }
      const taken = await api(`/rest/v1/profiles?username=eq.${encodeURIComponent(username)}&select=id`);
      if (taken.ok && taken.data?.length) return send(res, 409, { error: 'That User ID is already taken.' });

      const email = `${username}@${DOMAIN}`;
      const created = await api('/auth/v1/admin/users', { method: 'POST', body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { full_name: fullName, username } }) });
      if (!created.ok) {
        const m = errText(created.data);
        return send(res, created.status === 422 && /already/i.test(m) ? 409 : 400, { error: /already/i.test(m) ? 'That User ID is already taken.' : m });
      }
      const uid = created.data.id || created.data.user?.id;
      const up = await api('/rest/v1/profiles?on_conflict=id', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify({ id: uid, email, full_name: fullName, username, role, customer_code: role === 'customer' ? customer : null, disabled: false }) });
      if (!up.ok) {
        await api(`/auth/v1/admin/users/${uid}`, { method: 'DELETE' });
        return send(res, 500, { error: 'Could not save the user profile: ' + errText(up.data) });
      }
      await audit(callerId, 'User created', `${username} · ${role}${customer ? ' · ' + customer : ''}`);
      return send(res, 200, { ok: true, id: uid, username });
    }

    const id = String(body.id || '');
    if (!/^[0-9a-f-]{36}$/i.test(id)) return send(res, 400, { error: 'Missing user.' });
    const target = await api(`/rest/v1/profiles?id=eq.${id}&select=username,email`);
    const label = target.data?.[0]?.username || target.data?.[0]?.email || id;

    if (action === 'reset') {
      const password = String(body.password || '');
      if (password.length < 8) return send(res, 400, { error: 'Password must be at least 8 characters.' });
      const r = await api(`/auth/v1/admin/users/${id}`, { method: 'PUT', body: JSON.stringify({ password }) });
      if (!r.ok) return send(res, 400, { error: errText(r.data) });
      await audit(callerId, 'Password reset', label);
      return send(res, 200, { ok: true });
    }
    if (action === 'disable' || action === 'enable') {
      if (id === callerId) return send(res, 400, { error: 'You cannot disable your own login.' });
      const off = action === 'disable';
      const r = await api(`/auth/v1/admin/users/${id}`, { method: 'PUT', body: JSON.stringify({ ban_duration: off ? '876000h' : 'none' }) });
      if (!r.ok) return send(res, 400, { error: errText(r.data) });
      await api(`/rest/v1/profiles?id=eq.${id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ disabled: off }) });
      await audit(callerId, off ? 'User disabled' : 'User enabled', label);
      return send(res, 200, { ok: true });
    }
    if (action === 'delete') {
      if (id === callerId) return send(res, 400, { error: 'You cannot delete your own login.' });
      const r = await api(`/auth/v1/admin/users/${id}`, { method: 'DELETE' });
      if (!r.ok && r.status !== 404) return send(res, 400, { error: errText(r.data) });
      await api(`/rest/v1/profiles?id=eq.${id}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
      await audit(callerId, 'User deleted', label);
      return send(res, 200, { ok: true });
    }
    return send(res, 400, { error: 'Unknown action.' });
  } catch (e) {
    return send(res, 500, { error: 'Server error: ' + (e && e.message ? e.message : String(e)) });
  }
};
