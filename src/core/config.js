const path = require('path');
const os = require('os');
const fs = require('fs');

const GENERATION_CONFIG = {
  temperature: 0.1,
  maxOutputTokens: 2048, // Prevent truncated code/responses
  topP: 0.95
};

const MODEL_NAME = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

class ConfigManager {
  constructor() {
    this.env = process.env.NODE_ENV || 'development';
    this.appDataDir = path.join(os.homedir(), '.Vysper');
    this.settingsFile = path.join(this.appDataDir, 'settings.json');
    this.loadConfiguration();
    this.DEFAULT_MODEL = this.get('llm.gemini.model') || MODEL_NAME;
    this.GENERATION_CONFIG = GENERATION_CONFIG;
    this.MODEL_NAME = MODEL_NAME;
  }

  loadConfiguration() {
    this.config = {
      app: {
        name: 'Vysper',
        version: '1.0.0',
        processTitle: 'Vysper',
        dataDir: this.appDataDir,
        isDevelopment: this.env === 'development',
        isProduction: this.env === 'production'
      },
      
      window: {
        defaultWidth: 400,
        defaultHeight: 600,
        minWidth: 300,
        minHeight: 400,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          enableRemoteModule: false,
          preload: path.join(__dirname, '../../preload.js')
        }
      },

      ocr: {
        language: 'eng',
        tempDir: os.tmpdir(),
        cleanupDelay: 5000
      },

      llm: {
        gemini: {
          model: process.env.GEMINI_MODEL || MODEL_NAME,
          fallbackModels: ['gemini-3.5-flash-lite', 'gemini-3.8-flash'],
          maxTokens: GENERATION_CONFIG.maxOutputTokens,
          maxOutputTokens: GENERATION_CONFIG.maxOutputTokens,
          temperature: GENERATION_CONFIG.temperature,
          topP: GENERATION_CONFIG.topP,
          maxRetries: 3,
          timeout: 45000,
          fallbackEnabled: true,
          enableFallbackMethod: true
        }
      },

      speech: {
        azure: {
          language: 'en-US',
          enableDictation: true,
          enableAudioLogging: false,
          outputFormat: 'detailed'
        }
      },

      session: {
        maxMemorySize: 1000,
        compressionThreshold: 500,
        clearOnRestart: false
      },

      stealth: {
        hideFromDock: true,
        noAttachConsole: true,
        disguiseProcess: true
      }
    };

    this.loadSettings();
  }

  loadSettings() {
    try {
      if (fs.existsSync(this.settingsFile)) {
        const fileData = fs.readFileSync(this.settingsFile, 'utf8');
        const savedSettings = JSON.parse(fileData);
        
        if (savedSettings.geminiKey || savedSettings.geminiApiKey || savedSettings?.gemini?.apiKey) {
          const key = savedSettings.geminiKey || savedSettings.geminiApiKey || savedSettings?.gemini?.apiKey;
          this.set('gemini.apiKey', key);
          this.set('llm.gemini.apiKey', key);
        }
        if (savedSettings.azureKey) {
          this.set('speech.azure.key', savedSettings.azureKey);
        }
        if (savedSettings.azureRegion) {
          this.set('speech.azure.region', savedSettings.azureRegion);
        }
        if (savedSettings.codingLanguage) {
          this.set('codingLanguage', savedSettings.codingLanguage);
        }
        if (savedSettings.activeSkill) {
          this.set('activeSkill', savedSettings.activeSkill);
        }
        if (savedSettings.appIcon) {
          this.set('appIcon', savedSettings.appIcon);
        }
        if (savedSettings.windowGap) {
          this.set('windowGap', savedSettings.windowGap);
        }
      }
    } catch (error) {
      // Keep defaults if settings file reading fails
    }
  }

  saveSettings(settings) {
    try {
      if (!fs.existsSync(this.appDataDir)) {
        fs.mkdirSync(this.appDataDir, { recursive: true });
      }

      let existing = {};
      if (fs.existsSync(this.settingsFile)) {
        try {
          existing = JSON.parse(fs.readFileSync(this.settingsFile, 'utf8'));
        } catch {}
      }

      const updated = { ...existing, ...settings };
      fs.writeFileSync(this.settingsFile, JSON.stringify(updated, null, 2), 'utf8');

      if (settings.geminiKey) {
        this.set('gemini.apiKey', settings.geminiKey);
        this.set('llm.gemini.apiKey', settings.geminiKey);
      }
      if (settings.codingLanguage) {
        this.set('codingLanguage', settings.codingLanguage);
      }
      if (settings.activeSkill) {
        this.set('activeSkill', settings.activeSkill);
      }
      if (settings.appIcon) {
        this.set('appIcon', settings.appIcon);
      }
      if (settings.azureKey) {
        this.set('speech.azure.key', settings.azureKey);
      }
      if (settings.azureRegion) {
        this.set('speech.azure.region', settings.azureRegion);
      }
      if (settings.windowGap) {
        this.set('windowGap', settings.windowGap);
      }

      return true;
    } catch (error) {
      return false;
    }
  }

  get(keyPath) {
    return keyPath.split('.').reduce((obj, key) => obj?.[key], this.config);
  }

  set(keyPath, value) {
    const keys = keyPath.split('.');
    const lastKey = keys.pop();
    const target = keys.reduce((obj, key) => obj[key] = obj[key] || {}, this.config);
    target[lastKey] = value;
  }

  getApiKey(service) {
    if (service.toUpperCase() === 'GEMINI') {
      const value = process.env.GEMINI_API_KEY || this.get('gemini.apiKey') || this.get('llm.gemini.apiKey');
      return typeof value === 'string' ? value.trim() : value;
    }
    const envKey = `${service.toUpperCase()}_API_KEY`;
    const value = process.env[envKey] || this.get(`${service.toLowerCase()}.apiKey`);
    return typeof value === 'string' ? value.trim() : value;
  }

  isFeatureEnabled(feature) {
    return this.get(`features.${feature}`) !== false;
  }
}

const configManagerInstance = new ConfigManager();
configManagerInstance.GENERATION_CONFIG = GENERATION_CONFIG;
configManagerInstance.MODEL_NAME = MODEL_NAME;

module.exports = configManagerInstance;
module.exports.GENERATION_CONFIG = GENERATION_CONFIG;
module.exports.MODEL_NAME = MODEL_NAME;
module.exports.ConfigManager = ConfigManager;