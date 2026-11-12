const { contextBridge, ipcRenderer } = require('electron')

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  // Screenshot and OCR
  takeScreenshot: () => ipcRenderer.invoke('take-screenshot'),
  submitScreenshotBuffer: () => ipcRenderer.invoke('submit-screenshot-buffer'),
  clearScreenshotBuffer: () => ipcRenderer.invoke('clear-screenshot-buffer'),
  getScreenshotBufferCount: () => ipcRenderer.invoke('get-screenshot-buffer-count'),
  
  // Speech recognition
  startSpeechRecognition: () => ipcRenderer.invoke('start-speech-recognition'),
  stopSpeechRecognition: () => ipcRenderer.invoke('stop-speech-recognition'),
  getDesktopSources: () => ipcRenderer.invoke('get-desktop-sources'),
  sendTranscriptionResult: (data) => ipcRenderer.send('renderer-speech-final', data),
  sendInterimTranscription: (data) => ipcRenderer.send('renderer-speech-interim', data),
  sendSpeechStatus: (status) => ipcRenderer.send('renderer-speech-status', status),
  sendSpeechError: (error) => ipcRenderer.send('renderer-speech-error', error),
  sendSpeechFinalTranscript: (text) => ipcRenderer.send('speech-final-transcript', text),
  sendAudioChunkForTranscription: (data) => ipcRenderer.send('transcribe-audio-chunk', data),
  sendAudioPCMChunk: (buffer) => ipcRenderer.send('audio-pcm-chunk', buffer),
  processPCMAudioSubmit: (buffer, skill) => ipcRenderer.send('process-pcm-audio-submit', buffer, skill),
  onStreamLLMToken: (callback) => ipcRenderer.on('stream-llm-token', callback),
  onStreamChatToken: (callback) => ipcRenderer.on('stream-chat-token', callback),
  onClearResponsePanel: (callback) => ipcRenderer.on('clear-response-panel', callback),
  triggerLLMResponse: (transcriptText, activeSkill) => ipcRenderer.invoke('trigger-llm-response', { transcriptText, activeSkill }),
  onStartRendererRecognition: (callback) => ipcRenderer.on('start-renderer-recognition', callback),
  onStopRendererRecognition: (callback) => ipcRenderer.on('stop-renderer-recognition', callback),
  onAddChatMessage: (callback) => ipcRenderer.on('add-chat-message', callback),
  runSystemDiagnostics: () => ipcRenderer.send('run-system-diagnostics'),
  onDiagnosticsReport: (callback) => ipcRenderer.on('diagnostics-report', callback),
  sendSpeechStatusUpdate: (status) => ipcRenderer.send('speech-status-update', status),
  onSpeechStatusUpdate: (callback) => ipcRenderer.on('speech-status-update', callback),
  userChatSubmit: (text) => ipcRenderer.send('user-chat-submit', text),
  toggleVoiceRecording: () => ipcRenderer.send('toggle-voice-recording'),
  onStreamChatEnd: (callback) => ipcRenderer.on('stream-chat-end', callback),
  onTriggerMicToggle: (callback) => ipcRenderer.on('trigger-mic-toggle', callback),
  
  // Window management
  showAllWindows: () => ipcRenderer.invoke('show-all-windows'),
  hideAllWindows: () => ipcRenderer.invoke('hide-all-windows'),
  enableWindowInteraction: () => ipcRenderer.invoke('enable-window-interaction'),
  disableWindowInteraction: () => ipcRenderer.invoke('disable-window-interaction'),
  switchToChat: () => ipcRenderer.invoke('switch-to-chat'),
  switchToSkills: () => ipcRenderer.invoke('switch-to-skills'),
  resizeWindow: (width, height) => ipcRenderer.invoke('resize-window', { width, height }),
  moveWindow: (deltaX, deltaY) => ipcRenderer.invoke('move-window', { deltaX, deltaY }),
  getWindowStats: () => ipcRenderer.invoke('get-window-stats'),
  
  // Session memory
  getSessionHistory: () => ipcRenderer.invoke('get-session-history'),
  getLLMSessionHistory: () => ipcRenderer.invoke('get-llm-session-history'),
  clearSessionMemory: () => ipcRenderer.invoke('clear-session-memory'),
  formatSessionHistory: () => ipcRenderer.invoke('format-session-history'),
  sendChatMessage: (text) => ipcRenderer.invoke('send-chat-message', text),
  getSkillPrompt: (skillName) => ipcRenderer.invoke('get-skill-prompt', skillName),
  
  // Gemini LLM configuration
  setGeminiApiKey: (apiKey) => ipcRenderer.invoke('set-gemini-api-key', apiKey),
  getGeminiStatus: () => ipcRenderer.invoke('get-gemini-status'),
  testGeminiConnection: () => ipcRenderer.invoke('test-gemini-connection'),
  
  // Settings
  showSettings: () => ipcRenderer.invoke('show-settings'),
  hideSettings: () => ipcRenderer.invoke('hide-settings'),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  updateAppIcon: (iconKey) => ipcRenderer.invoke('update-app-icon', iconKey),
  updateActiveSkill: (skill) => ipcRenderer.invoke('update-active-skill', skill),
  restartAppForStealth: () => ipcRenderer.invoke('restart-app-for-stealth'),
  closeWindow: () => ipcRenderer.invoke('close-window'),
  quit: () => {
    try {
      ipcRenderer.send('quit-app');
      // Also try the app quit method
      setTimeout(() => {
        require('electron').app.quit();
      }, 100);
    } catch (error) {
      console.error('Error in quit:', error);
    }
  },
  
  // LLM window specific methods
  expandLlmWindow: (contentMetrics) => ipcRenderer.invoke('expand-llm-window', contentMetrics),
  resizeLlmWindowForContent: (contentMetrics) => ipcRenderer.invoke('resize-llm-window-for-content', contentMetrics),
  
  // Event listeners
  onTranscriptionReceived: (callback) => ipcRenderer.on('transcription-received', callback),
  onInterimTranscription: (callback) => ipcRenderer.on('interim-transcription', callback),
  onSpeechStatus: (callback) => ipcRenderer.on('speech-status', callback),
  onSpeechError: (callback) => ipcRenderer.on('speech-error', callback),
  onSessionEvent: (callback) => ipcRenderer.on('session-event', callback),
  onSessionCleared: (callback) => ipcRenderer.on('session-cleared', callback),
  onOcrCompleted: (callback) => ipcRenderer.on('ocr-completed', callback),
  onOcrError: (callback) => ipcRenderer.on('ocr-error', callback),
  onLlmResponse: (callback) => ipcRenderer.on('llm-response', callback),
  onLlmError: (callback) => ipcRenderer.on('llm-error', callback),
  onTranscriptionLlmResponse: (callback) => ipcRenderer.on('transcription-llm-response', callback),
  onOpenGeminiConfig: (callback) => ipcRenderer.on('open-gemini-config', callback),
  onDisplayLlmResponse: (callback) => ipcRenderer.on('display-llm-response', callback),
  onShowLoading: (callback) => ipcRenderer.on('show-loading', callback),
  onSkillChanged: (callback) => ipcRenderer.on('skill-changed', callback),
  onInteractionModeChanged: (callback) => ipcRenderer.on('interaction-mode-changed', callback),
  onRecordingStarted: (callback) => ipcRenderer.on('recording-started', callback),
  onRecordingStopped: (callback) => ipcRenderer.on('recording-stopped', callback),
  onScreenshotBuffered: (callback) => ipcRenderer.on('screenshot-buffered', callback),
  onScreenshotBufferCleared: (callback) => ipcRenderer.on('screenshot-buffer-cleared', callback),
  onScreenshotSubmitting: (callback) => ipcRenderer.on('screenshot-submitting', callback),
  onLlmStreamChunk: (callback) => ipcRenderer.on('llm-stream-chunk', callback),
  
  // Generic receive method
  receive: (channel, callback) => ipcRenderer.on(channel, callback),
  
  // Remove listeners
  removeAllListeners: (channel) => ipcRenderer.removeAllListeners(channel)
})

