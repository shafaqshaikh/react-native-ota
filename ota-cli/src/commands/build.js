const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const chalk = require('chalk');
const ora = require('ora');

/**
 * `ota build` — Generates a production RN bundle, hashes everything,
 * and writes a manifest.json ready for publishing.
 */
async function buildCommand(options) {
  const { platform, entry, output, appVersion, runtimeVersion } = options;

  if (!['ios', 'android'].includes(platform)) {
    console.error(chalk.red('Platform must be "ios" or "android"'));
    process.exit(1);
  }

  const outputDir = path.resolve(output);
  const assetsDir = path.join(outputDir, 'assets');
  const bundleName = platform === 'ios' ? 'main.jsbundle' : 'index.android.bundle';
  const bundlePath = path.join(outputDir, bundleName);

  // Clean and create output directory
  fs.rmSync(outputDir, { recursive: true, force: true });
  fs.mkdirSync(assetsDir, { recursive: true });

  // --- Step 1: Run react-native bundle ---
  const spinner = ora('Building React Native bundle...').start();

  try {
    const bundleCmd = [
      'npx react-native bundle',
      `--platform ${platform}`,
      `--entry-file ${entry}`,
      `--bundle-output ${bundlePath}`,
      `--assets-dest ${assetsDir}`,
      '--dev false',
      '--minify true',
    ].join(' ');

    execSync(bundleCmd, { stdio: 'pipe', cwd: process.cwd() });
    spinner.succeed('Bundle created');
  } catch (err) {
    spinner.fail('Bundle failed');
    console.error(chalk.red(err.stderr?.toString() || err.message));
    process.exit(1);
  }

  // --- Step 2: Hash bundle ---
  const hashSpinner = ora('Hashing bundle and assets...').start();

  const bundleBuffer = fs.readFileSync(bundlePath);
  const bundleHash = crypto.createHash('sha256').update(bundleBuffer).digest('hex');

  // --- Step 3: Hash assets ---
  const assetHashes = [];
  function walkDir(dir, prefix = '') {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relativePath = path.join(prefix, entry.name);
      if (entry.isDirectory()) {
        walkDir(fullPath, relativePath);
      } else {
        const buf = fs.readFileSync(fullPath);
        const hash = crypto.createHash('sha256').update(buf).digest('hex');
        assetHashes.push({ name: relativePath, hash, size: buf.length });
      }
    }
  }
  walkDir(assetsDir);

  hashSpinner.succeed(`Hashed bundle + ${assetHashes.length} assets`);

  // --- Step 4: Detect versions ---
  let detectedAppVersion = appVersion;
  let detectedRuntimeVersion = runtimeVersion;

  if (!detectedAppVersion) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8'));
      detectedAppVersion = pkg.version || '1.0.0';
    } catch {
      detectedAppVersion = '1.0.0';
    }
  }
  if (!detectedRuntimeVersion) {
    detectedRuntimeVersion = detectedAppVersion;
  }

  // --- Step 5: Write manifest ---
  const manifest = {
    platform,
    appVersion: detectedAppVersion,
    runtimeVersion: detectedRuntimeVersion,
    bundleFile: bundleName,
    bundleHash,
    assets: assetHashes,
    createdAt: new Date().toISOString(),
  };

  const manifestPath = path.join(outputDir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  console.log(chalk.green('\n✓ Build complete!'));
  console.log(chalk.gray(`  Output:    ${outputDir}`));
  console.log(chalk.gray(`  Bundle:    ${bundleName}`));
  console.log(chalk.gray(`  Hash:      ${bundleHash.substring(0, 16)}...`));
  console.log(chalk.gray(`  Assets:    ${assetHashes.length} files`));
  console.log(chalk.gray(`  App:       ${detectedAppVersion}`));
  console.log(chalk.gray(`  Runtime:   ${detectedRuntimeVersion}`));
  console.log(chalk.gray(`  Manifest:  ${manifestPath}`));
  console.log(chalk.yellow('\nNext: ota publish --dir ' + output));
}

module.exports = { buildCommand };