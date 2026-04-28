const credentials = require('./credentials');

async function whoami() {
  const creds = credentials.read();
  if (!creds || !creds.token) {
    console.log('Not logged in.');
    process.exit(1);
  }
  const fetch = require('node-fetch');
  const res = await fetch(`${creds.serverUrl}/v1/me`, {
    headers: { Authorization: `Bearer ${creds.token}` },
  });
  if (res.status === 401) {
    credentials.clear();
    console.error('Session expired, run `ota-updates login`');
    process.exit(1);
  }
  if (res.status !== 200) {
    let body = '';
    try { body = await res.text(); } catch {}
    console.error(`whoami failed (${res.status}): ${body}`);
    process.exit(1);
  }
  const me = await res.json();
  console.log(`${me.email} (logged in to ${creds.serverUrl}, expires ${creds.expiresAt})`);
}

module.exports = { whoami };
