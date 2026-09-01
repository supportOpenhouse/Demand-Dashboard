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

  let { ok, status, data } = await coreFetch('/update-home/', { method: 'PATCH', body });

  // Salvage: upstream 500s on `furnishing_data` whenever an item's name is
  // duplicated in the Furnishing master table — its upsert does a get-by-name
  // and hits MultipleObjectsReturned. Confirmed on "Almirahs" and "Modular
  // Kitchen"; names that exist once, or not at all, save fine.
  //
  // One bad name otherwise costs the entire publish, so retry once without the
  // furnishings and report them as skipped. Safe to retry: update-home is a
  // partial update and is not atomic, so the first attempt already applied
  // whatever it could before failing.
  let skippedFurnishing = null;
  if (!ok && Array.isArray(body.furnishingData) && body.furnishingData.length) {
    const { furnishingData, ...withoutFurnishing } = body;
    const retry = await coreFetch('/update-home/', { method: 'PATCH', body: withoutFurnishing });
    if (retry.ok) {
      ok = true; status = retry.status; data = retry.data;
      skippedFurnishing = furnishingData.map(f => f && f.name).filter(Boolean);
      console.warn('[/api/core-home/update] published without furnishings for home',
        body.homeId, '- upstream rejected:', skippedFurnishing.join(', '));
    }
  }

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
    skippedFurnishing,
  });
};
