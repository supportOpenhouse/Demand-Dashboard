// GET /api/cp-lookup?code=CP01234   or   ?phone=9876543210
// Resolves a channel partner for the booking form. Returns every match so the
// UI can disambiguate — phone has one known duplicate in the source data.
//
// `email` comes back null for essentially every CP today (the column is empty
// across all 6,971 rows), so the operator types it; it is written back on
// submit via saveChannelPartnerEmail so later lookups find it.
const { requireAuth, canEdit, setCors } = require('./_auth');
const { findChannelPartners } = require('./_cpdb');

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ success: false, error: 'Method not allowed' });

  const user = await requireAuth(req, res);
  if (!user) return;
  if (!canEdit(user)) return res.status(403).json({ success: false, error: 'Viewer access is read-only' });

  const { code, phone } = req.query;
  if (!code && !phone) {
    return res.status(400).json({ success: false, error: 'Provide a CP code or phone number' });
  }

  try {
    const matches = await findChannelPartners({ code, phone });
    return res.status(200).json({
      success: true,
      count: matches.length,
      matches: matches.map(m => ({
        id: m.id, cpCode: m.cp_code, name: m.name, phone: m.phone,
        email: m.email, company: m.company, city: m.city, isActive: m.is_active,
      })),
    });
  } catch (err) {
    console.error('[/api/cp-lookup]', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
};
