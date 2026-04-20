/**
 * OTA SDK Configuration
 * Set these before using any OTA functions.
 */

const OTAConfig = {
  // OTA server URL (must be HTTPS in production)
  serverUrl: 'http://localhost:3000',

  // Current app version from native build
  appVersion: '1.0.0',

  // Runtime version — OTA updates only apply if this matches
  runtimeVersion: '1.0.0',

  // Unique device identifier for rollout bucketing
  clientId: '',

  // Request timeout in ms
  timeout: 30000,

  // Enable verbose logging
  debug: false,
};

function configure(options) {
  Object.assign(OTAConfig, options);

  if (OTAConfig.debug) {
    console.log('[OTA] Config updated:', JSON.stringify(OTAConfig, null, 2));
  }

  // Warn if using HTTP in what looks like production
  if (
    OTAConfig.serverUrl.startsWith('http://') &&
    !OTAConfig.serverUrl.includes('localhost') &&
    !OTAConfig.serverUrl.includes('127.0.0.1')
  ) {
    console.warn('[OTA] WARNING: Using HTTP for non-localhost server. Use HTTPS in production!');
  }
}

module.exports = { OTAConfig, configure };