// GET /api/loan/homes   — PUBLIC, no authentication.
//
// The Openhouse-property picker on the loan form: live listings only (a home on
// core, not Sold / Dead, not cancelled or replicated in supply, never a test
// unit). Returns just what the picker shows — the home id and a title — nothing
// about owners or prices.
const { pool, TEST_SOCIETIES } = require('../_db');
const { setCors } = require('../_auth');

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ detail: 'Method not allowed', code: 'method_not_allowed' });
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (p.core_home_id) p.core_home_id AS home_id, p.society_name, p.tower_no, p.unit_no, p.city
         FROM properties p LEFT JOIN demand_details dd ON dd.uid = p.uid
        WHERE p.core_home_id IS NOT NULL
          AND COALESCE(dd.availability_status, 'Available') NOT IN ('Sold', 'Dead')
          AND NOT COALESCE(p.is_dead, false) AND NOT COALESCE(p.is_token_refunded, false)
          AND NOT COALESCE(p.replicated, false)
          AND NOT (TRIM(COALESCE(p.society_name, '')) = ANY($1))
        ORDER BY p.core_home_id, p.updated_at DESC NULLS LAST`, [TEST_SOCIETIES || []]);
    const homes = rows.map((r) => ({
      homeId: r.home_id,
      title: [String(r.society_name || '').trim(),
              String(r.tower_no || '').trim() && `Tower: ${String(r.tower_no).trim()}`,
              String(r.unit_no || '').trim() && `Unit: ${String(r.unit_no).trim()}`,
              String(r.city || '').trim()].filter(Boolean).join(' · '),
      city: r.city || null,
    })).sort((a, b) => a.title.localeCompare(b.title));
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.status(200).json({ homes });
  } catch (err) {
    console.error('[/api/loan/homes]', err.message);
    return res.status(500).json({ detail: 'Could not load properties', code: 'server_error' });
  }
};
