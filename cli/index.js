#!/usr/bin/env node

const { program } = require('commander');
const fs = require('fs');
const path = require('path');
const { publish } = require('./publish');

// ── Read .otaupdatesrc config file ──────────────────────────────
// Priority: CLI flags > env vars > .otaupdatesrc > defaults
function loadConfig() {
  const rcPaths = [
    path.join(process.cwd(), '.otaupdatesrc'),
    path.join(process.cwd(), '.otaupdatesrc.json'),
  ];
  for (const p of rcPaths) {
    try {
      if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {}
  }
  // Also try reading serverUrl from expo config plugin props
  try {
    let appConfig = require(path.join(process.cwd(), 'app.config.js'));
    if (appConfig && appConfig.__esModule && appConfig.default) appConfig = appConfig.default;
    const raw = typeof appConfig === 'function' ? appConfig() : appConfig;
    const cfg = raw.expo || raw;
    const plugin = (cfg.plugins || []).find(p =>
      Array.isArray(p) && typeof p[0] === 'string' &&
      (p[0] === 'react-native-ota-updates' || p[0].endsWith('/react-native-ota-updates'))
    );
    if (plugin && plugin[1]) {
      const p = plugin[1];
      return { server: p.serverUrl, token: p.token, projectId: p.projectId, channel: p.channel };
    }
  } catch {}
  try {
    const appJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'app.json'), 'utf8'));
    const expo = appJson.expo || appJson;
    const plugin = (expo.plugins || []).find(p =>
      Array.isArray(p) && typeof p[0] === 'string' &&
      (p[0] === 'react-native-ota-updates' || p[0].endsWith('/react-native-ota-updates'))
    );
    if (plugin && plugin[1]) {
      const p = plugin[1];
      return { server: p.serverUrl, token: p.token, projectId: p.projectId, channel: p.channel };
    }
  } catch {}
  return {};
}

const rc = loadConfig();

program
  .name('ota-updates')
  .description('React Native OTA Updates CLI')
  .version(require('../package.json').version);

program
  .command('publish')
  .description('Build and publish an OTA update')
  .requiredOption('-p, --platform <platform>', 'ios or android')
  .option('-s, --server <url>', 'OTA server URL', process.env.OTA_UPDATES_SERVER || rc.server || 'http://localhost:4000')
  .option('-e, --entry <file>', 'Entry file', 'index.js')
  .option('--app-version <ver>', 'App version (auto-detected from package.json)')
  .option('--runtime-version <ver>', 'Runtime version (defaults to app version)')
  .option('--channel <name>', 'Release channel', process.env.OTA_UPDATES_CHANNEL || rc.channel || 'production')
  .option('--label <label>', 'Human-readable label, e.g. "v1.4.9-hotfix-3"')
  .option('--rollout <pct>', 'Rollout ceiling 1-100', '100')
  .option('--rollout-schedule <json>', 'Staged rollout JSON, e.g. \'[{"atMinutes":0,"pct":5},{"atMinutes":60,"pct":50},{"atMinutes":240,"pct":100}]\'')
  .option('--token <apikey>', 'API key', process.env.OTA_UPDATES_TOKEN || rc.token)
  .option('--output <dir>', 'Temp output directory', '/tmp/ota-build')
  .action(publish);

program
  .command('check')
  .description('Check server for available updates')
  .requiredOption('-p, --platform <platform>', 'ios or android')
  .option('--project <slug>', 'Project slug', rc.projectId)
  .option('-s, --server <url>', 'OTA server URL', process.env.OTA_UPDATES_SERVER || rc.server || 'http://localhost:4000')
  .option('--app-version <ver>', 'App version')
  .option('--runtime-version <ver>', 'Runtime version')
  .option('--channel <name>', 'Release channel', process.env.OTA_UPDATES_CHANNEL || rc.channel || 'production')
  .action(async (opts) => {
    const fetch = require('node-fetch');
    const appVersion = opts.appVersion || require(process.cwd() + '/package.json').version;
    const runtimeVersion = opts.runtimeVersion || appVersion;
    const qs = new URLSearchParams({
      projectId: opts.project,
      appVersion,
      runtimeVersion,
      platform: opts.platform,
      channel: opts.channel,
    });
    const res = await fetch(`${opts.server}/v1/check?${qs}`);
    console.log(JSON.stringify(await res.json(), null, 2));
  });

program
  .command('list')
  .description('List all published updates')
  .option('-s, --server <url>', 'OTA server URL', 'http://localhost:4000')
  .action(async (opts) => {
    const fetch = require('node-fetch');
    const res = await fetch(`${opts.server}/updates`);
    const data = await res.json();
    if (data.updates.length === 0) {
      console.log('No updates published yet.');
      return;
    }
    console.log(`\n  ${data.updates.length} update(s):\n`);
    for (const u of data.updates) {
      const date = new Date(u.created_at).toLocaleString();
      console.log(`  ${u.id}  ${u.platform.padEnd(8)} v${u.app_version}  ${u.rollout_pct}%  ${date}`);
    }
    console.log();
  });

program
  .command('login')
  .description('Log in interactively with email + password')
  .option('-s, --server <url>', 'OTA server URL')
  .action(require('./login').login);

program.parse();
