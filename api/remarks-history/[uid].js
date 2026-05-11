const { pool } = require('../_db');
const { requireAuth, requireAdmin, setCors } = require('../_auth');

// Returns the full audit trail of internal_remarks edits for a property.
// Reads from activity_logs (append-only) so every prior value is preserved
// even if the live remark has since been edited or cleared.
//
// Admin-only by design — the user explicitly asked that the trail not be
// visible to editors/viewers.
module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const user = await requireAuth(req, res);
  if (!user) return;
  if (!requireAdmin(user, res)) return;

  const { uid } = req.query;
  if (!uid) return res.status(400).json({ success: false, error: 'uid is required' });

  try {
    const { rows } = await pool.query(
      `SELECT actor_email, actor_name, details, created_at
         FROM activity_logs
        WHERE uid = $1
          AND dashboard = 'Demand Dashboard'
          AND category = 'text'
          AND details->>'field' = 'internal_remarks'
        ORDER BY created_at DESC`,
      [uid]
    );

    const history = rows.map(r => ({
      actor_email: r.actor_email,
      actor_name: r.actor_name,
      value: (r.details && r.details.value) || '',
      created_at: r.created_at,
    }));

    res.status(200).json({ success: true, history });
  } catch (err) {
    console.error('[/api/remarks-history]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};
