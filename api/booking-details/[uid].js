// /api/booking-details/:uid
//
// GET  → returns the latest booking_details row for this uid (for prefilling
//        the modal) + the list of CP-RM emails seen on previous bookings
//        (for the page-1 datalist suggestions).
//
// POST → handles three actions via body.action:
//        - 'preview' : returns { subject, html } without writing anything.
//                      Used by the "Preview Mail" button in the modal.
//        - 'send'    : inserts a booking_details row, sends the email via
//                      SMTP, then marks mail_sent_at on the inserted row.
//                      Sets availability_status='Booked' on demand_details
//                      (idempotent — already Booked when the user opens the modal).
//        - 'save'    : draft save — inserts/updates without sending mail. Useful
//                      if we want to add a "Save Draft" button later. Currently
//                      not exposed in the UI, kept here for future extension.
//
// Admin + manager only. Re-submitting after mail_sent_at is set is the
// cancellation/rebooking case: allowed for both roles, and always inserted as a
// fresh row so earlier bookings survive as history. The repeat is recorded on
// the audit log as booking_resent / booking_cp_mail_resent with a count of the
// prior mailed bookings.
//
// All writes wrapped in a transaction; mail send happens AFTER commit so a
// failed send doesn't leave an orphan unsent row in the DB.

const { pool, logActivity } = require('../_db');
const { saveChannelPartnerEmail } = require('../_cpdb');
const { requireAuth, canEdit, setCors } = require('../_auth');
const { buildBookingEmail, buildBrokerEmail, sendMail } = require('../_email');

