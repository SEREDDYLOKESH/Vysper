require('dotenv').config();
const assert = require('assert');
const llmService = require('../src/services/llm.service');
const { promptLoader } = require('../prompt-loader');

async function runTests() {
  console.log('=== Starting Skill Prompts & Category Formatting Verification ===\n');

  // Test 1: MASTER_SYSTEM_PROMPT presence
  console.log('[Test 1] Verifying MASTER_SYSTEM_PROMPT...');
  assert(llmService.masterSystemPrompt, 'masterSystemPrompt must be defined on llmService');
  assert(llmService.masterSystemPrompt.includes('IF CODING / DSA:'), 'Must handle Coding/DSA');
  assert(llmService.masterSystemPrompt.includes('IF THEORETICAL / CS CORE:'), 'Must handle Theoretical/CS Core');
  assert(llmService.masterSystemPrompt.includes('IF BEHAVIORAL:'), 'Must handle Behavioral');
  assert(llmService.masterSystemPrompt.includes('IF SYSTEM DESIGN:'), 'Must handle System Design');
  assert(llmService.masterSystemPrompt.includes('NEVER summarize or give meta-advice'), 'Must enforce directness');
  console.log('✓ MASTER_SYSTEM_PROMPT matches specification.\n');

  // Test 2: Prompt templates loaded
  console.log('[Test 2] Verifying prompt templates in prompts/ ...');
  promptLoader.loadPrompts();

  const coreCsPrompt = promptLoader.getSkillPrompt('core-cs');
  assert(coreCsPrompt, 'core-cs prompt must be loaded');
  assert(coreCsPrompt.includes('CRITICAL INSTRUCTION: Provide a direct, authoritative interview response.'), 'core-cs must have critical instruction');
  assert(coreCsPrompt.includes('1. Direct 1-Sentence Answer / Definition'), 'core-cs format item 1');
  assert(coreCsPrompt.includes('2. Key Concepts & Core Architecture'), 'core-cs format item 2');
  assert(coreCsPrompt.includes('3. Trade-offs / Pros & Cons Comparison Table or Summary'), 'core-cs format item 3');
  assert(coreCsPrompt.includes('4. Real-World Practical Example'), 'core-cs format item 4');
  console.log('✓ core-cs.md template verified.');

  const behavioralPrompt = promptLoader.getSkillPrompt('behavioral');
  assert(behavioralPrompt, 'behavioral prompt must be loaded');
  assert(behavioralPrompt.includes('CRITICAL INSTRUCTION: Generate a complete, highly realistic interview response speaking in the first person ("I").'), 'behavioral critical instruction');
  assert(behavioralPrompt.includes('1. Situation:'), 'behavioral format 1');
  assert(behavioralPrompt.includes('2. Task:'), 'behavioral format 2');
  assert(behavioralPrompt.includes('3. Action:'), 'behavioral format 3');
  assert(behavioralPrompt.includes('4. Result:'), 'behavioral format 4');
  console.log('✓ behavioral.md template verified.');

  const systemDesignPrompt = promptLoader.getSkillPrompt('system-design');
  assert(systemDesignPrompt, 'system-design prompt must be loaded');
  assert(systemDesignPrompt.includes('CRITICAL INSTRUCTION: Provide a complete architectural breakdown.'), 'system-design critical instruction');
  assert(systemDesignPrompt.includes('1. Requirements (Functional & Non-Functional'), 'system-design format 1');
  assert(systemDesignPrompt.includes('2. High-Level Architecture Components'), 'system-design format 2');
  assert(systemDesignPrompt.includes('3. Data Flow & API Endpoint Contracts'), 'system-design format 3');
  assert(systemDesignPrompt.includes('4. Deep Dive: Bottlenecks, Scaling Strategies & Fault Tolerance'), 'system-design format 4');
  console.log('✓ system-design.md template verified.\n');

  // Test 3: Dynamic Category Detection & User Message Formatting
  console.log('[Test 3] Testing dynamic category detection and message formatting...');
  
  // Theoretical question under dsa/programming skill
  const theoreticalText = 'What is the difference between a process and a thread? Explain context switching overhead.';
  const theoreticalMsg = llmService.formatUserMessage(theoreticalText, 'dsa');
  assert(theoreticalMsg.includes('THEORETICAL / CORE COMPUTER SCIENCE'), 'Must detect theoretical question even in DSA mode');
  assert(theoreticalMsg.includes('1. Direct 1-Sentence Answer / Definition'), 'Must use theoretical format');
  assert(theoreticalMsg.includes('3. Trade-offs / Pros & Cons Comparison Table or Summary'), 'Must have trade-offs');
  console.log('✓ Auto-detected theoretical question in DSA mode and applied Core CS format.');

  // Behavioral question
  const behavioralText = 'Tell me about a time you had a technical disagreement with a team member and how you resolved it.';
  const behavioralMsg = llmService.formatUserMessage(behavioralText, 'behavioral');
  assert(behavioralMsg.includes('BEHAVIORAL INTERVIEW question'), 'Must format as behavioral');
  assert(behavioralMsg.includes('first person ("I")'), 'Must instruct first person');
  assert(behavioralMsg.includes('1. Situation:'), 'Must use STAR format');
  console.log('✓ Behavioral question formatted with STAR template.');

  // System Design question
  const systemDesignText = 'Design a distributed rate limiter that handles 100,000 requests per second across multiple regions.';
  const systemDesignMsg = llmService.formatUserMessage(systemDesignText, 'system-design');
  assert(systemDesignMsg.includes('SYSTEM DESIGN & ARCHITECTURE'), 'Must format as system design');
  assert(systemDesignMsg.includes('1. Requirements (Functional & Non-Functional'), 'Must use architecture format');
  assert(systemDesignMsg.includes('4. Deep Dive: Bottlenecks, Scaling Strategies'), 'Must include deep dive');
  console.log('✓ System Design question formatted with architecture template.');

  // Coding question
  const codingText = 'Given an array of integers nums and an integer target, return indices of the two numbers such that they add up to target.';
  const codingMsg = llmService.formatUserMessage(codingText, 'dsa', false, 'python');
  assert(codingMsg.includes('live technical coding interview'), 'Must format as coding interview');
  assert(codingMsg.includes('clean, executable Python class implementation') || codingMsg.includes('Full, complete, and runnable code implementation in PYTHON'), 'Must require full runnable code');
  console.log('✓ Coding question formatted with algorithmic template.\n');

  // Test 4: End-to-end generation for Core CS question
  console.log('[Test 4] Testing End-to-end Core CS theoretical question generation...');
  const csResult = await llmService.processTextWithSkill(
    'What is the difference between a mutex and a semaphore, and how do they prevent race conditions?',
    'core-cs'
  );
  assert(csResult && csResult.response, 'csResult must return response');
  assert(csResult.response.length > 200, 'csResult response must be thorough');
  console.log('✓ Core CS response successfully generated.');
  console.log('Preview:\n' + csResult.response.substring(0, 300) + '...\n');

  // Test 5: End-to-end generation for Behavioral question (STAR format)
  console.log('[Test 5] Testing End-to-end Behavioral question generation...');
  const behavioralResult = await llmService.processTextWithSkill(
    'Tell me about a time you led a critical outage post-mortem and improved system reliability.',
    'behavioral'
  );
  assert(behavioralResult && behavioralResult.response, 'behavioralResult must return response');
  assert(behavioralResult.response.includes('Situation') || behavioralResult.response.includes('Task') || behavioralResult.response.includes('Action'), 'Response must follow STAR format');
  console.log('✓ Behavioral response successfully generated with STAR format.');
  console.log('Preview:\n' + behavioralResult.response.substring(0, 300) + '...\n');

  console.log('=== ALL TESTS PASSED SUCCESSFULLY! ===');
}

runTests().catch(err => {
  console.error('\n❌ Test failed with error:', err);
  process.exit(1);
});
