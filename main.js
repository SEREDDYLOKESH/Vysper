require("dotenv").config();

const { app, BrowserWindow, globalShortcut, session, ipcMain } = require("electron");

// Enable audio capture & speech APIs in Chromium
if (app && app.commandLine) {
  app.commandLine.appendSwitch("use-fake-ui-for-media-stream");
  app.commandLine.appendSwitch("enable-speech-dispatcher");
}

const logger = require("./src/core/logger").createServiceLogger("MAIN");
const config = require("./src/core/config");

// Services
const ocrService = require("./src/services/ocr.service");
const speechService = require("./src/services/speech.service");
const llmService = require("./src/services/llm.service");
const DiagnosticsService = require("./src/services/diagnostics.service");

// Managers
const windowManager = require("./src/managers/window.manager");
const sessionManager = require("./src/managers/session.manager");

class ApplicationController {
  constructor() {
    this.isReady = false;
    this.activeSkill = config.get("activeSkill") || "dsa";
    this.codingLanguage = config.get("codingLanguage") || "javascript";

    // Window configurations for reference
    this.windowConfigs = {
      main: { title: "Vysper" },
      chat: { title: "Chat" },
      llmResponse: { title: "AI Response" },
      settings: { title: "Settings" },
    };

    this.setupStealth();
    this.setupEventHandlers();
  }

  setupStealth() {
    if (config.get("stealth.disguiseProcess")) {
      process.title = config.get("app.processTitle");
    }

    // Set default stealth app name early
    if (app && typeof app.setName === 'function') {
      app.setName("Terminal "); // Default to Terminal stealth mode
    }
    process.title = "Terminal ";

    if (
      process.platform === "darwin" &&
      config.get("stealth.noAttachConsole")
    ) {
      process.env.ELECTRON_NO_ATTACH_CONSOLE = "1";
      process.env.ELECTRON_NO_ASAR = "1";
    }
  }

  setupEventHandlers() {
    if (app && typeof app.whenReady === 'function') {
      app.whenReady().then(() => this.onAppReady());
      app.on("window-all-closed", () => this.onWindowAllClosed());
      app.on("activate", () => this.onActivate());
      app.on("will-quit", () => this.onWillQuit());
    }

    this.setupIPCHandlers();
    this.setupServiceEventHandlers();
  }

  async onAppReady() {
    // Force stealth mode IMMEDIATELY when app is ready
    app.setName("Terminal ");
    process.title = "Terminal ";

    logger.info("Application starting", {
      version: config.get("app.version"),
      environment: config.get("app.isDevelopment")
        ? "development"
        : "production",
      platform: process.platform,
    });

    try {
      this.setupPermissions();

      // Small delay to ensure desktop/space detection is accurate
      await new Promise((resolve) => setTimeout(resolve, 200));

      await windowManager.initializeWindows();
      this.setupGlobalShortcuts();

      // Initialize default stealth mode with terminal icon
      this.updateAppIcon("terminal");

      this.isReady = true;

      logger.info("Application initialized successfully", {
        windowCount: Object.keys(windowManager.getWindowStats().windows).length,
        currentDesktop: "detected",
      });

      sessionManager.addEvent("Application started");

      // Automated Startup Self-Check: Run diagnostics once windows are ready
      setTimeout(() => {
        this.runSystemDiagnostics();
      }, 1500);

      const chatWin = windowManager.getWindow('chat');
      if (chatWin && !chatWin.isDestroyed() && chatWin.webContents) {
        chatWin.webContents.once('did-finish-load', () => {
          setTimeout(() => {
            this.runSystemDiagnostics();
          }, 300);
        });
      }
    } catch (error) {
      logger.error("Application initialization failed", {
        error: error.message,
      });
      app.quit();
    }
  }

  setupPermissions() {
    const allowedPermissions = [
      "microphone",
      "camera",
      "display-capture",
      "media",
      "audio-capture",
      "screen-capture",
    ];

    session.defaultSession.setPermissionRequestHandler(
      (webContents, permission, callback) => {
        const granted = allowedPermissions.includes(permission);
        logger.debug("Permission request", { permission, granted });
        callback(granted);
      }
    );

    session.defaultSession.setPermissionCheckHandler(
      (webContents, permission) => {
        return allowedPermissions.includes(permission);
      }
    );
  }

  setupGlobalShortcuts() {
    const toggleWindowByName = (name) => {
      const win = windowManager.getWindow(name);
      if (!win || win.isDestroyed()) return;
      if (win.isVisible()) {
        win.hide();
      } else if (typeof windowManager.showOnCurrentDesktop === 'function') {
        windowManager.showOnCurrentDesktop(win);
      } else {
        win.show();
      }
    };

    const toggleMainOverlayWindows = () => {
      // Hide/show the entire main overlay UI (top header toolbar + response box)
      const names = ['main', 'llmResponse'];
      const wins = names.map((n) => windowManager.getWindow(n)).filter((w) => w && !w.isDestroyed());
      if (!wins.length) return;
      const anyVisible = wins.some((w) => w.isVisible());
      wins.forEach((w) => {
        if (anyVisible) {
          w.hide();
        } else if (typeof windowManager.showOnCurrentDesktop === 'function') {
          windowManager.showOnCurrentDesktop(w);
        } else {
          w.show();
        }
      });
    };

    const shortcuts = {
      // Spec-required/global hotkeys
      "CommandOrControl+Shift+H": () => toggleMainOverlayWindows(),        // Toggle entire main overlay (header + response)
      "CommandOrControl+Shift+C": () => toggleWindowByName('chat'),        // Toggle side chat window visibility
      "CommandOrControl+Shift+S": async () => {                            // Capture screenshot and queue it (no auto-submit)
        try {
          await this.handleScreenshotCapture();
        } catch (error) {
          logger.error('Screenshot capture (queue) shortcut failed', { error: error.message });
        }
      },
      "Alt+R": () => this.toggleSpeechRecognition(),                       // Toggle live voice recording state
      "CommandOrControl+Shift+X": () => this.clearConversationHistory('shortcut'), // Clear follow-up context / new topic

      // Screenshot queue submit/clear
      "CommandOrControl+Enter": () => this.submitScreenshotBuffer(),       // Submit all queued screenshots
      "CommandOrControl+Shift+Enter": () => this.submitScreenshotBuffer(),
      "CommandOrControl+Shift+Return": () => this.submitScreenshotBuffer(),
      "CommandOrControl+Shift+Backspace": () => this.clearScreenshotQueue('shortcut'), // Discard queued screenshots only

      // Additional app shortcuts (preserved, non-conflicting)
      "CommandOrControl+Shift+V": () => this.toggleOverlayWindows(),
      "CommandOrControl+Shift+I": () => windowManager.toggleInteraction(),
      "CommandOrControl+Shift+D": () => this.runSystemDiagnostics(),
      "CommandOrControl+Shift+\\": () => this.clearScreenshotBufferAndSession(),
      "CommandOrControl+,": () => windowManager.showSettings(),
      "Alt+A": () => windowManager.toggleInteraction(),
      "CommandOrControl+Shift+T": () => windowManager.forceAlwaysOnTopForAllWindows(),
      "CommandOrControl+Shift+Alt+T": () => {
        const results = windowManager.testAlwaysOnTopForAllWindows();
        logger.info('Always-on-top test triggered via shortcut', results);
      },
      "CommandOrControl+Up": () => this.handleUpArrow(),
      "CommandOrControl+Down": () => this.handleDownArrow(),
      "CommandOrControl+Left": () => this.handleLeftArrow(),
      "CommandOrControl+Right": () => this.handleRightArrow(),
    };

    Object.entries(shortcuts).forEach(([accelerator, handler]) => {
      try { globalShortcut.unregister(accelerator); } catch (_) {}
      const success = globalShortcut.register(accelerator, handler);
      if (success) {
        logger.debug("Global shortcut registered", { accelerator, success });
      } else {
        logger.warn("Failed to register global shortcut", { accelerator });
      }
    });
  }

  setupServiceEventHandlers() {
    speechService.on("recording-started", () => {
      BrowserWindow.getAllWindows().forEach((window) => {
        window.webContents.send("recording-started");
      });
    });

    speechService.on("recording-stopped", () => {
      BrowserWindow.getAllWindows().forEach((window) => {
        window.webContents.send("recording-stopped");
      });
    });

    speechService.on("transcription", (text, targetSkill = null) => {      
      // Add transcription to session memory
      sessionManager.addUserInput(text, 'speech');
      
      const windows = BrowserWindow.getAllWindows();
      
      windows.forEach((window) => {
        window.webContents.send("transcription-received", { text });
      });
      
      // Automatically process transcription with LLM for intelligent response immediately
      setTimeout(async () => {
        try {
          const sessionHistory = sessionManager.getOptimizedHistory();
          await this.processTranscriptionWithLLM(text, sessionHistory, targetSkill);
        } catch (error) {
          logger.error("Failed to process transcription with LLM", {
            error: error.message,
            text: text.substring(0, 100)
          });
        }
      }, 50);
    });

    speechService.on("interim-transcription", (text) => {
      BrowserWindow.getAllWindows().forEach((window) => {
        window.webContents.send("interim-transcription", { text });
      });
    });

    speechService.on("status", (status) => {
      BrowserWindow.getAllWindows().forEach((window) => {
        window.webContents.send("speech-status", { status });
      });
    });

    speechService.on("error", (error) => {
      BrowserWindow.getAllWindows().forEach((window) => {
        window.webContents.send("speech-error", { error });
      });
    });

    speechService.on("audio-chunk-for-answer", async ({ audioBase64, mimeType, activeSkill }) => {
      try {
        await this.processAudioWithLLM(audioBase64, mimeType, activeSkill);
      } catch (error) {
        logger.error("Failed to process audio chunk with LLM", {
          error: error.message
        });
      }
    });
  }

