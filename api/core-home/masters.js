// GET /api/core-home/masters
// Proxies the external GET /home-form-masters/ — property types + the three
// multiselect masters (overlooking, why-choose, documentation & loan). Used to
// populate the Update Home modal's dropdowns.
const { requireAuth, setCors } = require('../_auth');
const { coreFetch } = require('../_core');

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ success: false, error: 'Method not allowed' });

  const user = await requireAuth(req, res);
  if (!user) return;

  const { ok, status, data } = await coreFetch('/home-form-masters/');
  if (!ok) return res.status(status).json({ success: false, error: data.error || `Upstream ${status}` });
  return res.status(200).json({ success: true, masters: data });
};
