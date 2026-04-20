#!/usr/bin/env node

const { program } = require('commander');
const { publish } = require('./publish');

program
  .name('ota-updates')
  .description('React Native OTA Updates CLI')
  .version(require('../package.json').version);

program
  .command('publish')
  .description('Build and publish an OTA update')
  .requiredOption('-p, --platform <platform>', 'ios or android')
  .option('-s, --server <url>', 'OTA server URL', 'http://localhost:4000')
  .option('-e, --entry <file>', 'Entry file', 'index.js')
  .option('--app-version <ver>', 'App version (auto-detected from package.json)')
  .option('--runtime-version <ver>', 'Runtime version (defaults to app version)')
  .option('--rollout <pct>', 'Rollout percentage 1-100', '100')
  .option('--output <dir>', 'Temp output directory', '/tmp/ota-build')
  .action(publish);

program
  .command('check')
  .description('Check server for available updates')
  .requiredOption('-p, --platform <platform>', 'ios or android')
  .option('-s, --server <url>', 'OTA server URL', 'http://localhost:4000')
  .option('--app-version <ver>', 'App version')
  .option('--runtime-version <ver>', 'Runtime version')
  .action(async (opts) => {
    const fetch = require('node-fetch');
    const appVersion = opts.appVersion || require(process.cwd() + '/package.json').version;
    const runtimeVersion = opts.runtimeVersion || appVersion;
    const url = `${opts.server}/check?appVersion=${appVersion}&runtimeVersion=${runtimeVersion}&platform=${opts.platform}`;
    const res = await fetch(url);
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

program.parse();