  setupIPCHandlers() {
    if (!ipcMain || typeof ipcMain.handle !== 'function') {
      return;
    }
    const safeHandle = (channel, handler) => {
      try {
        ipcMain.removeHandler(channel);
      } catch (e) {}
      ipcMain.handle(channel, handler);
    };

    safeHandle("take-screenshot", () => this.handleScreenshotCapture());
    safeHandle("submit-screenshot-buffer", () => this.submitScreenshotBuffer());
    safeHandle("clear-screenshot-buffer", () => {
      const count = ocrService.clearScreenshotBuffer();
      windowManager.broadcastToAllWindows("screenshot-buffer-cleared", { count });
      windowManager.broadcastToAllWindows("screenshot-queue-updated", { count: 0, message: "📸 Screenshots Queued: 0" });
      return { count, success: true };
    });
    safeHandle("get-screenshot-buffer-count", () => {
      return { count: ocrService.getBufferCount() };
    });

    safeHandle("start-speech-recognition", () => {
      speechService.startRecording();
      return speechService.getStatus();
    });

    safeHandle("stop-speech-recognition", () => {
      speechService.stopRecording();
      return speechService.getStatus();
    });

    // Also handle direct send events for fallback
    ipcMain.on("start-speech-recognition", () => {
      speechService.startRecording();
    });

    ipcMain.on("stop-speech-recognition", () => {
      speechService.stopRecording();
    });

    safeHandle("trigger-llm-response", async (event, { transcriptText, activeSkill }) => {
      try {
        if (!transcriptText || transcriptText.trim().length === 0) return { error: "Empty text" };
        const cleanText = transcriptText.trim();
        const targetSkill = activeSkill || this.activeSkill;
        sessionManager.addUserInput(cleanText, 'speech');
        windowManager.broadcastToAllWindows("transcription-received", { text: cleanText });

        const sessionHistory = sessionManager.getOptimizedHistory();
        await this.processTranscriptionWithLLM(cleanText, sessionHistory, targetSkill);
        return { success: true };
      } catch (error) {
        logger.error("Error handling trigger-llm-response IPC", { error: error.message });
        return { error: error.message };
      }
    });

    ipcMain.on('speech-final-transcript', async (event, transcriptText) => {
      console.log('Received voice transcript:', transcriptText);

      const chatWindow = windowManager.getWindow('chat');
      const llmWindow = windowManager.getWindow('llmResponse');
      const mainWindow = llmWindow || windowManager.getWindow('main');
      const currentActiveSkill = this.activeSkill || 'dsa';

      // 1. Send user transcript to chat window UI
      if (chatWindow && !chatWindow.isDestroyed() && chatWindow.webContents) {
        chatWindow.webContents.send('add-chat-message', { sender: 'Interviewer', text: transcriptText });
      }

      // Add user transcript to session memory and broadcast
      sessionManager.addUserInput(transcriptText, 'speech');
      windowManager.broadcastToAllWindows('transcription-received', { text: transcriptText });

      // Show LLM loading indicator on overlay
      windowManager.showLLMLoading();

      // 2. Pass transcript to LLM service to generate an answer with real-time streaming
      try {
        let accumulatedResponse = '';
        const response = await llmService.generateResponseText(
          transcriptText,
          currentActiveSkill,
          (chunk, isFirst, fullText) => {
            accumulatedResponse = fullText;
            windowManager.streamLLMChunk(chunk, isFirst, fullText, { skill: currentActiveSkill });
            if (chatWindow && !chatWindow.isDestroyed() && chatWindow.webContents) {
              chatWindow.webContents.send('llm-stream-chunk', {
                chunk,
                isFirst,
                fullText,
                metadata: { skill: currentActiveSkill }
              });
            }
          }
        );

        const responseText = typeof response === 'string' ? response : (response?.response || response?.content || accumulatedResponse || '');

        // 3. Display answer on main response overlay window
        if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
          mainWindow.webContents.send('display-llm-response', responseText);
        }

        if (llmWindow && !llmWindow.isDestroyed() && llmWindow !== mainWindow && llmWindow.webContents) {
          llmWindow.webContents.send('display-llm-response', responseText);
        }

        windowManager.showLLMResponse(responseText, { skill: currentActiveSkill });

        this.broadcastTranscriptionLLMResponse({
          response: responseText,
          metadata: { skill: currentActiveSkill }
        });

        sessionManager.addModelResponse(responseText, {
          skill: currentActiveSkill,
          isTranscriptionResponse: true
        });
      } catch (err) {
        console.error('Failed to generate answer from speech transcript:', err);
      }
    });

    // Remove existing duplicate listeners before binding
    ipcMain.removeAllListeners('user-chat-submit');
    ipcMain.removeAllListeners('toggle-voice-recording');
    ipcMain.removeAllListeners('process-pcm-audio-submit');

