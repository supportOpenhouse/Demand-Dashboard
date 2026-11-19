const { pool, tmdPool, isHiddenTestUnit } = require('../_db');
const { requireAuth, setCors } = require('../_auth');
const { buildDocuments, forRole, shapeDeviation } = require('../_tmd');

// GET /api/tmd-docs/:uid
//
// The property's documents and deviation from TMD's "Docs Verified & AMA Draft"
// stage, for the expanded panel. Loaded only when a row is opened, so the list
// query never pays for it. See api/_tmd.js for the three document sources.
//
// TMD's database is optional (TMD_DATABASE_URL) and best-effort: unset or failing,
// the response still carries the ownership checklist with `tmd: false`, so the
// panel degrades instead of erroring.
//
// The unit's deal is its newest non-cancelled one in TMD — a cancelled deal's
// paperwork belongs to a seller transaction that did not happen.
module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const user = await requireAuth(req, res);
  if (!user) return;

  const uid = String(req.query.uid || '').trim();
  if (!uid) return res.status(400).json({ success: false, error: 'uid is required' });
  if (await isHiddenTestUnit(uid, user)) {
    return res.status(404).json({ success: false, error: 'Property not found' });
  }

  try {
    const { rows } = await pool.query('SELECT ama_prop_docs FROM properties WHERE uid = $1', [uid]);
    const propDocs = rows[0] ? rows[0].ama_prop_docs : null;

    let sellerApp = [], crm = [], deviation = null, tmd = false;
    const tp = tmdPool();
    if (tp && rows[0]) {
      try {
        const deal = await tp.query(
          `SELECT d.id FROM deals d JOIN units u ON u.id = d.unit_id
            WHERE u.property_uid = $1 AND d.status <> 'cancelled'
            ORDER BY d.created_at DESC NULLS LAST, d.id DESC LIMIT 1`, [uid]);
        const dealId = deal.rows[0] && deal.rows[0].id;
        if (dealId) {
          const [sa, docs, dev] = await Promise.all([
            tp.query('SELECT document_name, url, first_seen_at FROM seller_app_docs_seen WHERE deal_id = $1', [dealId]),
            tp.query(`SELECT filename, url, created_at FROM documents
                       WHERE deal_id = $1 AND doc_type = 'additional_doc' ORDER BY created_at, id`, [dealId]),
            tp.query('SELECT has_deviation, text, resolved_at FROM deal_deviations WHERE deal_id = $1', [dealId]),
          ]);
          sellerApp = sa.rows;
          crm = docs.rows;
          deviation = shapeDeviation(dev.rows[0]);
        }
        tmd = true;
      } catch (err) {
        console.warn('[/api/tmd-docs] TMD read failed:', err.message);
      }
    }

    const documents = forRole(buildDocuments({ propDocs, sellerApp, crm }), user.role);
    res.status(200).json({ success: true, documents, deviation, tmd });
  } catch (err) {
    console.error('[/api/tmd-docs]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};
