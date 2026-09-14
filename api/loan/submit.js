// POST /api/loan/submit   — PUBLIC, no authentication.
//
// Intake for the OH Loan Form. Anyone holding the link can post here, so the
// route is defensive in three ways: per-IP rate limiting, a hard cap on payload
// shape (applicant count, string lengths, document count), and a strict
// allow-list of document slugs so arbitrary keys cannot be written into JSONB.
//
// The row is committed BEFORE the notification is sent. A failed SMTP call must
// never lose an application the applicant believes they submitted — the failure
// is recorded on the row (mail_error) so it can be retried or chased manually.
const { pool, ensureLoanTables } = require('../_db');
const { setCors } = require('../_auth');
const { buildLoanApplicationEmail, DOC_LABELS, sendMail } = require('../_email');
const { checkLoanRateLimit, clientIp } = require('./_rate-limit');

const NOTIFY = ['ankit@openhouse.in', 'rajnish@openhouse.in'];

const MAX_APPLICANTS = 6;
const MAX_TEXT = 500;
const MAX_NOTES = 4000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DOC_SLUGS = Object.keys(DOC_LABELS);

const EMPLOYMENT = ['Salaried', 'Self-employed', 'Business', 'Retired', 'Not employed'];
const QUALIFICATIONS = ['Post-graduate or higher', 'Graduate', 'Diploma', 'Class 12', 'Other'];

const text = (v, max = MAX_TEXT) => {
  const t = String(v == null ? '' : v).trim();
  return t === '' ? null : t.slice(0, max);
};
const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) && n >= 0 ? n : null;
};
const year = (v) => {
  const n = parseInt(v, 10);
  const now = new Date().getFullYear();
  return Number.isInteger(n) && n >= 1950 && n <= now ? String(n) : null;
};

// OHL-XXXXXX, quotable over the phone. Not security-bearing — the row id is the
// key; this exists so an applicant and the loan team can refer to the same thing.
function makeReference() {
  const s = Math.random().toString(36).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return 'OHL-' + (s + '000000').slice(0, 6);
}

function cleanApplicant(raw, index) {
  const p = raw && typeof raw === 'object' ? raw : {};
  const employment = EMPLOYMENT.includes(text(p.employment_type)) ? text(p.employment_type) : null;
  const qualification = QUALIFICATIONS.includes(text(p.qualification)) ? text(p.qualification) : null;
  return {
    name: text(p.name, 200),
    relationship: index === 0 ? null : text(p.relationship, 80),
    mothers_name: text(p.mothers_name, 200),
    mobile: (text(p.mobile, 20) || '').replace(/\D/g, '').slice(-10) || null,
    email: (() => { const e = (text(p.email, 200) || '').toLowerCase(); return e && EMAIL_RE.test(e) ? e : null; })(),
    employment_type: employment,
    qualification,
    career_start_year: year(p.career_start_year),
    current_org_since: year(p.current_org_since),
    // Tri-state on purpose: null means "not answered", which is different from
    // "no" and decides whether a rent agreement was even asked for.
    current_address_same_as_aadhaar:
      p.current_address_same_as_aadhaar === true ? true
        : p.current_address_same_as_aadhaar === false ? false : null,
    additional_income_amount: num(p.additional_income_amount),
    ongoing_emi_amount: num(p.ongoing_emi_amount),
  };
}

// Only known slugs, only https Cloudinary URLs. Without this an attacker could
// stuff arbitrary keys and links into the JSONB, which then render as clickable
// links in an email sent to staff.
function cleanDocuments(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [idx, set] of Object.entries(raw)) {
    if (!/^\d+$/.test(idx) || Number(idx) >= MAX_APPLICANTS) continue;
    if (!set || typeof set !== 'object') continue;
    const kept = {};
    for (const slug of DOC_SLUGS) {
      const url = text(set[slug], 600);
      if (url && /^https:\/\/res\.cloudinary\.com\//.test(url)) kept[slug] = url;
    }
    if (Object.keys(kept).length) out[idx] = kept;
  }
  return out;
}

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });

  const ip = clientIp(req);
  const gate = await checkLoanRateLimit(ip, { limit: 8, windowMinutes: 60, bucket: 'submit' });
  if (!gate.allowed) return res.status(429).json({ success: false, error: gate.message });

  // The public route never passes through requireAuth(), so INIT_SQL has not
  // necessarily run in this environment.
  if (!(await ensureLoanTables())) {
    return res.status(503).json({ success: false, error: 'Service is not ready. Please try again shortly.' });
  }

  try {
    const body = req.body || {};
    const rawApplicants = Array.isArray(body.applicants) ? body.applicants.slice(0, MAX_APPLICANTS) : [];
    const applicants = rawApplicants.map(cleanApplicant).filter(p => p.name || p.mobile || p.email);

    if (!applicants.length) {
      return res.status(400).json({ success: false, error: 'At least one applicant with a name is required.' });
    }
    if (!applicants[0].name) {
      return res.status(400).json({ success: false, error: 'The primary applicant needs a name.' });
    }
    if (!applicants[0].mobile) {
      return res.status(400).json({ success: false, error: 'The primary applicant needs a 10-digit mobile number.' });
    }

    const application = {
      reference: makeReference(),
      primary_name: applicants[0].name,
      primary_email: applicants[0].email,
      primary_mobile: applicants[0].mobile,
      property_interest: text(body.property_interest, 300),
      loan_amount: num(body.loan_amount),
      notes: text(body.notes, MAX_NOTES),
      applicants,
      documents: cleanDocuments(body.documents),
    };

    const { rows } = await pool.query(
      `INSERT INTO loan_applications
         (reference, primary_name, primary_email, primary_mobile,
          property_interest, loan_amount, notes, applicants, documents,
          submitted_ip, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING id, reference`,
      [application.reference, application.primary_name, application.primary_email,
       application.primary_mobile, application.property_interest, application.loan_amount,
       application.notes, JSON.stringify(application.applicants),
       JSON.stringify(application.documents), ip,
       String(req.headers['user-agent'] || '').slice(0, 400)]
    );
    const saved = rows[0];

    // Committed. From here a failure is a notification problem, not a data-loss
    // problem, so the applicant is told they succeeded either way.
    let mailed = false, mailError = null;
    try {
      const { subject, html } = buildLoanApplicationEmail({ application });
      await sendMail({ to: NOTIFY, subject, html });
      mailed = true;
    } catch (err) {
      mailError = err.message;
      console.error('[/api/loan/submit] notification failed:', err.message);
    }
    await pool.query(
      `UPDATE loan_applications
          SET mail_sent_at = $2, mail_error = $3, updated_at = NOW()
        WHERE id = $1`,
      [saved.id, mailed ? new Date() : null, mailError]
    ).catch(() => {});

    return res.status(200).json({ success: true, reference: saved.reference, mailed });
  } catch (err) {
    console.error('[/api/loan/submit]', err && err.stack || err);
    return res.status(500).json({ success: false, error: 'Could not submit the application. Please try again.' });
  }
};
