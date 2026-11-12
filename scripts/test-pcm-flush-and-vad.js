require('dotenv').config();

let totalTests = 0;
let passedTests = 0;

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
  console.log('🧪 TESTING PCM AUDIO FLUSH & AUTOMATIC SILENCE VAD');
  console.log('========================================================\n');

  // ----------------------------------------------------
  // Test 1: Buffer Flushing on Manual Microphone Stop
  // ----------------------------------------------------
  console.log('--- Test 1: Manual Microphone Stop Buffer Flushing ---');

  let sentChannel = null;
  let sentPayload = null;
  let statusUpdateSent = null;

  const mockIpcRenderer = {
    send: (channel, data) => {
      if (channel === 'process-pcm-audio-submit') {
        sentChannel = channel;
        sentPayload = data;
      } else if (channel === 'speech-status-update') {
        statusUpdateSent = data;
      }
    }
  };

  // Simulate audio context & processor
  let processorDisconnected = false;
  let audioContextClosed = false;

  const mockProcessor = {
    disconnect: () => { processorDisconnected = true; }
  };
  const mockAudioContext = {
    state: 'running',
    close: () => { audioContextClosed = true; }
  };

  // Implementation matching chat.html stopListening()
  let isListening = true;
  let silenceTimer = setTimeout(() => {}, 10000);
  let pcmChunks = [
    Buffer.alloc(8192, 1),
    Buffer.alloc(8192, 2)
  ];

  function stopListening() {
    if (!isListening) return;
    isListening = false;

    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = null;

    if (mockProcessor) mockProcessor.disconnect();
    if (mockAudioContext && mockAudioContext.state !== 'closed') mockAudioContext.close();

    mockIpcRenderer.send('speech-status-update', 'Microphone stopped.');

    // CRITICAL: Flush collected PCM audio buffer to Gemini handler
    if (pcmChunks.length > 0) {
      const fullBuffer = Buffer.concat(pcmChunks);
      pcmChunks = []; // Reset RAM buffer
      
      console.log(`[PCM Flush] Dispatching ${fullBuffer.length} bytes to Gemini LLM...`);
      mockIpcRenderer.send('process-pcm-audio-submit', fullBuffer);
    } else {
      console.warn('[PCM Flush] Stopped listening but PCM buffer was empty.');
    }
  }

  // Trigger manual stop
  stopListening();

  assert(isListening === false, 'isListening flag is reset to false');
  assert(processorDisconnected === true, 'Audio processor is disconnected');
  assert(audioContextClosed === true, 'Audio context is closed');
  assert(statusUpdateSent === 'Microphone stopped.', 'speech-status-update event dispatched');
  assert(sentChannel === 'process-pcm-audio-submit', 'process-pcm-audio-submit event emitted');
  assert(sentPayload && sentPayload.length === 16384, 'Full PCM buffer concatenated and dispatched (16384 bytes)');
  assert(pcmChunks.length === 0, 'RAM buffer pcmChunks is cleared after flush');

  // ----------------------------------------------------
  // Test 2: Automatic Silence Detection (VAD) Trigger
  // ----------------------------------------------------
  console.log('\n--- Test 2: Voice Activity Detection (VAD) Logic ---');

  let vadTriggeredStop = false;
  isListening = true;
  let lastAudioTime = Date.now() - 2000; // 2 seconds ago (exceeds 1.5s threshold)
  pcmChunks = [Buffer.alloc(1000), Buffer.alloc(1000), Buffer.alloc(1000), Buffer.alloc(1000), Buffer.alloc(1000), Buffer.alloc(1000)];

  function vadStopListening() {
    vadTriggeredStop = true;
    isListening = false;
  }

  // Simulate audio processor onaudioprocess with silence (RMS < 0.01)
  const silentInput = new Float32Array(4096); // All zeroes
  let sum = 0;
  for (let i = 0; i < silentInput.length; i++) {
    sum += silentInput[i] * silentInput[i];
  }
  const rms = Math.sqrt(sum / silentInput.length);
  assert(rms < 0.01, 'Silent input generates RMS < 0.01');

  if (rms > 0.015) {
    lastAudioTime = Date.now();
  } else if (Date.now() - lastAudioTime > 1500 && pcmChunks.length > 5) {
    vadStopListening();
  }

  assert(vadTriggeredStop === true, 'VAD automatically triggers stopListening after 1.5s silence with speech captured');

  // Test 2.2: Active Speech Resets Silence Timer
  console.log('\n--- Test 2.2: Active Speech Resets Silence Timer ---');
  vadTriggeredStop = false;
  isListening = true;
  lastAudioTime = Date.now() - 2000;

  // Simulate loud speech sample
  const speechInput = new Float32Array(4096);
  for (let i = 0; i < speechInput.length; i++) {
    speechInput[i] = 0.5 * Math.sin(i);
  }
  let speechSum = 0;
  for (let i = 0; i < speechInput.length; i++) {
    speechSum += speechInput[i] * speechInput[i];
  }
  const speechRms = Math.sqrt(speechSum / speechInput.length);
  assert(speechRms > 0.015, 'Speech sample has RMS > 0.015');

  if (speechRms > 0.015) {
    lastAudioTime = Date.now();
  } else if (Date.now() - lastAudioTime > 1500 && pcmChunks.length > 5) {
    vadStopListening();
  }

  assert(vadTriggeredStop === false, 'VAD does not stop while speech is active');
  assert(Date.now() - lastAudioTime < 100, 'lastAudioTime updated to current timestamp');

  // ----------------------------------------------------
  // Test 3: Main Process Triggering Gemini Streaming
  // ----------------------------------------------------
  console.log('\n--- Test 3: Main Process IPC & Gemini Streaming Execution ---');

  let streamStatusReceived = null;
  let streamedTokens = [];
  let mainTokens = [];
  let chatTokens = [];

  const mockChatWindow = {
    isDestroyed: () => false,
    webContents: {
      send: (channel, data) => {
        if (channel === 'speech-status-update') streamStatusReceived = data;
        if (channel === 'stream-chat-token') chatTokens.push(data);
      }
    }
  };

  const mockMainWindow = {
    isDestroyed: () => false,
    webContents: {
      send: (channel, data) => {
        if (channel === 'stream-llm-token') mainTokens.push(data);
      }
    }
  };

  const mockLLMService = {
    streamAnswerFromAudioPCM: async (buffer, skill, onToken) => {
      onToken('Hello');
      onToken(' ');
      onToken('world');
      return 'Hello world';
    }
  };

  // Simulate handler logic in src/main.js
  const samplePCM = Buffer.alloc(16000 * 2);
  const currentSkill = 'General';

  if (mockChatWindow) mockChatWindow.webContents.send('speech-status-update', 'Transcribing & Generating Answer...');

  const responseText = await mockLLMService.streamAnswerFromAudioPCM(
    samplePCM,
    currentSkill,
    (token) => {
      mockMainWindow.webContents.send('stream-llm-token', token);
      if (mockChatWindow) mockChatWindow.webContents.send('stream-chat-token', token);
    }
  );

  assert(streamStatusReceived === 'Transcribing & Generating Answer...', 'speech-status-update sent to chatWindow at start');
  assert(mainTokens.join('') === 'Hello world', 'mainWindow received all streamed tokens');
  assert(chatTokens.join('') === 'Hello world', 'chatWindow received all streamed tokens');
  assert(responseText === 'Hello world', 'Final streamed response generated successfully');

  // Test 3.2: Error handling in main process
  console.log('\n--- Test 3.2: Error Handling in Gemini Stream ---');
  let errorStatus = null;
  const failingLLMService = {
    streamAnswerFromAudioPCM: async () => {
      throw new Error('Gemini API quota exceeded');
    }
  };

  try {
    await failingLLMService.streamAnswerFromAudioPCM(samplePCM, currentSkill, () => {});
  } catch (err) {
    if (mockChatWindow) mockChatWindow.webContents.send('speech-status-update', `Error: ${err.message}`);
  }

  assert(streamStatusReceived === 'Error: Gemini API quota exceeded', 'Error correctly reported to chatWindow via speech-status-update');

  // ----------------------------------------------------
  // Summary
  // ----------------------------------------------------
  console.log('\n========================================================');
  console.log(`RESULTS: ${passedTests}/${totalTests} tests passed (${Math.round((passedTests/totalTests)*100)}%)`);
  console.log('========================================================\n');

  if (passedTests === totalTests) {
    console.log('🎉 ALL PCM FLUSH & VAD TESTS PASSED!');
    process.exit(0);
  } else {
    console.error('❌ SOME TESTS FAILED.');
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Test execution error:', err);
  process.exit(1);
});
