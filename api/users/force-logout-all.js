const { pool } = require('../_db');
const { requireAuth, requireAdmin, setCors } = require('../_auth');

// POST /api/users/force-logout-all
// Bulk version of /api/users/:id/force-logout — stamps force_logout_at = NOW()
// on every user except the calling admin, so requireAuth rejects every JWT
// issued before this moment (token.iat < force_logout_at).
//
// The caller is excluded for the same reason the single-user route refuses
// self-logout: an admin who signs themselves out mid-action loses the session
// they'd need to undo it. They can still use Sign out normally.
module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const user = await requireAuth(req, res);
  if (!user) return;
  if (!requireAdmin(user, res)) return;

  try {
    const { rows } = await pool.query(
      `UPDATE demand_users SET force_logout_at = NOW(), updated_at = NOW()
       WHERE id <> $1 RETURNING id, email`,
      [user.id]
    );
    res.status(200).json({ success: true, count: rows.length });
  } catch (err) {
    console.error('[/api/users/force-logout-all]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};
