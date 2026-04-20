const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const chalk = require('chalk');
const FormData = require('form-data');
const fetch = require('node-fetch');

async function publish(opts) {
  const { platform, server, entry, rollout, output, channel, label, rolloutSchedule } = opts;
  const cwd = process.cwd();

  const token = process.env.OTA_UPDATES_TOKEN || opts.token;
  if (!token) {
    console.error(chalk.red('Missing API key. Set OTA_UPDATES_TOKEN env var or pass --token.'));
    console.error(chalk.gray('  Generate one from the server admin dashboard at /admin.'));
    process.exit(1);
  }

  if (!['ios', 'android'].includes(platform)) {
    console.error(chalk.red('Platform must be "ios" or "android"'));
    process.exit(1);
  }

  // Detect version: prefer Expo config, fall back to package.json
  let appVersion = opts.appVersion;
  let runtimeVersionFromConfig;
  if (!appVersion) {
    // Try app.config.js / app.json (Expo)
    try {
      const result = execSync('npx expo config --json --type public', {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).toString();
      const expoCfg = JSON.parse(result);
      appVersion = expoCfg.version;
      runtimeVersionFromConfig = expoCfg.runtimeVersion;
    } catch {}
    // Fall back to package.json
    if (!appVersion) {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf-8'));
        appVersion = pkg.version || '1.0.0';
      } catch {
        appVersion = '1.0.0';
      }
    }
  }
  const runtimeVersion = opts.runtimeVersion || runtimeVersionFromConfig || appVersion;
  console.log(chalk.gray(`  App version: ${appVersion}, runtime: ${runtimeVersion}`));

  // ── Step 1: Build ──────────────────────────────────────────────
  console.log(chalk.cyan('\n⚡ Building bundle…'));

  const outputDir = path.resolve(output);
  fs.rmSync(outputDir, { recursive: true, force: true });
  fs.mkdirSync(outputDir, { recursive: true });

  // Build using `expo export:embed` — same command Xcode uses for the
  // native build, so asset hashes match the .ipa exactly.
  const bundleName = platform === 'ios' ? 'main.jsbundle' : 'index.android.bundle';
  const jsBundlePath = path.join(outputDir, bundleName);
  const assetsDest = path.join(outputDir, 'assets');
  fs.mkdirSync(assetsDest, { recursive: true });
  let bundlePath = jsBundlePath;

  try {
    execSync(
      `npx expo export:embed ` +
      `--entry-file ${entry} ` +
      `--platform ${platform} ` +
      `--dev false ` +
      `--reset-cache ` +
      `--bundle-output "${jsBundlePath}" ` +
      `--assets-dest "${assetsDest}" ` +
      `--minify false`,
      { cwd, stdio: 'inherit' },
    );
    console.log(chalk.green('  ✓ Built with expo export:embed'));
  } catch (err) {
    console.error(chalk.red('  ✗ Bundle build failed'));
    process.exit(1);
  }

  // Compile to Hermes bytecode
  try {
    const hermescPaths = [
      path.join(cwd, 'node_modules', 'react-native', 'sdks', 'hermesc', 'osx-bin', 'hermesc'),
      path.join(cwd, 'node_modules', 'react-native', 'sdks', 'hermesc', 'linux64-bin', 'hermesc'),
    ];
    const hermesc = hermescPaths.find(p => fs.existsSync(p));
    if (hermesc) {
      const hbcPath = jsBundlePath + '.hbc';
      execSync(`"${hermesc}" -emit-binary -out "${hbcPath}" "${jsBundlePath}"`, { cwd, stdio: 'inherit' });
      bundlePath = hbcPath;
      console.log(chalk.green('  ✓ Compiled to Hermes bytecode'));
    } else {
      console.log(chalk.yellow('  ⚠ hermesc not found, using plain JS bundle'));
    }
  } catch (hermesErr) {
    console.log(chalk.yellow('  ⚠ Hermes compilation failed, using plain JS bundle'));
  }

  // ── Step 2: Hash ───────────────────────────────────────────────
  const bundleBuffer = fs.readFileSync(bundlePath);
  const bundleHash = crypto.createHash('sha256').update(bundleBuffer).digest('hex');
  const sizeMB = (bundleBuffer.length / 1024 / 1024).toFixed(1);
  console.log(chalk.green(`  ✓ Bundle: ${sizeMB} MB, hash: ${bundleHash.slice(0, 16)}…`));

  // ── Step 3: Package assets as a single zip ─────────────────────
  // Android can't symlink to APK-embedded assets the way iOS does, so
  // assets ship alongside the bundle. One zip downloads MUCH faster
  // than 244 sequential GETs and keeps launch-time OTA on parity with
  // iOS. iOS keeps its symlink trick and gets no asset zip.
  let assetsZipPath = null;
  let assetsZipHash = null;
  if (platform === 'android' && fs.existsSync(assetsDest) && fs.readdirSync(assetsDest).length > 0) {
    assetsZipPath = path.join(outputDir, 'assets.zip');
    try {
      execSync(`cd "${assetsDest}" && zip -rq "${assetsZipPath}" .`, { stdio: 'inherit' });
      const zipBuf = fs.readFileSync(assetsZipPath);
      assetsZipHash = crypto.createHash('sha256').update(zipBuf).digest('hex');
      const zipSizeMB = (zipBuf.length / 1024 / 1024).toFixed(1);
      console.log(chalk.green(`  ✓ Assets zip: ${zipSizeMB} MB, hash: ${assetsZipHash.slice(0, 16)}…`));
    } catch (err) {
      console.error(chalk.red('  ✗ Failed to build assets zip'));
      process.exit(1);
    }
  }

  // ── Step 4: Upload ─────────────────────────────────────────────
  console.log(chalk.cyan('⚡ Publishing to server…'));

  const form = new FormData();
  form.append('bundle', fs.createReadStream(bundlePath), { filename: path.basename(bundlePath) });
  form.append('appVersion', appVersion);
  form.append('runtimeVersion', runtimeVersion);
  form.append('bundleHash', bundleHash);
  form.append('platform', platform);
  form.append('rolloutPercentage', rollout.toString());
  if (channel) form.append('channel', channel);
  if (label) form.append('label', label);
  if (rolloutSchedule) form.append('rolloutSchedule', rolloutSchedule);
  if (assetsZipPath) {
    form.append('assetsZipHash', assetsZipHash);
    form.append('assetsZip', fs.createReadStream(assetsZipPath), { filename: 'assets.zip' });
  }

  let res;
  try {
    res = await fetch(`${server}/v1/publish`, {
      method: 'POST',
      body: form,
      headers: {
        ...form.getHeaders(),
        Authorization: `Bearer ${token}`,
      },
    });
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

function walkAssets(root) {
  const files = [];
  (function walk(dir, base) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const rel = base ? `${base}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(abs, rel);
      else files.push({ rel, abs });
    }
  })(root, '');
  return files;
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
