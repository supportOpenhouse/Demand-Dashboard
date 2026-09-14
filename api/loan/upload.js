// POST /api/loan/upload   — PUBLIC, no authentication.
//
// Uploads one loan document to Cloudinary and returns its URL. Deliberately
// separate from api/core-home/floor-plan.js: that route is auth-gated and
// image-only, whereas loan documents are mostly PDFs (Form 16, ITRs, bank
// statements) submitted by applicants who have no login.
//
// SECURITY NOTE — these files are PAN cards, Aadhaar, salary slips and bank
// statements, uploaded with the UNSIGNED preset, which stores them as
// Cloudinary delivery type "upload": publicly readable to anyone holding the
// URL. The public_id is random so URLs are not enumerable, but they never
// expire and are not access-controlled. Moving to signed uploads with
// type:"authenticated" requires CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET.
//
// Env: CLOUDINARY_CLOUD_NAME, CLOUDINARY_UPLOAD_PRESET, CLOUDINARY_FOLDER (opt).
const { setCors } = require('../_auth');
const { checkLoanRateLimit, clientIp } = require('./_rate-limit');

// Vercel caps a request body at ~4.5 MB and base64 inflates by a third, so the
// decoded file must stay well under that.
const MAX_BYTES = 3 * 1024 * 1024;
const ALLOWED = [
  'application/pdf',
  'image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif',
];

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });

  // Uploads are limited more loosely than submissions — one application
  // legitimately uploads many files — but still limited, since this endpoint
  // writes to our Cloudinary account with no login behind it.
  const ip = clientIp(req);
  const gate = await checkLoanRateLimit(ip, { limit: 120, windowMinutes: 60, bucket: 'upload' });
  if (!gate.allowed) return res.status(429).json({ success: false, error: gate.message });

  const cloud = process.env.CLOUDINARY_CLOUD_NAME;
  const preset = process.env.CLOUDINARY_UPLOAD_PRESET;
  if (!cloud || !preset) {
    return res.status(503).json({
      success: false,
      error: 'Document upload is not configured. Set CLOUDINARY_CLOUD_NAME and CLOUDINARY_UPLOAD_PRESET.',
    });
  }

  const dataUrl = (req.body && req.body.dataUrl) || '';
  const label = String((req.body && req.body.label) || 'document').slice(0, 80);
  const m = /^data:([^;,]+);base64,(.+)$/.exec(String(dataUrl));
  if (!m) return res.status(400).json({ success: false, error: 'A file is required' });

  const mime = m[1].toLowerCase();
  if (!ALLOWED.includes(mime)) {
    return res.status(400).json({
      success: false,
      error: 'Unsupported file type. Please upload a PDF or an image (PNG, JPEG, WebP, HEIC).',
    });
  }
  const padding = m[2].endsWith('==') ? 2 : m[2].endsWith('=') ? 1 : 0;
  const bytes = Math.floor(m[2].length * 3 / 4) - padding;
  if (bytes > MAX_BYTES) {
    return res.status(400).json({
      success: false,
      error: `That file is ${(bytes / 1024 / 1024).toFixed(1)} MB. Maximum ${MAX_BYTES / 1024 / 1024} MB — please compress it or upload a smaller scan.`,
    });
  }

  try {
    const form = new URLSearchParams();
    form.set('file', dataUrl);
    form.set('upload_preset', preset);
    form.set('folder', process.env.CLOUDINARY_FOLDER
      ? `${process.env.CLOUDINARY_FOLDER}/loan-applications`
      : 'loan-applications');

    // /auto/ so a PDF is accepted alongside images. Cloudinary reports PDFs as
    // resource_type "image", which is expected and fine for delivery.
    const r = await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(cloud)}/auto/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.secure_url) {
      const msg = (data.error && data.error.message) || `Cloudinary responded ${r.status}`;
      console.error('[/api/loan/upload]', msg);
      return res.status(502).json({ success: false, error: 'Upload failed: ' + msg });
    }
    return res.status(200).json({
      success: true,
      url: data.secure_url,
      format: data.format || null,
      bytes: data.bytes || bytes,
      label,
    });
  } catch (err) {
    console.error('[/api/loan/upload]', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
};
