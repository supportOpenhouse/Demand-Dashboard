const { pool, logActivity } = require('../_db');
const { requireAuth, requireAdmin, setCors } = require('../_auth');

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await requireAuth(req, res);
  if (!user) return;
  if (!requireAdmin(user, res)) return;

  const { id } = req.query;
  if (!id) return res.status(400).json({ success: false, error: 'User id is required' });

  if (req.method === 'PUT') {
    const { role } = req.body;
    const validRoles = ['admin', 'manager', 'viewer'];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ success: false, error: 'Invalid role. Must be: admin, manager, viewer' });
    }

    // Fetch the target up-front so we can capture the previous role for the
    // activity log AND reuse it for the "last admin" guard below.
    const targetRes = await pool.query(
      'SELECT id, email, name, role FROM demand_users WHERE id = $1',
      [id]
    );
    if (!targetRes.rows.length) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    const target = targetRes.rows[0];
    const prevRole = target.role;

    // Prevent demoting the last admin — system would lock itself out of user management.
    if (role !== 'admin' && prevRole === 'admin') {
      const admins = await pool.query("SELECT COUNT(*) FROM demand_users WHERE role = 'admin'");
      if (parseInt(admins.rows[0].count) <= 1) {
        return res.status(400).json({ success: false, error: 'Cannot remove the last admin' });
      }
    }

    const { rows } = await pool.query(
      `UPDATE demand_users SET role = $1, updated_at = NOW() WHERE id = $2
       RETURNING id, email, name, picture, role, created_at, updated_at`,
      [role, id]
    );
    if (!rows.length) return res.status(404).json({ success: false, error: 'User not found' });

    // Audit: record every role transition (skip no-op writes where role is unchanged).
    if (prevRole !== role) {
      logActivity(null, 'user_role_change', 'user', user, {
        target_user_id: target.id,
        target_email: target.email,
        target_name: target.name,
        old_role: prevRole,
        new_role: role,
      });
    }

    return res.status(200).json({ success: true, user: rows[0] });
  }

  if (req.method === 'DELETE') {
    if (parseInt(id) === user.id) {
      return res.status(400).json({ success: false, error: 'Cannot delete yourself' });
    }

    const target = await pool.query('SELECT role FROM demand_users WHERE id = $1', [id]);
    if (target.rows[0]?.role === 'admin') {
      const admins = await pool.query("SELECT COUNT(*) FROM demand_users WHERE role = 'admin'");
      if (parseInt(admins.rows[0].count) <= 1) {
        return res.status(400).json({ success: false, error: 'Cannot delete the last admin' });
      }
    }

    const { rowCount } = await pool.query('DELETE FROM demand_users WHERE id = $1', [id]);
    if (!rowCount) return res.status(404).json({ success: false, error: 'User not found' });
    return res.status(200).json({ success: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
