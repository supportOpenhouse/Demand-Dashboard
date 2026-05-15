const { ensureTable } = require('../_db');
const { verifyGoogleToken, upsertUser, createJWT, setSessionCookie, setCors } = require('../_auth');

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { credential } = req.body || {};
  if (!credential) {
    return res.status(400).json({ success: false, error: 'Missing credential' });
  }

  if (!process.env.GOOGLE_CLIENT_ID) {
    console.error('[/api/auth/login] GOOGLE_CLIENT_ID env var is not set');
    return res.status(500).json({ success: false, error: 'Server misconfigured: GOOGLE_CLIENT_ID env var is not set on Vercel.' });
  }
  if (!process.env.DATABASE_URL) {
    console.error('[/api/auth/login] DATABASE_URL env var is not set');
    return res.status(500).json({ success: false, error: 'Server misconfigured: DATABASE_URL env var is not set on Vercel.' });
  }

  // Step 1: ensure tables exist. Logged but non-fatal — tables may exist already.
  try {
    await ensureTable();
  } catch (e) {
    console.error('[/api/auth/login] ensureTable failed:', e.message);
    return res.status(500).json({ success: false, error: 'Database setup failed: ' + e.message });
  }

  // Step 2: verify the Google ID token. The most common failure here is an
  // audience mismatch — i.e., the GOOGLE_CLIENT_ID env var on Vercel doesn't
  // match the OAuth client that issued the token to the front-end.
  let payload;
  try {
    payload = await verifyGoogleToken(credential);
  } catch (e) {
    console.error('[/api/auth/login] verifyGoogleToken failed:', e.message);
    return res.status(401).json({
      success: false,
      error: 'Google verification failed: ' + e.message + '. (Common cause: GOOGLE_CLIENT_ID on Vercel does not match the OAuth client.)',
    });
  }

  // Step 3: find or create the user record.
  let user;
  try {
    user = await upsertUser(payload);
  } catch (e) {
    console.error('[/api/auth/login] upsertUser failed:', e.message);
    return res.status(500).json({
      success: false,
      error: 'Database error during login: ' + e.message + '. (Common cause: DATABASE_URL incorrect or Neon DB unreachable.)',
    });
  }

  if (!user) {
    return res.status(403).json({
      success: false,
      error: 'Access denied. Your email is not authorized for the Demand Dashboard. Contact admin to get access.',
    });
  }

  // Step 4: issue our session JWT and reply.
  try {
    const token = createJWT(user);
    setSessionCookie(res, token);
    res.status(200).json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        picture: user.picture,
        role: user.role,
      },
    });
  } catch (e) {
    console.error('[/api/auth/login] JWT creation failed:', e.message);
    res.status(500).json({ success: false, error: 'Session creation failed: ' + e.message + '. (Check JWT_SECRET env var.)' });
  }
};
