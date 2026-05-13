// SMTP email sender for booking submissions. Single transporter instance,
// reused across requests within a serverless cold-start. Pulls connection
// details from env vars — see README for the required set:
//
//   SMTP_HOST     — e.g. smtp.gmail.com / smtp.office365.com / mailgun host
//   SMTP_PORT     — 587 (STARTTLS) or 465 (TLS). Defaults to 587.
//   SMTP_SECURE   — 'true' for port 465 (implicit TLS), 'false' for 587 STARTTLS. Defaults 'false'.
//   SMTP_USER     — auth username (usually the From address)
//   SMTP_PASS     — auth password / app password / API key
//   SMTP_FROM     — display From address (e.g. 'Openhouse Demand <bookings@openhouse.in>')
//
// The transporter is created lazily on first sendMail() call so cold starts
// that don't need email don't pay the connection cost.

const nodemailer = require('nodemailer');

let _transporter = null;

function getTransporter() {
  if (_transporter) return _transporter;

  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  const secure = String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true';
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    throw new Error(
      'SMTP not configured. Set SMTP_HOST, SMTP_USER, SMTP_PASS (and optionally SMTP_PORT, SMTP_SECURE, SMTP_FROM) in Vercel env vars.'
    );
  }

  _transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
  });

  return _transporter;
}

// HTML escaping for template substitutions. nodemailer doesn't HTML-escape for us.
function esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function inr(n) {
  if (n == null || n === '') return '—';
  const num = Number(n);
  if (isNaN(num)) return esc(String(n));
  return '₹' + num.toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

// "INR 1,27,00,000/-" — the format the buyer letter uses. Whole rupees,
// Indian-style lakh/crore commas, no symbol prefix.
function inrLetter(n) {
  if (n == null || n === '') return '—';
  const num = Math.round(Number(n));
  if (isNaN(num)) return esc(String(n));
  return 'INR ' + num.toLocaleString('en-IN') + '/-';
}

// "2026-05-14" → "14th May 2026" (Indian-style ordinal). Returns the raw input
// if it's not a parseable ISO date — historical rows may be free-text from
// before the date-picker migration, and we don't want the template to blow up.
function dateLetter(iso) {
  if (!iso) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso).trim());
  if (!m) return esc(String(iso));
  const y = +m[1], mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return esc(String(iso));
  const months = ['January','February','March','April','May','June',
                  'July','August','September','October','November','December'];
  const j = d % 10, k = d % 100;
  const suffix = (k >= 11 && k <= 13) ? 'th'
                : j === 1 ? 'st'
                : j === 2 ? 'nd'
                : j === 3 ? 'rd' : 'th';
  return `${d}${suffix} ${months[mo - 1]} ${y}`;
}

// First word of the buyer name — used after the salutation. "Poonam Sharma" → "Poonam".
function firstName(name) {
  if (!name) return '';
  return String(name).trim().split(/\s+/)[0] || '';
}

function row(label, value) {
  if (value == null || value === '') return '';
  return `<tr>
    <td style="padding:6px 12px;color:#6b7280;font-size:12px;border-bottom:1px solid #f1f3f5;width:200px;">${esc(label)}</td>
    <td style="padding:6px 12px;color:#111827;font-size:13px;font-weight:500;border-bottom:1px solid #f1f3f5;">${esc(value)}</td>
  </tr>`;
}