const PAYMENT_METHODS = ['UPI', 'NEFT', 'IMPS', 'RTGS', 'Cheque', 'Cash', 'Other'];
const SOURCES = ['CP', 'Direct'];
const BROKERAGE_TIMINGS = ['Registry Only', 'ATS & Registry'];
const SALUTATIONS = ['Mr.', 'Mrs.', 'Ms.', 'Dr.'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Every column a booking row writes, in order. Shared by the insert and the
// draft update so the two can't drift. `recipients` / `broker_emails` are JSONB
// and get stringified; everything else goes through as-is.
const BOOKING_COLS = [
  'buyer_salutation', 'buyer_name', 'co_buyer_name', 'buyer_email', 'co_buyer_email',
  'consideration_amount', 'booking_amount_received',
  'booking_amount_method', 'booking_amount_method_2',
  'booking_amount_split_1', 'booking_amount_split_2',
  'ats_timeline', 'registry_timeline', 'booking_amount_forfeitable',
  'amount_on_ats_pct', 'other_conditions', 'recipients', 'broker_emails',
  'source', 'brokerage_amount', 'brokerage_timing',
  'brokerage_ats_amount', 'brokerage_registry_amount',
  'selling_cp_id', 'selling_cp_code', 'selling_cp_phone',
  'selling_cp_name', 'selling_cp_company', 'selling_cp_email',
];
const JSON_COLS = new Set(['recipients', 'broker_emails']);

function bookingValues(clean) {
  return BOOKING_COLS.map(c => {
    if (JSON_COLS.has(c)) return JSON.stringify(clean[c] || []);
    // A value that failed validation was skipped, so it is undefined here.
    // Postgres wants NULL, and a draft legitimately has empty fields.
    return clean[c] === undefined ? null : clean[c];
  });
}
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Strict-list fields. Reject anything not in the allow-list to keep DB clean.
function validate(body) {
  const errors = [];
  const clean = {};

  // Selling channel partner — resolved by the CP lookup, or typed by hand.
  // Snapshotted onto the booking because channel_partners lives in a separate
  // database and cannot be joined at read time.
  clean.selling_cp_id = Number.isInteger(Number(body.selling_cp_id)) && Number(body.selling_cp_id) > 0
    ? Number(body.selling_cp_id) : null;
  for (const f of ['selling_cp_code', 'selling_cp_phone', 'selling_cp_name', 'selling_cp_company']) {
    const v = body[f] == null ? '' : String(body[f]).trim();
    clean[f] = v === '' ? null : v.slice(0, 200);
  }
  if (clean.selling_cp_phone) clean.selling_cp_phone = clean.selling_cp_phone.replace(/\D/g, '').slice(-10) || null;
  {
    const v = body.selling_cp_email == null ? '' : String(body.selling_cp_email).trim().toLowerCase();
    if (v === '') clean.selling_cp_email = null;
    else if (!EMAIL_RE.test(v)) errors.push('selling_cp_email is not a valid email address');
    else clean.selling_cp_email = v;
  }

  // Strings (trim, max length)
  const textFields = ['buyer_name', 'co_buyer_name', 'booking_amount_method',
                      'buyer_salutation', 'other_conditions'];
  for (const f of textFields) {
    if (body[f] === undefined || body[f] === null || body[f] === '') { clean[f] = null; continue; }
    const v = String(body[f]).trim();
    if (v.length > 2000) { errors.push(`${f} exceeds 2000 chars`); continue; }
    clean[f] = v;
  }
  if (clean.booking_amount_method && !PAYMENT_METHODS.includes(clean.booking_amount_method)) {
    errors.push(`booking_amount_method must be one of: ${PAYMENT_METHODS.join(', ')}`);
  }
  if (clean.buyer_salutation && !SALUTATIONS.includes(clean.buyer_salutation)) {
    errors.push(`buyer_salutation must be one of: ${SALUTATIONS.join(', ')}`);
  }

  // ats_timeline: ISO date string (YYYY-MM-DD) from the date picker.
  // registry_timeline: integer days. Both stored as TEXT.
  if (body.ats_timeline === undefined || body.ats_timeline === null || body.ats_timeline === '') {
    clean.ats_timeline = null;
  } else {
    const v = String(body.ats_timeline).trim();
    if (!ISO_DATE_RE.test(v) || isNaN(new Date(v).getTime())) {
      errors.push('ats_timeline must be a valid date (YYYY-MM-DD)');
    } else {
      clean.ats_timeline = v;
    }
  }
  if (body.registry_timeline === undefined || body.registry_timeline === null || body.registry_timeline === '') {
    clean.registry_timeline = null;
  } else {
    const n = parseInt(body.registry_timeline, 10);
    if (isNaN(n) || n < 1 || n > 365) {
      errors.push('registry_timeline must be a whole number of days between 1 and 365');
    } else {
      clean.registry_timeline = String(n);
    }
  }

  // Email fields — lowercased, validated as email format. NULL if empty.
  const emailFields = ['buyer_email', 'co_buyer_email'];
  for (const f of emailFields) {
    if (body[f] === undefined || body[f] === null || body[f] === '') { clean[f] = null; continue; }
    const v = String(body[f]).trim().toLowerCase();
    if (!EMAIL_RE.test(v)) { errors.push(`${f} must be a valid email`); continue; }
    clean[f] = v;
  }

  // Numbers (non-negative)
  const numFields = ['consideration_amount', 'booking_amount_received', 'amount_on_ats_pct'];
  for (const f of numFields) {
    if (body[f] === undefined || body[f] === null || body[f] === '') { clean[f] = null; continue; }
    const n = parseFloat(body[f]);
    if (isNaN(n) || n < 0) { errors.push(`${f} must be a non-negative number`); continue; }
    clean[f] = n;
  }
  if (clean.amount_on_ats_pct != null && clean.amount_on_ats_pct > 100) {
    errors.push('amount_on_ats_pct must be 0-100');
  }

  // Boolean
  if (body.booking_amount_forfeitable === undefined || body.booking_amount_forfeitable === null || body.booking_amount_forfeitable === '') {
    clean.booking_amount_forfeitable = null;
  } else if (body.booking_amount_forfeitable === true || body.booking_amount_forfeitable === 'true' || body.booking_amount_forfeitable === 'Yes') {
    clean.booking_amount_forfeitable = true;
  } else if (body.booking_amount_forfeitable === false || body.booking_amount_forfeitable === 'false' || body.booking_amount_forfeitable === 'No') {
    clean.booking_amount_forfeitable = false;
  } else {
    errors.push('booking_amount_forfeitable must be Yes/No');
  }

  // Recipients — array of valid-looking emails
  let recipients = body.recipients;
  if (!Array.isArray(recipients)) recipients = [];
  recipients = recipients
    .map(s => String(s || '').trim())
    .filter(Boolean);
  for (const r of recipients) {
    if (!EMAIL_RE.test(r)) {
      errors.push(`Invalid email: ${r}`);
    }
  }
  clean.recipients = [...new Set(recipients)]; // dedupe

  // Broker emails — same shape as recipients, separate list. Lowercased for
  // dedupe + future suggestion lookups.
  let brokers = body.broker_emails;
  if (!Array.isArray(brokers)) brokers = [];
  brokers = brokers.map(s => String(s || '').trim().toLowerCase()).filter(Boolean);
  for (const b of brokers) {
    if (!EMAIL_RE.test(b)) errors.push(`Invalid broker email: ${b}`);
  }
  clean.broker_emails = [...new Set(brokers)];

  // Source — deal channel. Defaults to 'CP' when omitted/blank.
  if (body.source === undefined || body.source === null || body.source === '') {
    clean.source = 'CP';
  } else if (SOURCES.includes(String(body.source).trim())) {
    clean.source = String(body.source).trim();
  } else {
    errors.push(`source must be one of: ${SOURCES.join(', ')}`);
  }

  // Brokerage amount — non-negative. Meaning depends on source: for CP it's the
  // amount to be paid to the partner; for Direct it's the amount to be collected.
  if (body.brokerage_amount === undefined || body.brokerage_amount === null || body.brokerage_amount === '') {
    clean.brokerage_amount = null;
  } else {
    const n = parseFloat(body.brokerage_amount);
    if (isNaN(n) || n < 0) errors.push('brokerage_amount must be a non-negative number');
    else clean.brokerage_amount = n;
  }

  // Brokerage timing + split — only meaningful for CP. For Direct, forced null.
  // Type-sanitized here; requiredness + sum are enforced only in the send_cp /
  // preview_cp branch so the buyer flow is never blocked by brokerage state.
  if (clean.source === 'Direct') {
    clean.brokerage_timing = null;
    clean.brokerage_ats_amount = null;
    clean.brokerage_registry_amount = null;
  } else {
    if (body.brokerage_timing === undefined || body.brokerage_timing === null || body.brokerage_timing === '') {
      clean.brokerage_timing = null;
    } else if (BROKERAGE_TIMINGS.includes(String(body.brokerage_timing).trim())) {
      clean.brokerage_timing = String(body.brokerage_timing).trim();
    } else {
      errors.push(`brokerage_timing must be one of: ${BROKERAGE_TIMINGS.join(', ')}`);
    }
    if (clean.brokerage_timing === 'ATS & Registry') {
      for (const f of ['brokerage_ats_amount', 'brokerage_registry_amount']) {
        if (body[f] === undefined || body[f] === null || body[f] === '') { clean[f] = null; continue; }
        const n = parseFloat(body[f]);
        if (isNaN(n) || n < 0) errors.push(`${f} must be a non-negative number`);
        else clean[f] = n;
      }
    } else {
      clean.brokerage_ats_amount = null;
      clean.brokerage_registry_amount = null;
    }
  }

  // Split payment — optional second leg. If method_2 OR split_1 OR split_2 is
  // present, treat as a split and require all three. Else single (legs NULL).
  const m2 = body.booking_amount_method_2;
  const s1 = body.booking_amount_split_1;
  const s2 = body.booking_amount_split_2;
  const isSplit = (m2 != null && m2 !== '') || (s1 != null && s1 !== '') || (s2 != null && s2 !== '');
  if (!isSplit) {
    clean.booking_amount_method_2 = null;
    clean.booking_amount_split_1 = null;
    clean.booking_amount_split_2 = null;
  } else {
    if (!m2 || !PAYMENT_METHODS.includes(String(m2).trim())) {
      errors.push(`booking_amount_method_2 must be one of: ${PAYMENT_METHODS.join(', ')}`);
    } else {
      clean.booking_amount_method_2 = String(m2).trim();
    }
    const n1 = parseFloat(s1), n2 = parseFloat(s2);
    if (isNaN(n1) || n1 < 0) errors.push('booking_amount_split_1 must be a non-negative number');
    else clean.booking_amount_split_1 = n1;
    if (isNaN(n2) || n2 < 0) errors.push('booking_amount_split_2 must be a non-negative number');
    else clean.booking_amount_split_2 = n2;
    // Both legs may use the same instrument (e.g. two separate UPI transfers) —
    // the only constraint is that the two amounts total the received amount.
    // Sum must equal booking_amount_received (allow 1 paisa tolerance for float rounding).
    if (clean.booking_amount_received != null && !isNaN(n1) && !isNaN(n2)) {
      const sum = n1 + n2;
      if (Math.abs(sum - clean.booking_amount_received) > 0.01) {
        errors.push(`Split amounts (${sum}) must total Booking Amount Received (${clean.booking_amount_received})`);
      }
    }
  }

  return { clean, errors };
}

// Effective mailing list = curated CP-RM `recipients` + buyer_email + co_buyer_email.
// Deduped case-insensitively, preserving first occurrence order. Used for both
// the preview "To:" line and the actual SMTP send.
function effectiveRecipients(clean) {
  const all = [
    ...(clean.recipients || []),
    ...(clean.broker_emails || []),
    ...(clean.buyer_email ? [clean.buyer_email] : []),
    ...(clean.co_buyer_email ? [clean.co_buyer_email] : []),
  ];
  const seen = new Set();
  return all.filter(e => {
    const k = String(e).toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// Recipient list for the broker (CP) mail = brokers + CP RMs + internal. The
// `recipients` array already carries the CP RMs and the fixed internal addresses
// (seeded as defaults in the modal). Buyer / co-buyer emails are deliberately
// excluded so brokerage figures never reach the buyer.
function cpRecipients(clean) {
  const all = [...(clean.broker_emails || []), ...(clean.recipients || [])];
  const seen = new Set();
  return all.filter(e => {
    const k = String(e).toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// Loads the full property row for the email body. Tries `properties` then
// `legacy_properties`. Returns null if not found.
async function loadProperty(uid) {
  const real = await pool.query(
    `SELECT p.*, apd.status AS supply_status
     FROM properties p
     LEFT JOIN ap_details apd ON apd.uid = p.uid
     WHERE p.uid = $1`,
    [uid]
  );
  if (real.rows.length) return { ...real.rows[0], origin: 'real' };

  const legacy = await pool.query(`SELECT * FROM legacy_properties WHERE uid = $1`, [uid]);
  if (legacy.rows.length) return { ...legacy.rows[0], origin: 'legacy' };

  return null;
}

const handleBookingRequest = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await requireAuth(req, res);
  if (!user) return;

  const { uid } = req.query;
  if (!uid) return res.status(400).json({ success: false, error: 'uid is required' });

  // ── GET: prefill data for the modal ────────────────────────────────────
  if (req.method === 'GET') {
    if (!canEdit(user)) {
      return res.status(403).json({ success: false, error: 'Viewer access is read-only' });
    }
    // Note: ensureTable() has already run inside requireAuth(), so we skip
    // the redundant pass here. The three queries below are independent and
    // fired in parallel to cut latency on cold-starts of this function.
    try {
      const FIXED = ['bookings@openhouse.in', 'manish.pal@openhouse.in'];

      const [latest, past, pastBrokers, teamUsers] = await Promise.all([
        // Latest booking for this uid (could be null — fresh submission)
        pool.query(
          `SELECT * FROM booking_details WHERE uid = $1 ORDER BY created_at DESC LIMIT 1`,
          [uid]
        ),
        // Distinct CP-RM-ish emails from past submissions — used to populate
        // the datalist on page 1. Filter out the standard fixed recipients
        // (done in JS below) so suggestions don't repeat them.
        pool.query(`
          SELECT DISTINCT TRIM(LOWER(email)) AS email
          FROM booking_details, jsonb_array_elements_text(recipients) AS email
          WHERE TRIM(email) <> ''
        `),
        // Distinct broker emails from past submissions — feeds the broker-section
        // datalist on page 1. Wrapped in COALESCE so rows predating the
        // broker_emails column (NULL JSONB) don't blow up jsonb_array_elements_text.
        pool.query(`
          SELECT DISTINCT TRIM(LOWER(email)) AS email
          FROM booking_details,
               jsonb_array_elements_text(COALESCE(broker_emails, '[]'::jsonb)) AS email
          WHERE TRIM(email) <> ''
        `),
        // Demand team users — used for the page-1 datalist too (any of them
        // can be a recipient).
        pool.query(
          `SELECT email, name FROM demand_users WHERE role IN ('admin','manager') ORDER BY name NULLS LAST, email`
        ),
      ]);

      const suggestions = past.rows
        .map(r => r.email)
        .filter(e => e && !FIXED.includes(e))
        .sort();
      const brokerSuggestions = pastBrokers.rows.map(r => r.email).filter(Boolean).sort();

      return res.status(200).json({
        success: true,
        latest: latest.rows[0] || null,
        locked: !!(latest.rows[0]?.mail_sent_at),
        suggestions,
        brokerSuggestions,
        team: teamUsers.rows,
        fixedRecipients: FIXED,
        paymentMethods: PAYMENT_METHODS,
        sources: SOURCES,
        brokerageTimings: BROKERAGE_TIMINGS,
      });
    } catch (err) {
      console.error('[/api/booking-details GET]', err.message);
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  // ── POST: preview / send / save ────────────────────────────────────────
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!canEdit(user)) {
    return res.status(403).json({ success: false, error: 'Viewer access is read-only' });
  }

  const { action } = req.body || {};
  if (!['preview', 'send', 'save', 'preview_cp', 'send_cp'].includes(action)) {
    return res.status(400).json({ success: false, error: `action must be one of: preview, send, save, preview_cp, send_cp` });
  }

  const { clean, errors } = validate(req.body);
  // Drafts are partial by definition — a half-typed email or an incomplete date
  // is the normal state of a form being filled in, not an error. Autosave keeps
  // whatever currently validates and drops the rest; the strict check still
  // applies to preview and send, which is where completeness actually matters.
  if (errors.length && action !== 'save') {
    return res.status(400).json({ success: false, error: errors.join('; ') });
  }

  // Load property for email body
  const property = await loadProperty(uid);
  if (!property) return res.status(404).json({ success: false, error: 'Property not found' });

  // ── action: preview — no DB write, no mail send. Just return rendered HTML.
  if (action === 'preview') {
    const { subject, html } = buildBookingEmail({
      property,
      booking: clean,
      submittedBy: user.email,
      submittedByName: user.name || user.email,
    });
    return res.status(200).json({
      success: true, subject, html,
      recipients: effectiveRecipients(clean),
    });
  }

  // ── action: preview_cp — render the broker (CP) mail. No DB write, no send.
  if (action === 'preview_cp') {
    const { subject, html } = buildBrokerEmail({
      property,
      booking: clean,
      submittedBy: user.email,
      submittedByName: user.name || user.email,
    });
    return res.status(200).json({
      success: true, subject, html,
      recipients: cpRecipients(clean),
    });
  }

  // ── action: send_cp — send the broker (CP) mail + persist brokerage. Separate
  // from the buyer send; carries its own validation + cp_mail_sent_at timestamp.
  if (action === 'send_cp') {
    if (clean.source !== 'CP') {
      return res.status(400).json({ success: false, error: 'CP mail is only available when Source is CP.' });
    }
    const cpErrors = [];
    if (clean.brokerage_amount == null) cpErrors.push('Brokerage amount is required');
    if (!clean.brokerage_timing) cpErrors.push('Brokerage timing is required');
    if (clean.brokerage_timing === 'ATS & Registry') {
      if (clean.brokerage_ats_amount == null) cpErrors.push('Brokerage at ATS is required');
      if (clean.brokerage_registry_amount == null) cpErrors.push('Brokerage at Registry is required');
      if (clean.brokerage_ats_amount != null && clean.brokerage_registry_amount != null && clean.brokerage_amount != null
          && Math.abs((clean.brokerage_ats_amount + clean.brokerage_registry_amount) - clean.brokerage_amount) > 0.01) {
        cpErrors.push(`Brokerage split (${clean.brokerage_ats_amount + clean.brokerage_registry_amount}) must total the brokerage amount (${clean.brokerage_amount})`);
      }
    }
    const cpTo = cpRecipients(clean);
    if (!cpTo.length) cpErrors.push('At least one CP recipient (broker or CP RM) is required');
    if (cpErrors.length) return res.status(400).json({ success: false, error: cpErrors.join('; ') });

    // A repeat CP mail is the rebooking case (new buyer, new brokerage) —
    // allowed for managers and admins alike. Counted for the audit log.
    const priorCp = await pool.query(
      `SELECT COUNT(*)::int AS n FROM booking_details WHERE uid = $1 AND cp_mail_sent_at IS NOT NULL`,
      [uid]
    );
    const priorCpCount = priorCp.rows[0].n;

    // Persist brokerage on the most recent booking row (usually the one the buyer
    // send just created in this session); insert a fresh row if the CP mail is
    // sent before the buyer mail. A latest row whose CP mail already went out
    // belongs to a completed booking — a repeat send is a rebooking, so it gets
    // its own row rather than overwriting that history.
    let cpRowId;
    const latest = await pool.query(
      `SELECT id FROM booking_details
        WHERE uid = $1 AND cp_mail_sent_at IS NULL
        ORDER BY created_at DESC LIMIT 1`,
      [uid]
    );
    if (latest.rows.length) {
      cpRowId = latest.rows[0].id;
      await pool.query(
        `UPDATE booking_details
           SET source = $2, brokerage_amount = $3, brokerage_timing = $4,
               brokerage_ats_amount = $5, brokerage_registry_amount = $6,
               broker_emails = $7, recipients = $8, updated_at = NOW()
         WHERE id = $1`,
        [cpRowId, clean.source, clean.brokerage_amount, clean.brokerage_timing,
         clean.brokerage_ats_amount, clean.brokerage_registry_amount,
         JSON.stringify(clean.broker_emails || []), JSON.stringify(clean.recipients || [])]
      );
    } else {
      const ins = await pool.query(
        `INSERT INTO booking_details (
           uid, source, brokerage_amount, brokerage_timing,
           brokerage_ats_amount, brokerage_registry_amount, buyer_name,
           recipients, broker_emails, submitted_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [uid, clean.source, clean.brokerage_amount, clean.brokerage_timing,
         clean.brokerage_ats_amount, clean.brokerage_registry_amount, clean.buyer_name,
         JSON.stringify(clean.recipients || []), JSON.stringify(clean.broker_emails || []), user.email]
      );
      cpRowId = ins.rows[0].id;
      await pool.query(
        `INSERT INTO demand_details (uid, availability_status, updated_by)
         VALUES ($1, 'Booked', $2)
         ON CONFLICT (uid) DO UPDATE
           SET availability_status = 'Booked', updated_by = $2, updated_at = NOW()`,
        [uid, user.email]
      );
    }

    const { subject, html } = buildBrokerEmail({
      property,
      booking: clean,
      submittedBy: user.email,
      submittedByName: user.name || user.email,
    });
    try {
      await sendMail({ to: cpTo, subject, html });
    } catch (err) {
      console.error('[/api/booking-details POST send_cp]', err.message);
      return res.status(500).json({
        success: false,
        error: 'Failed to send CP email: ' + err.message,
        hint: 'The brokerage was saved but the broker email was not sent. An admin can retry.',
      });
    }
    await pool.query(
      `UPDATE booking_details SET cp_mail_sent_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [cpRowId]
    );
    logActivity(uid, priorCpCount ? 'booking_cp_mail_resent' : 'booking_cp_mail', 'booking', user, {
      booking_id: cpRowId,
      // >0 means a CP mail had already gone out for this unit — a rebooking.
      prior_cp_mails: priorCpCount,
    });
    return res.status(200).json({ success: true, id: cpRowId, sent: true });
  }

  // ── action: save (draft) — autosaved from the form as the operator types and
  // on each step change, so nothing is lost if the tab closes mid-entry.
  //
  // Two deliberate differences from `send`:
  //   * it UPDATES the row it created rather than inserting another, so an
  //     autosaving form leaves one draft, not hundreds;
  //   * it never touches demand_details. A half-typed draft must not flip the
  //     unit to Booked — only an actually-sent booking means that.
  // A row that has already been mailed is immutable here.
  if (action === 'save') {
    const draftId = Number((req.body || {}).booking_id) || null;
    const sets = BOOKING_COLS.map((c, i) => `"${c}" = $${i + 1}`).join(', ');
    if (draftId) {
      const { rows } = await pool.query(
        `UPDATE booking_details SET ${sets}, updated_at = NOW()
          WHERE id = $${BOOKING_COLS.length + 1} AND uid = $${BOOKING_COLS.length + 2}
          RETURNING id, mail_sent_at`,
        [...bookingValues(clean), draftId, uid]
      );
      if (rows.length) {
        // Editing a booking that has already gone out is allowed, but it means
        // the stored record no longer matches the mail the buyer received — so
        // it is logged distinctly rather than passing as a routine autosave.
        if (rows[0].mail_sent_at) {
          logActivity(uid, 'booking_edited_after_send', 'booking', user, { booking_id: rows[0].id });
        }
        return res.status(200).json({
          success: true, id: rows[0].id, sent: !!rows[0].mail_sent_at, draft: true,
          editedAfterSend: !!rows[0].mail_sent_at,
        });
      }
      // Fell through: the row belongs to another unit — start a fresh draft
      // rather than silently editing nothing.
    }
    const cols = ['uid', ...BOOKING_COLS, 'submitted_by'];
    const ph = cols.map((_, i) => `$${i + 1}`).join(', ');
    const { rows } = await pool.query(
      `INSERT INTO booking_details (${cols.map(c => `"${c}"`).join(', ')})
       VALUES (${ph}) RETURNING id`,
      [uid, ...bookingValues(clean), user.email]
    );
    logActivity(uid, 'booking_draft_saved', 'booking', user, { booking_id: rows[0].id });
    return res.status(200).json({ success: true, id: rows[0].id, sent: false, draft: true });
  }

  // ── action: send (full) — writes a row.
  // For send, we additionally:
  //   - require buyer_email + at least one effective recipient
  //   - call SMTP after commit
  //   - stamp mail_sent_at + bump availability_status to Booked
  if (action === 'send' && !clean.buyer_email) {
    return res.status(400).json({ success: false, error: 'Buyer email is required to send mail.' });
  }
  if (action === 'send' && !effectiveRecipients(clean).length) {
    return res.status(400).json({ success: false, error: 'At least one recipient is required to send mail.' });
  }

  // Re-submission after a mailed booking is the cancellation/rebooking case:
  // allowed for managers and admins alike, and inserted as a fresh row so the
  // earlier booking stays intact as history. Counted here so the audit log can
  // record which attempt this is.
  const priorSent = await pool.query(
    `SELECT COUNT(*)::int AS n FROM booking_details WHERE uid = $1 AND mail_sent_at IS NOT NULL`,
    [uid]
  );
  const priorSentCount = priorSent.rows[0].n;

  // Insert booking row. Email sending happens AFTER the transaction commits
  // so we don't lose track of in-flight bookings if SMTP fails.
  const client = await pool.connect();
  let insertedId;
  try {
    await client.query('BEGIN');

    // If the form autosaved a draft, promote that row rather than inserting a
    // second one for the same booking. A row that has already been mailed is
    // deliberately excluded: sending again is a REBOOKING, and the earlier
    // submission has to survive as history. (Editing a mailed booking in place
    // is still possible via the draft save above.)
    const draftId = Number((req.body || {}).booking_id) || null;
    if (draftId) {
      const sets = BOOKING_COLS.map((c, i) => `"${c}" = $${i + 1}`).join(', ');
      const upd = await client.query(
        `UPDATE booking_details SET ${sets}, submitted_by = $${BOOKING_COLS.length + 1}, updated_at = NOW()
          WHERE id = $${BOOKING_COLS.length + 2} AND uid = $${BOOKING_COLS.length + 3}
            AND mail_sent_at IS NULL
          RETURNING id`,
        [...bookingValues(clean), user.email, draftId, uid]
      );
      if (upd.rows.length) insertedId = upd.rows[0].id;
    }

    const { rows } = insertedId ? { rows: [{ id: insertedId }] } : await client.query(
      `INSERT INTO booking_details (
         uid, buyer_salutation, buyer_name, co_buyer_name, buyer_email, co_buyer_email,
         consideration_amount, booking_amount_received,
         booking_amount_method, booking_amount_method_2,
         booking_amount_split_1, booking_amount_split_2,
         ats_timeline, registry_timeline, booking_amount_forfeitable,
         amount_on_ats_pct, other_conditions, recipients, broker_emails, submitted_by,
         source, brokerage_amount, brokerage_timing,
         brokerage_ats_amount, brokerage_registry_amount,
         selling_cp_id, selling_cp_code, selling_cp_phone,
         selling_cp_name, selling_cp_company, selling_cp_email
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
                 $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31)
       RETURNING id`,
      [
        uid, clean.buyer_salutation, clean.buyer_name, clean.co_buyer_name,
        clean.buyer_email, clean.co_buyer_email,
        clean.consideration_amount, clean.booking_amount_received,
        clean.booking_amount_method, clean.booking_amount_method_2,
        clean.booking_amount_split_1, clean.booking_amount_split_2,
        clean.ats_timeline, clean.registry_timeline,
        clean.booking_amount_forfeitable, clean.amount_on_ats_pct,
        clean.other_conditions,
        JSON.stringify(clean.recipients || []),
        JSON.stringify(clean.broker_emails || []),
        user.email,
        clean.source, clean.brokerage_amount, clean.brokerage_timing,
        clean.brokerage_ats_amount, clean.brokerage_registry_amount,
        clean.selling_cp_id, clean.selling_cp_code, clean.selling_cp_phone,
        clean.selling_cp_name, clean.selling_cp_company, clean.selling_cp_email,
      ]
    );
    insertedId = rows[0].id;

    // Ensure demand_details has availability_status='Booked' (idempotent).
    await client.query(
      `INSERT INTO demand_details (uid, availability_status, updated_by)
       VALUES ($1, 'Booked', $2)
       ON CONFLICT (uid) DO UPDATE
         SET availability_status = 'Booked', updated_by = $2, updated_at = NOW()`,
      [uid, user.email]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[/api/booking-details POST insert]', err.message);
    client.release();
    return res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }

  // Save (draft) — done. Audit log + return.
  if (action === 'save') {
    logActivity(uid, 'booking_save', 'booking', user, { booking_id: insertedId });
    return res.status(200).json({ success: true, id: insertedId, sent: false });
  }

  // Send — call SMTP, then stamp mail_sent_at.
  const { subject, html } = buildBookingEmail({
    property,
    booking: clean,
    submittedBy: user.email,
    submittedByName: user.name,
  });

  const mailTo = effectiveRecipients(clean);
  try {
    await sendMail({ to: mailTo, subject, html });
  } catch (err) {
    console.error('[/api/booking-details POST send]', err.message);
    // The booking_details row is already inserted (without mail_sent_at).
    // Surface the failure to the user so they can retry the send without
    // re-typing the form.
    return res.status(500).json({
      success: false,
      error: 'Failed to send email: ' + err.message,
      booking_id: insertedId,
      hint: 'The booking was saved but the email was not sent. An admin can retry.',
    });
  }

  // Stamp mail_sent_at on success.
  await pool.query(
    `UPDATE booking_details SET mail_sent_at = NOW(), updated_at = NOW() WHERE id = $1`,
    [insertedId]
  );

  logActivity(uid, priorSentCount ? 'booking_resent' : 'booking_sent', 'booking', user, {
    booking_id: insertedId,
    recipients: mailTo,
    subject,
    // >0 means this is a rebooking after a cancellation; the prior bookings
    // remain in booking_details as history.
    prior_bookings: priorSentCount,
  });

  return res.status(200).json({ success: true, id: insertedId, sent: true });
};

module.exports = async (req, res) => {
  try {
    return await handleBookingRequest(req, res);
  } catch (err) {
    // Without this an unhandled throw rejects the async handler and Vercel
    // reports only FUNCTION_INVOCATION_FAILED, with no clue which line failed.
    console.error('[/api/booking-details] unhandled:', err && err.stack || err);
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: err && err.message || 'Server error' });
    }
  }
};
