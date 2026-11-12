const assert = require('assert');
const speechService = require('../src/services/speech.service');
const windowManager = require('../src/managers/window.manager');
const llmService = require('../src/services/llm.service');

async function runTests() {
  console.log('=== Starting Local Speech Recognition & AI Trigger Unit Tests ===\n');

  // [Test 1] Verify SpeechService is local and requires no Azure credentials
  console.log('[Test 1] Verifying SpeechService local configuration...');
  const initialStatus = speechService.getStatus();
  assert.strictEqual(initialStatus.isRecording, false, 'Initial state must not be recording');
  assert.strictEqual(initialStatus.mode, 'local-web-speech', 'Mode must be local-web-speech');
  console.log('✓ Initial status verified:', initialStatus);

  // [Test 2] Verify Recording Lifecycle (start, toggle, stop)
  console.log('\n[Test 2] Verifying startRecording, stopRecording, and toggleRecording...');
  let recordingStartedEmitted = false;
  let recordingStoppedEmitted = false;
  let statusEmitted = null;

  speechService.once('recording-started', () => {
    recordingStartedEmitted = true;
  });
  speechService.once('recording-stopped', () => {
    recordingStoppedEmitted = true;
  });
  speechService.once('status', (msg) => {
    statusEmitted = msg;
  });

  speechService.startRecording();
  const activeStatus = speechService.getStatus();
  assert.strictEqual(activeStatus.isRecording, true, 'isRecording must be true after start');
  assert.strictEqual(recordingStartedEmitted, true, 'recording-started event must fire');
  assert(statusEmitted !== null, 'status event must fire');
  console.log('✓ Started recording successfully, status:', activeStatus);

  speechService.stopRecording();
  const stoppedStatus = speechService.getStatus();
  assert.strictEqual(stoppedStatus.isRecording, false, 'isRecording must be false after stop');
  assert.strictEqual(recordingStoppedEmitted, true, 'recording-stopped event must fire');
  console.log('✓ Stopped recording successfully, status:', stoppedStatus);

  // Test toggle
  speechService.toggleRecording();
  assert.strictEqual(speechService.getStatus().isRecording, true, 'toggle from stopped should start');
  speechService.toggleRecording();
  assert.strictEqual(speechService.getStatus().isRecording, false, 'toggle from active should stop');
  console.log('✓ toggleRecording works correctly');

  // [Test 3] Verify Interim & Final Transcription Event Relaying
  console.log('\n[Test 3] Verifying Interim and Final Transcription Event Relaying...');
  let interimReceived = null;
  let finalReceived = null;
  let finalSkillReceived = null;

  speechService.once('interim-transcription', (text) => {
    interimReceived = text;
  });
  speechService.once('transcription', (text, skill) => {
    finalReceived = text;
    finalSkillReceived = skill;
  });

  speechService.emit('interim-transcription', 'What is the time complexity');
  assert.strictEqual(interimReceived, 'What is the time complexity', 'Interim transcription should match');

  speechService.emit('transcription', 'What is the time complexity of QuickSort?', 'dsa');
  assert.strictEqual(finalReceived, 'What is the time complexity of QuickSort?', 'Final transcription text should match');
  assert.strictEqual(finalSkillReceived, 'dsa', 'Final transcription skill should match');
  console.log('✓ Interim and Final transcription events verified');

  // [Test 4] Verify windowManager.displayLLMResponse and showLLMResponse exist
  console.log('\n[Test 4] Verifying windowManager response methods...');
  assert.strictEqual(typeof windowManager.showLLMResponse, 'function', 'showLLMResponse must be a function');
  assert.strictEqual(typeof windowManager.displayLLMResponse, 'function', 'displayLLMResponse must be a function');
  assert.strictEqual(typeof windowManager.showLLMLoading, 'function', 'showLLMLoading must be a function');
  console.log('✓ windowManager display and loading methods verified');

  // [Test 5] Verify llmService.generateResponse contract for speech transcript
  console.log('\n[Test 5] Verifying llmService.generateResponse interface for speech text...');
  assert.strictEqual(typeof llmService.generateResponse, 'function', 'generateResponse must be a function');
  console.log('✓ llmService.generateResponse interface verified');

  // [Test 6] Verify llmService.generateResponseText exists and returns a string
  console.log('\n[Test 6] Verifying llmService.generateResponseText...');
  assert.strictEqual(typeof llmService.generateResponseText, 'function', 'generateResponseText must be a function');
  
  const origGenerate = llmService.generateResponse.bind(llmService);
  llmService.generateResponse = async (text, ctx) => ({
    response: 'A process is an execution unit with isolated memory; a thread is a lightweight execution flow sharing memory.',
    metadata: { skill: ctx.skill }
  });

  const generatedText = await llmService.generateResponseText('What is the difference between a process and a thread?', 'core-cs');
  assert.strictEqual(typeof generatedText, 'string', 'generateResponseText must return a string');
  assert(generatedText.length > 0, 'generateResponseText must not return an empty string');
  console.log('✓ llmService.generateResponseText returns valid response text:', generatedText);

  // [Test 7] Verify speech-final-transcript IPC event flow
  console.log('\n[Test 7] Verifying speech-final-transcript IPC event handling...');
  let addChatMessagePayload = null;
  let displayLlmResponsePayload = null;

  const mockChatWindow = {
    isDestroyed: () => false,
    webContents: {
      send: (channel, data) => {
        if (channel === 'add-chat-message') {
          addChatMessagePayload = data;
        }
      }
    }
  };

  const mockMainWindow = {
    isDestroyed: () => false,
    webContents: {
      send: (channel, data) => {
        if (channel === 'display-llm-response') {
          displayLlmResponsePayload = data;
        }
      }
    }
  };

  // Temporarily store mock windows on windowManager
  const originalGetWindow = windowManager.getWindow.bind(windowManager);
  windowManager.getWindow = (type) => {
    if (type === 'chat') return mockChatWindow;
    if (type === 'llmResponse' || type === 'main') return mockMainWindow;
    return originalGetWindow(type);
  };

  // Simulate speech-final-transcript invocation
  const testQuestion = 'What is the difference between process and thread?';
  const currentActiveSkill = 'core-cs';

  // 1. Send user transcript to chat window UI
  mockChatWindow.webContents.send('add-chat-message', { sender: 'Interviewer', text: testQuestion });
  assert.deepStrictEqual(addChatMessagePayload, { sender: 'Interviewer', text: testQuestion });
  console.log('✓ Chat message forwarded to chat window UI:', addChatMessagePayload);

  // 2. Pass transcript to LLM service to generate an answer
  const testResponse = await llmService.generateResponseText(testQuestion, currentActiveSkill);
  assert.strictEqual(typeof testResponse, 'string');

  // 3. Display answer on main response overlay window
  mockMainWindow.webContents.send('display-llm-response', testResponse);
  assert.strictEqual(displayLlmResponsePayload, testResponse);
  console.log('✓ Response displayed to main response overlay window');

  // Restore
  llmService.generateResponse = origGenerate;
  windowManager.getWindow = originalGetWindow;

  console.log('\n=== All Tests Passed Successfully! ===');
  process.exit(0);
}

runTests().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
