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
// Admin + manager only. After mail_sent_at is set, the row is considered
// locked for managers (admins can still re-submit a fresh row, treated as a
// new submission rather than an edit).
//
// All writes wrapped in a transaction; mail send happens AFTER commit so a
// failed send doesn't leave an orphan unsent row in the DB.

const { pool, logActivity } = require('../_db');
const { requireAuth, canEdit, setCors } = require('../_auth');
const { buildBookingEmail, sendMail } = require('../_email');

const PAYMENT_METHODS = ['UPI', 'NEFT', 'IMPS', 'RTGS', 'Cheque', 'Cash', 'Other'];
const SALUTATIONS = ['Mr.', 'Mrs.', 'Ms.', 'Dr.'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Strict-list fields. Reject anything not in the allow-list to keep DB clean.
function validate(body) {
  const errors = [];
  const clean = {};

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
    // Reject when method_1 === method_2 (split into the same instrument makes no sense)
    if (clean.booking_amount_method && clean.booking_amount_method === clean.booking_amount_method_2) {
      errors.push('Split payment methods must be different');
    }
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

module.exports = async (req, res) => {
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
  if (!['preview', 'send', 'save'].includes(action)) {
    return res.status(400).json({ success: false, error: `action must be one of: preview, send, save` });
  }

  const { clean, errors } = validate(req.body);
  if (errors.length) return res.status(400).json({ success: false, error: errors.join('; ') });

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

  // ── action: save (draft) or send (full) — both write a row.
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

  // Manager lockout: if a prior booking for this uid is already mailed and
  // user is manager (not admin), block further bookings. Admins can re-submit.
  if (user.role !== 'admin') {
    const existing = await pool.query(
      `SELECT 1 FROM booking_details WHERE uid = $1 AND mail_sent_at IS NOT NULL LIMIT 1`,
      [uid]
    );
    if (existing.rows.length) {
      return res.status(403).json({
        success: false,
        error: 'A booking for this property has already been submitted. Only admins can re-submit.',
      });
    }
  }

  // Insert booking row. Email sending happens AFTER the transaction commits
  // so we don't lose track of in-flight bookings if SMTP fails.
  const client = await pool.connect();
  let insertedId;
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `INSERT INTO booking_details (
         uid, buyer_salutation, buyer_name, co_buyer_name, buyer_email, co_buyer_email,
         consideration_amount, booking_amount_received,
         booking_amount_method, booking_amount_method_2,
         booking_amount_split_1, booking_amount_split_2,
         ats_timeline, registry_timeline, booking_amount_forfeitable,
         amount_on_ats_pct, other_conditions, recipients, broker_emails, submitted_by
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
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

  logActivity(uid, 'booking_sent', 'booking', user, {
    booking_id: insertedId,
    recipients: mailTo,
    subject,
  });

  return res.status(200).json({ success: true, id: insertedId, sent: true });
};
