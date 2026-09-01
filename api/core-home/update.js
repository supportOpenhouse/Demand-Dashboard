// POST /api/core-home/update
// Proxies the external PATCH /update-home/ (partial update). The browser POSTs a
// camelCase body ({ homeId, listingStatus: 'CS', ...only the fields to change });
// we forward it as a PATCH with the server-held key. Publishing always moves the
// home to Coming Soon (listingStatus = 'CS') and the backend auto-adds a Coming
// Soon photo. Admin + manager only.
const { requireAuth, canEdit, setCors } = require('../_auth');
const { coreFetch } = require('../_core');

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  // Accept POST (our app convention) and forward upstream as PATCH.
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });

  const user = await requireAuth(req, res);
  if (!user) return;
  if (!canEdit(user)) return res.status(403).json({ success: false, error: 'Viewer access is read-only' });

  const body = req.body || {};
  if (body.homeId == null && body.home_id == null) {
    return res.status(400).json({ success: false, error: 'homeId is required' });
  }
  // Enforce the Coming Soon contract up front so a mistaken caller can't send a
  // different status. The upstream also rejects anything but 'CS'.
  if (body.listingStatus == null && body.listing_status == null) {
    body.listingStatus = 'CS';
  }

  const { ok, status, data } = await coreFetch('/update-home/', { method: 'PATCH', body });
  if (!ok) {
    // Upstream answers a failed apply with a single generic string
    // ("Failed to update home.") and no field name, so log what we actually
    // sent — otherwise a 500 is unattributable. Values are logged for the
    // small, non-sensitive fields; the rest are logged by key only.
    const shape = {};
    for (const [k, v] of Object.entries(body)) {
      shape[k] = (v && typeof v === 'object')
        ? (Array.isArray(v) ? `array(${v.length})` : `object{${Object.keys(v).join(',')}}`)
        : (k === 'floorPlanUrl' ? String(v) : typeof v === 'string' ? `"${v}"` : v);
    }
    console.error('[/api/core-home/update] upstream', status, data.error || '', 'payload:', JSON.stringify(shape));
    return res.status(status).json({
      success: false,
      error: data.error || `Upstream ${status}`,
      // Field list only — lets the operator report which fields were in play
      // without exposing values in the browser.
      sentFields: Object.keys(body),
    });
  }
  return res.status(200).json({
    success: true,
    message: data.message || 'Home updated successfully',
    homeId: data.homeId != null ? data.homeId : (body.homeId != null ? body.homeId : body.home_id),
    home: data.home || null,
  });
};
