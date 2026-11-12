require('dotenv').config();
const llmService = require('../src/services/llm.service');

async function testPCMStreaming() {
  console.log('--- Generating synthetic 16kHz PCM audio buffer (1 second, 16000 samples) ---');
  const sampleRate = 16000;
  const numSamples = sampleRate; // 1 second
  const pcm16 = new Int16Array(numSamples);

  // Generate 440Hz sine wave tone
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const sample = Math.sin(2 * Math.PI * 440 * t);
    pcm16[i] = Math.round(sample * 30000);
  }

  const pcmBuffer = Buffer.from(pcm16.buffer);
  console.log(`PCM Buffer size: ${pcmBuffer.length} bytes (${pcmBuffer.length / 2} samples at 16-bit)`);

  console.log('\n--- Calling streamAnswerFromAudioPCM ---');
  const startTime = Date.now();
  let tokenCount = 0;

  try {
    const fullAnswer = await llmService.streamAnswerFromAudioPCM(
      pcmBuffer,
      'General',
      (token) => {
        tokenCount++;
        process.stdout.write(token);
      }
    );

    const elapsed = Date.now() - startTime;
    console.log(`\n\n--- Success! ---`);
    console.log(`Received ${tokenCount} tokens in ${elapsed}ms.`);
    console.log(`Full answer length: ${fullAnswer.length} characters.`);
    process.exit(0);
  } catch (err) {
    console.error('\n--- Error in streamAnswerFromAudioPCM: ---', err.message);
    process.exit(1);
  }
}

testPCMStreaming();
