// GET /api/core-home/floor-plan-lookup?society=&bhk=&area=&city=
// Looks up candidate floor plan images for a unit from the private Floor Plans
// Google Sheet. Ranked best-first; the Update Home modal takes the top hit as
// the suggested plan and lets the operator view or replace it.
const { requireAuth, setCors } = require('../_auth');
const { getFloorPlanRows, matchFloorPlans } = require('../_sheets');

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ success: false, error: 'Method not allowed' });

  const user = await requireAuth(req, res);
  if (!user) return;

  const { society, bhk, area, city } = req.query;
  if (!society) return res.status(400).json({ success: false, error: 'society is required' });

  try {
    const rows = await getFloorPlanRows();
    const matches = matchFloorPlans(rows, { society, bhk, area, city });
    return res.status(200).json({
      success: true,
      count: matches.length,
      matches: matches.map(m => ({
        url: m.url, society: m.society, bhk: m.bhk, area: m.area,
        tower: m.tower, unit: m.unit,
      })),
    });
  } catch (err) {
    console.error('[/api/core-home/floor-plan-lookup]', err.message);
    // A misconfigured/unshared sheet must not break opening the modal — the
    // caller treats a failure as "no suggestion".
    return res.status(200).json({ success: false, error: err.message, matches: [] });
  }
};
