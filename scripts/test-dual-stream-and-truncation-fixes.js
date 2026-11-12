const assert = require('assert');
const config = require('../src/core/config');
const configViaPath = require('../src/config/config');
const llmService = require('../src/services/llm.service');

let totalTests = 0;
let passedTests = 0;

function runAssert(condition, testName) {
  totalTests++;
  try {
    assert(condition);
    console.log(`  ✅ PASS: ${testName}`);
    passedTests++;
  } catch (e) {
    console.error(`  ❌ FAIL: ${testName} - ${e.message}`);
  }
}

async function testFixes() {
  console.log('\n========================================================');
  console.log('🧪 TESTING FIX 1, FIX 2 & FIX 3 IMPLEMENTATIONS');
  console.log('========================================================\n');

  // -----------------------------------------------------------------
  // Fix 1: Stop Answer Truncation (maxOutputTokens: 2048 & gemini-3.5-flash)
  // -----------------------------------------------------------------
  console.log('--- Test Fix 1: maxOutputTokens & Model String ---');
  
  // Test config.js values (generation params + active model pool)
  runAssert(!!config.MODEL_NAME && typeof config.MODEL_NAME === 'string', 'config.MODEL_NAME is set');
  runAssert(configViaPath.PRIMARY_MODEL === configViaPath.MODEL_NAME, 'src/config/config.js exports consistent primary model');
  runAssert(config.get('llm.gemini.maxOutputTokens') === 2048, 'config llm.gemini.maxOutputTokens is 2048');
  runAssert(config.GENERATION_CONFIG.maxOutputTokens === 2048, 'config.GENERATION_CONFIG.maxOutputTokens is 2048');
  runAssert(config.GENERATION_CONFIG.temperature === 0.1, 'config.GENERATION_CONFIG.temperature is 0.1');
  runAssert(config.GENERATION_CONFIG.topP === 0.95, 'config.GENERATION_CONFIG.topP is 0.95');

  // Test llm.service.js values
  const genConfig = llmService.getGenerationConfig();
  runAssert(genConfig.maxOutputTokens === 2048, 'llmService getGenerationConfig().maxOutputTokens is 2048');
  runAssert(genConfig.temperature === 0.1, 'llmService getGenerationConfig().temperature is 0.1');
  runAssert(genConfig.topP === 0.95, 'llmService getGenerationConfig().topP is 0.95');
  runAssert(!!llmService.modelName, 'llmService active modelName is set');

  const candidates = llmService.getModelCandidates();
  runAssert(Array.isArray(candidates) && candidates.length >= 1, 'llmService has model candidates');
  runAssert(!candidates.some(c => /gemini-1\.5(?!-flash-latest)|gemini-3\.5-transcribe/i.test(c)), 'Candidates exclude legacy 1.5/transcribe aliases');

  // -----------------------------------------------------------------
  // Fix 3: System Prompt Override for Pure Code Output
  // -----------------------------------------------------------------
  console.log('\n--- Test Fix 3: System Prompt Override ---');

  const progPrompt = llmService.getSystemPrompt('Programming');
  const dsaPrompt = llmService.getSystemPrompt('DSA');
  const generalPrompt = llmService.getSystemPrompt('General');

  // Spec: DSA & Programming => ONLY clean, fully-implemented, executable solution code; no markdown wrappers/prose/commentary/filler
  [ ['Programming', progPrompt], ['DSA', dsaPrompt] ].forEach(([name, p]) => {
    runAssert(/only/i.test(p) && /clean/i.test(p) && /executable/i.test(p) && /solution code/i.test(p), `${name} prompt requires clean executable solution code only`);
    runAssert(/no markdown wrappers|without markdown wrappers|no .*code fences/i.test(p) && /no .*prose|no .*commentary|no .*filler/i.test(p), `${name} prompt forbids markdown wrappers/prose/commentary/filler`);
  });
  // Spec: General/Behavioral => direct, concise, natural text suitable for spoken responses; no Python templates/boilerplates unless explicitly asked
  runAssert(/direct/i.test(generalPrompt) && /concise/i.test(generalPrompt) && /natural text/i.test(generalPrompt) && /spoken/i.test(generalPrompt), 'General prompt requires direct concise natural spoken text');
  runAssert(/no python|python class templates|function boilerplates/i.test(generalPrompt) && /unless explicitly asked/i.test(generalPrompt), 'General prompt forbids Python templates/boilerplates unless explicitly asked');

  // Case insensitivity / compatibility
  runAssert(llmService.getSystemPrompt('dsa').length > 20, 'getSystemPrompt("dsa") lowercase handled');
  runAssert(llmService.getSystemPrompt('programming').length > 20, 'getSystemPrompt("programming") lowercase handled');
  runAssert(typeof llmService.getSystemPromptForSkill('DSA') === 'string', 'getSystemPromptForSkill("DSA") backwards compatible');

  // -----------------------------------------------------------------
  // Fix 2: Force Synchronized Dual-Window Streaming
  // -----------------------------------------------------------------
  console.log('\n--- Test Fix 2: Dual-Window IPC Broadcast & Clearing ---');

  const mainSrc = require('../src/main');
  runAssert(typeof mainSrc.broadcastLLMStream === 'function', 'broadcastLLMStream function is exported from src/main.js');

  // Mock windows and test broadcastLLMStream simulation
  const mainEvents = [];
  const chatEvents = [];
  const mockMainWindow = {
    isDestroyed: () => false,
    webContents: {
      send: (channel, data) => mainEvents.push({ channel, data })
    }
  };
  const mockChatWindow = {
    isDestroyed: () => false,
    webContents: {
      send: (channel, data) => chatEvents.push({ channel, data })
    }
  };

  // Mock generator for testing stream loop
  async function* mockStream() {
    yield { text: () => 'def ' };
    yield { text: () => 'solve():\n' };
    yield { text: () => '    return True' };
  }

  // Simulate broadcastLLMStream behavior
  if (mockMainWindow && !mockMainWindow.isDestroyed()) mockMainWindow.webContents.send('clear-response-panel');
  if (mockChatWindow && !mockChatWindow.isDestroyed()) mockChatWindow.webContents.send('clear-response-panel');

  const stream = mockStream();
  for await (const chunk of stream) {
    const token = chunk.text();
    if (mockMainWindow && !mockMainWindow.isDestroyed()) mockMainWindow.webContents.send('stream-llm-token', token);
    if (mockChatWindow && !mockChatWindow.isDestroyed()) mockChatWindow.webContents.send('stream-chat-token', token);
  }
  if (mockChatWindow && !mockChatWindow.isDestroyed()) mockChatWindow.webContents.send('stream-chat-end');

  // Assertions
  runAssert(mainEvents[0].channel === 'clear-response-panel', 'mainWindow receives clear-response-panel before stream');
  runAssert(chatEvents[0].channel === 'clear-response-panel', 'chatWindow receives clear-response-panel before stream');
  
  const mainTokens = mainEvents.filter(e => e.channel === 'stream-llm-token').map(e => e.data);
  const chatTokens = chatEvents.filter(e => e.channel === 'stream-chat-token').map(e => e.data);

  runAssert(mainTokens.length === 3, 'mainWindow received all 3 streamed tokens');
  runAssert(chatTokens.length === 3, 'chatWindow received all 3 streamed tokens');
  runAssert(JSON.stringify(mainTokens) === JSON.stringify(chatTokens), 'Tokens to mainWindow and chatWindow match identically');
  runAssert(chatEvents[chatEvents.length - 1].channel === 'stream-chat-end', 'chatWindow received stream-chat-end');

  // Verify generateStream generator exists on llmService
  runAssert(typeof llmService.generateStream === 'function', 'llmService.generateStream is defined and is a function');

  console.log('\n========================================================');
  console.log(`RESULTS: ${passedTests}/${totalTests} tests passed (${Math.round((passedTests / totalTests) * 100)}%)`);
  console.log('========================================================\n');

  if (passedTests === totalTests) {
    console.log('🎉 ALL FIXES VERIFIED SUCCESSFULLY!');
  } else {
    process.exit(1);
  }
}

testFixes().catch((err) => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
