const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const { pool, ensureTable } = require('./_db');

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';
// Distinct cookie name from the other dashboards so sessions don't collide when
// served from the same parent domain.
const COOKIE_NAME = 'oh_session_demand';
const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

async function verifyGoogleToken(idToken) {
  const ticket = await client.verifyIdToken({
    idToken,
    audience: process.env.GOOGLE_CLIENT_ID,
  });
  return ticket.getPayload();
}

async function findUserByEmail(email) {
  const { rows } = await pool.query(
    'SELECT * FROM demand_users WHERE email = $1',
    [email.toLowerCase()]
  );
  return rows[0] || null;
}

async function getUserCount() {
  const { rows } = await pool.query('SELECT COUNT(*) FROM demand_users');
  return parseInt(rows[0].count);
}

// First user → admin. All subsequent users must be pre-added by an admin.
// Updates name/picture on every login so we always have the latest profile data.
async function upsertUser(payload) {
  const email = payload.email.toLowerCase();
  const name = payload.name || '';
  const picture = payload.picture || '';

  const existing = await findUserByEmail(email);
  if (existing) {
    const { rows } = await pool.query(
      `UPDATE demand_users SET name = $1, picture = $2, updated_at = NOW()
       WHERE email = $3 RETURNING *`,
      [name, picture, email]
    );
    return rows[0];
  }

  const count = await getUserCount();
  if (count === 0) {
    const { rows } = await pool.query(
      `INSERT INTO demand_users (email, name, picture, role)
       VALUES ($1, $2, $3, 'admin') RETURNING *`,
      [email, name, picture]
    );
    return rows[0];
  }

  return null;
}

function createJWT(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

function verifyJWT(token) {
  return jwt.verify(token, JWT_SECRET);
}

function parseCookie(req, name) {
  const header = req.headers.cookie || '';
  const match = header.split(';').map(c => c.trim()).find(c => c.startsWith(name + '='));
  return match ? match.split('=').slice(1).join('=') : null;
}

function setSessionCookie(res, token) {
  const isProd = process.env.VERCEL_ENV === 'production' || process.env.NODE_ENV === 'production';
  const parts = [
    `${COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${7 * 24 * 60 * 60}`,
  ];
  if (isProd) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

async function requireAuth(req, res) {
  const token = parseCookie(req, COOKIE_NAME);
  if (!token) {
    res.status(401).json({ success: false, error: 'Authentication required' });
    return null;
  }
  try {
    const payload = verifyJWT(token);
    await ensureTable();
    // Re-load from DB so role changes (or user removal) take effect mid-session.
    const user = await findUserByEmail(payload.email);
    if (!user) {
      res.status(403).json({ success: false, error: 'Access revoked. Contact admin.' });
      return null;
    }
    // Force-logout: admin can stamp force_logout_at to invalidate every JWT
    // issued before that moment. payload.iat is unix seconds; convert to ms.
    if (user.force_logout_at) {
      const tokenIatMs = (payload.iat || 0) * 1000;
      const forceLogoutMs = new Date(user.force_logout_at).getTime();
      if (forceLogoutMs > tokenIatMs) {
        res.status(401).json({ success: false, error: 'Session ended by admin. Please sign in again.' });
        return null;
      }
    }
    return user;
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      res.status(401).json({ success: false, error: 'Session expired. Please sign in again.' });
    } else {
      res.status(401).json({ success: false, error: 'Invalid session' });
    }
    return null;
  }
}

function requireAdmin(user, res) {
  if (user.role !== 'admin') {
    res.status(403).json({ success: false, error: 'Admin access required' });
    return false;
  }
  return true;
}

function canEdit(user) {
  return user.role === 'admin' || user.role === 'manager';
}

function setCors(res) {
  const origin = process.env.ALLOWED_ORIGIN || '';
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
}

module.exports = {
  verifyGoogleToken,
  findUserByEmail,
  upsertUser,
  createJWT,
  setSessionCookie,
  clearSessionCookie,
  requireAuth,
  requireAdmin,
  canEdit,
  setCors,
};
