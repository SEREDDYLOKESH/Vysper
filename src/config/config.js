require('dotenv').config();
const config = require('../core/config');

// Gemini API key pool (free-tier rotation). Populate via .env:
// GEMINI_API_KEY_1=...
// GEMINI_API_KEY_2=...
// GEMINI_API_KEY_3=...
const API_KEYS = [
  process.env.GEMINI_API_KEY_1,
  process.env.GEMINI_API_KEY_2,
  process.env.GEMINI_API_KEY_3,
  process.env.GEMINI_API_KEY,
].filter((k) => typeof k === 'string' && k.trim().length > 0 && !k.includes('YOUR_') && !k.includes('your_'));

let activeKeyIndex = 0;

function getApiKey() {
  if (API_KEYS.length > 0) {
    return API_KEYS[activeKeyIndex % API_KEYS.length];
  }
  const fallback = process.env.GEMINI_API_KEY;
  return typeof fallback === 'string' ? fallback.trim() : fallback;
}

function getActiveApiKey() {
  return getApiKey();
}

function rotateApiKey() {
  if (API_KEYS.length > 1) {
    activeKeyIndex = (activeKeyIndex + 1) % API_KEYS.length;
    console.warn(`[Quota Protection] Rotated to API key index: ${activeKeyIndex}`);
    return true;
  }
  return false;
}

function isQuotaOrRateLimitError(error) {
  const message = `${error?.message || ''} ${error?.status || ''} ${error?.code || ''} ${error?.cause?.message || ''}`.toLowerCase();
  return (
    message.includes('429') ||
    message.includes('resource_exhausted') ||
    message.includes('quota') ||
    message.includes('too many requests') ||
    message.includes('rate limit')
  );
}

async function withApiKeyRotation(taskFn, { maxKeyAttempts } = {}) {
  const keyAttempts = Math.max(1, maxKeyAttempts || Math.max(API_KEYS.length, 1));
  let lastError;
  for (let attempt = 0; attempt < keyAttempts; attempt++) {
    try {
      return await taskFn(getApiKey(), attempt);
    } catch (error) {
      lastError = error;
      if (isQuotaOrRateLimitError(error) && rotateApiKey()) {
        console.warn(`[Quota Protection] 429/RESOURCE_EXHAUSTED detected. Retrying with rotated key (attempt ${attempt + 2}/${keyAttempts}).`);
        continue;
      }
      throw error;
    }
  }
  throw lastError || new Error('All API keys exhausted due to quota/rate limits.');
}

// Active Gemini models (updated to versions currently available for this API/key; override with GEMINI_MODEL if needed)
const PRIMARY_MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const MODEL_NAME = PRIMARY_MODEL;
const FALLBACK_MODELS = ['gemini-3.5-flash-lite', 'gemini-3.8-flash'];

const GENERATION_CONFIG = {
  temperature: 0.1,
  maxOutputTokens: 2048,
  topP: 0.95,
};

module.exports = {
  getApiKey,
  getActiveApiKey,
  rotateApiKey,
  isQuotaOrRateLimitError,
  withApiKeyRotation,
  PRIMARY_MODEL,
  MODEL_NAME,
  FALLBACK_MODELS,
  API_KEYS,
  GENERATION_CONFIG,
  ConfigManager: config.ConfigManager,
  get: (key) => config.get(key),
  set: (key, val) => config.set(key, val),
};
