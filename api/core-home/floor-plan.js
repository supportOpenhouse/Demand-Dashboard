// POST /api/core-home/floor-plan
// Uploads a floor plan image to Cloudinary and returns its secure URL. The
// Update Home modal then sends that URL to the Core API as `floorPlanUrl`,
// which upserts it as a HomePhoto (altText "Floor Plan") on the home.
//
// The upload runs server-side so the preset never reaches the browser and so we
// can enforce type/size limits before spending an upload.
//
// Env:
//   CLOUDINARY_CLOUD_NAME     — the Cloudinary account (existing images are on
//                               `dwdlsuy61`, so that is almost certainly it).
//   CLOUDINARY_UPLOAD_PRESET  — an UNSIGNED upload preset created in the
//                               Cloudinary console. Unsigned keeps the API
//                               secret out of this app entirely.
//   CLOUDINARY_FOLDER         — optional; folder to upload into.
const { requireAuth, canEdit, setCors } = require('../_auth');

// Vercel caps a serverless request body at ~4.5 MB and base64 inflates by ~33%,
// so hold the decoded image well under that.
const MAX_BYTES = 3 * 1024 * 1024;
const ALLOWED = ['image/png', 'image/jpeg', 'image/webp'];

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });

  const user = await requireAuth(req, res);
  if (!user) return;
  if (!canEdit(user)) return res.status(403).json({ success: false, error: 'Viewer access is read-only' });

  const cloud = process.env.CLOUDINARY_CLOUD_NAME;
  const preset = process.env.CLOUDINARY_UPLOAD_PRESET;
  if (!cloud || !preset) {
    return res.status(503).json({
      success: false,
      error: 'Floor plan upload is not configured. Set CLOUDINARY_CLOUD_NAME and CLOUDINARY_UPLOAD_PRESET.',
    });
  }

  // Browser sends a data URL: "data:image/png;base64,<...>".
  const dataUrl = (req.body && req.body.dataUrl) || '';
  const m = /^data:([^;,]+);base64,(.+)$/.exec(String(dataUrl));
  if (!m) return res.status(400).json({ success: false, error: 'dataUrl (base64 image) is required' });

  const mime = m[1].toLowerCase();
  if (!ALLOWED.includes(mime)) {
    return res.status(400).json({ success: false, error: `Unsupported image type "${mime}". Use PNG, JPEG or WebP.` });
  }
  // base64 length → decoded byte count, without allocating the buffer first.
  const padding = (m[2].endsWith('==') ? 2 : m[2].endsWith('=') ? 1 : 0);
  const bytes = Math.floor(m[2].length * 3 / 4) - padding;
  if (bytes > MAX_BYTES) {
    return res.status(400).json({
      success: false,
      error: `Image is ${(bytes / 1024 / 1024).toFixed(1)} MB. Max ${MAX_BYTES / 1024 / 1024} MB — please compress it.`,
    });
  }

  try {
    const form = new URLSearchParams();
    form.set('file', dataUrl);
    form.set('upload_preset', preset);
    if (process.env.CLOUDINARY_FOLDER) form.set('folder', process.env.CLOUDINARY_FOLDER);

    const r = await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(cloud)}/image/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.secure_url) {
      const msg = (data.error && data.error.message) || `Cloudinary responded ${r.status}`;
      console.error('[/api/core-home/floor-plan]', msg);
      return res.status(502).json({ success: false, error: 'Upload failed: ' + msg });
    }
    return res.status(200).json({ success: true, url: data.secure_url });
  } catch (err) {
    console.error('[/api/core-home/floor-plan]', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
};
