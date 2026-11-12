require('dotenv').config();
const DiagnosticsService = require('../src/services/diagnostics.service');
const config = require('../src/core/config');
const { renderDiagnosticsReport } = require('../src/ui/chat');

let passedTests = 0;
let totalTests = 0;

function assert(condition, message) {
  totalTests++;
  if (condition) {
    console.log(`  ✅ PASS: ${message}`);
    passedTests++;
  } else {
    console.error(`  ❌ FAIL: ${message}`);
  }
}

async function runTests() {
  console.log('========================================================');
  console.log('🧪 VYSPER DIAGNOSTICS & SELF-HEALING TEST SUITE');
  console.log('========================================================\n');

  // ----------------------------------------------------
  // Test Suite 1: Audio & Microphone Permissions
  // ----------------------------------------------------
  console.log('--- Suite 1: Audio & Microphone Permissions Check ---');

  // Test 1.1: System Audio Permissions (Current Environment)
  const defaultPermCheck = DiagnosticsService.checkAudioPermissions();
  console.log('  Live Environment Perm Check:', defaultPermCheck);
  assert(typeof defaultPermCheck.success === 'boolean', 'checkAudioPermissions returns boolean success');
  assert(typeof defaultPermCheck.details === 'string', 'checkAudioPermissions returns details string');

  // Test 1.2: Mock Granted Preferences
  const mockGrantedPrefs = {
    getMediaAccessStatus: (mediaType) => 'granted'
  };
  const grantedCheck = DiagnosticsService.checkAudioPermissions(mockGrantedPrefs);
  assert(grantedCheck.success === true, 'Granted permissions check evaluates to true');
  assert(grantedCheck.details.includes('Microphone: granted'), 'Details reflect microphone granted status');

  // Test 1.3: Mock Denied Preferences
  const mockDeniedPrefs = {
    getMediaAccessStatus: (mediaType) => (mediaType === 'microphone' ? 'denied' : 'granted')
  };
  const deniedCheck = DiagnosticsService.checkAudioPermissions(mockDeniedPrefs);
  assert(deniedCheck.success === false, 'Denied microphone permission evaluates to false');

  // ----------------------------------------------------
  // Test Suite 2: Gemini API Connectivity & Streaming
  // ----------------------------------------------------
  console.log('\n--- Suite 2: Gemini API Connectivity Check ---');

  // Test 2.1: Mock LLM Service Success
  const mockSuccessLLM = {
    generateResponseText: async (prompt, skill, onChunk) => {
      if (typeof onChunk === 'function') onChunk('API_OK');
      return 'API_OK';
    }
  };
  const apiSuccess = await DiagnosticsService.testGeminiAPIStream(mockSuccessLLM);
  assert(apiSuccess.success === true, 'Successful LLM call evaluates to true');
  assert(apiSuccess.details.includes('Gemini API responding correctly'), 'Success details contain latency check pass');

  // Test 2.2: Mock LLM Service Empty Response
  const mockEmptyLLM = {
    generateResponseText: async () => ''
  };
  const apiEmpty = await DiagnosticsService.testGeminiAPIStream(mockEmptyLLM);
  assert(apiEmpty.success === false, 'Empty LLM response evaluates to false');
  assert(apiEmpty.details.includes('empty text response'), 'Details reflect empty text error');

  // Test 2.3: Mock LLM Service Error Message String
  const mockErrorMsgLLM = {
    generateResponseText: async () => 'Error generating response: API_KEY_INVALID'
  };
  const apiErrorMsg = await DiagnosticsService.testGeminiAPIStream(mockErrorMsgLLM);
  assert(apiErrorMsg.success === false, 'Error message response evaluates to false');
  assert(apiErrorMsg.details.includes('API Call Failed'), 'Details reflect API call failure');

  // Test 2.4: Mock LLM Service Throwing Exception
  const mockThrowingLLM = {
    generateResponseText: async () => {
      throw new Error('Connection timeout to Google Generative AI');
    }
  };
  const apiThrow = await DiagnosticsService.testGeminiAPIStream(mockThrowingLLM);
  assert(apiThrow.success === false, 'Exception in LLM evaluates to false');
  assert(apiThrow.details.includes('Connection timeout'), 'Details include thrown exception message');

  // ----------------------------------------------------
  // Test Suite 3: PCM Audio Buffer Construction
  // ----------------------------------------------------
  console.log('\n--- Suite 3: PCM Buffer Validation ---');

  const emptyPCM = Buffer.alloc(0);
  const emptyCheck = DiagnosticsService.testPCMBuffer(emptyPCM);
  assert(emptyCheck.success === false, 'Zero-length PCM buffer fails');

  const nullCheck = DiagnosticsService.testPCMBuffer(null);
  assert(nullCheck.success === false, 'Null PCM buffer fails');

  const validPCM = Buffer.alloc(16000 * 2); // 1 sec of 16-bit PCM
  const validCheck = DiagnosticsService.testPCMBuffer(validPCM);
  assert(validCheck.success === true, 'Populated PCM buffer passes');
  assert(validCheck.details.includes('32000 bytes'), 'Details reflect accurate buffer length in bytes');

  // ----------------------------------------------------
  // Test Suite 4: Self-Healing Repairs
  // ----------------------------------------------------
  console.log('\n--- Suite 4: Self-Healing Repair Routines ---');

  let reinitialized = false;
  let modelCandidateSwitched = false;
  const mockRepairableLLM = {
    modelName: 'gemini-nonexistent',
    initializeClient: () => { reinitialized = true; },
    switchToNextAvailableModel: (name) => {
      modelCandidateSwitched = true;
      mockRepairableLLM.modelName = 'gemini-3.8-flash';
      return true;
    },
    generateResponseText: async () => 'API_OK'
  };

  const repairResult = await DiagnosticsService.attemptLLMRepair(mockRepairableLLM);
  assert(repairResult.repaired === true, 'attemptLLMRepair successfully ran repair');
  assert(reinitialized === true, 'Client reinitialization invoked during self-healing');
  assert(modelCandidateSwitched === true, 'Fallback candidate model switched');

  const audioRepairResult = DiagnosticsService.attemptAudioRepair();
  assert(audioRepairResult.repaired === true, 'attemptAudioRepair executes cleanly');

  // ----------------------------------------------------
  // Test Suite 5: Chat UI Diagnostics Rendering
  // ----------------------------------------------------
  console.log('\n--- Suite 5: Chat UI Report Rendering ---');

  // Mock DOM container
  let innerHTMLStore = '';
  let scrollCalled = false;
  const mockContainer = {
    set innerHTML(val) { innerHTMLStore = val; },
    get innerHTML() { return innerHTMLStore; },
    scrollHeight: 500,
    scrollTop: 0
  };

  // Mock global document
  global.document = {
    getElementById: (id) => (id === 'chat-messages' ? mockContainer : null),
    querySelector: () => null
  };

  const successReport = {
    permissions: { success: true, details: 'Microphone: granted, Screen/Loopback: granted' },
    api: { success: true, details: 'Gemini API responding correctly. Latency check passed.' },
    activeModel: 'gemini-3.8-flash',
    timestamp: '11:59:00 PM'
  };

  renderDiagnosticsReport(successReport);
  assert(innerHTMLStore.includes('#10B981'), 'Green status color (#10B981) applied for healthy diagnostics');
  assert(innerHTMLStore.includes('System Diagnostic Report'), 'Report title rendered');
  assert(innerHTMLStore.includes('gemini-3.8-flash'), 'Active model name rendered');
  assert(innerHTMLStore.includes('Granted'), 'Granted audio permission rendered with checkmark');

  // Test Failure Report rendering
  innerHTMLStore = '';
  const failureReport = {
    permissions: { success: false, details: 'Microphone: denied' },
    api: { success: false, details: 'Gemini API Call Failed: 403 Forbidden' },
    activeModel: 'gemini-3.8-flash',
    timestamp: '11:59:01 PM'
  };

  renderDiagnosticsReport(failureReport);
  assert(innerHTMLStore.includes('#EF4444'), 'Red status color (#EF4444) applied for failed diagnostics');
  assert(innerHTMLStore.includes('Refused'), 'Refused audio permission rendered with cross');
  assert(innerHTMLStore.includes('Error'), 'API Error status rendered');

  // ----------------------------------------------------
  // Test Suite 6: Full Live LLM Diagnostic (if API key present)
  // ----------------------------------------------------
  console.log('\n--- Suite 6: Live LLM Service Integration ---');
  try {
    const liveLLMService = require('../src/services/llm.service');
    if (process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'your-api-key-here') {
      console.log('  Testing live Gemini API stream with registered service...');
      const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve({ success: false, details: 'Live check timed out after 30s' }), 30000));
      const liveReport = await Promise.race([
        DiagnosticsService.testGeminiAPIStream(liveLLMService),
        timeoutPromise
      ]);
      console.log('  Live API Test Result:', liveReport);
      assert(typeof liveReport.success === 'boolean', 'Live API call returned valid report structure');
    } else {
      console.log('  ℹ️ GEMINI_API_KEY is not set or placeholder; live network call skipped.');
    }
  } catch (err) {
    console.warn('  ⚠️ Live LLM test skipped:', err.message);
  }

  // ----------------------------------------------------
  // Summary
  // ----------------------------------------------------
  console.log('\n========================================================');
  console.log(`RESULTS: ${passedTests}/${totalTests} tests passed (${Math.round((passedTests/totalTests)*100)}%)`);
  console.log('========================================================\n');

  if (passedTests === totalTests) {
    console.log('🎉 ALL DIAGNOSTIC PIPELINE TESTS PASSED!');
    process.exit(0);
  } else {
    console.error('❌ SOME TESTS FAILED.');
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
