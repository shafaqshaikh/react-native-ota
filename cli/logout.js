const credentials = require('./credentials');

async function logout() {
  const creds = credentials.read();
  if (!creds || !creds.token) {
    console.log('Not logged in.');
    return;
  }
  const fetch = require('node-fetch');
  try {
    await fetch(`${creds.serverUrl}/v1/logout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${creds.token}` },
    });
  } catch {
    // best-effort — server may be unreachable; we still clear locally
  }
  credentials.clear();
  console.log('Logged out.');
}

module.exports = { logout };
