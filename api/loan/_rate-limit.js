// Per-IP rate limiting for the public loan routes.
//
// Backed by Postgres rather than process memory on purpose: serverless
// instances do not share memory and are recycled constantly, so an in-process
// counter resets on every cold start and effectively limits nothing.
//
// Fails OPEN. If the limiter itself errors (table missing, DB blip) a genuine
// applicant should still be able to submit — the limiter exists to blunt abuse,
// not to gate legitimate use, and a DB problem is not the applicant's fault.
const { pool } = require('../_db');

// Vercel puts the real client address first in x-forwarded-for; everything
// after it is proxy hops and is not trustworthy.
function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim().slice(0, 64);
  return String(req.headers['x-real-ip'] || (req.socket && req.socket.remoteAddress) || 'unknown').slice(0, 64);
}

async function checkLoanRateLimit(ip, { limit, windowMinutes, bucket = 'submit' } = {}) {
  const key = `${bucket}:${ip}`;
  try {
    // One statement: reset the window if it has aged out, otherwise increment.
    // Doing it as an upsert keeps it atomic against concurrent requests from
    // the same address.
    const { rows } = await pool.query(
      `INSERT INTO loan_form_rate_limit (ip, window_started, hits, last_hit)
       VALUES ($1, NOW(), 1, NOW())
       ON CONFLICT (ip) DO UPDATE SET
         window_started = CASE
           WHEN loan_form_rate_limit.window_started < NOW() - ($2 || ' minutes')::interval
           THEN NOW() ELSE loan_form_rate_limit.window_started END,
         hits = CASE
           WHEN loan_form_rate_limit.window_started < NOW() - ($2 || ' minutes')::interval
           THEN 1 ELSE loan_form_rate_limit.hits + 1 END,
         last_hit = NOW()
       RETURNING hits`,
      [key, String(windowMinutes)]
    );
    const hits = (rows[0] && rows[0].hits) || 1;
    if (hits > limit) {
      return {
        allowed: false,
        hits,
        message: 'Too many requests from this network. Please wait a while and try again.',
      };
    }
    return { allowed: true, hits };
  } catch (err) {
    console.warn('[loan rate-limit] failing open:', err.message);
    return { allowed: true, hits: 0, degraded: true };
  }
}

module.exports = { checkLoanRateLimit, clientIp };
