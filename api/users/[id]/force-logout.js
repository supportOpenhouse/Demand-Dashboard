const { pool } = require('../../_db');
const { requireAuth, requireAdmin, setCors } = require('../../_auth');

// POST /api/users/:id/force-logout
// Stamps demand_users.force_logout_at = NOW() for the target user.
// requireAuth then rejects any JWT they previously held (token.iat < force_logout_at).
module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const user = await requireAuth(req, res);
  if (!user) return;
  if (!requireAdmin(user, res)) return;

  const { id } = req.query;
  if (!id) return res.status(400).json({ success: false, error: 'User id is required' });

  if (parseInt(id) === user.id) {
    return res.status(400).json({ success: false, error: 'Cannot force-logout yourself' });
  }

  try {
    const { rows } = await pool.query(
      `UPDATE demand_users SET force_logout_at = NOW(), updated_at = NOW()
       WHERE id = $1 RETURNING id, email`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ success: false, error: 'User not found' });
    res.status(200).json({ success: true, email: rows[0].email });
  } catch (err) {
    console.error('[/api/users/:id/force-logout]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};
