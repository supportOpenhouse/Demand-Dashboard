const { pool, ensureTable, logActivity } = require('../_db');
const { requireAuth, canEdit, setCors } = require('../_auth');

// Pipeline tracking (demand_status + 8 stage dates) was removed from the UI.
// Schema columns remain but are no longer writable through this endpoint.
// availability_status (Available/Booked/Sold/Dead) — Available/Booked/Sold are
// editable by admin + manager; 'Dead' is admin-only (soft-delete: once a unit
// is Dead it's hidden from viewers + managers by /api/list, so allowing them
// to set it would immediately lose the row from their view). Strict enum
// validation. Once a Booked submission has been mailed, the booking_details
// locked flag (checked elsewhere) prevents further status changes for
// managers — admins keep full edit rights.
const EDITOR_FIELDS = ['internal_remarks', 'availability_status'];
const ADMIN_ONLY_FIELDS = ['listing_price'];
const TEXT_FIELDS = ['internal_remarks'];
const ENUM_FIELDS = {
  availability_status: ['Available', 'Booked', 'Sold', 'Dead'],
};
const ADMIN_ONLY_ENUM_VALUES = {
  availability_status: ['Dead'],
};
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
      } else if (ENUM_FIELDS[field]) {
        const val = String(raw || '').trim();
        if (!ENUM_FIELDS[field].includes(val)) {
          return res.status(400).json({
            success: false,
            error: `${field} must be one of: ${ENUM_FIELDS[field].join(', ')}`,
          });
        }
        // Admin-only values (e.g. availability_status = 'Dead'). Also blocks
        // non-admins from clearing an existing Dead value, since they can't
        // see the row via /api/list — checked further below against the
        // current DB value.
        if ((ADMIN_ONLY_ENUM_VALUES[field] || []).includes(val) && !isAdmin) {
          return res.status(403).json({
            success: false,
            error: `Only admins can set ${field} to "${val}"`,
          });
        }
        if (field === 'availability_status' && !isAdmin) {
          const { rows: cur } = await pool.query(
            `SELECT availability_status FROM demand_details WHERE uid = $1`,
            [uid]
          );
          if (cur.length && cur[0].availability_status === 'Dead') {
            return res.status(403).json({
              success: false,
              error: 'Only admins can change status on a Dead unit',
            });
          }
        }
        // Lockout: once a Booked submission has been mailed, managers can't
        // change availability_status (admins still can). Check booking_details
        // for a row with mail_sent_at not null. Wrapped to tolerate the
        // booking_details table not existing yet (pre-Phase-2 deploys).
        if (field === 'availability_status' && !isAdmin) {
          try {
            const { rows: locked } = await pool.query(
              `SELECT 1 FROM booking_details WHERE uid = $1 AND mail_sent_at IS NOT NULL LIMIT 1`,
              [uid]
            );
            if (locked.length) {
              return res.status(403).json({
                success: false,
                error: 'This property has a submitted booking. Only admins can change status.',
              });
            }
          } catch (e) {
            // booking_details table not yet created — no lockout applies.
            if (!/relation .*booking_details.* does not exist/i.test(e.message)) throw e;
          }
        }
        updates[field] = val;
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
      const category =
        field === 'listing_price'         ? 'price'
        : field === 'availability_status' ? 'availability'
        :                                   'text';
      logActivity(uid, 'demand_update', category, user, { field, value });
    }

    res.status(200).json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('[/api/demand-details]', err);
    res.status(500).json({ success: false, error: err.message });
  }
};
