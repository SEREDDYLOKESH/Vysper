const assert = require('assert');
const llmService = require('../src/services/llm.service');
const ocrService = require('../src/services/ocr.service');
const config = require('../src/core/config');

async function runTests() {
  console.log('=== Starting Response Speed & Candidate Resume Grounding Tests ===\n');

  // [Test 1] Verify Generation Configuration
  console.log('[Test 1] Verifying generation parameters (temperature: 0.1/0.2, maxOutputTokens: 2048)...');
  const genConfig = llmService.getGenerationConfig();
  assert(genConfig.temperature === 0.1 || genConfig.temperature === 0.2, 'Temperature should be within expected range');
  assert.strictEqual(genConfig.maxOutputTokens, 2048, 'maxOutputTokens must be 2048');
  console.log('✓ Generation config verified:', genConfig);

  // [Test 2] Verify Model Target & Fallbacks
  console.log('\n[Test 2] Verifying model configuration and fallback list...');
  const candidates = llmService.getModelCandidates();
  assert(candidates[0] === 'gemini-3.5-flash' || candidates[0] === 'gemini-3.8-flash' || candidates[0] === 'gemini-2.5-flash' || candidates[0] === 'gemini-1.5-flash', 'Primary candidate should be valid candidate');
  console.log('✓ Model candidates:', candidates);

  // [Test 3] Verify Candidate Resume in System Instructions & Behavioral Rules
  console.log('\n[Test 3] Verifying candidate resume grounding in behavioral instructions...');
  assert(llmService.masterSystemPrompt.includes('LOKESH SEREDDY'), 'Master system prompt must include candidate name');
  assert(llmService.masterSystemPrompt.includes('AI Multi-Language Code Converter'), 'Must include AI Code Converter project');
  assert(llmService.masterSystemPrompt.includes('Cloud-Based File Sharing System'), 'Must include Cloud-Based File Sharing project');
  
  const behavioralInstruction = llmService.buildSystemInstruction('', 'behavioral');
  assert(behavioralInstruction.includes('LOKESH SEREDDY'), 'Behavioral instruction must ground in candidate');
  assert(behavioralInstruction.includes('STAR Method'), 'Must enforce STAR method');
  console.log('✓ Candidate resume context successfully integrated into behavioral instructions.');

  // [Test 4] Verify Image Downscaling & Compression
  console.log('\n[Test 4] Verifying image downscaling and compression...');
  // Mock NativeImage with 1920x1080 dimensions
  const mock1080p = {
    getSize() {
      return { width: 1920, height: 1080 };
    },
    resize({ width, height, quality }) {
      return {
        getSize() {
          return { width, height };
        },
        toJPEG(q) {
          return Buffer.alloc(Math.round((width * height * 0.15 * (q / 100))));
        },
        toPNG() {
          return Buffer.alloc(width * height * 3);
        }
      };
    }
  };

  const downscaled = ocrService.downscaleAndCompressImage(mock1080p, 1024, 80);
  console.log('Downscaled dimensions:', `${downscaled.width}x${downscaled.height}`);
  assert.strictEqual(downscaled.width, 1024, 'Width should be downscaled to 1024');
  assert.strictEqual(downscaled.height, 576, 'Height should be proportionally 576');
  assert.strictEqual(downscaled.mimeType, 'image/jpeg', 'Mime type should be image/jpeg');
  console.log('✓ Downscaling calculated correct aspect ratio and JPEG compression.');

  // [Test 5] Test generateResponse pipeline with Behavioral Question
  console.log('\n[Test 5] Generating real response via generateResponse(image, skillContext)...');
  const question = 'Tell me about a time you handled a difficult technical challenge';
  const skillContext = {
    skill: 'behavioral',
    skillName: 'Behavioral',
    text: question
  };

  const startTime = Date.now();
  const result = await llmService.generateResponse(null, skillContext);
  const elapsed = Date.now() - startTime;
  
  console.log(`Response generated in ${elapsed}ms:`);
  console.log('----------------------------------------------------');
  console.log(result.response);
  console.log('----------------------------------------------------');

  // Verify Behavioral Grounding
  const responseText = result.response;
  const usesFirstPerson = responseText.includes('I ') || responseText.includes('my ') || responseText.includes('I was') || responseText.includes('I developed');
  assert(usesFirstPerson, 'Behavioral response must speak in the first person ("I")');
  
  const mentionsProjects = responseText.toLowerCase().includes('code converter') || 
                           responseText.toLowerCase().includes('file sharing') ||
                           responseText.toLowerCase().includes('fastapi') ||
                           responseText.toLowerCase().includes('flask') ||
                           responseText.toLowerCase().includes('ollama') ||
                           responseText.toLowerCase().includes('s3') ||
                           responseText.toLowerCase().includes('jwt') ||
                           responseText.toLowerCase().includes('postgresql');
  assert(mentionsProjects, 'Response must reference Lokesh Sereddy\'s actual tech stack or projects');

  const hasSTAR = responseText.toLowerCase().includes('situation') && 
                  responseText.toLowerCase().includes('task') && 
                  responseText.toLowerCase().includes('action') && 
                  responseText.toLowerCase().includes('result');
  assert(hasSTAR, 'Response must follow the STAR framework (Situation, Task, Action, Result)');

  console.log('\n✓ First-person ("I") verified.');
  console.log('✓ Lokesh Sereddy projects/tech stack grounding verified.');
  console.log('✓ STAR framework structure verified.');
  console.log('\n=== ALL TESTS PASSED SUCCESSFULLY! ===');
}

runTests().catch((err) => {
  console.error('\n✗ Test failed:', err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