    // Handler for Text Chat Queries
    ipcMain.on('user-chat-submit', async (event, userText) => {
      console.log('[Main IPC] User chat submitted:', userText);

      const mainWindow = windowManager.getWindow('llmResponse') || windowManager.getWindow('main');
      const chatWindow = windowManager.getWindow('chat');
      const currentSkill = this.activeSkill || 'General';

      // Clear main overlay prior to new response
      if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
        mainWindow.webContents.send('clear-response-panel');
      }

      try {
        const stream = await llmService.streamAnswerFromText(userText, currentSkill);

        for await (const chunk of stream) {
          const token = typeof chunk.text === 'function' ? chunk.text() : (chunk.text || chunk);
          
          // Broadcast token to both Main Overlay and Chat Panel
          if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
            mainWindow.webContents.send('stream-llm-token', token);
          }
          if (chatWindow && !chatWindow.isDestroyed() && chatWindow.webContents) {
            chatWindow.webContents.send('stream-chat-token', token);
          }
        }

        if (chatWindow && !chatWindow.isDestroyed() && chatWindow.webContents) {
          chatWindow.webContents.send('stream-chat-end');
        }
      } catch (err) {
        console.error('[Main IPC Error]:', err);
        if (chatWindow && !chatWindow.isDestroyed() && chatWindow.webContents) {
          chatWindow.webContents.send('speech-status-update', `Error: ${err.message}`);
        }
      }
    });

    // Handle Voice Recording Toggle (single stateful path)
    ipcMain.on('toggle-voice-recording', () => {
      this.toggleSpeechRecognition();
    });

    ipcMain.on('audio-pcm-chunk', (event, chunkBuffer) => {
      speechService.emit('audio-pcm-chunk', chunkBuffer);
    });

    // Serialize PCM answer generation to avoid colliding streams (continuous listening may queue utterances)
    this._pcmGenerationQueue = Promise.resolve();
    this._isGeneratingPcmAnswer = false;
    const enqueuePcmGeneration = (fullPCMBuffer, skill) => {
      this._pcmGenerationQueue = this._pcmGenerationQueue.then(async () => {
        this._isGeneratingPcmAnswer = true;
        const chatWindow = windowManager.getWindow('chat');
        const llmWindow = windowManager.getWindow('llmResponse');
        const mainWindow = llmWindow || windowManager.getWindow('main');
        const effectiveSkill = skill || this.activeSkill || 'dsa';

        logger.info('Processing 16kHz PCM audio stream directly with Gemini', {
          skill: effectiveSkill,
          byteLength: fullPCMBuffer ? (fullPCMBuffer.length || fullPCMBuffer.byteLength || 0) : 0
        });

        let ignoredAsNonQuestion = false;
        try {
          // Prepare for possible new question, but defer clearing/updating the MAIN overlay until
          // we confirm the audio is not a brief acknowledgment/non-question ([NO_QUESTION]).
          if (chatWindow && !chatWindow.isDestroyed() && chatWindow.webContents) {
            chatWindow.webContents.send('speech-status-update', 'Transcribing & Generating Answer...');
          }
          windowManager.broadcastToAllWindows('speech-status', { status: 'Generating streaming AI answer...' });

          let accumulatedResponse = '';
          let prefixBuffer = '';
          let isFirst = true;
          let committedVisibleAnswer = false;
          const NO_QUESTION_TOKEN = '[NO_QUESTION]';

          const commitVisibleAnswerStart = () => {
            if (committedVisibleAnswer) return;
            committedVisibleAnswer = true;

            // New valid question: clear main overlay (latest answer only) and prepare chat stream state.
            // Chat window keeps permanent append-only history; clear-response-panel only resets active card.
            if (chatWindow && !chatWindow.isDestroyed() && chatWindow.webContents) {
              chatWindow.webContents.send('clear-response-panel');
            }
            if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
              mainWindow.webContents.send('clear-response-panel');
            }
            if (llmWindow && !llmWindow.isDestroyed() && llmWindow !== mainWindow && llmWindow.webContents) {
              llmWindow.webContents.send('clear-response-panel');
            }

            windowManager.showLLMLoading();

            if (!prefixBuffer) return;
            accumulatedResponse += prefixBuffer;

            if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
              mainWindow.webContents.send('stream-llm-token', prefixBuffer);
            }
            if (llmWindow && !llmWindow.isDestroyed() && llmWindow !== mainWindow && llmWindow.webContents) {
              llmWindow.webContents.send('stream-llm-token', prefixBuffer);
            }
            if (chatWindow && !chatWindow.isDestroyed() && chatWindow.webContents) {
              chatWindow.webContents.send('stream-chat-token', prefixBuffer);
            }

            windowManager.streamLLMChunk(prefixBuffer, isFirst, accumulatedResponse, { skill: effectiveSkill });
            if (chatWindow && !chatWindow.isDestroyed() && chatWindow.webContents) {
              chatWindow.webContents.send('llm-stream-chunk', {
                chunk: prefixBuffer,
                isFirst,
                fullText: accumulatedResponse,
                metadata: { skill: effectiveSkill }
              });
            }
            isFirst = false;
            prefixBuffer = '';
          };

          const responseText = await llmService.streamAnswerFromAudioPCM(
            fullPCMBuffer,
            effectiveSkill,
            (token) => {
              if (!token || ignoredAsNonQuestion) return;

              if (!committedVisibleAnswer) {
                prefixBuffer += token;
                const trimmedPrefix = prefixBuffer.replace(/^\s+/, '');
                if (trimmedPrefix.startsWith(NO_QUESTION_TOKEN)) {
                  ignoredAsNonQuestion = true;
                  logger.info('Ignored non-question audio response ([NO_QUESTION]); preserving current main overlay answer');
                  // Abort clearing/updating the main overlay; discard pending chat answer card
                  if (chatWindow && !chatWindow.isDestroyed() && chatWindow.webContents) {
                    chatWindow.webContents.send('discard-active-chat-card', { reason: 'no-question' });
                    chatWindow.webContents.send('speech-status-update', 'Ignored non-question audio. Listening for next question...');
                  }
                  windowManager.broadcastToAllWindows('speech-status', { status: 'Listening for next question...' });
                  return;
                }
                // Wait for enough chars to confidently distinguish, or commit once clearly not a match
                if (trimmedPrefix.length >= NO_QUESTION_TOKEN.length || !NO_QUESTION_TOKEN.startsWith(trimmedPrefix)) {
                  commitVisibleAnswerStart();
                }
                return;
              }

              accumulatedResponse += token;

              if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
                mainWindow.webContents.send('stream-llm-token', token);
              }
              if (llmWindow && !llmWindow.isDestroyed() && llmWindow !== mainWindow && llmWindow.webContents) {
                llmWindow.webContents.send('stream-llm-token', token);
              }
              if (chatWindow && !chatWindow.isDestroyed() && chatWindow.webContents) {
                chatWindow.webContents.send('stream-chat-token', token);
              }

              windowManager.streamLLMChunk(token, isFirst, accumulatedResponse, { skill: effectiveSkill });
              if (chatWindow && !chatWindow.isDestroyed() && chatWindow.webContents) {
                chatWindow.webContents.send('llm-stream-chunk', {
                  chunk: token,
                  isFirst,
                  fullText: accumulatedResponse,
                  metadata: { skill: effectiveSkill }
                });
              }
              isFirst = false;
            }
          );

          const finalResponse = responseText || accumulatedResponse;

          if (ignoredAsNonQuestion || finalResponse.trim().startsWith(NO_QUESTION_TOKEN)) {
            if (!ignoredAsNonQuestion && chatWindow && !chatWindow.isDestroyed() && chatWindow.webContents) {
              chatWindow.webContents.send('discard-active-chat-card', { reason: 'no-question' });
            }
            windowManager.broadcastToAllWindows('speech-status', { status: 'Listening for next question...' });
            if (chatWindow && !chatWindow.isDestroyed() && chatWindow.webContents) {
              chatWindow.webContents.send('speech-status-update', 'Ignored non-question audio. Listening for next question...');
            }
            return;
          }

          // If stream ended before prefix threshold but it's a valid short answer, commit buffered content now
          if (!committedVisibleAnswer && prefixBuffer) {
            commitVisibleAnswerStart();
          }

          const finalVisibleResponse = finalResponse || accumulatedResponse;

          if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
            mainWindow.webContents.send('display-llm-response', finalVisibleResponse);
          }
          if (llmWindow && !llmWindow.isDestroyed() && llmWindow !== mainWindow && llmWindow.webContents) {
            llmWindow.webContents.send('display-llm-response', finalVisibleResponse);
          }

          windowManager.showLLMResponse(finalVisibleResponse, { skill: effectiveSkill });
          sessionManager.addModelResponse(finalVisibleResponse, { skill: effectiveSkill, isAudioResponse: true });
          this.broadcastTranscriptionLLMResponse({
            response: finalVisibleResponse,
            metadata: { skill: effectiveSkill, isAudioResponse: true }
          });

          windowManager.broadcastToAllWindows('speech-status', { status: 'Listening for next question...' });
          if (chatWindow && !chatWindow.isDestroyed() && chatWindow.webContents) {
            chatWindow.webContents.send('speech-status-update', 'Answer generated. Listening for next question...');
          }
        } catch (err) {
          console.error('Gemini PCM Processing Error:', err);
          logger.error('Gemini PCM Processing Error:', { error: err.message });
          if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
            mainWindow.webContents.send('display-llm-response', `⚠️ Response Error: ${err.message}`);
          }
          if (chatWindow && !chatWindow.isDestroyed() && chatWindow.webContents) {
            chatWindow.webContents.send('speech-status-update', `Error: ${err.message}`);
            chatWindow.webContents.send('add-chat-message', {
              sender: 'System',
              text: `⚠️ Response Error: ${err.message}`
            });
          }
          windowManager.broadcastToAllWindows('speech-status', { status: 'Error: ' + err.message });
        } finally {
          // Always signal end-of-generation so renderer can release guard and flush any queued follow-up
          if (chatWindow && !chatWindow.isDestroyed() && chatWindow.webContents) {
            chatWindow.webContents.send('stream-chat-end');
          }
          this._isGeneratingPcmAnswer = false;
        }
      }).catch((e) => {
        console.error('[PCM Queue] Unexpected queue error:', e);
        this._isGeneratingPcmAnswer = false;
      });
      return this._pcmGenerationQueue;
    };

    ipcMain.on('process-pcm-audio-submit', (event, fullPCMBuffer, skill) => {
      enqueuePcmGeneration(fullPCMBuffer, skill);
    });

    ipcMain.on('speech-status-update', (event, status) => {
      const chatWindow = windowManager.getWindow('chat');
      if (chatWindow && !chatWindow.isDestroyed() && chatWindow.webContents) {
        chatWindow.webContents.send('speech-status-update', status);
      }
    });

    ipcMain.on('run-system-diagnostics', async (event) => {
      const report = await this.runSystemDiagnostics();
      if (event && event.reply && report) {
        event.reply('diagnostics-report', report);
      }
    });

    const clearHistoryIpc = () => this.clearConversationHistory('ipc');
    ipcMain.removeAllListeners('clear-conversation-history');
    ipcMain.on('clear-conversation-history', clearHistoryIpc);
    safeHandle('clear-conversation-history', async () => this.clearConversationHistory('invoke'));

    ipcMain.on("chat-window-ready", () => {
      // Send a test message to confirm communication
      setTimeout(() => {
        windowManager.broadcastToAllWindows("transcription-received", {
          text: "Test message from main process - chat window communication is working!",
        });
      }, 1000);
    });

    ipcMain.on("test-chat-window", () => {
      windowManager.broadcastToAllWindows("transcription-received", {
        text: "🧪 IMMEDIATE TEST: Chat window IPC communication test successful!",
      });
    });

    ipcMain.handle("show-all-windows", () => {
      windowManager.showAllWindows();
      return windowManager.getWindowStats();
    });

    ipcMain.handle("hide-all-windows", () => {
      windowManager.hideAllWindows();
      return windowManager.getWindowStats();
    });

    ipcMain.handle("enable-window-interaction", () => {
      windowManager.setInteractive(true);
      return windowManager.getWindowStats();
    });

    ipcMain.handle("disable-window-interaction", () => {
      windowManager.setInteractive(false);
      return windowManager.getWindowStats();
    });

    ipcMain.handle("switch-to-chat", () => {
      windowManager.switchToWindow("chat");
      return windowManager.getWindowStats();
    });

    ipcMain.handle("switch-to-skills", () => {
      windowManager.switchToWindow("skills");
      return windowManager.getWindowStats();
    });

    ipcMain.handle("resize-window", (event, { width, height }) => {
      const mainWindow = windowManager.getWindow("main");
      if (mainWindow) {
        mainWindow.setSize(width, height);
        logger.debug("Main window resized", { width, height });
      }
      return { success: true };
    });

    ipcMain.handle("move-window", (event, { deltaX, deltaY }) => {
      const mainWindow = windowManager.getWindow("main");
      if (mainWindow) {
        const [currentX, currentY] = mainWindow.getPosition();
        const newX = currentX + deltaX;
        const newY = currentY + deltaY;
        mainWindow.setPosition(newX, newY);
        logger.debug("Main window moved", {
          deltaX,
          deltaY,
          from: { x: currentX, y: currentY },
          to: { x: newX, y: newY },
        });
      }
      return { success: true };
    });

    ipcMain.handle("get-session-history", () => {
      return sessionManager.getOptimizedHistory();
    });

    ipcMain.handle("clear-session-memory", () => {
      sessionManager.clear();
      windowManager.broadcastToAllWindows("session-cleared");
      return { success: true };
    });

    ipcMain.handle("force-always-on-top", () => {
      windowManager.forceAlwaysOnTopForAllWindows();
      return { success: true };
    });

    ipcMain.handle("test-always-on-top", () => {
      const results = windowManager.testAlwaysOnTopForAllWindows();
      return { success: true, results };
    });

    ipcMain.handle("send-chat-message", async (event, text) => {
      // Add chat message to session memory
      sessionManager.addUserInput(text, 'chat');
      logger.debug('Chat message added to session memory', { textLength: text.length });
      
      // Process typed message with LLM in the same way as transcribed text
      setTimeout(async () => {
        try {
          const sessionHistory = sessionManager.getOptimizedHistory();
          await this.processTranscriptionWithLLM(text, sessionHistory);
        } catch (error) {
          logger.error("Failed to process chat message with LLM", {
            error: error.message,
            text: text.substring(0, 100)
          });
        }
      }, 500);
      
      return { success: true };
    });

    ipcMain.handle("get-skill-prompt", (event, skillName) => {
      try {
        const { promptLoader } = require('./prompt-loader');
        const skillPrompt = promptLoader.getSkillPrompt(skillName);
        return skillPrompt;
      } catch (error) {
        logger.error('Failed to get skill prompt', { skillName, error: error.message });
        return null;
      }
    });

    ipcMain.handle("set-gemini-api-key", (event, apiKey) => {
      llmService.updateApiKey(apiKey);
      return llmService.getStats();
    });

    ipcMain.handle("get-gemini-status", () => {
      return llmService.getStats();
    });

    // Window binding IPC handlers
    ipcMain.handle("set-window-binding", (event, enabled) => {
      return windowManager.setWindowBinding(enabled);
    });

    ipcMain.handle("toggle-window-binding", () => {
      return windowManager.toggleWindowBinding();
    });

    ipcMain.handle("get-window-binding-status", () => {
      return windowManager.getWindowBindingStatus();
    });

    ipcMain.handle("get-window-stats", () => {
      return windowManager.getWindowStats();
    });

    ipcMain.handle("set-window-gap", (event, gap) => {
      return windowManager.setWindowGap(gap);
    });

    ipcMain.handle("move-bound-windows", (event, { deltaX, deltaY }) => {
      windowManager.moveBoundWindows(deltaX, deltaY);
      return windowManager.getWindowBindingStatus();
    });

    ipcMain.handle("test-gemini-connection", async () => {
      return await llmService.testConnection();
    });

    ipcMain.handle("run-gemini-diagnostics", async () => {
      try {
        const connectivity = await llmService.checkNetworkConnectivity();
        const apiTest = await llmService.testConnection();
        
        return {
          success: true,
          connectivity,
          apiTest,
          timestamp: new Date().toISOString()
        };
      } catch (error) {
        return {
          success: false,
          error: error.message,
          timestamp: new Date().toISOString()
        };
      }
    });

    // Settings handlers
    ipcMain.handle("show-settings", () => {
      windowManager.showSettings();

      // Send current settings to the settings window
      const settingsWindow = windowManager.getWindow("settings");
      if (settingsWindow) {
        const currentSettings = this.getSettings();
        setTimeout(() => {
          settingsWindow.webContents.send("load-settings", currentSettings);
        }, 100);
      }

      return { success: true };
    });

    ipcMain.handle("get-settings", () => {
      return this.getSettings();
    });

    ipcMain.handle("save-settings", (event, settings) => {
      return this.saveSettings(settings);
    });

    ipcMain.handle("update-app-icon", (event, iconKey) => {
      return this.updateAppIcon(iconKey);
    });

    ipcMain.handle("update-active-skill", (event, skill) => {
      this.activeSkill = skill;
      try { llmService.clearConversationHistory(); } catch (_) {}
      try { sessionManager.setActiveSkill(skill); } catch (_) {}
      windowManager.broadcastToAllWindows("skill-changed", { skill });
      windowManager.broadcastToAllWindows("skill-mode-changed", { skill });
      const chatWindow = windowManager.getWindow('chat');
      if (chatWindow && !chatWindow.isDestroyed() && chatWindow.webContents) {
        chatWindow.webContents.send('conversation-history-cleared', { reason: 'skill-mode-changed', skill });
      }
      return { success: true, conversationHistoryCleared: true };
    });

    ipcMain.handle("restart-app-for-stealth", () => {
      // Force restart the app to ensure stealth name changes take effect
      const { app } = require("electron");
      app.relaunch();
      app.exit();
    });

    ipcMain.handle("close-window", (event) => {
      const webContents = event.sender;
      const window = windowManager.windows.forEach((win, type) => {
        if (win.webContents === webContents) {
          win.hide();
          return true;
        }
      });
      return { success: true };
    });

    // LLM window specific handlers
    ipcMain.handle("expand-llm-window", (event, contentMetrics) => {
      windowManager.expandLLMWindow(contentMetrics);
      return { success: true, contentMetrics };
    });

    ipcMain.handle("resize-llm-window-for-content", (event, contentMetrics) => {
      // Use the same expansion logic for now, can be enhanced later
      windowManager.expandLLMWindow(contentMetrics);
      return { success: true, contentMetrics };
    });

    ipcMain.handle("quit-app", () => {
      logger.info("Quit app requested via IPC");
      try {
        // Force quit the application
        const { app } = require("electron");

        // Close all windows first
        windowManager.destroyAllWindows();

        // Unregister shortcuts
        globalShortcut.unregisterAll();

        // Force quit
        app.quit();

        // If the above doesn't work, force exit
        setTimeout(() => {
          process.exit(0);
        }, 2000);
      } catch (error) {
        logger.error("Error during quit:", error);
        process.exit(1);
      }
    });

    // Handle close settings
    ipcMain.on("close-settings", () => {
      const settingsWindow = windowManager.getWindow("settings");
      if (settingsWindow) {
        settingsWindow.hide();
      }
    });

    // Handle save settings (synchronous)
    ipcMain.on("save-settings", (event, settings) => {
      this.saveSettings(settings);
    });

    // Handle update skill
    ipcMain.on("update-skill", (event, skill) => {
      const previousSkill = this.activeSkill;
      this.activeSkill = skill;
      try { llmService.clearConversationHistory(); } catch (_) {}
      try { sessionManager.setActiveSkill(skill); } catch (_) {}
      windowManager.broadcastToAllWindows("skill-updated", { skill });
      windowManager.broadcastToAllWindows("skill-mode-changed", { skill, previousSkill });
      const chatWindow = windowManager.getWindow('chat');
      if (chatWindow && !chatWindow.isDestroyed() && chatWindow.webContents) {
        chatWindow.webContents.send('conversation-history-cleared', { reason: 'skill-mode-changed', skill });
      }
    });

    // Handle quit app (alternative method)
    ipcMain.on("quit-app", () => {
      logger.info("Quit app requested via IPC (on method)");
      try {
        const { app } = require("electron");
        windowManager.destroyAllWindows();
        globalShortcut.unregisterAll();
        app.quit();
        setTimeout(() => process.exit(0), 1000);
      } catch (error) {
        logger.error("Error during quit (on method):", error);
        process.exit(1);
      }
    });
  }

  toggleOverlayWindows() {
    const windows = BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed());
    const anyVisible = windows.some((win) => win.isVisible());

    windows.forEach((win) => {
      if (anyVisible) {
        win.hide();
      } else {
        win.show();
      }
    });

    if (typeof windowManager.isVisible !== "undefined") {
      windowManager.isVisible = !anyVisible;
    }

    logger.info("Overlay visibility toggled via global shortcut", {
      hidden: anyVisible,
      windowCount: windows.length,
    });
  }

  toggleSpeechRecognition() {
    const currentStatus = speechService.getStatus();
    if (currentStatus.isRecording) {
      try {
        speechService.stopRecording();
        windowManager.hideChatWindow();
        logger.info("Speech recognition stopped via global shortcut");
      } catch (error) {
        logger.error("Error stopping speech recognition:", error);
      }
    } else {
      try {
        speechService.startRecording();
        windowManager.showChatWindow();
        logger.info("Speech recognition started via global shortcut");
      } catch (error) {
        logger.error("Error starting speech recognition:", error);
      }
    }
  }

  clearSessionMemory() {
    try {
      sessionManager.clear();
      windowManager.broadcastToAllWindows("session-cleared");
      logger.info("Session memory cleared via global shortcut");
    } catch (error) {
      logger.error("Error clearing session memory:", error);
    }
  }

  clearConversationHistory(reason = 'manual') {
    try {
      if (llmService && typeof llmService.clearConversationHistory === 'function') {
        llmService.clearConversationHistory();
      } else if (llmService && Array.isArray(llmService.conversationHistory)) {
        llmService.conversationHistory = [];
      }
      const chatWindow = windowManager.getWindow('chat');
      if (chatWindow && !chatWindow.isDestroyed() && chatWindow.webContents) {
        chatWindow.webContents.send('conversation-history-cleared', { reason });
        chatWindow.webContents.send('speech-status-update', 'Conversation context cleared. New topic ready.');
      }
      windowManager.broadcastToAllWindows('conversation-history-cleared', { reason });
      logger.info('LLM conversation history cleared', { reason });
      return { success: true, reason };
    } catch (error) {
      logger.error('Failed to clear conversation history', { error: error.message, reason });
      return { success: false, error: error.message, reason };
    }
  }

  handleUpArrow() {
    const isInteractive = windowManager.getWindowStats().isInteractive;

    if (isInteractive) {
      // Interactive mode: Navigate to previous skill
      this.navigateSkill(-1);
    } else {
      // Non-interactive mode: Move window up
      windowManager.moveBoundWindows(0, -20);
    }
  }

  handleDownArrow() {
    const isInteractive = windowManager.getWindowStats().isInteractive;

    if (isInteractive) {
      // Interactive mode: Navigate to next skill
      this.navigateSkill(1);
    } else {
      // Non-interactive mode: Move window down
      windowManager.moveBoundWindows(0, 20);
    }
  }

  handleLeftArrow() {
    const isInteractive = windowManager.getWindowStats().isInteractive;

    if (!isInteractive) {
      // Non-interactive mode: Move window left
      windowManager.moveBoundWindows(-20, 0);
    }
    // Interactive mode: Left arrow does nothing
  }

  handleRightArrow() {
    const isInteractive = windowManager.getWindowStats().isInteractive;

    if (!isInteractive) {
      // Non-interactive mode: Move window right
      windowManager.moveBoundWindows(20, 0);
    }
    // Interactive mode: Right arrow does nothing
  }

  navigateSkill(direction) {
    const availableSkills = [
      "general",
      "programming",
      "dsa",
      "core-cs",
      "system-design",
      "behavioral",
      "data-science",
      "sales",
      "presentation",
      "negotiation",
      "devops",
    ];

    const currentIndex = availableSkills.indexOf(this.activeSkill);
    if (currentIndex === -1) {
      logger.warn("Current skill not found in available skills", {
        currentSkill: this.activeSkill,
        availableSkills,
      });
      return;
    }

    // Calculate new index with wrapping
    let newIndex = currentIndex + direction;
    if (newIndex >= availableSkills.length) {
      newIndex = 0; // Wrap to beginning
    } else if (newIndex < 0) {
      newIndex = availableSkills.length - 1; // Wrap to end
    }

    const newSkill = availableSkills[newIndex];
    const previousSkill = this.activeSkill;
    this.activeSkill = newSkill;

    // Reset LLM multi-turn context when switching topics/skill modes
    try { llmService.clearConversationHistory(); } catch (_) {}
    // Update session manager with the new skill
    sessionManager.setActiveSkill(newSkill);

    logger.info("Skill navigated via global shortcut", {
      from: availableSkills[currentIndex],
      to: newSkill,
      direction: direction > 0 ? "down" : "up",
    });

    // Broadcast the skill change to all windows
    windowManager.broadcastToAllWindows("skill-updated", { skill: newSkill });
    windowManager.broadcastToAllWindows("skill-mode-changed", { skill: newSkill, previousSkill });
    const chatWindow = windowManager.getWindow('chat');
    if (chatWindow && !chatWindow.isDestroyed() && chatWindow.webContents) {
      chatWindow.webContents.send('conversation-history-cleared', { reason: 'skill-mode-changed', skill: newSkill });
    }
  }

  getSkillDisplayName(skill) {
    const skillDisplayNames = {
      'general': 'General',
      'conversational': 'Conversational',
      'dsa': 'DSA',
      'behavioral': 'Behavioral',
      'system-design': 'System Design',
      'core-cs': 'Core CS',
      'programming': 'Programming',
      'devops': 'DevOps',
      'data-science': 'Data Science',
      'sales': 'Sales',
      'presentation': 'Presentation',
      'negotiation': 'Negotiation',
    };
    return skillDisplayNames[skill] || (skill ? skill.toUpperCase() : 'General');
  }

  async handleScreenshotCapture() {
    if (!this.isReady) {
      logger.warn("Screenshot requested before application ready");
      return;
    }

    // Hide overlay briefly during capture so Vysper doesn't block problem text
    const overlayNames = ['main', 'llmResponse', 'chat'];
    const visibleOverlays = overlayNames
      .map((name) => windowManager.getWindow(name))
      .filter((win) => win && !win.isDestroyed() && win.isVisible());

    try {
      visibleOverlays.forEach((win) => { try { win.hide(); } catch (_) {} });
      await new Promise((resolve) => setTimeout(resolve, 100));

      const { count, item } = await ocrService.captureAndBufferScreenshot();
      const statusMsg = `📸 Screenshots Queued: ${count} (Press Ctrl+Enter to Solve)`;
      logger.info('Screenshot captured and queued (no auto-submit)', { count });

      windowManager.broadcastToAllWindows("screenshot-buffered", {
        count,
        message: statusMsg,
        timestamp: new Date().toISOString(),
        item,
      });
      windowManager.broadcastToAllWindows("screenshot-queue-updated", { count, message: statusMsg });
      windowManager.broadcastToAllWindows("speech-status", { status: statusMsg });
      return { count, item };
    } catch (error) {
      logger.error("Failed to capture and buffer screenshot", { error: error.message });
      windowManager.broadcastToAllWindows("ocr-error", { error: error.message });
      windowManager.broadcastToAllWindows("speech-status", { status: `Screenshot capture failed: ${error.message}` });
      throw error;
    } finally {
      // Restore overlays after capture
      visibleOverlays.forEach((win) => {
        try {
          if (typeof windowManager.showOnCurrentDesktop === 'function') windowManager.showOnCurrentDesktop(win);
          else win.showInactive ? win.showInactive() : win.show();
        } catch (_) {}
      });
    }
  }

  clearScreenshotQueue(reason = 'manual') {
    const count = ocrService.clearScreenshotBuffer();
    const statusMsg = `📸 Screenshots Queued: 0`;
    windowManager.broadcastToAllWindows("screenshot-buffer-cleared", { count, reason });
    windowManager.broadcastToAllWindows("screenshot-queue-updated", { count: 0, message: statusMsg, reason });
    windowManager.broadcastToAllWindows("speech-status", { status: reason === 'shortcut' ? 'Screenshot queue cleared' : statusMsg });
    logger.info("Screenshot queue cleared", { clearedScreenshots: count, reason });
    return { count, success: true };
  }

  async submitScreenshotBuffer() {
    const bufferedItems = ocrService.getScreenshotBuffer();
    if (!bufferedItems || bufferedItems.length === 0) {
      logger.debug("Screenshot buffer is empty, nothing to submit");
      windowManager.broadcastToAllWindows("screenshot-queue-updated", { count: 0, message: "📸 Screenshots Queued: 0" });
      return;
    }

    // Clear buffer immediately so rapid successive hotkeys do not clash
    ocrService.clearScreenshotBuffer();
    windowManager.broadcastToAllWindows("screenshot-queue-updated", { count: 0, message: "📸 Screenshots Queued: 0" });

    const startTime = Date.now();
    const count = bufferedItems.length;
    const currentSkill = this.activeSkill || 'dsa';
    logger.info(`Submitting ${count} queued screenshot(s) together to Gemini`, { skill: currentSkill });

    try {
      windowManager.showLLMLoading();
      windowManager.broadcastToAllWindows("screenshot-submitting", { count });
      windowManager.broadcastToAllWindows("speech-status", { status: `Analyzing ${count} screenshot(s)...` });

      // Extract queued image buffers for a single multimodal request
      const queuedBuffers = bufferedItems.map(item => {
        if (Buffer.isBuffer(item?.buffer)) return item.buffer;
        if (item?.buffer && item.buffer.type === 'Buffer' && Array.isArray(item.buffer.data)) {
          return Buffer.from(item.buffer.data);
        }
        const cleanBase64 = (item?.rawBase64 || item?.imageBase64 || '').replace(/^data:image\/[a-zA-Z0-9.+]+;base64,/, '').trim();
        return cleanBase64 ? Buffer.from(cleanBase64, 'base64') : null;
      }).filter(Boolean);

      const combinedText = bufferedItems
        .map((item, idx) => item.text ? `[Image ${idx + 1} Captured Text]:\n${item.text}` : '')
        .filter(Boolean)
        .join('\n\n');

      sessionManager.addOCREvent(combinedText || `Captured ${count} stacked screenshots`, {
        processingTime: Date.now() - startTime,
        source: 'screenshot_buffer',
        imageCount: count
      });

      const mainWindow = windowManager.getWindow('llmResponse') || windowManager.getWindow('main');
      const chatWindow = windowManager.getWindow('chat');

      // New question: clear main overlay + reset chat active answer target (chat history remains append-only)
      if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
        mainWindow.webContents.send('clear-response-panel');
      }
      if (chatWindow && !chatWindow.isDestroyed() && chatWindow.webContents) {
        chatWindow.webContents.send('clear-response-panel');
      }

      let accumulatedResponse = '';
      let isFirst = true;

      // Send ALL queued screenshots together in one streamFromScreenshots(...) call
      const stream = await llmService.streamFromScreenshots(queuedBuffers, currentSkill);
      for await (const chunk of stream) {
        const token = typeof chunk?.text === 'function' ? chunk.text() : (chunk?.text || chunk || '');
        if (!token) continue;
        accumulatedResponse += token;

        if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
          mainWindow.webContents.send('stream-llm-token', token);
        }
        if (chatWindow && !chatWindow.isDestroyed() && chatWindow.webContents) {
          chatWindow.webContents.send('stream-chat-token', token);
        }

        windowManager.streamLLMChunk(token, isFirst, accumulatedResponse, { skill: currentSkill, imageCount: count });
        if (chatWindow && !chatWindow.isDestroyed() && chatWindow.webContents) {
          chatWindow.webContents.send('llm-stream-chunk', {
            chunk: token,
            isFirst,
            fullText: accumulatedResponse,
            metadata: { skill: currentSkill, imageCount: count }
          });
        }
        isFirst = false;
      }

      if (chatWindow && !chatWindow.isDestroyed() && chatWindow.webContents) {
        chatWindow.webContents.send('stream-chat-end');
      }

      const finalResponse = accumulatedResponse.trim();
      const needsProgrammingLanguage = ['programming', 'dsa', 'devops', 'system-design', 'data-science'].includes(currentSkill);

      sessionManager.addModelResponse(finalResponse, {
        skill: currentSkill,
        multiScreenshotCount: count
      });

      windowManager.showLLMResponse(finalResponse, {
        skill: currentSkill,
        programmingLanguage: needsProgrammingLanguage ? this.codingLanguage : 'not applicable',
        imageCount: count
      });

      this.broadcastLLMSuccess({ response: finalResponse, metadata: { skill: currentSkill, imageCount: count } });
      windowManager.broadcastToAllWindows("speech-status", { status: `Response ready (${count} images)` });
      logger.info("Queued multi-screenshot response completed", { count, skill: currentSkill, responseLength: finalResponse.length });
      return { success: true, count, response: finalResponse };
    } catch (error) {
      logger.error("Multi-screenshot LLM processing failed", {
        error: error.message,
        count
      });

      windowManager.showLLMResponse(
        `Gemini request failed for ${count} screenshots: ${error.message}`,
        {
          skill: this.activeSkill,
          usedFallback: true
        }
      );

      const chatWindow = windowManager.getWindow('chat');
      if (chatWindow && !chatWindow.isDestroyed() && chatWindow.webContents) {
        chatWindow.webContents.send('stream-chat-end');
      }

      sessionManager.addConversationEvent({
        role: 'system',
        content: `Multi-screenshot LLM processing failed: ${error.message}`,
        action: 'llm_error',
        metadata: {
          error: error.message,
          skill: this.activeSkill
        }
      });

      this.broadcastLLMError(error.message);
      return { success: false, error: error.message, count };
    }
  }

  clearScreenshotBufferAndSession() {
    const count = ocrService.clearScreenshotBuffer();
    try {
      sessionManager.clear();
      windowManager.broadcastToAllWindows("session-cleared");
      windowManager.broadcastToAllWindows("screenshot-buffer-cleared", { count });
      windowManager.broadcastToAllWindows("screenshot-queue-updated", { count: 0, message: "📸 Screenshots Queued: 0" });
      windowManager.broadcastToAllWindows("speech-status", { status: "Screenshot buffer & session cleared" });
      logger.info("Screenshot buffer and session memory cleared via shortcut", { clearedScreenshots: count });
    } catch (error) {
      logger.error("Error clearing session memory and screenshot buffer:", error);
    }
  }

  async triggerScreenshotOCR() {
    if (!this.isReady) {
      logger.warn("Screenshot requested before application ready");
      return;
    }

    const startTime = Date.now();

    try {
      windowManager.showLLMLoading();

      const ocrResult = await ocrService.captureAndProcess();
      const hasImage = !!ocrResult.imageBase64;
      const hasText = !!(ocrResult.text && ocrResult.text.trim().length > 0);

      if (!hasText && !hasImage) {
        windowManager.hideLLMResponse();
        this.broadcastOCRError("No text found in screenshot");
        return;
      }

      if (hasText || hasImage) {
        sessionManager.addOCREvent(ocrResult.text || 'High-resolution screenshot captured (Vision mode)', {
          processingTime: ocrResult.metadata?.processingTime,
          source: 'screenshot'
        });
        this.broadcastOCRSuccess(ocrResult);
      }

      const sessionHistory = sessionManager.getOptimizedHistory();
      const skillsRequiringProgrammingLanguage = ['programming', 'dsa', 'devops', 'system-design', 'data-science'];
      const needsProgrammingLanguage = skillsRequiringProgrammingLanguage.includes(this.activeSkill);
      const skillDisplayName = this.getSkillDisplayName(this.activeSkill);

      const skillContext = {
        skill: this.activeSkill,
        skillName: skillDisplayName,
        text: ocrResult.text || '',
        sessionMemory: sessionHistory.recent,
        programmingLanguage: needsProgrammingLanguage ? this.codingLanguage : null
      };

      await this.processWithLLM(ocrResult.text || '', sessionHistory, ocrResult.imageBase64, skillContext);
    } catch (error) {
      logger.error("Screenshot OCR process failed", {
        error: error.message,
        duration: Date.now() - startTime,
      });

      windowManager.hideLLMResponse();
      this.broadcastOCRError(error.message);
      
      sessionManager.addConversationEvent({
        role: 'system',
        content: `Screenshot OCR failed: ${error.message}`,
        action: 'ocr_error',
        metadata: {
          error: error.message
        }
      });
    }
  }

  async processWithLLM(text, sessionHistory, imageBase64 = null, skillContext = null) {
    try {
      const skillsRequiringProgrammingLanguage = ['programming', 'dsa', 'devops', 'system-design', 'data-science'];
      const needsProgrammingLanguage = skillsRequiringProgrammingLanguage.includes(this.activeSkill);
      const skillDisplayName = this.getSkillDisplayName(this.activeSkill);

      const resolvedContext = skillContext || {
        skill: this.activeSkill,
        skillName: skillDisplayName,
        text,
        sessionMemory: sessionHistory.recent,
        programmingLanguage: needsProgrammingLanguage ? this.codingLanguage : null
      };

      const mainWindow = windowManager.getWindow('llmResponse') || windowManager.getWindow('main');
      const chatWindow = windowManager.getWindow('chat');

      // Clear both windows prior to generating
      if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
        mainWindow.webContents.send('clear-response-panel');
      }
      if (chatWindow && !chatWindow.isDestroyed() && chatWindow.webContents) {
        chatWindow.webContents.send('clear-response-panel');
      }

      const llmResult = await llmService.generateResponse(
        imageBase64,
        resolvedContext,
        (token) => {
          if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
            mainWindow.webContents.send('stream-llm-token', token);
          }
          if (chatWindow && !chatWindow.isDestroyed() && chatWindow.webContents) {
            chatWindow.webContents.send('stream-chat-token', token);
          }
        }
      );

      if (chatWindow && !chatWindow.isDestroyed() && chatWindow.webContents) {
        chatWindow.webContents.send('stream-chat-end');
      }

      logger.info("LLM processing completed, showing response", {
        responseLength: llmResult.response.length,
        skill: this.activeSkill,
        programmingLanguage: needsProgrammingLanguage ? this.codingLanguage : 'not applicable',
        processingTime: llmResult.metadata.processingTime,
        responsePreview: llmResult.response.substring(0, 200) + "...",
      });

      // Add LLM response to session memory
      sessionManager.addModelResponse(llmResult.response, {
        skill: this.activeSkill,
        processingTime: llmResult.metadata.processingTime,
        usedFallback: llmResult.metadata.usedFallback,
      });

      windowManager.showLLMResponse(llmResult.response, {
        skill: this.activeSkill,
        processingTime: llmResult.metadata.processingTime,
        usedFallback: llmResult.metadata.usedFallback,
      });

      this.broadcastLLMSuccess(llmResult);
    } catch (error) {
      logger.error("LLM processing failed", {
        error: error.message,
        skill: this.activeSkill,
      });

      windowManager.showLLMResponse(
        `Gemini request failed: ${error.message}`,
        {
          skill: this.activeSkill,
          usedFallback: true,
        }
      );

      sessionManager.addConversationEvent({
        role: 'system',
        content: `LLM processing failed: ${error.message}`,
        action: 'llm_error',
        metadata: {
          error: error.message,
          skill: this.activeSkill
        }
      });

      this.broadcastLLMError(error.message);
    }
  }

  async processTranscriptionWithLLM(text, sessionHistory, targetSkill = null) {
    try {
      // Validate input text
      if (!text || typeof text !== 'string' || text.trim().length === 0) {
        logger.warn("Skipping LLM processing for empty or invalid transcription", {
          textType: typeof text,
          textLength: text ? text.length : 0
        });
        return;
      }

      const cleanText = text.trim();
      if (cleanText.length < 2) {
        logger.debug("Skipping LLM processing for very short transcription", {
          text: cleanText
        });
        return;
      }

      // Deduplicate rapid identical submissions (within 3 seconds)
      if (
        this.lastProcessedTranscription === cleanText &&
        Date.now() - (this.lastProcessedTime || 0) < 3000
      ) {
        logger.debug("Skipping duplicate transcription processing", { text: cleanText });
        return;
      }
      this.lastProcessedTranscription = cleanText;
      this.lastProcessedTime = Date.now();

      const effectiveSkill = targetSkill || this.activeSkill;

      logger.info("Processing transcription with intelligent LLM response", {
        skill: effectiveSkill,
        textLength: cleanText.length,
        textPreview: cleanText.substring(0, 100) + "..."
      });

      // 1. Immediately show loading on the overlay window
      windowManager.showLLMLoading();

      // Check if current skill needs programming language context
      const skillsRequiringProgrammingLanguage = ['programming', 'dsa', 'devops', 'system-design', 'data-science'];
      const needsProgrammingLanguage = skillsRequiringProgrammingLanguage.includes(effectiveSkill);
      const skillDisplayName = this.getSkillDisplayName(effectiveSkill);

      const skillContext = {
        skill: effectiveSkill,
        skillName: skillDisplayName,
        text: cleanText,
        sessionMemory: sessionHistory ? sessionHistory.recent : [],
        programmingLanguage: needsProgrammingLanguage ? this.codingLanguage : null
      };

      // 2. Call generateResponse(cleanText, skillContext) with streaming
      const chatWindow = windowManager.getWindow('chat');
      let accumulatedResponse = '';

      const llmResult = await llmService.generateResponse(
        cleanText,
        skillContext,
        (chunk, isFirst, fullText) => {
          accumulatedResponse = fullText;
          windowManager.streamLLMChunk(chunk, isFirst, fullText, { skill: effectiveSkill });
          if (chatWindow && !chatWindow.isDestroyed() && chatWindow.webContents) {
            chatWindow.webContents.send('llm-stream-chunk', {
              chunk,
              isFirst,
              fullText,
              metadata: { skill: effectiveSkill }
            });
          }
        }
      );

      const finalResponse = llmResult?.response || accumulatedResponse;

      // Add LLM response to session memory
      sessionManager.addModelResponse(finalResponse, {
        skill: effectiveSkill,
        processingTime: llmResult.metadata ? llmResult.metadata.processingTime : 0,
        usedFallback: llmResult.metadata ? llmResult.metadata.usedFallback : false,
        isTranscriptionResponse: true
      });

      // Send response to chat windows
      this.broadcastTranscriptionLLMResponse({
        response: finalResponse,
        metadata: {
          skill: effectiveSkill,
          processingTime: llmResult.metadata ? llmResult.metadata.processingTime : 0,
          usedFallback: llmResult.metadata ? llmResult.metadata.usedFallback : false,
          isTranscriptionResponse: true
        }
      });

      // Also display directly on the main overlay window (llmResponse)
      windowManager.showLLMResponse(finalResponse, {
        skill: effectiveSkill,
        programmingLanguage: needsProgrammingLanguage ? this.codingLanguage : 'not applicable',
        processingTime: llmResult.metadata ? llmResult.metadata.processingTime : 0
      });
      this.broadcastLLMSuccess({ response: finalResponse, metadata: llmResult.metadata });

      logger.info("Transcription LLM response completed and displayed on overlay", {
        responseLength: finalResponse.length,
        skill: effectiveSkill,
        programmingLanguage: needsProgrammingLanguage ? this.codingLanguage : 'not applicable',
        processingTime: llmResult.metadata ? llmResult.metadata.processingTime : 0
      });

    } catch (error) {
      logger.error("Transcription LLM processing failed", {
        error: error.message,
        errorStack: error.stack,
        skill: targetSkill || this.activeSkill,
        text: text ? text.substring(0, 100) : 'undefined'
      });

      // Try to provide a fallback response
      try {
        const effectiveSkill = targetSkill || this.activeSkill;
        const fallbackResult = llmService.generateIntelligentFallbackResponse(text, effectiveSkill);
        
        sessionManager.addModelResponse(fallbackResult.response, {
          skill: effectiveSkill,
          processingTime: fallbackResult.metadata ? fallbackResult.metadata.processingTime : 0,
          usedFallback: true,
          isTranscriptionResponse: true,
          fallbackReason: error.message
        });

        this.broadcastTranscriptionLLMResponse(fallbackResult);
        windowManager.showLLMResponse(fallbackResult.response, {
          skill: effectiveSkill,
          usedFallback: true
        });
        this.broadcastLLMSuccess(fallbackResult);
        
        logger.info("Used fallback response for transcription", {
          skill: effectiveSkill,
          fallbackResponse: fallbackResult.response
        });
        
      } catch (fallbackError) {
        logger.error("Fallback response also failed", {
          fallbackError: fallbackError.message
        });

        sessionManager.addConversationEvent({
          role: 'system',
          content: `Transcription LLM processing failed: ${error.message}`,
          action: 'transcription_llm_error',
          metadata: {
            error: error.message,
            skill: this.activeSkill
          }
        });
      }
    }
  }

  async processAudioWithLLM(audioBase64, mimeType = 'audio/webm', targetSkill = null) {
    try {
      if (!audioBase64 || audioBase64.length === 0) {
        logger.warn("Skipping single-pass audio processing for empty audio chunk");
        return;
      }

      const effectiveSkill = targetSkill || this.activeSkill || 'dsa';
      logger.info("Processing audio with single-pass Gemini streaming", {
        skill: effectiveSkill,
        audioLength: audioBase64.length,
        mimeType
      });

      // 1. Immediately show loading on the overlay window and chat status
      windowManager.showLLMLoading();
      windowManager.broadcastToAllWindows('speech-status', { status: 'Generating AI answer...' });

      const chatWindow = windowManager.getWindow('chat');
      let accumulatedResponse = '';

      // 2. Call single-pass generateAnswerFromAudio with real-time streaming
      const result = await llmService.generateAnswerFromAudio(
        { audioBase64, mimeType },
        effectiveSkill,
        (chunk, isFirst, fullText) => {
          accumulatedResponse = fullText;
          windowManager.streamLLMChunk(chunk, isFirst, fullText, { skill: effectiveSkill });
          if (chatWindow && !chatWindow.isDestroyed() && chatWindow.webContents) {
            chatWindow.webContents.send('llm-stream-chunk', {
              chunk,
              isFirst,
              fullText,
              metadata: { skill: effectiveSkill }
            });
          }
        }
      );

      const finalResponse = result?.response || accumulatedResponse;

      // 3. Add to session memory and broadcast
      sessionManager.addModelResponse(finalResponse, {
        skill: effectiveSkill,
        isAudioResponse: true
      });

      this.broadcastTranscriptionLLMResponse({
        response: finalResponse,
        metadata: { skill: effectiveSkill, isAudioResponse: true }
      });

      windowManager.showLLMResponse(finalResponse, {
        skill: effectiveSkill
      });
      this.broadcastLLMSuccess({ response: finalResponse, metadata: { skill: effectiveSkill } });

      windowManager.broadcastToAllWindows('speech-status', { status: 'Listening for speech...' });

      logger.info("Single-pass audio response completed and displayed", {
        responseLength: finalResponse.length,
        skill: effectiveSkill
      });
    } catch (error) {
      logger.error("Single-pass audio processing failed", {
        error: error.message,
        stack: error.stack,
        skill: targetSkill || this.activeSkill
      });

      windowManager.broadcastToAllWindows('speech-status', { status: 'Speech error: ' + error.message });

      try {
        const effectiveSkill = targetSkill || this.activeSkill || 'dsa';
        const fallbackResult = llmService.generateIntelligentFallbackResponse("Audio question", effectiveSkill);
        sessionManager.addModelResponse(fallbackResult.response, {
          skill: effectiveSkill,
          usedFallback: true,
          isAudioResponse: true,
          fallbackReason: error.message
        });

        this.broadcastTranscriptionLLMResponse(fallbackResult);
        windowManager.showLLMResponse(fallbackResult.response, {
          skill: effectiveSkill,
          usedFallback: true
        });
      } catch (fbErr) {
        logger.error("Fallback response failed", { error: fbErr.message });
      }
    }
  }

  broadcastOCRSuccess(ocrResult) {
    windowManager.broadcastToAllWindows("ocr-completed", {
      text: ocrResult.text,
      metadata: ocrResult.metadata,
    });
  }

  broadcastOCRError(errorMessage) {
    windowManager.broadcastToAllWindows("ocr-error", {
      error: errorMessage,
      timestamp: new Date().toISOString(),
    });
  }

  broadcastLLMSuccess(llmResult) {
    const broadcastData = {
      response: llmResult.response,
      metadata: llmResult.metadata,
      skill: this.activeSkill, // Add the current active skill to the top level
    };

    logger.info("Broadcasting LLM success to all windows", {
      responseLength: llmResult.response.length,
      skill: this.activeSkill,
      dataKeys: Object.keys(broadcastData),
      responsePreview: llmResult.response.substring(0, 100) + "...",
    });

    windowManager.broadcastToAllWindows("llm-response", broadcastData);
  }

  broadcastLLMError(errorMessage) {
    windowManager.broadcastToAllWindows("llm-error", {
      error: errorMessage,
      timestamp: new Date().toISOString(),
    });
  }

  broadcastTranscriptionLLMResponse(llmResult) {
    const broadcastData = {
      response: llmResult.response,
      metadata: llmResult.metadata,
      skill: this.activeSkill,
      isTranscriptionResponse: true
    };

    logger.info("Broadcasting transcription LLM response to all windows", {
      responseLength: llmResult.response.length,
      skill: this.activeSkill,
      responsePreview: llmResult.response.substring(0, 100) + "..."
    });

    windowManager.broadcastToAllWindows("transcription-llm-response", broadcastData);
  }

  onWindowAllClosed() {
    if (process.platform !== "darwin") {
      app.quit();
    }
  }

  onActivate() {
    if (!this.isReady) {
      this.onAppReady();
    } else {
      // When app is activated, ensure windows appear on current desktop
      const mainWindow = windowManager.getWindow("main");
      if (mainWindow && mainWindow.isVisible()) {
        windowManager.showOnCurrentDesktop(mainWindow);
      }

      // Also handle other visible windows
      windowManager.windows.forEach((window, type) => {
        if (window.isVisible()) {
          windowManager.showOnCurrentDesktop(window);
        }
      });

      logger.debug("App activated - ensured windows appear on current desktop");
    }
  }

  onWillQuit() {
    globalShortcut.unregisterAll();
    windowManager.destroyAllWindows();

    const sessionStats = sessionManager.getMemoryUsage();
    logger.info("Application shutting down", {
      sessionEvents: sessionStats.eventCount,
      sessionSize: sessionStats.approximateSize,
    });
  }

  getSettings() {
    return {
      codingLanguage: this.codingLanguage || config.get('codingLanguage') || "javascript",
      activeSkill: this.activeSkill || config.get('activeSkill') || "dsa",
      appIcon: this.appIcon || config.get('appIcon') || "terminal",
      selectedIcon: this.appIcon || config.get('appIcon') || "terminal",
      geminiKey: process.env.GEMINI_API_KEY || config.get('gemini.apiKey') || "",
      azureKey: process.env.AZURE_SPEECH_KEY || config.get('speech.azure.key') || "",
      azureRegion: process.env.AZURE_SPEECH_REGION || config.get('speech.azure.region') || "",
      windowGap: config.get('windowGap') || (windowManager.getWindowGap ? windowManager.getWindowGap() : 20),
    };
  }

  saveSettings(settings) {
    try {
      if (settings.geminiKey) {
        config.set('gemini.apiKey', settings.geminiKey);
        llmService.updateApiKey(settings.geminiKey);
      }
      if (settings.azureKey) {
        process.env.AZURE_SPEECH_KEY = settings.azureKey;
        config.set('speech.azure.key', settings.azureKey);
      }
      if (settings.azureRegion) {
        process.env.AZURE_SPEECH_REGION = settings.azureRegion;
        config.set('speech.azure.region', settings.azureRegion);
      }
      if (settings.windowGap) {
        config.set('windowGap', settings.windowGap);
        if (windowManager.setWindowGap) {
          windowManager.setWindowGap(parseInt(settings.windowGap, 10));
        }
      }
      // Update application settings
      if (settings.codingLanguage) {
        this.codingLanguage = settings.codingLanguage;
        config.set('codingLanguage', settings.codingLanguage);
      }
      if (settings.activeSkill) {
        this.activeSkill = settings.activeSkill;
        config.set('activeSkill', settings.activeSkill);
        // Broadcast skill change to all windows
        windowManager.broadcastToAllWindows("skill-updated", {
          skill: settings.activeSkill,
        });
      }
      if (settings.appIcon) {
        this.appIcon = settings.appIcon;
        config.set('appIcon', settings.appIcon);
      }

      // Handle icon change specifically
      if (settings.selectedIcon) {
        this.appIcon = settings.selectedIcon;
        config.set('appIcon', settings.selectedIcon);
        // Immediately update the app icon
        this.updateAppIcon(settings.selectedIcon);
      }

      // Persist settings to file or config
      this.persistSettings(settings);

      logger.info("Settings saved successfully", settings);
      return { success: true };
    } catch (error) {
      logger.error("Failed to save settings", { error: error.message });
      return { success: false, error: error.message };
    }
  }

  persistSettings(settings) {
    config.saveSettings(settings);
    logger.debug("Settings persisted to settings.json", settings);
  }

  updateAppIcon(iconKey) {
    try {
      const { app } = require("electron");
      const path = require("path");
      const fs = require("fs");

      // Icon mapping for available icons in assests/icons folder
      const iconPaths = {
        terminal: "assests/icons/terminal.png",
        activity: "assests/icons/activity.png",
        settings: "assests/icons/settings.png",
      };

      // App name mapping for stealth mode
      const appNames = {
        terminal: "Terminal ",
        activity: "Activity Monitor ",
        settings: "System Settings ",
      };

      const iconPath = iconPaths[iconKey];
      const appName = appNames[iconKey];

      if (!iconPath) {
        logger.error("Invalid icon key", { iconKey });
        return { success: false, error: "Invalid icon key" };
      }

      const fullIconPath = path.resolve(iconPath);

      if (!fs.existsSync(fullIconPath)) {
        logger.error("Icon file not found", {
          iconKey,
          iconPath: fullIconPath,
        });
        return { success: false, error: "Icon file not found" };
      }

      // Set app icon for dock/taskbar
      if (process.platform === "darwin") {
        // macOS - update dock icon
        app.dock.setIcon(fullIconPath);

        // Force dock refresh with multiple attempts
        setTimeout(() => {
          app.dock.setIcon(fullIconPath);
        }, 100);

        setTimeout(() => {
          app.dock.setIcon(fullIconPath);
        }, 500);
      } else {
        // Windows/Linux - update window icons
        windowManager.windows.forEach((window, type) => {
          if (window && !window.isDestroyed()) {
            window.setIcon(fullIconPath);
          }
        });
      }

      // Update app name for stealth mode
      this.updateAppName(appName, iconKey);

      logger.info("App icon and name updated successfully", {
        iconKey,
        appName,
        iconPath: fullIconPath,
        platform: process.platform,
        fileExists: fs.existsSync(fullIconPath),
      });

      this.appIcon = iconKey;
      return { success: true };
    } catch (error) {
      logger.error("Failed to update app icon", {
        error: error.message,
        stack: error.stack,
      });
      return { success: false, error: error.message };
    }
  }

  updateAppName(appName, iconKey) {
    try {
      const { app } = require("electron");

      // Force update process title for Activity Monitor stealth - CRITICAL
      process.title = appName;

      // Set app name in dock (macOS) - this affects the dock and Activity Monitor
      if (process.platform === "darwin") {
        // Multiple attempts to ensure the name sticks
        app.setName(appName);

        // Force update the bundle name for macOS stealth
        const { execSync } = require("child_process");
        try {
          // Update the app's Info.plist CFBundleName in memory
          if (process.mainModule && process.mainModule.filename) {
            const appPath = process.mainModule.filename;
            // Force set the bundle name directly
            process.env.CFBundleName = appName.trim();
          }
        } catch (e) {
          // Silently fail if we can't modify bundle info
        }

        // Clear dock badge and reset
        if (app.dock) {
          app.dock.setBadge("");
          // Force dock refresh
          setTimeout(() => {
            app.dock.setIcon(
              require("path").resolve(`assests/icons/${iconKey}.png`)
            );
          }, 50);
        }
      }

      // Set app user model ID for Windows taskbar grouping
      app.setAppUserModelId(`${appName.trim()}-${iconKey}`);

      // Update all window titles to match the new app name
      const windows = windowManager.windows;
      windows.forEach((window, type) => {
        if (window && !window.isDestroyed()) {
          // Use stealth name for all windows
          const stealthTitle = appName.trim();
          window.setTitle(stealthTitle);
        }
      });

      // Multiple force refreshes with increasing delays
      const refreshTimes = [50, 100, 200, 500];
      refreshTimes.forEach((delay) => {
        setTimeout(() => {
          process.title = appName;
          if (process.platform === "darwin") {
            app.setName(appName);
            // Force update bundle display name
            if (app.getName() !== appName) {
              app.setName(appName);
            }
          }
        }, delay);
      });

      logger.info("App name updated for stealth mode", {
        appName,
        processTitle: process.title,
        appGetName: app.getName(),
        iconKey,
        platform: process.platform,
      });
    } catch (error) {
      logger.error("Failed to update app name", { error: error.message });
    }
  }

  async runSystemDiagnostics() {
    try {
      const permCheck = DiagnosticsService.checkAudioPermissions();
      let apiCheck = await DiagnosticsService.testGeminiAPIStream(llmService);

      if (!apiCheck.success && llmService) {
        try {
          await DiagnosticsService.attemptLLMRepair(llmService);
          apiCheck = await DiagnosticsService.testGeminiAPIStream(llmService);
        } catch (e) {
          logger.warn('Diagnostics self-healing repair attempt failed', { error: e.message });
        }
      }

      const report = {
        permissions: permCheck,
        api: apiCheck,
        activeModel: (llmService && llmService.modelName) || config.DEFAULT_MODEL || (config.get && config.get('llm.gemini.model')) || 'gemini-3.8-flash',
        timestamp: new Date().toLocaleTimeString()
      };

      console.log('=== VYSPER SYSTEM DIAGNOSTICS REPORT ===', report);

      const chatWindow = windowManager.getWindow('chat');
      if (chatWindow && !chatWindow.isDestroyed() && chatWindow.webContents) {
        chatWindow.webContents.send('diagnostics-report', report);
      }
      return report;
    } catch (error) {
      logger.error('Failed to run system diagnostics', { error: error.message });
      return null;
    }
  }
}

const appController = new ApplicationController();

// Forward/load src/main extensions
try {
  require('./src/main');
} catch (e) {
  logger.warn('Could not load src/main forwarder', { error: e.message });
}

module.exports = appController;

