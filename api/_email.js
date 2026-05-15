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

// "INR 1,27,00,000/-" — the format the buyer letter uses. Whole rupees,
// Indian-style lakh/crore commas, no symbol prefix.
function inrLetter(n) {
  if (n == null || n === '') return '—';
  const num = Math.round(Number(n));
  if (isNaN(num)) return esc(String(n));
  return '₹' + num.toLocaleString('en-IN') + '/-';
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

// Whole rupees → Indian-system words: "12700000" → "One Crore Twenty Seven Lakh".
// Uses the Indian numbering segmentation (crore/lakh/thousand/hundred) — not
// the western million/billion — so the words match the figure's comma grouping.
function _twoDigitWords(n) {
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
                'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen',
                'Seventeen', 'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  if (n < 20) return ones[n];
  const t = Math.floor(n / 10), o = n % 10;
  return tens[t] + (o ? ' ' + ones[o] : '');
}
function _threeDigitWords(n) {
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];
  const h = Math.floor(n / 100), r = n % 100;
  let s = '';
  if (h) s += ones[h] + ' Hundred';
  if (r) s += (s ? ' ' : '') + _twoDigitWords(r);
  return s;
}
function numToWordsIndian(n) {
  const num = Math.round(Number(n));
  if (!isFinite(num) || num < 0) return '';
  if (num === 0) return 'Zero';
  const crore    = Math.floor(num / 10000000);
  const lakh     = Math.floor((num % 10000000) / 100000);
  const thousand = Math.floor((num % 100000) / 1000);
  const hundred  =            num % 1000;
  let s = '';
  if (crore)    s += _threeDigitWords(crore) + ' Crore';
  if (lakh)     s += (s ? ' ' : '') + _twoDigitWords(lakh) + ' Lakh';
  if (thousand) s += (s ? ' ' : '') + _twoDigitWords(thousand) + ' Thousand';
  if (hundred)  s += (s ? ' ' : '') + _threeDigitWords(hundred);
  return s;
}

// "Rupees <words> only" — Indian formal-letter convention for amounts in words.
// Returns '' for null/blank inputs so the template can branch off it.
function inrWords(n) {
  if (n == null || n === '') return '';
  const words = numToWordsIndian(n);
  return words ? `Rupees ${words} only` : '';
}

