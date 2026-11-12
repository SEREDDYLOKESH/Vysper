let electron = {};
try { electron = require('electron'); } catch (_) {}
const { ipcMain, globalShortcut } = electron;
const llmService = require('./services/llm.service');
const config = require('./core/config');

function getWindow(windowManager, names) {
  if (!windowManager) return null;
  for (const name of names) {
    try {
      const win = windowManager.getWindow ? windowManager.getWindow(name) : null;
      if (win && !win.isDestroyed()) return win;
    } catch (_) {}
  }
  return null;
}

function send(win, channel, payload) {
  try {
    if (win && !win.isDestroyed() && win.webContents) win.webContents.send(channel, payload);
  } catch (_) {}
}

function createDispatcher({ appController, windowManager, ocrService } = {}) {
  const screenshotBuffer = [];

  function getMainWindow() {
    return getWindow(windowManager, ['llmResponse', 'main']);
  }
  function getChatWindow() {
    return getWindow(windowManager, ['chat']);
  }
  function getSkill(fallback = 'General') {
    return (appController && (appController.activeSkill || appController.getActiveSkill?.())) || config.get('activeSkill') || fallback;
  }

  // Unified synchronized broadcast: clear both, then stream to BOTH in real time
  async function broadcastLLMStream(promptPayload, activeSkill) {
    const mainWindow = getMainWindow();
    const chatWindow = getChatWindow();
    const skill = activeSkill || getSkill('General');

    if (mainWindow && windowManager?.showOnCurrentDesktop) {
      try { windowManager.showOnCurrentDesktop(mainWindow); } catch (_) {}
    }

    send(mainWindow, 'clear-response-panel');
    send(chatWindow, 'clear-response-panel');

    try {
      const stream = await llmService.generateStream(promptPayload, skill);
      for await (const chunk of stream) {
        const token = typeof chunk?.text === 'function' ? chunk.text() : (chunk?.text || chunk || '');
        if (!token) continue;
        send(mainWindow, 'stream-llm-token', token);
        send(chatWindow, 'stream-chat-token', token);
      }
      send(chatWindow, 'stream-chat-end');
    } catch (err) {
      const errorMsg = `\n\n⚠️ Error: ${err?.message || err}`;
      send(mainWindow, 'stream-llm-token', errorMsg);
      send(chatWindow, 'stream-chat-token', errorMsg);
      send(chatWindow, 'stream-chat-end');
      send(chatWindow, 'speech-status-update', `Error: ${err?.message || err}`);
    }
  }

  async function triggerScreenshotAnalysis(incomingBuffers) {
    if (Array.isArray(incomingBuffers) && incomingBuffers.length) {
      screenshotBuffer.splice(0, screenshotBuffer.length, ...incomingBuffers);
    } else if (screenshotBuffer.length === 0 && ocrService?.getScreenshotBuffer) {
      try {
        const items = ocrService.getScreenshotBuffer() || [];
        if (items.length) {
          screenshotBuffer.push(...items.map((i) => i.image || i.buffer || i.base64 || i.rawBase64 || i));
          if (ocrService.clearScreenshotBuffer) ocrService.clearScreenshotBuffer();
        }
      } catch (_) {}
    }
    if (!screenshotBuffer.length) return;
    const buffers = screenshotBuffer.splice(0, screenshotBuffer.length);
    await broadcastLLMStream({ imageBuffers: buffers, text: '' }, getSkill('DSA'));
  }

  function clearScreenshotQueue() {
    screenshotBuffer.splice(0, screenshotBuffer.length);
    try { if (ocrService?.clearScreenshotBuffer) ocrService.clearScreenshotBuffer(); } catch (_) {}
  }

  function appendScreenshot(buffer) {
    if (buffer) screenshotBuffer.push(buffer);
  }

  return { broadcastLLMStream, triggerScreenshotAnalysis, appendScreenshot, clearScreenshotQueue, screenshotBuffer };
}

function setupUnifiedIPC(ctx = {}) {
  if (!ipcMain || typeof ipcMain.on !== 'function') return null;
  const dispatcher = ctx.dispatcher || createDispatcher(ctx);
  const { windowManager } = ctx;

  const channels = [
    'user-chat-submit',
    'toggle-voice-recording',
    'process-pcm-audio-submit',
    'speech-final-transcript',
    'process-screenshot-submit',
    'add-screenshot-buffer',
  ];
  channels.forEach((ch) => { try { ipcMain.removeAllListeners(ch); } catch (_) {} });

  // Text input
  ipcMain.on('user-chat-submit', (event, text) => {
    return dispatcher.broadcastLLMStream(String(text || ''), dispatcher && null);
  });

  // Voice PCM buffer (single-pass multimodal)
  ipcMain.on('process-pcm-audio-submit', (event, pcmBuffer, skill) => {
    return dispatcher.broadcastLLMStream(pcmBuffer, skill);
  });

  // Mic toggle (UI/hotkey -> chat renderer capture)
  ipcMain.on('toggle-voice-recording', () => {
    const chatWindow = getWindow(windowManager, ['chat']);
    send(chatWindow, 'trigger-mic-toggle');
  });

  // Screenshot buffer/analyze
  ipcMain.on('add-screenshot-buffer', (event, buffer) => dispatcher.appendScreenshot(buffer));
  ipcMain.on('process-screenshot-submit', (event, buffers) => dispatcher.triggerScreenshotAnalysis(buffers));

  // Legacy transcript path: broadcast as text query
  ipcMain.on('speech-final-transcript', async (event, transcriptText) => {
    const text = typeof transcriptText === 'string' ? transcriptText : transcriptText?.text;
    if (!text) return;
    const chatWindow = getWindow(windowManager, ['chat']);
    send(chatWindow, 'add-chat-message', { sender: 'Interviewer', text });
    await dispatcher.broadcastLLMStream(text);
  });

  // Status forwarding
  if (!ipcMain.eventNames?.().includes?.('speech-status-update')) {
    ipcMain.on('speech-status-update', (event, status) => {
      const chatWindow = getWindow(windowManager, ['chat']);
      send(chatWindow, 'speech-status-update', status);
    });
  }

  return dispatcher;
}

