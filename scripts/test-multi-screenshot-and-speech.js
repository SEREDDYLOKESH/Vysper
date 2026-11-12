require('dotenv').config();
const assert = require('assert');
const ocrService = require('../src/services/ocr.service');
const llmService = require('../src/services/llm.service');
const speechService = require('../src/services/speech.service');

async function runTests() {
  console.log('=== Starting Test: Multi-Screenshot Buffer & Speech Resilience ===\n');

  // Test 1: OCR Service Screenshot Buffer Management
  console.log('[Test 1] Testing OCR Service Screenshot Stacking Buffer...');
  ocrService.clearScreenshotBuffer();
  assert.strictEqual(ocrService.getBufferCount(), 0, 'Buffer should initially be empty');

  const mockBuffer1 = Buffer.from('mock image buffer 1 data');
  const mockBuffer2 = Buffer.from('mock image buffer 2 data');

  const count1 = ocrService.addScreenshotToBuffer({
    buffer: mockBuffer1,
    imageBase64: 'data:image/png;base64,' + mockBuffer1.toString('base64'),
    rawBase64: mockBuffer1.toString('base64'),
    mimeType: 'image/png',
    text: 'Top half of LeetCode Two Sum question'
  });
  assert.strictEqual(count1, 1, 'Buffer count should be 1 after first screenshot');
  assert.strictEqual(ocrService.getBufferCount(), 1);

  const count2 = ocrService.addScreenshotToBuffer({
    buffer: mockBuffer2,
    imageBase64: 'data:image/png;base64,' + mockBuffer2.toString('base64'),
    rawBase64: mockBuffer2.toString('base64'),
    mimeType: 'image/png',
    text: 'Bottom half with constraints and examples'
  });
  assert.strictEqual(count2, 2, 'Buffer count should be 2 after second screenshot');
  assert.strictEqual(ocrService.getBufferCount(), 2);

  const buffered = ocrService.getScreenshotBuffer();
  assert.strictEqual(buffered.length, 2, 'Retrieved buffer should have 2 items');
  assert.strictEqual(buffered[0].text, 'Top half of LeetCode Two Sum question');
  assert.strictEqual(buffered[1].text, 'Bottom half with constraints and examples');

  const clearedCount = ocrService.clearScreenshotBuffer();
  assert.strictEqual(clearedCount, 2, 'Cleared count should report 2');
  assert.strictEqual(ocrService.getBufferCount(), 0, 'Buffer should be empty after clear');
  console.log('✓ OCR Service screenshot stacking buffer functions properly.\n');

  // Test 2: Multi-Image Gemini Payload Generator
  console.log('[Test 2] Testing LLM Service Multi-Image Gemini Payload...');
  const sample1pxBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const imgBuf1 = Buffer.from(sample1pxBase64, 'base64');
  const imgBuf2 = Buffer.from(sample1pxBase64, 'base64');

  const sampleImageBuffers = [imgBuf1, imgBuf2];

  // Test buildGeminiMultiImageRequest
  const testPrompt = "The following images represent parts of a single problem. Read all images sequentially and provide the complete solution:";
  const imageParts = sampleImageBuffers.map(buffer => ({
    inlineData: {
      data: buffer.toString('base64'),
      mimeType: 'image/png'
    }
  }));

  assert.strictEqual(imageParts.length, 2, 'Should have 2 image parts');
  assert.strictEqual(imageParts[0].inlineData.mimeType, 'image/png');
  assert.strictEqual(imageParts[0].inlineData.data, sample1pxBase64);

  const formattedPrompt = llmService.formatUserMessage(testPrompt, 'dsa', true, 'python');
  const geminiRequest = llmService.buildGeminiMultiImageRequest(
    formattedPrompt,
    imageParts,
    'dsa',
    [],
    'python'
  );

  assert(geminiRequest.systemInstruction, 'Request should contain systemInstruction');
  assert.strictEqual(geminiRequest.systemInstruction.role, 'system');
  const dsaSysPrompt = geminiRequest.systemInstruction.parts[0].text;
  assert(dsaSysPrompt.includes('You are an ultra-fast live interview helper.'), 'Must include ultra-fast helper intro');
  assert(dsaSysPrompt.includes('Return ONLY the clean, executable Python class implementation.'), 'Must require executable Python class');
  assert(dsaSysPrompt.includes('Do NOT include explanations, do NOT include problem patterns'), 'Must strictly forbid explanations/patterns');
  assert(!dsaSysPrompt.includes('Naive Solution'), 'Must strip naive solution');
  assert(!dsaSysPrompt.includes('Dry Run'), 'Must strip dry run');
  assert(geminiRequest.contents.length > 0, 'Request should contain contents');

  const userTurn = geminiRequest.contents[geminiRequest.contents.length - 1];
  assert.strictEqual(userTurn.role, 'user', 'Last turn should be user');
  assert(userTurn.parts.length === 3, 'User parts should contain 1 prompt + 2 inlineData image parts');
  assert(userTurn.parts[0].text.includes('Return ONLY the clean, executable Python class implementation.'), 'User prompt must enforce code-only');
  assert(!userTurn.parts[0].text.includes('Naive approach + time/space complexity'), 'User prompt must strip naive approach');
  assert(!userTurn.parts[0].text.includes('Step-by-step dry run on an example'), 'User prompt must strip dry run');
  assert(userTurn.parts[1].inlineData && userTurn.parts[1].inlineData.mimeType === 'image/png', 'Second part should be first image');
  assert(userTurn.parts[2].inlineData && userTurn.parts[2].inlineData.mimeType === 'image/png', 'Third part should be second image');
  console.log('✓ Multi-Image Gemini request built with correct multi-part payload structure and pure clean code-only instructions.\n');

  // Test 3: Speech Recognition Service State & Resilience
  console.log('[Test 3] Testing Speech Service isListening State & Status...');
  const initialStatus = speechService.getStatus();
  assert.strictEqual(typeof initialStatus.isListening, 'boolean', 'getStatus should include isListening');
  assert.strictEqual(initialStatus.isListening, false, 'isListening should be false initially');

  speechService.startRecording();
  const recordingStatus = speechService.getStatus();
  assert.strictEqual(recordingStatus.isRecording, true, 'isRecording should be true when started');
  assert.strictEqual(recordingStatus.isListening, true, 'isListening should be true when started');

  speechService.stopRecording();
  const stoppedStatus = speechService.getStatus();
  assert.strictEqual(stoppedStatus.isRecording, false, 'isRecording should be false when stopped');
  assert.strictEqual(stoppedStatus.isListening, false, 'isListening should be false when stopped');
  console.log('✓ Speech Service isListening and session state verified.\n');

  console.log('=== All Multi-Screenshot Buffer & Speech Resilience Tests Passed! ===');
}

runTests().catch(err => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
