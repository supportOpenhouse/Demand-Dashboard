// POST /api/core-home/layout-resolve
// Proxies the external POST /layouts/resolve/ — matches a layout on the society,
// or creates one and attaches it to Society.layouts.
//
// The browser sends the camelCase payload the upstream expects; we forward it
// with the server-held key. Admin + manager only, since createIfMissing writes.
//
// NOTE on duplicates: upstream matches ONLY against layouts already on the
// society's M2M, and that M2M is still under-populated (many layouts are linked
// to homes but never added to their society). So a "no match" here does not mean
// the layout doesn't exist. The caller checks the home's own known layouts
// locally before offering to create — see uhLocalLayoutMatch() in app.js.
const { requireAuth, canEdit, setCors } = require('../_auth');
const { coreFetch } = require('../_core');

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });

  const user = await requireAuth(req, res);
  if (!user) return;
  if (!canEdit(user)) return res.status(403).json({ success: false, error: 'Viewer access is read-only' });

  const body = req.body || {};
  if (body.societyId == null && body.society_id == null) {
    return res.status(400).json({ success: false, error: 'societyId is required' });
  }
  if (body.createIfMissing && !String(body.name || '').trim()) {
    return res.status(400).json({ success: false, error: 'A layout name is required to create one' });
  }

  const { ok, status, data } = await coreFetch('/layouts/resolve/', { method: 'POST', body });
  if (!ok) return res.status(status).json({ success: false, error: data.error || `Upstream ${status}` });

  return res.status(200).json({
    success: true,
    layoutId: data.layoutId != null ? data.layoutId : null,
    created: !!data.created,
    matchedOn: data.matchedOn || null,
  });
};