function registerGlobalHotkeys(ctx = {}) {
  if (!globalShortcut || typeof globalShortcut.register !== 'function') return false;
  const { windowManager, appController, ocrService, dispatcher } = ctx;
  const dispatch = dispatcher || createDispatcher(ctx);

  const toggleWindow = (name) => {
    const win = getWindow(windowManager, [name, name === 'main' ? 'llmResponse' : name]);
    if (!win) return;
    if (win.isVisible()) win.hide();
    else {
      if (windowManager?.showOnCurrentDesktop) windowManager.showOnCurrentDesktop(win);
      else win.show();
    }
  };

  const toggleMainOverlay = () => {
    ['main', 'llmResponse'].forEach((name) => {
      const win = getWindow(windowManager, [name]);
      if (!win) return;
      // If any target is visible, hide all; else show all
    });
    const wins = ['main', 'llmResponse'].map((n) => getWindow(windowManager, [n])).filter(Boolean);
    if (!wins.length) return;
    const anyVisible = wins.some((w) => w.isVisible());
    wins.forEach((w) => { if (anyVisible) w.hide(); else (windowManager?.showOnCurrentDesktop ? windowManager.showOnCurrentDesktop(w) : w.show()); });
  };

  const bindings = {
    'CommandOrControl+Shift+H': () => toggleMainOverlay(),         // entire main overlay (header + response)
    'CommandOrControl+Shift+C': () => toggleWindow('chat'),        // side chat
    'CommandOrControl+Shift+S': async () => {
      // Capture and queue screenshot only (no auto-submit)
      try {
        if (appController?.handleScreenshotCapture) {
          await appController.handleScreenshotCapture();
        } else if (ocrService?.captureAndBufferScreenshot) {
          await ocrService.captureAndBufferScreenshot();
        } else if (ocrService?.captureScreenshotBuffer) {
          const buffer = await ocrService.captureScreenshotBuffer();
          if (buffer) dispatch.appendScreenshot(buffer);
        }
      } catch (e) {
        console.error('[Hotkey Ctrl+Shift+S] screenshot queue failed:', e);
      }
    },
    'CommandOrControl+Enter': async () => {
      try {
        if (appController?.submitScreenshotBuffer) await appController.submitScreenshotBuffer();
        else await dispatch.triggerScreenshotAnalysis();
      } catch (e) {
        console.error('[Hotkey Ctrl+Enter] screenshot submit failed:', e);
      }
    },
    'CommandOrControl+Shift+Enter': async () => {
      try {
        if (appController?.submitScreenshotBuffer) await appController.submitScreenshotBuffer();
        else await dispatch.triggerScreenshotAnalysis();
      } catch (e) {
        console.error('[Hotkey Ctrl+Shift+Enter] screenshot submit failed:', e);
      }
    },
    'CommandOrControl+Shift+Backspace': () => {
      try {
        if (appController?.clearScreenshotQueue) appController.clearScreenshotQueue('shortcut');
        else dispatch.clearScreenshotQueue?.();
      } catch (e) {
        console.error('[Hotkey Ctrl+Shift+Backspace] clear screenshot queue failed:', e);
      }
    },
    'Alt+R': () => {
      // Toggle live voice recording state
      try {
        if (appController?.toggleSpeechRecognition) appController.toggleSpeechRecognition();
        else {
          const chatWindow = getWindow(windowManager, ['chat']);
          send(chatWindow, 'trigger-mic-toggle');
        }
      } catch (e) {
        console.error('[Hotkey Alt+R] toggle recording failed:', e);
      }
    },
  };

  let ok = true;
  for (const [accel, handler] of Object.entries(bindings)) {
    try {
      // Re-register to match spec
      try { globalShortcut.unregister(accel); } catch (_) {}
      if (!globalShortcut.register(accel, handler)) ok = false;
    } catch (_) {
      ok = false;
    }
  }
  return ok;
}

module.exports = { createDispatcher, setupUnifiedIPC, registerGlobalHotkeys, broadcastLLMStream: null };
// Back-compat if required directly
module.exports.broadcastLLMStream = async function (...args) {
  // Minimal fallback; real usage should pass context
  const dispatcher = createDispatcher({});
  return dispatcher.broadcastLLMStream(...args);
};
