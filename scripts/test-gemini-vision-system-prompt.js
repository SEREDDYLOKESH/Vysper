require('dotenv').config();
const assert = require('assert');
const config = require('../src/core/config');
const llmService = require('../src/services/llm.service');
const { promptLoader } = require('../prompt-loader');

async function runTests() {
  console.log('--- Starting Gemini Vision & System Prompt Verification ---');

  // Test 1: Config and API key priority
  console.log('\n[Test 1] Testing API Key loading priority...');
  const key = process.env.GEMINI_API_KEY || config.get('gemini.apiKey');
  assert(key, 'API key should be resolved from process.env or config');
  assert(llmService.isInitialized, 'LLM service should be initialized with API key');
  console.log('✓ API key priority verified. Service initialized successfully.');

  // Test 2: System prompt application with language injection
  console.log('\n[Test 2] Testing System Prompt Application...');
  const request = llmService.buildGeminiRequest(
    'Two Sum problem: Given an array of integers nums and an integer target, return indices of the two numbers such that they add up to target.',
    'dsa',
    [],
    'python'
  );

  assert(request.systemInstruction, 'Request must have systemInstruction');
  assert.strictEqual(request.systemInstruction.role, 'system', 'systemInstruction must have role: "system"');
  assert(request.systemInstruction.parts && request.systemInstruction.parts.length > 0, 'systemInstruction must have parts');

  const systemText = request.systemInstruction.parts[0].text;
  assert(systemText.includes('You are an ultra-fast live interview helper.'), 'System prompt must include ultra-fast helper');
  assert(systemText.includes('Return ONLY the clean, executable Python class implementation.'), 'System prompt must require clean executable Python class');
  assert(systemText.includes('Output code only.'), 'System prompt must mandate output code only');
  console.log('✓ System prompt adheres to pure clean code-only DSA instructions.');

  // Test 3: Vision payload and user parts formatting
  console.log('\n[Test 3] Testing Vision Payload and User Parts...');
  const sample1pxBase64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const visionRequest = llmService.buildGeminiRequest(
    'Solve the problem in the screenshot',
    'dsa',
    [],
    'python',
    sample1pxBase64
  );

  const userParts = visionRequest.contents[0].parts;
  assert(userParts.length === 2, 'Vision request must have 2 parts: image inlineData and user text');
  assert(userParts[0].inlineData, 'First part must be inlineData');
  assert.strictEqual(userParts[0].inlineData.mimeType, 'image/png');
  assert(!userParts[0].inlineData.data.startsWith('data:'), 'Data URI prefix must be stripped');
  assert(userParts[1].text.includes('Python'), 'User text must specify preferred language');
  assert(userParts[1].text.includes('Return ONLY the clean, executable Python class implementation.'), 'Must demand clean executable code');
  console.log('✓ Vision payload correctly formatted and stripped of data URI prefix.');

  // Test 4: Multi-turn alternating role validation
  console.log('\n[Test 4] Testing Multi-turn Alternating Role Validation...');
  const sessionManager = require('../src/managers/session.manager');
  const skillContext = sessionManager.getSkillContext('dsa', 'python');
  
  // Create simulated history with consecutive same-role messages
  const dirtyHistory = [
    { role: 'model', content: 'Greeting' }, // Starts with model (should be dropped)
    { role: 'user', content: 'Question 1' },
    { role: 'user', content: 'Question 1 continuation' }, // Consecutive user
    { role: 'model', content: 'Answer 1' },
    { role: 'user', content: 'Question 2' } // Ends with user (should be dropped so last turn is model before appending new user)
  ];

  const multiturnRequest = llmService.buildGeminiRequestWithHistory(
    'New Question',
    'dsa',
    dirtyHistory,
    skillContext,
    'python'
  );

  // Validate alternating roles in request contents
  let lastRole = null;
  for (const content of multiturnRequest.contents) {
    assert.notStrictEqual(content.role, lastRole, `Consecutive duplicate role found: ${content.role}`);
    lastRole = content.role;
  }
  assert.strictEqual(multiturnRequest.contents[0].role, 'user', 'First turn must be user');
  assert.strictEqual(multiturnRequest.contents[multiturnRequest.contents.length - 1].role, 'user', 'Final turn must be user');
  console.log('✓ Alternating turn validation passed: strictly user -> model -> user.');

  // Test 5: End-to-end LLM processing with vision input
  console.log('\n[Test 5] Testing End-to-end LLM processing with Vision input...');
  const result = await llmService.processTextWithSkill(
    'Problem: Find the maximum element in an array. Provide optimal solution.',
    'dsa',
    [],
    'python',
    sample1pxBase64
  );

  assert(result && result.response, 'Result must contain response');
  assert(result.response.length > 50, 'Response should be detailed and full');
  console.log('✓ End-to-end vision processing successful!');
  console.log('Response preview:\n' + result.response.substring(0, 300) + '...\n');

  // Test 6: Settings persistence to settings.json
  console.log('\n[Test 6] Testing settings persistence...');
  const testSettings = {
    geminiKey: key,
    codingLanguage: 'python',
    activeSkill: 'dsa'
  };
  const saveSuccess = config.saveSettings(testSettings);
  assert(saveSuccess, 'saveSettings should return true');
  console.log('✓ Settings persisted to ~/.Vysper/settings.json successfully.');

  console.log('\n=== ALL TESTS PASSED SUCCESSFULLY! ===');
}

runTests().catch(err => {
  console.error('\n❌ Test failed with error:', err);
  process.exit(1);
});
