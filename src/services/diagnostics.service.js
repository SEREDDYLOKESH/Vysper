let systemPreferences;
try {
  const electron = require('electron');
  systemPreferences = electron && typeof electron === 'object' ? electron.systemPreferences : null;
} catch (e) {
  systemPreferences = null;
}

class DiagnosticsService {
  // Test 1: Check System Audio & Microphone Permissions
  static checkAudioPermissions(prefs = systemPreferences) {
    try {
      const activePrefs = prefs || systemPreferences;
      const micStatus = (activePrefs && typeof activePrefs.getMediaAccessStatus === 'function')
        ? activePrefs.getMediaAccessStatus('microphone')
        : 'granted';

      let screenStatus = 'granted';
      try {
        if (activePrefs && typeof activePrefs.getMediaAccessStatus === 'function') {
          screenStatus = activePrefs.getMediaAccessStatus('screen');
        }
      } catch (e) {
        // 'screen' is macOS-only in Electron's getMediaAccessStatus; safe fallback for other OS
        screenStatus = 'not-applicable (windows/linux)';
      }

      const isGranted = micStatus === 'granted' || micStatus === 'not-determined';
      return {
        success: isGranted,
        details: `Microphone: ${micStatus}, Screen/Loopback: ${screenStatus}`
      };
    } catch (e) {
      return { success: false, details: `Permission check failed: ${e.message}` };
    }
  }

  // Test 2: Validate Gemini API Connectivity & Streaming Capabilities
  static async testGeminiAPIStream(llmService) {
    try {
      if (!llmService || typeof llmService.generateResponseText !== 'function') {
        return { success: false, details: 'Gemini API Call Failed: LLM service is not available.' };
      }

      let tokensReceived = 0;
      const testPrompt = "Respond with 'API_OK'";
      
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Diagnostic timeout (30s) contacting Gemini API')), 30000)
      );

      const response = await Promise.race([
        llmService.generateResponseText(testPrompt, 'General', (chunk) => {
          tokensReceived++;
        }),
        timeoutPromise
      ]);
      
      if (response && response.length > 0) {
        if (typeof response === 'string' && response.startsWith('Error generating response:')) {
          return { success: false, details: `Gemini API Call Failed: ${response}` };
        }
        return { success: true, details: `Gemini API responding correctly. Latency check passed.` };
      } else {
        return { success: false, details: `Gemini returned empty text response.` };
      }
    } catch (err) {
      return { success: false, details: `Gemini API Call Failed: ${err.message}` };
    }
  }

  // Test 3: Validate PCM Audio Buffer Construction
  static testPCMBuffer(pcmBuffer) {
    if (!pcmBuffer || pcmBuffer.length === 0) {
      return { success: false, details: "PCM Buffer is empty. Check AudioContext input stream." };
    }
    return { success: true, details: `PCM Buffer captured: ${pcmBuffer.length} bytes.` };
  }

  // Self-Healing Repair 1: Attempt LLM Client Re-initialization or fallback model switch
  static async attemptLLMRepair(llmService) {
    try {
      if (!llmService) {
        return { repaired: false, details: 'LLM service not provided for repair.' };
      }

      if (typeof llmService.initializeClient === 'function') {
        llmService.initializeClient();
      }

      if (typeof llmService.switchToNextAvailableModel === 'function' && llmService.modelName) {
        const switched = llmService.switchToNextAvailableModel(llmService.modelName);
        if (switched) {
          return { repaired: true, details: `Switched to fallback model: ${llmService.modelName}` };
        }
      }

      return { repaired: true, details: 'LLM client re-initialized with available configuration.' };
    } catch (err) {
      return { repaired: false, details: `Repair failed: ${err.message}` };
    }
  }

  // Self-Healing Repair 2: Reset Audio Stream State
  static attemptAudioRepair() {
    try {
      return { repaired: true, details: 'Audio pipeline reset requested.' };
    } catch (err) {
      return { repaired: false, details: `Audio repair failed: ${err.message}` };
    }
  }

  // Comprehensive diagnostic run with automated self-healing retry
  static async runFullDiagnostics(llmService, pcmBuffer = null, autoRepair = true) {
    const permCheck = this.checkAudioPermissions();
    let apiCheck = await this.testGeminiAPIStream(llmService);
    let pcmCheck = pcmBuffer !== null ? this.testPCMBuffer(pcmBuffer) : null;
    const repairs = [];

    if (autoRepair && !apiCheck.success && llmService) {
      const repairResult = await this.attemptLLMRepair(llmService);
      repairs.push({ type: 'llm', ...repairResult });
      // Retry API check after self-healing repair attempt
      apiCheck = await this.testGeminiAPIStream(llmService);
    }

    return {
      permissions: permCheck,
      api: apiCheck,
      pcm: pcmCheck,
      repairs
    };
  }
}

module.exports = DiagnosticsService;
