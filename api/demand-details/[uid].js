const { pool, ensureTable, logActivity } = require('../_db');
const { requireAuth, canEdit, setCors } = require('../_auth');

// Pipeline tracking (demand_status + 8 stage dates) was removed from the UI.
// Schema columns remain but are no longer writable through this endpoint.
//
// availability_status is READ-ONLY here — the Transaction CRM owns it.
// 'Sold' and 'Dead' are set by an external app and are deliberately NOT
// settable here — they remain valid values in the column, they just cannot be
// written through this endpoint.
//
// A booked unit stays editable here: demand releases it back to Available when
// a buyer falls through. Only Sold and Dead are protected, because the external
// system sets those.
const EDITOR_FIELDS = ['internal_remarks', 'availability_status'];
const ADMIN_ONLY_FIELDS = ['listing_price'];
const TEXT_FIELDS = ['internal_remarks'];
const ENUM_FIELDS = {
  availability_status: ['Available', 'Booked'],
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

    // The blanket "booking mail has gone out → nothing is editable" lock has been
    // REMOVED. It stopped demand releasing a unit whose buyer fell through, which
    // they have to be able to do without waiting on the CRM.
    //
    // Sold and Dead are still protected further down: those are set by the
    // external system and must not be overwritten from here.
    for (const field of [...EDITOR_FIELDS, ...ADMIN_ONLY_FIELDS]) {
      if (req.body[field] === undefined) continue;

      if (ADMIN_ONLY_FIELDS.includes(field) && !isAdmin) {
        return res.status(403).json({
          success: false,
          error: `Only admins can edit ${field}`,
        });
      }

      const raw = req.body[field];

      // Any human edit to the listing price — including clearing it — makes it
      // no longer auto. Clearing also re-opens it to the auto-pricer on the next
      // list load, which is the intended way to ask for a fresh derivation.
      if (field === 'listing_price') updates.listing_price_is_auto = false;

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
        // Availability is owned by the Transaction CRM, for EVERY value and
        // every role. Releasing a booked unit there also archives the booking
        // and resets the buyer journey; a write here would change the pill and
        // none of that, leaving the two systems disagreeing. The CRM writes this
        // column over its own SQL connection, not through this endpoint, so
        // refusing here does not block it.
        if (field === 'availability_status') {
          return res.status(403).json({
            success: false,
            locked: true,
            error: 'Availability is managed in the Transaction CRM. Change it there.',
          });
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

    // (The Demand-side booking archive that used to live here is gone: this
    // endpoint can no longer change availability at all, so releasing a unit —
    // and archiving its booking — happens only in the CRM's cancel action.)

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
