/**
 * OTA Logger — Structured logging with levels.
 * In production, replace console calls with your analytics/crash reporting service.
 */

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
let currentLevel = LOG_LEVELS.info;
const logHistory = [];
const MAX_HISTORY = 200;

function setLevel(level) {
  if (LOG_LEVELS[level] !== undefined) {
    currentLevel = LOG_LEVELS[level];
  }
}

function log(level, message, data) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    data,
  };

  logHistory.push(entry);
  if (logHistory.length > MAX_HISTORY) logHistory.shift();

  if (LOG_LEVELS[level] >= currentLevel) {
    const prefix = `[OTA:${level.toUpperCase()}]`;
    if (data) {
      console[level === 'debug' ? 'log' : level](prefix, message, data);
    } else {
      console[level === 'debug' ? 'log' : level](prefix, message);
    }
  }
}

module.exports = {
  setLevel,
  debug: (msg, data) => log('debug', msg, data),
  info: (msg, data) => log('info', msg, data),
  warn: (msg, data) => log('warn', msg, data),
  error: (msg, data) => log('error', msg, data),
  getHistory: () => [...logHistory],
};