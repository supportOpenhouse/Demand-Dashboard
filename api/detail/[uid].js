const { pool } = require('../_db');
const { requireAuth, setCors } = require('../_auth');

// GET /api/detail/:uid
//
// Tries the supply-pipeline `properties` table first; if not found there,
// falls back to `legacy_properties`. The dashboard treats both as a unified
// pool — this endpoint hides the distinction except via the `origin` field
// in the response ('real' or 'legacy'), which the frontend can use if needed.
module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const user = await requireAuth(req, res);
  if (!user) return;

  const { uid } = req.query;
  if (!uid) return res.status(400).json({ success: false, error: 'uid is required' });

  try {
    // Real properties path. SELECT p.* gives us every column for the detail view.
    // supply_status used to come from v_property_status.derived_status; that view
    // has been removed and the AMA/Keys distinction is gone, so it's NULL now.
    const realRes = await pool.query(`
      SELECT p.*,
             NULL::TEXT AS supply_status,
             apd.parking_number,
             apd.property_tax_status,
             apd.internal_remarks AS supply_internal_remarks,
             dd.listing_price, dd.demand_status,
             dd.buyer_visit_date, dd.buyer_interested_date, dd.buyer_revisit_date,
             dd.negotiation_meeting_date, dd.booking_done_date,
             dd.ats_signed_date, dd.registry_done_date, dd.sold_date,
             dd.internal_remarks, dd.legacy_raw_values,
             dd.updated_by, dd.updated_at,
             'real'::TEXT AS origin
      FROM properties p
      LEFT JOIN ap_details apd ON apd.uid = p.uid
      LEFT JOIN demand_details dd ON dd.uid = p.uid
      WHERE p.uid = $1
    `, [uid]);

    if (realRes.rows.length) {
      // owner_broker_name → owner_name alias for frontend consistency with /list.
      const row = realRes.rows[0];
      row.owner_name = row.owner_broker_name;
      row.poc = row.assigned_by;
      return res.status(200).json({ success: true, data: row });
    }

    // Legacy fallback. Same shape, sourced from legacy_properties.
    const legacyRes = await pool.query(`
      SELECT lp.*,
             lp.legacy_status AS supply_status,
             NULL::TEXT AS property_tax_status,
             NULL::TEXT AS supply_internal_remarks,
             dd.listing_price, dd.demand_status,
             dd.buyer_visit_date, dd.buyer_interested_date, dd.buyer_revisit_date,
             dd.negotiation_meeting_date, dd.booking_done_date,
             dd.ats_signed_date, dd.registry_done_date, dd.sold_date,
             dd.internal_remarks, dd.legacy_raw_values,
             dd.updated_by, dd.updated_at,
             'legacy'::TEXT AS origin
      FROM legacy_properties lp
      LEFT JOIN demand_details dd ON dd.uid = lp.uid
      WHERE lp.uid = $1
    `, [uid]);

    if (legacyRes.rows.length) {
      const row = legacyRes.rows[0];
      row.owner_name = row.owner_broker_name;
      row.poc = row.assigned_by;
      return res.status(200).json({ success: true, data: row });
    }

    return res.status(404).json({ success: false, error: 'Property not found' });
  } catch (err) {
    console.error('[/api/detail]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};
