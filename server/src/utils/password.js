const bcrypt = require('bcryptjs');

const ROUNDS = 12;

async function hash(plain) {
  return bcrypt.hash(plain, ROUNDS);
}

async function compare(plain, hashed) {
  if (!hashed) return false;
  return bcrypt.compare(plain, hashed);
}

module.exports = { hash, compare };
