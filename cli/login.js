const prompts = require('prompts');
const credentials = require('./credentials');

async function login(opts) {
  const existing = credentials.read() || {};
  const defaultServer =
    opts.server ||
    process.env.OTA_UPDATES_SERVER ||
    existing.serverUrl ||
    'http://localhost:4000';

  const answers = await prompts(
    [
      { type: 'text', name: 'server', message: 'Server URL', initial: defaultServer },
      { type: 'text', name: 'email', message: 'Email' },
      { type: 'password', name: 'password', message: 'Password' },
    ],
    { onCancel: () => process.exit(1) },
  );

  if (!answers.email || !answers.password) {
    console.error('Aborted.');
    process.exit(1);
  }

  const url = `${answers.server.replace(/\/$/, '')}/v1/login`;
  const fetch = require('node-fetch');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: answers.email, password: answers.password }),
  });

  if (res.status !== 200) {
    let body = '';
    try { body = await res.text(); } catch {}
    console.error(`Login failed (${res.status}): ${body}`);
    process.exit(1);
  }

  const data = await res.json();
  credentials.write({
    serverUrl: answers.server.replace(/\/$/, ''),
    token: data.token,
    email: data.user.email,
    expiresAt: data.expiresAt,
    defaultProject: existing.defaultProject || null,
  });
  console.log(`Logged in as ${data.user.email}`);
}

module.exports = { login };
