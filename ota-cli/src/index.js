#!/usr/bin/env node

const { program } = require('commander');
const { buildCommand } = require('./commands/build');
const { publishCommand } = require('./commands/publish');

program
  .name('ota')
  .description('OTA update CLI for React Native')
  .version('1.0.0');

program
  .command('build')
  .description('Build a React Native production bundle and generate manifest')
  .requiredOption('--platform <platform>', 'Target platform: ios or android')
  .option('--entry <entry>', 'Entry file path', 'index.js')
  .option('--output <dir>', 'Output directory', './ota-output')
  .option('--app-version <version>', 'App version (e.g., 1.0.0)')
  .option('--runtime-version <version>', 'Runtime version for compatibility check')
  .action(buildCommand);

program
  .command('publish')
  .description('Publish an OTA update to the server')
  .requiredOption('--dir <dir>', 'Directory containing build output', './ota-output')
  .option('--server <url>', 'OTA server URL', 'http://localhost:3000')
  .option('--rollout <percentage>', 'Rollout percentage (1-100)', '100')
  .action(publishCommand);

program.parse();