const crypto = require('node:crypto');

const PREFIX = 'ota_sess_';
const SESSION_TTL_DAYS = 30;

function generateToken() {
  const random = crypto.randomBytes(16).toString('hex');
  const token = `${PREFIX}${random}`;
  return { token, tokenHash: hashToken(token) };
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function defaultExpiry() {
  return new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
}

module.exports = { generateToken, hashToken, defaultExpiry, PREFIX, SESSION_TTL_DAYS };
