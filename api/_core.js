// Shared client for the external "Core" (Django) home API. Centralises the base
// URL and the X-Demand-Dashboard-Key secret so route handlers never duplicate
// them and the key never reaches the browser (all calls are server-side proxies).
//
// Env:
//   X_DEMAND_DASHBOARD_KEY  — the auth secret sent as the X-Demand-Dashboard-Key
//                             header (falls back to DEMAND_DASHBOARD_API_KEY).
//   CORE_API_BASE_URL       — override the API base; defaults to the production
//                             host documented in docs/update-home-api.md.

// NOTE: must be https. The host 302-redirects http→https, and Node's fetch
// downgrades a redirected POST/PATCH to GET and drops the body — so an http base
// would silently turn update-home into a no-op GET.
const CORE_BASE = (process.env.CORE_API_BASE_URL
  || 'https://backend-prod-561394753846.asia-south2.run.app/api/v1/oh').replace(/\/+$/, '');

const CORE_KEY = process.env.X_DEMAND_DASHBOARD_KEY
  || process.env.DEMAND_DASHBOARD_API_KEY
  || '';

// Calls the external API and normalises the result to { ok, status, data }.
// `data` is parsed JSON when possible, otherwise { error: <raw text> }.
// A missing key short-circuits to 503 (matching the upstream contract) so we
// never fire an unauthenticated request.
async function coreFetch(path, { method = 'GET', query, body } = {}) {
  if (!CORE_KEY) {
    return {
      ok: false,
      status: 503,
      data: { error: 'Server misconfiguration: X_DEMAND_DASHBOARD_KEY is not set' },
    };
  }

  let url = CORE_BASE + path;
  if (query && typeof query === 'object') {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v != null && v !== '') qs.set(k, String(v));
    }
    const s = qs.toString();
    if (s) url += (url.includes('?') ? '&' : '?') + s;
  }

  const headers = { 'X-Demand-Dashboard-Key': CORE_KEY };
  let payload;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  let upstream;
  try {
    upstream = await fetch(url, { method, headers, body: payload });
  } catch (e) {
    return { ok: false, status: 502, data: { error: 'Failed to reach home service: ' + e.message } };
  }

  const text = await upstream.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text || `Upstream returned ${upstream.status}` };
  }
  return { ok: upstream.ok, status: upstream.status, data };
}

module.exports = { coreFetch, CORE_BASE };
