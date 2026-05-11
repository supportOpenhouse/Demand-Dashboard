const { pool } = require('../_db');
const { requireAuth, requireAdmin, setCors } = require('../_auth');

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await requireAuth(req, res);
  if (!user) return;
  if (!requireAdmin(user, res)) return;

  if (req.method === 'GET') {
    const { rows } = await pool.query(
      'SELECT id, email, name, picture, role, created_at, updated_at FROM demand_users ORDER BY created_at'
    );
    return res.status(200).json({ success: true, users: rows });
  }

  if (req.method === 'POST') {
    const { email, role } = req.body;
    if (!email || !email.includes('@')) {
      return res.status(400).json({ success: false, error: 'Valid email is required' });
    }

    const cleanEmail = email.toLowerCase().trim();
    const validRoles = ['admin', 'manager', 'viewer'];
    const userRole = validRoles.includes(role) ? role : 'viewer';

    const existing = await pool.query('SELECT id FROM demand_users WHERE email = $1', [cleanEmail]);
    if (existing.rows.length) {
      return res.status(409).json({ success: false, error: 'User already exists' });
    }

    try {
      const { rows } = await pool.query(
        `INSERT INTO demand_users (email, role) VALUES ($1, $2)
         RETURNING id, email, name, picture, role, created_at, updated_at`,
        [cleanEmail, userRole]
      );
      return res.status(201).json({ success: true, user: rows[0] });
    } catch (err) {
      console.error('[/api/users POST]', err.message);
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
