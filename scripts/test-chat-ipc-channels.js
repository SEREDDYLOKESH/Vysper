/**
 * Unit & Integration Test Suite for:
 * Chat Input, Microphone Button, and Voice IPC Channels
 */

const assert = require('assert');

// 1. Mock DOM environment
class MockElement {
  constructor(tag, id = '') {
    this.tagName = tag.toUpperCase();
    this.id = id;
    this.value = '';
    this.children = [];
    this.style = {};
    this.innerHTML = '';
    this.textContent = '';
    this.scrollTop = 0;
    this.scrollHeight = 100;
    this.listeners = {};
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  querySelector(selector) {
    if (selector === 'span') {
      return this.children.find(c => c.tagName === 'SPAN') || this._createSpanFromHTML();
    }
    return null;
  }

  _createSpanFromHTML() {
    const span = new MockElement('span');
    span.textContent = '';
    this.children.push(span);
    return span;
  }

  addEventListener(event, handler) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(handler);
  }

  dispatchEvent(event, ...args) {
    if (this.listeners[event]) {
      this.listeners[event].forEach(fn => fn(...args));
    }
  }

  click() {
    this.dispatchEvent('click');
  }
}

const mockInput = new MockElement('input', 'chat-input');
const mockSendBtn = new MockElement('button', 'send-btn');
const mockMicBtn = new MockElement('button', 'mic-btn');
const mockContainer = new MockElement('div', 'chat-messages');

global.document = {
  getElementById: (id) => {
    if (id === 'chat-input' || id === 'messageInput') return mockInput;
    if (id === 'send-btn' || id === 'sendButton') return mockSendBtn;
    if (id === 'mic-btn' || id === 'micButton') return mockMicBtn;
    if (id === 'chat-messages' || id === 'chatMessages') return mockContainer;
    return null;
  },
  querySelector: (sel) => {
    if (sel === 'input[type="text"]') return mockInput;
    if (sel === '.send-button') return mockSendBtn;
    if (sel === '.mic-button') return mockMicBtn;
    if (sel === '.messages-container') return mockContainer;
    return null;
  },
  querySelectorAll: (sel) => {
    if (sel === 'button') return [mockMicBtn, mockSendBtn];
    return [];
  },
  createElement: (tag) => new MockElement(tag),
  readyState: 'complete'
};

// 2. Mock IPC renderer
const sentIPCMessages = [];
const ipcListeners = {};

global.window = {
  ipcRenderer: {
    send: (channel, ...args) => {
      sentIPCMessages.push({ channel, args });
    },
    on: (channel, handler) => {
      if (!ipcListeners[channel]) ipcListeners[channel] = [];
      ipcListeners[channel].push(handler);
    }
  }
};

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

