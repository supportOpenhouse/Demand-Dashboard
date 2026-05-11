const { pool, ensureTable, logActivity } = require('../_db');
const { requireAuth, canEdit, setCors } = require('../_auth');

// Pipeline tracking (demand_status + 8 stage dates) was removed from the UI.
// Schema columns remain but are no longer writable through this endpoint.
const EDITOR_FIELDS = ['internal_remarks'];
const ADMIN_ONLY_FIELDS = ['listing_price'];
const TEXT_FIELDS = ['internal_remarks'];
const MAX_LEN = 5000;

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const user = await requireAuth(req, res);
  if (!user) return;

  if (!canEdit(user)) {
    return res.status(403).json({ success: false, error: 'Viewer access is read-only' });
  }

  try {
    await ensureTable();

    const { uid } = req.query;
    if (!uid) return res.status(400).json({ success: false, error: 'uid is required' });

    const updates = {};
    const isAdmin = user.role === 'admin';

    for (const field of [...EDITOR_FIELDS, ...ADMIN_ONLY_FIELDS]) {
      if (req.body[field] === undefined) continue;

      if (ADMIN_ONLY_FIELDS.includes(field) && !isAdmin) {
        return res.status(403).json({
          success: false,
          error: `Only admins can edit ${field}`,
        });
      }

      const raw = req.body[field];

      if (field === 'listing_price') {
        if (raw === null || raw === '' || raw === undefined) {
          updates[field] = null;
        } else {
          const num = parseFloat(raw);
          if (isNaN(num) || num < 0) {
            return res.status(400).json({ success: false, error: 'listing_price must be a non-negative number' });
          }
          updates[field] = num;
        }
      } else if (TEXT_FIELDS.includes(field)) {
        const val = String(raw || '').trim();
        if (val.length > MAX_LEN) {
          return res.status(400).json({ success: false, error: `${field} exceeds ${MAX_LEN} characters` });
        }
        updates[field] = val;
      }
    }

    if (!Object.keys(updates).length) {
      return res.status(400).json({ success: false, error: 'No valid fields to update' });
    }

    const fields = Object.keys(updates);
    const values = Object.values(updates);

    const insertCols = ['uid', ...fields, 'updated_by'].map(c => `"${c}"`).join(', ');
    const placeholders = [];
    for (let i = 0; i < fields.length + 2; i++) placeholders.push(`$${i + 1}`);
    const setClauses = fields.map((f, i) => `"${f}" = $${i + 2}`).join(', ');

    const params = [uid, ...values, user.email];
    const updatedByIdx = params.length;

    const sql = `
      INSERT INTO demand_details (${insertCols})
      VALUES (${placeholders.join(', ')})
      ON CONFLICT (uid) DO UPDATE SET
        ${setClauses},
        updated_by = $${updatedByIdx},
        updated_at = NOW()
      RETURNING *
    `;

    const { rows } = await pool.query(sql, params);

    // Best-effort audit log per changed field. Async — failures don't block the save.
    // Remarks history (visible to admin) is reconstructed from these activity_logs rows.
    for (const [field, value] of Object.entries(updates)) {
      const category = field === 'listing_price' ? 'price' : 'text';
      logActivity(uid, 'demand_update', category, user, { field, value });
    }

    res.status(200).json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('[/api/demand-details]', err);
    res.status(500).json({ success: false, error: err.message });
  }
};
