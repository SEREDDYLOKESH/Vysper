/**
 * Test suite for Universal "General / Conversational" Skill Mode
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { promptLoader } = require('../prompt-loader');
const llmService = require('../src/services/llm.service');

console.log('=== Running General Skill Mode Tests ===\n');

// Test 1: Prompt Loader Normalization
console.log('Test 1: Prompt Loader Normalization...');
assert.strictEqual(promptLoader.normalizeSkillName('general'), 'general');
assert.strictEqual(promptLoader.normalizeSkillName('conversational'), 'general');
assert.strictEqual(promptLoader.normalizeSkillName('general-conversational'), 'general');
assert.strictEqual(promptLoader.normalizeSkillName('conversation'), 'general');
assert.strictEqual(promptLoader.normalizeSkillName('chat'), 'general');
assert.strictEqual(promptLoader.normalizeSkillName('GENERAL'), 'general');
console.log('✓ Normalization works for all aliases.\n');

// Test 2: Available Skills Discovery
console.log('Test 2: Available Skills Discovery...');
const availableSkills = promptLoader.getAvailableSkills();
assert.ok(availableSkills.includes('general'), 'availableSkills must include "general"');
console.log(`✓ "general" discovered in available skills: [${availableSkills.join(', ')}]\n`);

// Test 3: Prompt Template Loading
console.log('Test 3: Prompt Template Loading...');
const generalPrompt = promptLoader.getSkillPrompt('general');
assert.ok(generalPrompt && generalPrompt.length > 50, 'General prompt must load from prompts/general.md');
assert.ok(generalPrompt.includes('live technical interview'), 'Prompt must contain interview instructions');
assert.ok(!generalPrompt.includes('LOKESH SEREDDY'), 'Prompt template must not contain personal resume');
console.log('✓ General prompt template loaded successfully.\n');

// Test 4: Question Category Detection
console.log('Test 4: Question Category Detection...');
assert.strictEqual(llmService.detectQuestionCategory('How do you handle conflict?', 'general'), 'general');
assert.strictEqual(llmService.detectQuestionCategory('What is polymorphism?', 'conversational'), 'general');
assert.strictEqual(llmService.detectQuestionCategory('How do you handle conflict?', 'behavioral'), 'behavioral');
console.log('✓ Category detection routes correctly based on activeSkill.\n');

// Test 5: System Instruction - Verify Resume Exclusion
console.log('Test 5: System Instruction - Verify Resume Exclusion...');
const generalSystemInstruction = llmService.buildSystemInstruction(generalPrompt, 'general');
assert.ok(
  !generalSystemInstruction.includes('LOKESH SEREDDY'),
  'General system instruction MUST NOT contain candidate name or resume context'
);
assert.ok(
  !generalSystemInstruction.includes('SRM Institute'),
  'General system instruction MUST NOT contain college details'
);
assert.ok(
  !generalSystemInstruction.includes('STAR Method (Situation, Task, Action, Result)'),
  'General system instruction MUST NOT force STAR Method rules'
);
assert.ok(
  generalSystemInstruction.toLowerCase().includes('humanized') || generalSystemInstruction.toLowerCase().includes('conversationally'),
  'General system instruction must contain humanized conversational delivery guidelines'
);

// Verify Behavioral Still Gets Resume Grounding
const behavioralSystemInstruction = llmService.buildSystemInstruction('', 'behavioral');
assert.ok(
  behavioralSystemInstruction.includes('LOKESH SEREDDY'),
  'Behavioral system instruction SHOULD contain candidate resume context'
);
console.log('✓ System instruction correctly excludes resume for general mode while preserving it for behavioral mode.\n');

// Test 6: User Message Formatting
console.log('Test 6: User Message Formatting...');
const userMsg = llmService.formatUserMessage('Why should we hire you?', 'general', false, null);
assert.ok(userMsg.toLowerCase().includes('conversationally'), 'User message should include conversational guidance');
assert.ok(!userMsg.includes('STAR format'), 'User message must not demand STAR format in general mode');
console.log('✓ User message formatting verified for general mode.\n');

// Test 7: Intelligent Transcription Request Building
console.log('Test 7: Intelligent Transcription Request...');
const transcriptionReq = llmService.buildIntelligentTranscriptionRequest(
  'Can you tell me about your background and experience?',
  'general',
  []
);
assert.strictEqual(transcriptionReq.contents[0].parts[0].text, 'Can you tell me about your background and experience?');
const transcriptionSystemInstruction = transcriptionReq.systemInstruction.parts[0].text;
assert.ok(!transcriptionSystemInstruction.includes('LOKESH SEREDDY'), 'Transcription request must not include resume');
assert.ok(transcriptionSystemInstruction.includes('General / Conversational Mode'), 'Transcription request includes general instructions');
console.log('✓ Intelligent transcription request correctly built.\n');

// Test 8: Fallback Responses
console.log('Test 8: Fallback Responses...');
const fallback = llmService.generateFallbackResponse('Explain recursion', 'general');
assert.ok(fallback.response.includes('conversational'), 'Fallback response should reflect general mode');
const intFallback = llmService.generateIntelligentFallbackResponse('Tell me about your thoughts on cloud computing', 'general');
assert.ok(intFallback.response.includes('conversational'), 'Intelligent fallback should reflect general mode');
console.log('✓ Fallback responses return valid content for general mode.\n');

// Test 9: Settings HTML Validation
console.log('Test 9: Settings HTML Validation...');
const settingsHtml = fs.readFileSync(path.join(__dirname, '..', 'settings.html'), 'utf8');
assert.ok(
  settingsHtml.includes('<option value="general">General / Conversational</option>'),
  'settings.html must include general option'
);
console.log('✓ settings.html contains General / Conversational option.\n');

// Test 10: MainWindow UI availableSkills Validation
console.log('Test 10: MainWindow UI availableSkills Validation...');
const mainWindowJs = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'main-window.js'), 'utf8');
assert.ok(mainWindowJs.includes("'general'"), 'main-window.js must include general in availableSkills');
assert.ok(mainWindowJs.includes("'conversational': 'Conversational'"), 'main-window.js must map conversational display name');
console.log('✓ main-window.js configured with general and conversational mappings.\n');

console.log('==========================================');
console.log(' ALL 10 GENERAL SKILL MODE TESTS PASSED! ');
console.log('==========================================');
