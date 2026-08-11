// GET /api/core-home/public-masters?city=Gurgaon
// Proxies the external GET /get-public-masters/?city=... — used for the society
// dropdown (societies scoped to the property's city).
const { requireAuth, setCors } = require('../_auth');
const { coreFetch } = require('../_core');

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ success: false, error: 'Method not allowed' });

  const user = await requireAuth(req, res);
  if (!user) return;

  const { city } = req.query;
  const { ok, status, data } = await coreFetch('/get-public-masters/', { query: { city } });
  if (!ok) return res.status(status).json({ success: false, error: data.error || `Upstream ${status}` });
  return res.status(200).json({ success: true, publicMasters: data });
};
