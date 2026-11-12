const EventEmitter = require('events');
const logger = require('../core/logger').createServiceLogger('SPEECH');

const SAMPLE_RATE = 16000;
const VAD_RMS_THRESHOLD = 0.015;
const VAD_SILENCE_MS = 1500;

class SpeechService extends EventEmitter {
  constructor() {
    super();
    this.isRecording = false;
    this.isListening = false;
    this.sessionStartTime = null;
    this.desktopSourceId = null;
    this.setupIPC();
    logger.info('SpeechService initialized (16kHz PCM multimodal capture mode)', {
      sampleRate: SAMPLE_RATE,
      vadRmsThreshold: VAD_RMS_THRESHOLD,
      vadSilenceMs: VAD_SILENCE_MS,
    });
  }

  setupIPC() {
    try {
      const { ipcMain, desktopCapturer } = require('electron');
      if (!ipcMain) return;

      const safeHandle = (channel, handler) => {
        try { ipcMain.removeHandler(channel); } catch (_) {}
        ipcMain.handle(channel, handler);
      };

      safeHandle('start-speech-recognition', () => this.startRecording());
      safeHandle('stop-speech-recognition', () => this.stopRecording());
      safeHandle('get-speech-config', () => this.getCaptureConfig());

      // Provide desktop capturer sources for system audio loopback capture
      safeHandle('get-desktop-sources', async (event, options = {}) => {
        try {
          if (!desktopCapturer) return [];
          const types = Array.isArray(options.types) && options.types.length ? options.types : ['screen', 'window'];
          const sources = await desktopCapturer.getSources({
            types,
            thumbnailSize: { width: 0, height: 0 },
            fetchWindowIcons: false,
          });
          return sources.map((s) => ({ id: s.id, name: s.name, display_id: s.display_id }));
        } catch (err) {
          logger.error('Failed to get desktop capturer sources', { error: err.message });
          return [];
        }
      });

      // Toggle (used by hotkeys/UI)
      ipcMain.on('toggle-speech-recognition', () => this.toggleRecording());
      ipcMain.on('toggle-voice-recording', () => this.toggleRecording());

      // Renderer -> main PCM streaming/submit (main.js also listens for process-pcm-audio-submit in this app;
      // keep events for observability and forward status)
      ipcMain.on('audio-pcm-chunk', (event, chunkBuffer) => {
        this.emit('audio-pcm-chunk', chunkBuffer);
      });

      ipcMain.on('process-pcm-audio-submit', (event, fullPCMBuffer, activeSkill) => {
        const bytes = fullPCMBuffer ? (fullPCMBuffer.byteLength || fullPCMBuffer.length || 0) : 0;
        logger.info('PCM audio submit received', { bytes, activeSkill });
        this.emit('process-pcm-audio-submit', { fullPCMBuffer, activeSkill, bytes });
        // Compatibility for legacy listeners
        this.emit('audio-chunk-for-answer', { audioBase64: null, pcmBuffer: fullPCMBuffer, activeSkill });
      });

      // Legacy compatibility (two-step STT discouraged by spec; kept for compatibility)
      ipcMain.on('transcribe-audio-chunk', (event, data) => {
        const audioBase64 = data?.audioBase64 || (typeof data === 'string' ? data : null);
        const mimeType = data?.mimeType || 'audio/webm';
        const activeSkill = data?.activeSkill || null;
        if (audioBase64) this.emit('audio-chunk-for-answer', { audioBase64, mimeType, activeSkill });
      });

      ipcMain.on('speech-status-update', (event, status) => {
        this.emit('status', status);
        this._broadcastToWindows('speech-status-update', status);
      });

      ipcMain.on('speech-final-transcript', (event, data) => {
        // Legacy/compat channel; multimodal PCM flow is preferred.
        const text = typeof data === 'string' ? data : data?.text;
        if (text) {
          const t = String(text);
          this.emit('speech-final-transcript', t);
          this.emit('transcription', t, data?.activeSkill || null);
        }
      });

      ipcMain.on('renderer-speech-interim', (event, data) => {
        const text = typeof data === 'string' ? data : data?.text;
        if (text) this.emit('interim-transcription', String(text));
      });
      ipcMain.on('renderer-speech-error', (event, error) => {
        if (error && error !== 'no-speech' && error !== 'network' && error !== 'aborted') this.emit('error', error);
      });
    } catch (err) {
      logger.debug('ipcMain not available during initialization (non-electron or test environment)', {
        error: err.message,
      });
    }
  }

  getCaptureConfig() {
    return {
      sampleRate: SAMPLE_RATE,
      channelCount: 1,
      vadRmsThreshold: VAD_RMS_THRESHOLD,
      vadSilenceMs: VAD_SILENCE_MS,
      mimeType: 'audio/pcm;rate=16000',
      dualCapture: true, // mic + system loopback (renderer implements with available sources)
    };
  }

  startRecording() {
    if (this.isRecording) return this.getStatus();
    this.isRecording = true;
    this.isListening = true;
    this.sessionStartTime = Date.now();
    logger.info('Starting 16kHz PCM capture session');
    this._broadcastToWindows('start-renderer-recognition', this.getCaptureConfig());
    this._broadcastToWindows('speech-status-update', 'Listening...');
    this.emit('recording-started');
    this.emit('status', 'Listening...');
    return this.getStatus();
  }

  stopRecording() {
    if (!this.isRecording && !this.isListening) return this.getStatus();
    this.isRecording = false;
    this.isListening = false;
    const duration = this.sessionStartTime ? Date.now() - this.sessionStartTime : 0;
    this.sessionStartTime = null;
    logger.info('Stopping PCM capture session', { durationMs: duration });
    // Renderer must flush accumulated PCM on stop (manual mic stop flush).
    this._broadcastToWindows('stop-renderer-recognition', { reason: 'manual-stop', flush: true });
    this.emit('recording-stopped');
    this.emit('status', 'Speech recognition stopped');
    return this.getStatus();
  }

  toggleRecording() {
    return this.isRecording ? this.stopRecording() : this.startRecording();
  }

  getStatus() {
    return {
      isRecording: this.isRecording,
      isListening: this.isListening,
      sessionStartTime: this.sessionStartTime,
      duration: this.sessionStartTime ? Date.now() - this.sessionStartTime : 0,
      mode: 'pcm-16khz-multimodal',
      config: this.getCaptureConfig(),
    };
  }

  setDesktopAudioSource(sourceId) {
    this.desktopSourceId = sourceId || null;
    this._broadcastToWindows('set-desktop-audio-source', { sourceId: this.desktopSourceId });
  }

  _broadcastToWindows(channel, payload) {
    try {
      const { BrowserWindow } = require('electron');
      if (BrowserWindow && typeof BrowserWindow.getAllWindows === 'function') {
        BrowserWindow.getAllWindows().forEach((win) => {
          if (win && !win.isDestroyed() && win.webContents) {
            win.webContents.send(channel, payload);
          }
        });
      }
    } catch (err) {
      logger.debug('Error broadcasting to windows', { error: err.message, channel });
    }
  }
}

module.exports = new SpeechService();
module.exports.SpeechService = SpeechService;
module.exports.SAMPLE_RATE = SAMPLE_RATE;
module.exports.VAD_RMS_THRESHOLD = VAD_RMS_THRESHOLD;
module.exports.VAD_SILENCE_MS = VAD_SILENCE_MS;
