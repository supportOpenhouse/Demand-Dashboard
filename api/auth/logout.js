const { clearSessionCookie, setCors } = require('../_auth');

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  clearSessionCookie(res);
  res.status(200).json({ success: true });
};
