const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const ora = require('ora');
const FormData = require('form-data');
const fetch = require('node-fetch');

/**
 * `ota publish` — Reads the build output dir, uploads bundle + assets
 * to the OTA server, and registers the update.
 */
async function publishCommand(options) {
  const { dir, server, rollout } = options;
  const outputDir = path.resolve(dir);

  // --- Validate build output ---
  const manifestPath = path.join(outputDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    console.error(chalk.red(`No manifest.json found in ${outputDir}. Run "ota build" first.`));
    process.exit(1);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  const bundlePath = path.join(outputDir, manifest.bundleFile);

  if (!fs.existsSync(bundlePath)) {
    console.error(chalk.red(`Bundle file not found: ${bundlePath}`));
    process.exit(1);
  }

  // --- Build multipart form ---
  const spinner = ora('Publishing update to server...').start();

  try {
    const form = new FormData();
    form.append('appVersion', manifest.appVersion);
    form.append('runtimeVersion', manifest.runtimeVersion);
    form.append('bundleHash', manifest.bundleHash);
    form.append('rolloutPercentage', rollout.toString());
    form.append('bundle', fs.createReadStream(bundlePath), {
      filename: manifest.bundleFile,
      contentType: 'application/javascript',
    });

    // Append assets
    const assetsDir = path.join(outputDir, 'assets');
    if (fs.existsSync(assetsDir)) {
      const assetManifest = [];
      function walkDir(dir, prefix = '') {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          const relativePath = path.join(prefix, entry.name);
          if (entry.isDirectory()) {
            walkDir(fullPath, relativePath);
          } else {
            form.append('assets', fs.createReadStream(fullPath), {
              filename: relativePath,
            });
            // Find matching hash from manifest
            const hashEntry = manifest.assets.find((a) => a.name === relativePath);
            assetManifest.push({
              name: relativePath,
              hash: hashEntry?.hash || '',
            });
          }
        }
      }
      walkDir(assetsDir);
      form.append('assetManifest', JSON.stringify(assetManifest));
    }

    // --- Upload ---
    const serverUrl = server.replace(/\/$/, '');
    const response = await fetch(`${serverUrl}/publish`, {
      method: 'POST',
      body: form,
      headers: form.getHeaders(),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      spinner.fail('Publish failed');
      console.error(chalk.red(`Server responded with ${response.status}: ${body.error || 'Unknown error'}`));
      process.exit(1);
    }

    const result = await response.json();
    spinner.succeed('Update published!');

    console.log(chalk.green('\n✓ Published successfully'));
    console.log(chalk.gray(`  Update ID:  ${result.updateId}`));
    console.log(chalk.gray(`  App:        ${manifest.appVersion}`));
    console.log(chalk.gray(`  Runtime:    ${manifest.runtimeVersion}`));
    console.log(chalk.gray(`  Rollout:    ${rollout}%`));
    console.log(chalk.gray(`  Server:     ${serverUrl}`));
  } catch (err) {
    spinner.fail('Publish failed');
    if (err.code === 'ECONNREFUSED') {
      console.error(chalk.red(`Cannot connect to server at ${server}. Is it running?`));
    } else {
      console.error(chalk.red(err.message));
    }
    process.exit(1);
  }
}

module.exports = { publishCommand };