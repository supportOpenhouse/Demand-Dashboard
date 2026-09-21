const { pool, ensureTable, logActivity } = require('../_db');
const { requireAuth, canEdit, setCors } = require('../_auth');

// Pipeline tracking (demand_status + 8 stage dates) was removed from the UI.
// Schema columns remain but are no longer writable through this endpoint.
//
// availability_status is now only Available <-> Booked from this dashboard.
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
    // Previous availability_status, read before the write so the log can show
    // the actual transition (e.g. Booked → Available) rather than just the new value.
    let prevAvailability = null;
    if (req.body.availability_status !== undefined) {
      const { rows: prev } = await pool.query(
        `SELECT availability_status FROM demand_details WHERE uid = $1`,
        [uid]
      );
      if (prev.length) prevAvailability = prev[0].availability_status;
    }

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
        // A unit already Sold or Dead was put there by the external system, so
        // the dashboard must not move it back — those values are no longer in
        // ENUM_FIELDS and cannot be submitted, but an existing one must also
        // not be overwritten with Available/Booked from here.
        if (field === 'availability_status'
            && (prevAvailability === 'Sold' || prevAvailability === 'Dead')) {
          return res.status(403).json({
            success: false,
            locked: true,
            error: `This property is marked ${prevAvailability} and is managed outside the Demand Dashboard.`,
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

    // Releasing a booked unit is a CANCELLATION, so the booking has to go with
    // it — exactly what the CRM's own cancel action does. Leaving the row behind
    // keeps a withdrawn buyer, their token and the agreed brokerage attached to
    // a unit that is back on the market, and the CRM goes on reading it as the
    // live booking. (That divergence is what left 9 properties showing
    // "Available" beside a live buyer before 17 Sep 2026.)
    //
    // Archive first: there are no foreign keys protecting these rows, and the
    // booking holds the buyer, the brokerage split and the selling CP. Only rows
    // whose confirmation actually went out are archived — an unsent draft is not
    // a booking anyone needs back.
    let archived = 0;
    if (updates.availability_status === 'Available' && prevAvailability === 'Booked') {
      try {
        await pool.query(`
          CREATE TABLE IF NOT EXISTS booking_details_archive
            (LIKE booking_details INCLUDING DEFAULTS,
             archived_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
             archived_by TEXT)`);
        // Name the columns instead of `SELECT b.*`: the archive was created by
        // LIKE at some past moment, so a column added to booking_details later
        // is absent here and `b.*` then fails with "more expressions than target
        // columns" — which is exactly what token_type did. Copy the intersection
        // and the archive can lag without breaking a cancellation.
        const { rows: cols } = await pool.query(
          `SELECT a.column_name FROM information_schema.columns a
             JOIN information_schema.columns b
               ON b.table_name = 'booking_details' AND b.column_name = a.column_name
            WHERE a.table_name = 'booking_details_archive'`);
        const names = cols.map(c => `"${c.column_name}"`).join(', ');
        const { rows: moved } = await pool.query(
          `INSERT INTO booking_details_archive (${names}, archived_at, archived_by)
             SELECT ${names}, NOW(), $2 FROM booking_details WHERE uid = $1
           RETURNING id`,
          [uid, user.email]);
        archived = moved.length;
        if (archived) await pool.query('DELETE FROM booking_details WHERE uid = $1', [uid]);
        logActivity(uid, 'booking_cancelled', 'availability', user,
                    { archived, reason: 'Released to Available from the Demand Dashboard' });
      } catch (e) {
        // Never fail the status change over the tidy-up — but say so, rather
        // than leaving a silent half-cancellation.
        console.error('[/api/demand-details] booking archive failed for', uid, e.message);
      }
    }

    // Best-effort audit log per changed field. Async — failures don't block the save.
    // Remarks history (visible to admin) is reconstructed from these activity_logs rows.
    for (const [field, value] of Object.entries(updates)) {
      const category =
        field === 'listing_price'         ? 'price'
        : field === 'availability_status' ? 'availability'
        :                                   'text';
      const details = { field, value };
      if (field === 'availability_status') {
        details.previous = prevAvailability;
      }
      logActivity(uid, 'demand_update', category, user, details);
    }

    res.status(200).json({ success: true, data: rows[0], bookings_archived: archived });
  } catch (err) {
    console.error('[/api/demand-details]', err);
    res.status(500).json({ success: false, error: err.message });
  }
};
