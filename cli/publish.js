const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const chalk = require('chalk');
const FormData = require('form-data');
const fetch = require('node-fetch');

async function publish(opts) {
  const { platform, server, entry, rollout, output } = opts;
  const cwd = process.cwd();

  if (!['ios', 'android'].includes(platform)) {
    console.error(chalk.red('Platform must be "ios" or "android"'));
    process.exit(1);
  }

  // Detect version
  let appVersion = opts.appVersion;
  if (!appVersion) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf-8'));
      appVersion = pkg.version || '1.0.0';
    } catch {
      appVersion = '1.0.0';
    }
  }
  const runtimeVersion = opts.runtimeVersion || appVersion;

  // ── Step 1: Build ──────────────────────────────────────────────
  console.log(chalk.cyan('\n⚡ Building bundle…'));

  const outputDir = path.resolve(output);
  fs.rmSync(outputDir, { recursive: true, force: true });
  fs.mkdirSync(outputDir, { recursive: true });

  // Try expo export first (Expo projects), fall back to react-native bundle
  let bundlePath;
  try {
    execSync(`npx expo export --platform ${platform} --output-dir ${outputDir} --clear`, {
      cwd,
      stdio: 'pipe',
    });

    // Find the .hbc or .js bundle in expo output
    bundlePath = findBundle(outputDir, platform);
    if (!bundlePath) throw new Error('Bundle not found in expo export output');
    console.log(chalk.green('  ✓ Built with expo export'));
  } catch (expoErr) {
    // Fallback: react-native bundle
    console.log(chalk.gray('  expo export not available, trying react-native bundle…'));
    const bundleName = platform === 'ios' ? 'main.jsbundle' : 'index.android.bundle';
    bundlePath = path.join(outputDir, bundleName);

    try {
      execSync(
        `npx react-native bundle --platform ${platform} --entry-file ${entry} ` +
        `--bundle-output ${bundlePath} --assets-dest ${outputDir}/assets --dev false --minify true`,
        { cwd, stdio: 'pipe' },
      );
      console.log(chalk.green('  ✓ Built with react-native bundle'));
    } catch (rnErr) {
      console.error(chalk.red('  ✗ Build failed'));
      console.error(rnErr.stderr?.toString() || rnErr.message);
      process.exit(1);
    }
  }

  // ── Step 2: Hash ───────────────────────────────────────────────
  const bundleBuffer = fs.readFileSync(bundlePath);
  const bundleHash = crypto.createHash('sha256').update(bundleBuffer).digest('hex');
  const sizeMB = (bundleBuffer.length / 1024 / 1024).toFixed(1);
  console.log(chalk.green(`  ✓ Bundle: ${sizeMB} MB, hash: ${bundleHash.slice(0, 16)}…`));

  // ── Step 3: Upload ─────────────────────────────────────────────
  console.log(chalk.cyan('⚡ Publishing to server…'));

  const form = new FormData();
  form.append('bundle', fs.createReadStream(bundlePath), { filename: path.basename(bundlePath) });
  form.append('appVersion', appVersion);
  form.append('runtimeVersion', runtimeVersion);
  form.append('bundleHash', bundleHash);
  form.append('platform', platform);
  form.append('rolloutPercentage', rollout.toString());

  let res;
  try {
    res = await fetch(`${server}/publish`, { method: 'POST', body: form, headers: form.getHeaders() });
  } catch (err) {
    if (err.code === 'ECONNREFUSED') {
      console.error(chalk.red(`\n  ✗ Cannot connect to ${server}`));
      console.error(chalk.gray('    Start the server: npx ota-updates server'));
      process.exit(1);
    }
    throw err;
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    console.error(chalk.red(`  ✗ Server error ${res.status}: ${body.error || 'Unknown'}`));
    process.exit(1);
  }

  const result = await res.json();

  console.log(chalk.green('\n  ✓ Published!\n'));
  console.log(chalk.white(`    Update ID:   ${result.updateId}`));
  console.log(chalk.white(`    Platform:    ${platform}`));
  console.log(chalk.white(`    App:         ${appVersion}`));
  console.log(chalk.white(`    Runtime:     ${runtimeVersion}`));
  console.log(chalk.white(`    Rollout:     ${rollout}%`));
  console.log(chalk.white(`    Server:      ${server}`));
  console.log();

  // Cleanup
  fs.rmSync(outputDir, { recursive: true, force: true });
}

function findBundle(dir, platform) {
  // Expo export puts bundles in _expo/static/js/<platform>/
  const expoDir = path.join(dir, '_expo', 'static', 'js', platform);
  if (fs.existsSync(expoDir)) {
    const files = fs.readdirSync(expoDir);
    const bundle = files.find(f => f.endsWith('.hbc') || f.endsWith('.js'));
    if (bundle) return path.join(expoDir, bundle);
  }

  // Also check root for react-native bundle output
  const rootFiles = fs.readdirSync(dir);
  const rnBundle = rootFiles.find(f =>
    f === 'main.jsbundle' || f === 'index.android.bundle' || f.endsWith('.bundle')
  );
  if (rnBundle) return path.join(dir, rnBundle);

  return null;
}

module.exports = { publish };
