const { requireAuth, setCors } = require('./_auth');

const PHOTOS_URL = 'http://backend-prod-561394753846.asia-south2.run.app/api/v1/oh/get-homes-photo/';

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const user = await requireAuth(req, res);
  if (!user) return;

  try {
    const upstream = await fetch(PHOTOS_URL);
    if (!upstream.ok) {
      res.status(502).json({ success: false, error: `Upstream returned ${upstream.status}` });
      return;
    }
    const data = await upstream.json();
    res.json({ success: true, homePhoto: data.homePhoto || [] });
  } catch (e) {
    console.error('[home-photos]', e.message);
    res.status(500).json({ success: false, error: 'Failed to fetch home photos' });
  }
};