async function testSuite() {
  console.log('\n========================================================');
  console.log('🧪 TESTING CHAT INPUT, MIC BUTTON & VOICE IPC CHANNELS');
  console.log('========================================================');

  // Load chat.js module
  const chatUI = require('../src/ui/chat');
  chatUI.setupChatListeners();

  // Test 1: Message Bubble Creation
  console.log('\n--- Suite 1: appendMessage DOM Bubble Styles ---');
  const userBubble = chatUI.appendMessage('You', 'Hello Vysper', true);
  runAssert(userBubble !== null, 'User bubble created');
  runAssert(userBubble.style.background === 'rgba(59, 130, 246, 0.2)', 'User bubble has blue styling');
  runAssert(userBubble.innerHTML.includes('Hello Vysper'), 'User message text rendered in bubble');
  runAssert(mockContainer.children.length === 1, 'Message appended to container');

  const aiBubble = chatUI.appendMessage('Gemini', 'Hello Human', false);
  runAssert(aiBubble.style.background === 'rgba(255, 255, 255, 0.08)' || aiBubble.style.background === 'rgba(255, 255, 255, 0.1)', 'AI bubble has neutral styling');

  // Test 2: Text Submission via Send Button
  console.log('\n--- Suite 2: Text Submit Handling ---');
  mockInput.value = 'Explain Dijkstra algorithm';
  mockSendBtn.click();

  runAssert(mockInput.value === '', 'Input field cleared on send');
  runAssert(sentIPCMessages.some(m => m.channel === 'user-chat-submit' && m.args[0] === 'Explain Dijkstra algorithm'), 'user-chat-submit emitted with text');

  // Test 3: Text Submission via Enter Key
  mockInput.value = 'Write quicksort in Python';
  mockInput.dispatchEvent('keydown', { key: 'Enter', preventDefault: () => {} });
  runAssert(mockInput.value === '', 'Input field cleared on Enter key');
  runAssert(sentIPCMessages.some(m => m.channel === 'user-chat-submit' && m.args[0] === 'Write quicksort in Python'), 'user-chat-submit emitted via Enter key');

  // Test 4: Microphone Button Click
  console.log('\n--- Suite 3: Microphone Toggle Trigger ---');
  mockMicBtn.click();
  runAssert(sentIPCMessages.some(m => m.channel === 'toggle-voice-recording'), 'toggle-voice-recording emitted on mic button click');

  // Test 5: Incoming Token Streaming
  console.log('\n--- Suite 4: Streaming AI Response Tokens ---');
  const streamListeners = ipcListeners['stream-chat-token'] || [];
  runAssert(streamListeners.length > 0, 'stream-chat-token listener registered');

  // Simulate streaming token 1
  streamListeners[0](null, 'def ');
  const hasToken = mockContainer.children.some(c => {
    const span = c.querySelector ? c.querySelector('span') : null;
    return (span && span.textContent.includes('def ')) || c.innerHTML.includes('def ');
  });
  runAssert(hasToken, 'First stream token created Gemini bubble');

  // Simulate streaming token 2
  streamListeners[0](null, 'quicksort():');
  const geminiMsg = mockContainer.children.find(c => c.innerHTML.includes('Gemini'));
  runAssert(geminiMsg !== undefined, 'Gemini message bubble found in container');

  // Test 6: Stream End
  const endListeners = ipcListeners['stream-chat-end'] || [];
  runAssert(endListeners.length > 0, 'stream-chat-end listener registered');
  endListeners[0]();

  // Test 7: Speech Status Update
  console.log('\n--- Suite 5: Speech Status Updates ---');
  const statusListeners = ipcListeners['speech-status-update'] || [];
  runAssert(statusListeners.length > 0, 'speech-status-update listener registered');
  statusListeners[0](null, 'Listening for voice...');
  const systemMsg = mockContainer.children.find(c => c.innerHTML.includes('System'));
  runAssert(systemMsg !== undefined, 'System status update bubble rendered');

  // Test 8: LLM Service streamAnswerFromText Verification
  console.log('\n--- Suite 6: LLMService.streamAnswerFromText Implementation ---');
  const llmService = require('../src/services/llm.service');
  runAssert(typeof llmService.streamAnswerFromText === 'function', 'streamAnswerFromText generator function exists on llmService');

  // Mock generator execution
  const streamIter = llmService.streamAnswerFromText('test query', 'dsa');
  runAssert(typeof streamIter[Symbol.asyncIterator] === 'function', 'streamAnswerFromText returns an AsyncIterable');

  // Summary
  console.log('\n========================================================');
  console.log(`RESULTS: ${passedTests}/${totalTests} tests passed (${Math.round((passedTests/totalTests)*100)}%)`);
  console.log('========================================================\n');

  if (passedTests === totalTests) {
    console.log('🎉 ALL CHAT & VOICE IPC TESTS PASSED!');
    process.exit(0);
  } else {
    console.error('❌ SOME TESTS FAILED.');
    process.exit(1);
  }
}

testSuite().catch(e => {
  console.error('Test suite failed:', e);
  process.exit(1);
});
