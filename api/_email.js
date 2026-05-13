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

function row(label, value) {
  if (value == null || value === '') return '';
  return `<tr>
    <td style="padding:6px 12px;color:#6b7280;font-size:12px;border-bottom:1px solid #f1f3f5;width:200px;">${esc(label)}</td>
    <td style="padding:6px 12px;color:#111827;font-size:13px;font-weight:500;border-bottom:1px solid #f1f3f5;">${esc(value)}</td>
  </tr>`;
}

// Builds the email subject + HTML body for a booking submission.
// `property` is the row from /api/list-or-detail; `booking` is the form data.
function buildBookingEmail({ property, booking, submittedBy }) {
  const p = property || {};
  const b = booking || {};

  const propertyLabel = [
    p.society_name,
    p.unit_no && ('Unit ' + p.unit_no),
    p.tower_no && ('Tower ' + p.tower_no),
    p.floor != null && ('Floor ' + p.floor),
  ].filter(Boolean).join(' · ');

  const subject = `Booking — ${propertyLabel || 'Property'} (${p.city || 'City'})`;

  const html = `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f5f6f8;font-family:Inter,Arial,sans-serif;color:#1a1d23;">
  <div style="max-width:680px;margin:24px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.06);">
    <div style="padding:20px 24px;background:#4f46e5;color:#fff;">
      <div style="font-size:11px;letter-spacing:.5px;text-transform:uppercase;opacity:.85;">Openhouse · Demand Visibility Dashboard</div>
      <div style="font-size:20px;font-weight:700;margin-top:4px;">Booking Submission</div>
    </div>

    <div style="padding:20px 24px;">
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
        ${row('Buyer Name', b.buyer_name)}
        ${row('Co-buyer Name', b.co_buyer_name)}
        ${row('Consideration Amount', inr(b.consideration_amount))}
        ${row('Booking Amount Received', inr(b.booking_amount_received))}
        ${row('Payment Method', b.booking_amount_method)}
        ${row('ATS Timeline', b.ats_timeline)}
        ${row('Registry Timeline', b.registry_timeline)}
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