contextBridge.exposeInMainWorld('api', {
    send: (channel, data) => {
        let validChannels = [
            'close-settings',
            'quit-app',
            'save-settings',
            'toggle-recording',
            'toggle-interaction-mode',
            'update-skill',
            'window-loaded',
            'renderer-speech-final',
            'renderer-speech-interim',
            'renderer-speech-status',
            'renderer-speech-error',
            'speech-final-transcript',
            'transcribe-audio-chunk',
            'audio-pcm-chunk',
            'process-pcm-audio-submit',
            'run-system-diagnostics',
            'speech-status-update',
            'user-chat-submit',
            'toggle-voice-recording',
            'clear-conversation-history'
        ];
        if (validChannels.includes(channel)) {
            ipcRenderer.send(channel, data);
        } else {
            console.warn('Invalid IPC channel:', channel);
        }
    },
    receive: (channel, func) => {
        let validChannels = [
            'load-settings',
            'recording-state-changed',
            'interaction-mode-changed',
            'skill-updated',
            'update-skill',
            'recording-started',
            'recording-stopped',
            'start-renderer-recognition',
            'stop-renderer-recognition',
            'interim-transcription',
            'transcription-received',
            'screenshot-buffered',
            'screenshot-buffer-cleared',
            'screenshot-submitting',
            'add-chat-message',
            'llm-stream-chunk',
            'stream-llm-token',
            'stream-chat-token',
            'clear-response-panel',
            'diagnostics-report',
            'speech-status-update',
            'stream-chat-end',
            'trigger-mic-toggle',
            'conversation-history-cleared',
            'skill-mode-changed',
            'discard-active-chat-card',
            'screenshot-queue-updated'
        ];
        if (validChannels.includes(channel)) {
            ipcRenderer.on(channel, (event, ...args) => func(...args));
        }
    }
});

contextBridge.exposeInMainWorld('ipcRenderer', {
    send: (channel, ...args) => ipcRenderer.send(channel, ...args),
    on: (channel, func) => ipcRenderer.on(channel, (event, ...args) => func(event, ...args)),
    invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
    removeListener: (channel, func) => ipcRenderer.removeListener(channel, func),
    removeAllListeners: (channel) => ipcRenderer.removeAllListeners(channel)
}); 