// Builds the email subject + HTML body for a booking submission. The body is
// a buyer-facing narrative letter; the same email is sent to the buyer, CP RMs,
// brokers, and the internal fixed list (the caller concatenates the To line).
//
// The forfeit/refund paragraph appears only when booking_amount_forfeitable===true.
// The receipt line renders one or two payment instruments depending on whether
// `booking_amount_method_2` and the `booking_amount_split_*` legs are populated.
function buildBookingEmail({ property, booking, submittedBy, submittedByName }) {
  const p = property || {};
  const b = booking || {};

  // Subject — buyer-facing tone, since the buyer is on the To line.
  const unitLabel = p.unit_no ? `Unit ${p.unit_no}` : 'Unit';
  const societyLabel = p.society_name || 'Property';
  const subject = `Booking Confirmation — ${unitLabel}, ${societyLabel}`;

  // ── Letter body. Variables ───────────────────────────────────────────────
  const addressee = firstName(b.buyer_name) || 'Buyer';
  const propertyAddress = [
    p.tower_no && `${p.unit_no} -`,
    p.society_name,
    p.locality,
    p.city,
  ].filter(Boolean).join(', ');
  const considerationStr = inrLetter(b.consideration_amount);
  const considerationWords = inrWords(b.consideration_amount);
  const atsDateStr = dateLetter(b.ats_timeline);
  const atsPctStr = b.amount_on_ats_pct != null ? `${b.amount_on_ats_pct}%` : '—';
  const registryDaysStr = b.registry_timeline ? `${b.registry_timeline} days` : '—';
  const bookingAmtStr = inrLetter(b.booking_amount_received);
  const showForfeitClause = b.booking_amount_forfeitable === true;

  // Payment sentence — single instrument vs split. For split, we render
  // "INR X (INR A via UPI and INR B via NEFT)" so the buyer sees both legs.
  const isSplit = !!(b.booking_amount_method_2 && b.booking_amount_split_1 != null && b.booking_amount_split_2 != null);
  const receiptHtml = isSplit
    ? `via <strong>${esc(b.booking_amount_method || '—')}</strong>
       (${esc(inrLetter(b.booking_amount_split_1))}) and
       <strong>${esc(b.booking_amount_method_2)}</strong>
       (${esc(inrLetter(b.booking_amount_split_2))})`
    : `via <strong>${esc(b.booking_amount_method || '—')}</strong>`;

  const signerName = submittedByName || submittedBy || 'Team Openhouse';

  const letterHtml = `
    <p style="margin:0 0 14px;">Dear ${esc(addressee)},</p>

    <p style="margin:0 0 14px;">
      Greetings from Openhouse!

      Thank you for booking <strong>${esc(propertyAddress)}</strong>
      for a total consideration of <strong>${esc(considerationStr)}</strong>${considerationWords ? ` (<strong>${esc(considerationWords)}</strong>)` : ''}.
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
      We also acknowledge receipt of a booking amount of
      <strong>${esc(bookingAmtStr)}</strong> ${receiptHtml}.
      The said amount will be refunded to you after successful execution of the ATS.
      ${showForfeitClause ? `Please note that if you choose not to proceed with the ATS, the booking amount will be forfeited.` : ''}
    </p>

    ${b.other_conditions ? `
      <p style="margin:0 0 14px;white-space:pre-wrap;">${esc(b.other_conditions)}</p>
    ` : ''}

    <p style="margin:0 0 14px;">
      Congratulations on your booking. Please feel free to contact us if you have
      any questions or require further clarifications.
    </p>


    <p style="margin:0 0 4px;">Thanks &amp; Regards,</p>
    <p style="margin:0 0 14px;"><strong>${esc(signerName)}</strong></p>    
    <p style="margin:24px 0 0;"><a href="https://www.openhouse.in" style="color:#1d4ed8;text-decoration:underline;">www.openhouse.in</a>
    </p>

    <p style="margin:0 0 14px;color:#374151;">
    
      <em>P.S.: Please note that Stamp Duty, Registration related charges are not
      included in the total consideration and has to be incurred by the buyer.</em>
    </p>
  `;

  // Logo URL — served from public/logo_white.png by Vercel's static hosting.
  // White variant chosen for legibility on the orange banner. Built from
  // PUBLIC_BASE_URL (set in Vercel env, e.g. "https://demand.openhouse.in")
  // and falls back to the per-deploy VERCEL_URL so the logo still renders in
  // preview deploys. If neither env var is present, the right cell is dropped.
  const baseUrl = process.env.PUBLIC_BASE_URL
    || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '');
  const logoUrl = baseUrl ? `${baseUrl.replace(/\/$/, '')}/logo_white.png` : '';
  const logoCell = logoUrl
    ? `<td align="right" valign="middle" style="padding:20px 24px;width:1%;white-space:nowrap;">
         <img src="${logoUrl}" alt="Openhouse" width="44" height="44"
              style="display:block;height:44px;width:auto;border:0;outline:none;text-decoration:none;">
       </td>`
    : '';

  // Banner uses a 2-column table (text left, logo right) for Outlook-safe
  // layout — flexbox isn't honored by Word-engine renderers used by Outlook.
  const html = `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f5f6f8;font-family:Inter,Arial,sans-serif;color:#1a1d23;">
  <div style="max-width:680px;margin:24px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.06);">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0"
           style="width:100%;background:#FF6B2B;color:#fff;border-collapse:collapse;">
      <tr>
        <td valign="middle" style="padding:20px 24px;">
          <div style="font-size:11px;letter-spacing:.5px;text-transform:uppercase;opacity:.85;">Openhouse</div>
          <div style="font-size:20px;font-weight:700;margin-top:4px;">Booking Confirmation</div>
        </td>
        ${logoCell}
      </tr>
    </table>

    <div style="padding:24px;font-size:14px;line-height:1.6;color:#1a1d23;">
      ${letterHtml}
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