// Builds the email subject + HTML body for a booking submission.
// `property` is the row from /api/list-or-detail; `booking` is the form data.
//
// The email is a single message that goes to both the buyer and the internal
// recipient list (concatenated To by the caller). It has two stacked sections:
//   (1) A buyer-facing narrative letter at the top — "Dear Ms. Poonam, …".
//       The third paragraph (forfeit / refund) is included only when
//       booking_amount_forfeitable === true.
//   (2) An internal HTML summary table below, separated by a divider —
//       gives the demand team and CP RMs a structured record of every field.
function buildBookingEmail({ property, booking, submittedBy }) {
  const p = property || {};
  const b = booking || {};

  // Subject — buyer-facing tone, since the buyer is on the To line.
  const unitLabel = p.unit_no ? `Unit ${p.unit_no}` : 'Unit';
  const societyLabel = p.society_name || 'Property';
  const subject = `Booking Confirmation — ${unitLabel}, ${societyLabel}`;

  // ── Letter body. Variables ───────────────────────────────────────────────
  const addressee = [b.buyer_salutation, firstName(b.buyer_name)].filter(Boolean).join(' ') || 'Buyer';
  const propertyAddress = [
    p.unit_no && `Unit No. ${p.unit_no}`,
    p.society_name,
    p.locality,
    p.city,
  ].filter(Boolean).join(', ');
  const considerationStr = inrLetter(b.consideration_amount);
  const atsDateStr = dateLetter(b.ats_timeline);
  const atsPctStr = b.amount_on_ats_pct != null ? `${b.amount_on_ats_pct}%` : '—';
  const registryDaysStr = b.registry_timeline ? `${b.registry_timeline} days` : '—';
  const bookingAmtStr = inrLetter(b.booking_amount_received);
  const payMethod = b.booking_amount_method || '—';
  const showForfeitClause = b.booking_amount_forfeitable === true;

  const letterHtml = `
    <p style="margin:0 0 14px;">Dear ${esc(addressee)},</p>

    <p style="margin:0 0 14px;">
      Thank you for booking <strong>${esc(propertyAddress)}</strong>
      for a total consideration of <strong>${esc(considerationStr)}</strong>.
    </p>

    <p style="margin:0 0 14px;">
      We plan to execute the Agreement to Sell (ATS) between you and the owner
      by <strong>${esc(atsDateStr)}</strong>. At the time of signing the ATS, you
      will be required to pay a minimum of <strong>${esc(atsPctStr)}</strong> of
      the total sale value. The remaining balance amount will be payable at the
      time of registry, which is to be completed within
      <strong>${esc(registryDaysStr)}</strong>.
    </p>

    <p style="margin:0 0 14px;">
      We also acknowledge receipt of a booking amount totaling
      <strong>${esc(bookingAmtStr)}</strong> via <strong>${esc(payMethod)}</strong>.
      ${showForfeitClause ? `Please note that if you choose not to proceed with the ATS, the booking amount will be forfeited. However after the successful signing of the ATS, the booking amount will be refunded to you.` : ''}
    </p>

    ${b.other_conditions ? `
      <p style="margin:0 0 14px;white-space:pre-wrap;">${esc(b.other_conditions)}</p>
    ` : ''}

    <p style="margin:0 0 14px;">
      Congratulations on your booking. Please feel free to contact us if you have
      any questions or require further clarification.
    </p>

    <p style="margin:0 0 4px;">Thanks &amp; Regards,</p>
    <p style="margin:0 0 14px;"><strong>Team Openhouse</strong></p>
  `;

  // ── Internal summary table — for the demand team + CP RM records ────────
  const summaryHtml = `
    <div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.4px;font-weight:600;margin-bottom:8px;">Property</div>
    <table style="width:100%;border-collapse:collapse;">
      ${row('Society', p.society_name)}
      ${row('Unit', p.unit_no)}
      ${row('Tower', p.tower_no)}
      ${row('Floor', p.floor != null ? String(p.floor) : '')}
      ${row('Configuration', p.configuration)}
      ${row('Super Area (sqft)', p.super_area || p.area_sqft)}
      ${row('Carpet Area (sqft)', p.carpet_area)}
      ${row('Locality', p.locality)}
      ${row('City', p.city)}
    </table>

    <div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.4px;font-weight:600;margin:20px 0 8px;">Booking Details</div>
    <table style="width:100%;border-collapse:collapse;">
      ${row('Buyer', [b.buyer_salutation, b.buyer_name].filter(Boolean).join(' '))}
      ${row('Buyer Email', b.buyer_email)}
      ${row('Co-buyer Name', b.co_buyer_name)}
      ${row('Co-buyer Email', b.co_buyer_email)}
      ${row('Consideration Amount', inr(b.consideration_amount))}
      ${row('Booking Amount Received', inr(b.booking_amount_received))}
      ${row('Payment Method', b.booking_amount_method)}
      ${row('ATS Date', dateLetter(b.ats_timeline))}
      ${row('Registry Within', b.registry_timeline ? b.registry_timeline + ' days' : '')}
      ${row('Booking Amount Forfeitable?', b.booking_amount_forfeitable === true ? 'Yes' : b.booking_amount_forfeitable === false ? 'No' : '')}
      ${row('Amount Payable at ATS (%)', b.amount_on_ats_pct != null ? b.amount_on_ats_pct + '%' : '')}
    </table>

    ${b.other_conditions ? `
      <div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.4px;font-weight:600;margin:20px 0 8px;">Other Conditions</div>
      <div style="font-size:13px;color:#374151;background:#fffbeb;border-left:3px solid #f59e0b;padding:10px 12px;white-space:pre-wrap;">${esc(b.other_conditions)}</div>
    ` : ''}

    <div style="margin-top:24px;padding-top:14px;border-top:1px solid #e4e7ec;font-size:11px;color:#9ca3af;">
      Submitted by <strong style="color:#374151;">${esc(submittedBy || '—')}</strong>
      on ${new Date().toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' })} IST
    </div>
  `;

  const html = `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f5f6f8;font-family:Inter,Arial,sans-serif;color:#1a1d23;">
  <div style="max-width:680px;margin:24px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.06);">
    <div style="padding:20px 24px;background:#4f46e5;color:#fff;">
      <div style="font-size:11px;letter-spacing:.5px;text-transform:uppercase;opacity:.85;">Openhouse</div>
      <div style="font-size:20px;font-weight:700;margin-top:4px;">Booking Confirmation</div>
    </div>

    <div style="padding:24px;font-size:14px;line-height:1.6;color:#1a1d23;">
      ${letterHtml}
    </div>

    <div style="padding:0 24px;">
      <div style="border-top:1px dashed #d1d5db;margin:0 -4px;"></div>
      <div style="font-size:10px;color:#9ca3af;text-transform:uppercase;letter-spacing:.5px;margin:14px 0 12px;">— Internal record (booking summary) —</div>
    </div>

    <div style="padding:0 24px 24px;">
      ${summaryHtml}
    </div>
  </div>
</body></html>`;

  return { subject, html };
}

async function sendMail({ to, subject, html }) {
  const transporter = getTransporter();
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  const info = await transporter.sendMail({
    from,
    to: Array.isArray(to) ? to.join(', ') : to,
    subject,
    html,
  });
  return info;
}

module.exports = { buildBookingEmail, sendMail };
