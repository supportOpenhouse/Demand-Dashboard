// GET /api/core-home/details?id=<home_id>
// Proxies the external GET /get-home-details/?id=... — the current listing state
// for a home. Used to (a) prefill the Update Home modal and (b) show the live
// listing_status badge (Coming Soon / Available / Sold) for a dashboard row.
const { requireAuth, setCors } = require('../_auth');
const { coreFetch } = require('../_core');

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ success: false, error: 'Method not allowed' });

  const user = await requireAuth(req, res);
  if (!user) return;

  const { id } = req.query;
  if (!id) return res.status(400).json({ success: false, error: 'id is required' });

  const { ok, status, data } = await coreFetch('/get-home-details/', { query: { id } });
  if (!ok) return res.status(status).json({ success: false, error: data.error || `Upstream ${status}` });
  return res.status(200).json({ success: true, home: data });
};
