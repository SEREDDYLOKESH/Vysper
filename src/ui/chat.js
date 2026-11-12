// Vysper Chat UI - IIFE (IPC, text/mic bindings, dual PCM capture + VAD, streaming)
(function () {
  'use strict';

  const SAMPLE_RATE = 16000;
  const VAD_RMS_THRESHOLD = 0.015;
  const VAD_SILENCE_MS = 1500;

  function $(id) {
    return typeof document !== 'undefined' ? document.getElementById(id) : null;
  }

  function getIpc() {
    if (typeof window !== 'undefined') {
      if (window.ipcRenderer && typeof window.ipcRenderer.send === 'function') return window.ipcRenderer;
      if (window.electronAPI && typeof window.electronAPI.send === 'function') return window.electronAPI;
    }
    try {
      const { ipcRenderer } = require('electron');
      if (ipcRenderer) return ipcRenderer;
    } catch (_) {}
    return null;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatContent(text) {
    const raw = String(text == null ? '' : text);
    // Prefer marked if available (chat.html loads it), otherwise minimal escaping.
    try {
      if (typeof marked !== 'undefined' && marked.parse) return marked.parse(raw);
      if (typeof markdown !== 'undefined' && markdown.toHTML) return markdown.toHTML(raw);
    } catch (_) {}
    return escapeHtml(raw).replace(/\n/g, '<br>');
  }

  function ts() {
    return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  const state = {
    isRecording: false,
    hasSpokenInCurrentTurn: false,
    isGeneratingAnswer: false,
    pendingUtteranceBuffer: null,
    lastVoiceAt: 0,
    speechStartTime: 0,
    audioContext: null,
    processor: null,
    analyser: null,
    micSource: null,
    sysSource: null,
    micStream: null,
    sysStream: null,
    mixedGain: null,
    pcmChunks: [],
    activeAssistantEl: null,
    answerCount: 0,
    visualizerRaf: null,
    loopbackAttached: false,
  };

  function getEls() {
    return {
      input: $('chat-input') || $('messageInput') || document.querySelector('.input-field'),
      sendBtn: $('send-btn') || $('sendButton') || document.querySelector('.send-button'),
      micBtn: $('mic-btn') || $('micButton') || document.querySelector('.mic-button'),
      clearBtn: $('clear-context-btn'),
      messages: $('chat-messages') || $('chatMessages') || document.querySelector('.messages-list') || document.querySelector('.chat-messages'),
      recordingIndicator: $('recordingIndicator'),
      listeningIndicator: $('listeningIndicator'),
      listeningText: $('listeningText'),
      audioStatusBadge: $('audioStatusBadge'),
      audioVisualizer: $('audioVisualizerContainer'),
      interimOverlay: $('interimOverlay'),
      loopbackStatusBadge: $('loopbackStatusBadge') || document.querySelector('.loopback-status-badge'),
      loopbackBannerBadge: $('loopbackBannerBadge'),
      screenshotQueueBadge: $('screenshotQueueBadge'),
    };
  }

  function setScreenshotQueueBadge(count, message) {
    const { screenshotQueueBadge } = getEls();
    if (!screenshotQueueBadge) return;
    const n = Number.isFinite(count) ? count : 0;
    screenshotQueueBadge.textContent = message || `📸 Screenshots Queued: ${n}${n > 0 ? ' (Press Ctrl+Enter to Solve)' : ''}`;
  }

  function appendMessage(sender, text, opts = {}) {
    const { messages } = getEls();
    if (!messages) return null;
    const wrap = document.createElement('div');
    const type = opts.type || (sender === 'You' ? 'user' : sender === 'System' ? 'system' : 'assistant');
    const classes = [opts.className || `message ${type}`];
    if (opts.card) classes.push('chat-card');
    if (opts.isAnswerCard) classes.push('answer-card');
    wrap.className = classes.join(' ').trim();

    const timeDiv = document.createElement('div');
    timeDiv.className = 'message-time';
    const answerLabel = opts.answerIndex ? `Answer #${opts.answerIndex} • ` : '';
    timeDiv.textContent = `${answerLabel}${sender} • ${ts()}`;

    const textDiv = document.createElement('div');
    textDiv.className = 'message-text';
    if (opts.raw) textDiv.textContent = String(text || '');
    else if (type === 'assistant' || opts.markdown) textDiv.innerHTML = formatContent(text);
    else textDiv.textContent = String(text || '');

    wrap.appendChild(timeDiv);
    wrap.appendChild(textDiv);
    messages.appendChild(wrap);
    messages.scrollTop = messages.scrollHeight;
    return wrap;
  }

  function beginNewAssistantAnswerCard(initialText = '...', raw = true) {
    // Permanent append-only chat history: every new valid answer gets a new card
    state.answerCount += 1;
    state.activeAssistantEl = appendMessage('Gemini', initialText, {
      type: 'assistant',
      raw,
      card: true,
      isAnswerCard: true,
      answerIndex: state.answerCount,
    });
    return state.activeAssistantEl;
  }

  function setStatus(text) {
    const { listeningText, audioStatusBadge } = getEls();
    if (listeningText) listeningText.textContent = text;
    if (audioStatusBadge) audioStatusBadge.textContent = text;
  }

  function setLoopbackStatus(stateName, detail) {
    const { loopbackStatusBadge, loopbackBannerBadge } = getEls();
    const badges = [loopbackStatusBadge, loopbackBannerBadge].filter(Boolean);
    if (!badges.length) return;
    const config = {
      attached: { text: 'Loopback: Attached', cls: 'attached', title: detail || 'System audio loopback attached successfully.' },
      detached: { text: 'Loopback: Mic only', cls: 'detached', title: detail || 'System audio loopback not attached; using microphone only.' },
      checking: { text: 'Loopback: Checking…', cls: 'idle', title: detail || 'Checking system audio loopback availability.' },
      idle: { text: 'Loopback: Idle', cls: 'idle', title: detail || 'System audio loopback status (idle).' },
      error: { text: 'Loopback: Error', cls: 'detached', title: detail || 'System audio loopback failed; using microphone only.' },
    }[stateName] || { text: 'Loopback: Idle', cls: 'idle', title: detail || '' };
    badges.forEach((el) => {
      el.textContent = config.text;
      el.classList.remove('attached', 'detached', 'idle');
      el.classList.add(config.cls);
      if (config.title) el.title = config.title;
    });
  }

  function setRecordingUI(on) {
    const { recordingIndicator, micBtn, listeningIndicator, audioVisualizer } = getEls();
    if (recordingIndicator) recordingIndicator.style.display = on ? 'block' : 'none';
    if (micBtn) micBtn.classList.toggle('recording', !!on);
    if (micBtn) micBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    if (listeningIndicator) listeningIndicator.classList.toggle('active', !!on);
    if (audioVisualizer) audioVisualizer.style.display = on ? 'flex' : 'none';
    if (!on) setLoopbackStatus('idle');
  }

  function toIpcBuffer(int16Array) {
    // Prefer Buffer in Electron renderers, fallback to Uint8Array
    const u8 = new Uint8Array(int16Array.buffer, int16Array.byteOffset, int16Array.byteLength);
    try {
      if (typeof Buffer !== 'undefined' && Buffer.from) return Buffer.from(u8);
    } catch (_) {}
    return u8;
  }

  async function getSystemAudioStream() {
    const ipc = getIpc();
    if (!ipc) return null;
    try {
      let sources = [];
      if (typeof ipc.invoke === 'function') {
        sources = await ipc.invoke('get-desktop-sources', { types: ['screen'] });
      } else if (window.electronAPI && typeof window.electronAPI.getDesktopSources === 'function') {
        sources = await window.electronAPI.getDesktopSources();
      }
      if (!Array.isArray(sources) || sources.length === 0) return null;
      const source = sources.find((s) => /screen|entire|display/i.test(s.name || '')) || sources[0];
      const constraints = {
        audio: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: source.id,
          },
        },
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: source.id,
            maxWidth: 2,
            maxHeight: 2,
          },
        },
      };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      // We only need audio; stop any accidental video track
      stream.getVideoTracks().forEach((t) => { try { t.stop(); } catch (_) {} stream.removeTrack(t); });
      if (!stream.getAudioTracks().length) {
        stream.getTracks().forEach((t) => { try { t.stop(); } catch (_) {} });
        return null;
      }
      return stream;
    } catch (err) {
      console.warn('[Audio] System audio loopback unavailable, using microphone only:', err?.message || err);
      return null;
    }
  }

  async function startCapture() {
    if (state.isRecording) return;
    const ipc = getIpc();
    state.pcmChunks = [];
    state.hasSpokenInCurrentTurn = false;
    state.pendingUtteranceBuffer = null;
    state.lastVoiceAt = Date.now();
    state.speechStartTime = 0;

    try {
      const micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: SAMPLE_RATE,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      state.micStream = micStream;

      // Best-effort dual capture: mic + system audio loopback
      setLoopbackStatus('checking', 'Checking system audio loopback availability...');
      state.sysStream = await getSystemAudioStream();

      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      state.audioContext = new AudioCtx({ sampleRate: SAMPLE_RATE });
      state.mixedGain = state.audioContext.createGain();
      state.mixedGain.gain.value = 1.0;

      state.micSource = state.audioContext.createMediaStreamSource(micStream);
      state.micSource.connect(state.mixedGain);

      let loopbackAttached = false;
      if (state.sysStream) {
        try {
          state.sysSource = state.audioContext.createMediaStreamSource(state.sysStream);
          const sysGain = state.audioContext.createGain();
          sysGain.gain.value = 1.0;
          state.sysSource.connect(sysGain);
          sysGain.connect(state.mixedGain);
          loopbackAttached = !!(state.sysStream.getAudioTracks && state.sysStream.getAudioTracks().length);
        } catch (e) {
          console.warn('[Audio] Failed to attach system loopback source:', e);
          loopbackAttached = false;
        }
      }

      if (loopbackAttached) {
        setLoopbackStatus('attached', 'System audio loopback attached successfully.');
      } else if (state.sysStream) {
        setLoopbackStatus('error', 'System audio stream found but could not be attached; using microphone only.');
      } else {
        setLoopbackStatus('detached', 'System audio loopback not available; using microphone only.');
      }

      // VAD/visualizer tap
      state.analyser = state.audioContext.createAnalyser();
      state.analyser.fftSize = 256;
      state.mixedGain.connect(state.analyser);

      // PCM encoding via ScriptProcessorNode (16-bit Int16 in memory, no temp files)
      state.processor = state.audioContext.createScriptProcessor(4096, 1, 1);
      state.processor.onaudioprocess = (e) => {
        if (!state.isRecording) return;
        const input = e.inputBuffer.getChannelData(0);
        let sum = 0;
        const pcm = new Int16Array(input.length);
        for (let i = 0; i < input.length; i++) {
          const s = Math.max(-1, Math.min(1, input[i]));
          sum += s * s;
          pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
        // Always capture while listening (continuous session)
        state.pcmChunks.push(toIpcBuffer(pcm));

        const rms = Math.sqrt(sum / input.length);
        if (rms >= VAD_RMS_THRESHOLD) {
          // Active speech in current turn: mark spoken (prevents empty flushes during background silence)
          if (!state.hasSpokenInCurrentTurn) {
            state.speechStartTime = Date.now();
            appendMessage('System', 'Voice detected. Listening...', { type: 'system' });
          }
          state.hasSpokenInCurrentTurn = true;
          state.lastVoiceAt = Date.now();
          setStatus(`Voice detected (${Math.min(100, Math.round(rms * 400))}%)`);
        } else if (state.hasSpokenInCurrentTurn && (Date.now() - state.lastVoiceAt >= VAD_SILENCE_MS) && state.pcmChunks.length > 0) {
          // Utterance boundary: flush current question, reset turn, keep stream alive for next question
          const flushed = flushCurrentUtterance('silence-vad', { keepListening: true });
          if (flushed) {
            setStatus('Silence detected. Generating answer...');
            appendMessage('System', `Silence detected (${(VAD_SILENCE_MS / 1000).toFixed(1)}s). Submitting audio...`, { type: 'system' });
          }
          if (state.isRecording) setStatus('Listening for next question...');
        }
      };
      state.mixedGain.connect(state.processor);
      state.processor.connect(state.audioContext.destination);

      state.isRecording = true;
      state.loopbackAttached = loopbackAttached;
      state.isGeneratingAnswer = false;
      state.pendingUtteranceBuffer = null;
      setRecordingUI(true);
      setStatus(loopbackAttached ? 'Listening for next question (mic + system audio)...' : 'Listening for next question (microphone)...');
      appendMessage('System', `Continuous listening started at ${SAMPLE_RATE / 1000}kHz PCM${loopbackAttached ? ' (mic + system loopback attached)' : ' (microphone only; loopback not attached)'}. I will auto-answer each question after a pause.`, { type: 'system' });
      if (ipc && ipc.send) ipc.send('speech-status-update', 'Continuous listening active...');
      startVisualizer();
    } catch (err) {
      console.error('[Audio] Capture start failed:', err);
      appendMessage('System', `Microphone/capture error: ${err?.message || err}`, { type: 'error' });
      setStatus('Capture error');
      cleanupCapture();
    }
  }

  function concatChunks(chunks) {
    if (!chunks || chunks.length === 0) return null;
    try {
      if (typeof Buffer !== 'undefined' && Buffer.concat) {
        const bufs = chunks.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(c.buffer || c, c.byteOffset || 0, c.byteLength || c.length)));
        return Buffer.concat(bufs);
      }
    } catch (_) {}
    let total = 0;
    for (const c of chunks) total += c.byteLength || c.length || 0;
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      const u8 = c instanceof Uint8Array ? c : new Uint8Array(c.buffer || c, c.byteOffset || 0, c.byteLength || c.length);
      out.set(u8, off);
      off += u8.length;
    }
    return out;
  }

  function flushCurrentUtterance(reason = 'silence-vad', { keepListening = true, fromManualStop = false } = {}) {
    if (!state.pcmChunks.length) {
      state.hasSpokenInCurrentTurn = false;
      state.speechStartTime = 0;
      if (!keepListening) setStatus('Ready');
      return false;
    }

    const full = concatChunks(state.pcmChunks);
    const speechDurationMs = state.speechStartTime ? Math.max(0, Date.now() - state.speechStartTime) : 0;
    const pcmBytes = full ? (full.byteLength || full.length || 0) : 0;

    // Reset turn buffer/state immediately so next question is captured cleanly
    state.pcmChunks = [];
    state.hasSpokenInCurrentTurn = false;
    state.speechStartTime = 0;
    state.lastVoiceAt = Date.now();

    if (!full || !pcmBytes) {
      if (keepListening && state.isRecording) setStatus('Listening for next question...');
      return false;
    }

    // Discard brief interviewer acknowledgments/fillers: do NOT clear panels or call Gemini
    // 16kHz 16-bit mono ~= 32000 bytes/sec, so ~1.2s ~= 38400 bytes (use < 38000 threshold)
    if (speechDurationMs < 1200 || pcmBytes < 38000) {
      console.log('[VAD] Ignored brief acknowledgment (<1.2s)', { speechDurationMs, pcmBytes, reason });
      if (keepListening && state.isRecording) setStatus('Listening for next question...');
      return false;
    }

    if (keepListening && state.isRecording && !fromManualStop) {
      appendMessage('System', `Utterance captured (${reason}, ${(speechDurationMs / 1000).toFixed(1)}s). Answering while still listening for next question...`, { type: 'system' });
      setStatus('Generating answer (still listening)...');
    }

    submitUtteranceBuffer(full, reason);

    if (keepListening && state.isRecording) {
      // Keep AudioContext/ScriptProcessor/MediaStream alive for continuous listening
      setStatus(state.isGeneratingAnswer ? 'Generating answer... (listening continues)' : 'Listening for next question...');
    }
    return true;
  }

  function stopCapture(flush = true, reason = 'manual-stop') {
    if (!state.isRecording && !state.audioContext) {
      setRecordingUI(false);
      setStatus('Ready');
      return;
    }

    // Manual/explicit stop only: flush any unsent speech in current turn before teardown
    if (flush && state.hasSpokenInCurrentTurn && state.pcmChunks.length) {
      flushCurrentUtterance(reason, { keepListening: false, fromManualStop: true });
    } else if (flush && state.pcmChunks.length && reason === 'remote-stop') {
      // Best-effort flush for remote stop if data exists
      flushCurrentUtterance(reason, { keepListening: false, fromManualStop: true });
    } else {
      state.pcmChunks = [];
      state.hasSpokenInCurrentTurn = false;
      state.speechStartTime = 0;
    }

    state.isRecording = false;
    setRecordingUI(false);
    setStatus('Microphone stopped');
    cleanupCapture();
    if (state.pendingUtteranceBuffer) {
      // If we stopped during generation, pending will be handled when generation ends; clear if no generation
      if (!state.isGeneratingAnswer) state.pendingUtteranceBuffer = null;
    }
  }

  function toggleCapture() {
    if (state.isRecording) stopCapture(true, 'manual-stop'); // Manual mic stop flush (teardown only on explicit stop)
    else startCapture();
  }

  function cleanupCapture() {
    if (state.visualizerRaf) { try { cancelAnimationFrame(state.visualizerRaf); } catch (_) {} state.visualizerRaf = null; }
    if (state.processor) { try { state.processor.disconnect(); state.processor.onaudioprocess = null; } catch (_) {} state.processor = null; }
    if (state.analyser) { try { state.analyser.disconnect(); } catch (_) {} state.analyser = null; }
    if (state.micSource) { try { state.micSource.disconnect(); } catch (_) {} state.micSource = null; }
    if (state.sysSource) { try { state.sysSource.disconnect(); } catch (_) {} state.sysSource = null; }
    if (state.mixedGain) { try { state.mixedGain.disconnect(); } catch (_) {} state.mixedGain = null; }
    if (state.micStream) { try { state.micStream.getTracks().forEach((t) => t.stop()); } catch (_) {} state.micStream = null; }
    if (state.sysStream) { try { state.sysStream.getTracks().forEach((t) => t.stop()); } catch (_) {} state.sysStream = null; }
    if (state.audioContext) { try { state.audioContext.close(); } catch (_) {} state.audioContext = null; }
    state.loopbackAttached = false;
  }

  function startVisualizer() {
    const bars = typeof document !== 'undefined' ? document.querySelectorAll('.v-bar, .wave-bar') : [];
    if (!bars.length || !state.analyser) return;
    const data = new Uint8Array(state.analyser.frequencyBinCount);
    const render = () => {
      if (!state.isRecording || !state.analyser) return;
      state.analyser.getByteFrequencyData(data);
      const step = Math.max(1, Math.floor(data.length / bars.length));
      bars.forEach((bar, i) => {
        const v = data[i * step] || 0;
        const h = Math.max(3, Math.min(18, Math.round((v / 255) * 18)));
        bar.style.height = `${h}px`;
      });
      state.visualizerRaf = requestAnimationFrame(render);
    };
    render();
  }

  function submitText() {
    const { input } = getEls();
    const ipc = getIpc();
    if (!input) return;
    const query = String(input.value || '').trim();
    if (!query) return;
    appendMessage('You', query, { type: 'user', raw: true });
    input.value = '';
    beginNewAssistantAnswerCard('Thinking...', true);
    state.isGeneratingAnswer = true;
    if (ipc && ipc.send) ipc.send('user-chat-submit', query);
  }

  function onToken(token) {
    const t = String(token == null ? '' : token);
    if (!t) return;
    // Receiving tokens means generation is in progress
    state.isGeneratingAnswer = true;
    if (!state.activeAssistantEl) beginNewAssistantAnswerCard('', true);
    const el = state.activeAssistantEl.querySelector('.message-text') || state.activeAssistantEl;
    if (el.textContent === '...' || el.textContent === 'Thinking...') el.textContent = '';
    el.textContent += t;
    const { messages } = getEls();
    if (messages) messages.scrollTop = messages.scrollHeight;
  }

  function clearResponse() {
    state.activeAssistantEl = null;
  }

  function submitUtteranceBuffer(buffer, reason) {
    if (!buffer || !(buffer.byteLength || buffer.length)) return false;
    const ipc = getIpc();
    // Guard: if generating, queue cleanly and resume listening for next question
    if (state.isGeneratingAnswer) {
      state.pendingUtteranceBuffer = buffer;
      appendMessage('System', `Queued follow-up utterance while generating (${reason || 'auto'}). It will be answered next.`, { type: 'system' });
      setStatus('Listening for next question...');
      return false;
    }
    state.isGeneratingAnswer = true;
    beginNewAssistantAnswerCard('Thinking...', true);
    appendMessage('System', `Submitting ${((buffer.byteLength || buffer.length) / 1024) | 0} KB PCM audio for analysis...`, { type: 'system' });
    if (ipc && ipc.send) {
      ipc.send('process-pcm-audio-submit', buffer);
      ipc.send('speech-status-update', 'Transcribing & generating answer...');
    }
    return true;
  }

  function flushPendingUtteranceIfAny() {
    if (!state.pendingUtteranceBuffer) return;
    const buf = state.pendingUtteranceBuffer;
    state.pendingUtteranceBuffer = null;
    if (state.isRecording) {
      // Start processing queued utterance for a fresh answer
      submitUtteranceBuffer(buf, 'queued-follow-up');
    }
  }

  function finalizeGenerationCycle(errorText) {
    state.isGeneratingAnswer = false;
    clearResponse();
    if (errorText) appendMessage('System', String(errorText), { type: 'error' });
    if (state.isRecording) {
      setStatus('Listening for next question...');
    }
    // If a follow-up was queued while generating, submit it now (clean, serialized)
    flushPendingUtteranceIfAny();
  }

  function clearConversationContextUI(reason) {
    const ipc = getIpc();
    state.activeAssistantEl = null;
    if (ipc && ipc.send) {
      ipc.send('clear-conversation-history', { reason: reason || 'ui' });
    }
  }

  function bindIpc() {
    const ipc = getIpc();
    if (!ipc) return;
    // Clean up existing IPC listeners before registering new ones (prevents duplicate accumulation/crashes)
    const channels = [
      'stream-chat-token',
      'stream-chat-end',
      'clear-response-panel',
      'speech-status-update',
      'add-chat-message',
      'trigger-mic-toggle',
      'start-renderer-recognition',
      'stop-renderer-recognition',
      'diagnostics-report',
      'conversation-history-cleared',
      'skill-mode-changed',
      'discard-active-chat-card',
      'screenshot-queue-updated',
      'screenshot-buffered',
      'screenshot-buffer-cleared',
      'screenshot-submitting',
    ];
    if (typeof ipc.removeAllListeners === 'function') {
      channels.forEach((ch) => { try { ipc.removeAllListeners(ch); } catch (_) {} });
    }

    const on = (ch, fn) => {
      if (typeof ipc.on === 'function') ipc.on(ch, fn);
    };

    on('stream-chat-token', (event, token) => onToken(typeof token === 'string' ? token : (typeof event === 'string' ? event : token?.token ?? token?.chunk ?? '')));
    on('stream-chat-end', () => { finalizeGenerationCycle(); });
    on('clear-response-panel', () => {
      // IMPORTANT (append-only chat history): never wipe #chat-messages/.messages-list.
      // Only reset active assistant card so the next answer streams into a new permanent card.
      clearResponse();
    });
    on('speech-status-update', (event, status) => {
      const text = typeof status === 'string' ? status : (event && typeof event === 'string' ? event : status?.status || '');
      if (text) {
        setStatus(text);
        appendMessage('System', text, { type: 'system' });
        // Release generation guard on terminal error statuses so continuous listening can proceed
        if (state.isGeneratingAnswer && /^error\b|response error|failed|quota|exhausted/i.test(text)) {
          finalizeGenerationCycle();
        }
      }
    });
    on('discard-active-chat-card', (event, payload) => {
      // Remove pending assistant answer card for non-questions/aborted streams without wiping history
      const reason = (payload && payload.reason) || (event && event.reason) || '';
      if (state.activeAssistantEl && state.activeAssistantEl.parentNode) {
        try { state.activeAssistantEl.parentNode.removeChild(state.activeAssistantEl); } catch (_) {}
      }
      state.activeAssistantEl = null;
      // If we pre-created an answer card count for this pending attempt, roll it back
      if (reason === 'no-question' && state.answerCount > 0) {
        // best-effort rollback; safe since card removed before any permanent answer text streamed
        state.answerCount = Math.max(0, state.answerCount - 1);
      }
    });
    on('add-chat-message', (event, data) => {
      const msg = data && typeof data === 'object' ? data : event;
      const sender = msg?.sender || 'Interviewer';
      const text = msg?.text || (typeof msg === 'string' ? msg : '');
      if (text) appendMessage(sender, text, { type: sender === 'Interviewer' ? 'transcription' : 'system', raw: false });
    });
    on('trigger-mic-toggle', () => toggleCapture());
    on('start-renderer-recognition', () => { if (!state.isRecording) startCapture(); });
    on('stop-renderer-recognition', (event, payload) => {
      // Explicit stop (e.g. Alt+R toggle off): flush pending speech then teardown
      const shouldFlush = payload?.flush !== false;
      if (state.isRecording) stopCapture(shouldFlush, payload?.reason || 'manual-stop');
      else setRecordingUI(false);
    });
    const onHistoryCleared = (event, payload) => {
      const reason = (payload && payload.reason) || (typeof event === 'string' ? event : 'manual');
      const skill = payload && payload.skill ? ` (${payload.skill})` : '';
      const msg = reason === 'skill-mode-changed'
        ? `Conversation context cleared for new skill${skill}.`
        : 'Conversation context cleared. New topic ready.';
      state.activeAssistantEl = null;
      appendMessage('System', msg, { type: 'system' });
      setStatus('New topic ready');
    };
    on('conversation-history-cleared', onHistoryCleared);
    on('skill-mode-changed', (event, payload) => onHistoryCleared(event, { ...(payload || {}), reason: 'skill-mode-changed' }));
    on('screenshot-queue-updated', (event, payload) => {
      const data = (payload && typeof payload === 'object') ? payload : ((event && typeof event === 'object' && !event.sender) ? event : {});
      setScreenshotQueueBadge(data.count || 0, data.message);
      if (data.message) setStatus(data.message);
    });
    on('screenshot-buffered', (event, payload) => {
      const data = (payload && typeof payload === 'object') ? payload : ((event && typeof event === 'object' && !event.sender) ? event : {});
      setScreenshotQueueBadge(data.count || 0, data.message);
    });
    on('screenshot-buffer-cleared', () => setScreenshotQueueBadge(0, '📸 Screenshots Queued: 0'));
    on('screenshot-submitting', (event, payload) => {
      const data = (payload && typeof payload === 'object') ? payload : {};
      if (data.count) setStatus(`Analyzing ${data.count} screenshot(s)...`);
    });

    on('diagnostics-report', (event, report) => {
      const data = report?.api ? report : event?.api ? event : report;
      if (data) appendMessage('System', `Diagnostics @ ${data.timestamp || ts()}: API ${data.api?.success ? 'OK' : 'ERR'}; Mic ${data.permissions?.success ? 'OK' : 'ERR'}; Model ${data.activeModel || 'n/a'}`, { type: 'system' });
    });
  }

  function bindUI() {
    const { input, sendBtn, micBtn, clearBtn } = getEls();
    if (sendBtn && !sendBtn.__vysperBound) {
      sendBtn.__vysperBound = true;
      sendBtn.addEventListener('click', (e) => { e.preventDefault(); submitText(); });
    }
    if (input && !input.__vysperBound) {
      input.__vysperBound = true;
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitText(); }
      });
    }
    if (micBtn && !micBtn.__vysperBound) {
      micBtn.__vysperBound = true;
      micBtn.addEventListener('click', (e) => {
        e.preventDefault();
        const ipc = getIpc();
        // Bind mic toggle to IPC channel (single path; renderer handles trigger/start/stop events)
        if (ipc && ipc.send) ipc.send('toggle-voice-recording');
        else toggleCapture();
      });
    }
    if (clearBtn && !clearBtn.__vysperBound) {
      clearBtn.__vysperBound = true;
      clearBtn.addEventListener('click', (e) => {
        e.preventDefault();
        clearConversationContextUI('button');
      });
    }
    if (!document.__vysperClearShortcutBound) {
      document.__vysperClearShortcutBound = true;
      document.addEventListener('keydown', (e) => {
        if (e.ctrlKey && e.shiftKey && (e.key === 'x' || e.key === 'X')) {
          e.preventDefault();
          clearConversationContextUI('shortcut');
        }
      });
    }
  }

  function init() {
    if (typeof document === 'undefined') return;
    bindIpc();
    bindUI();
    appendMessage('System', 'Vysper chat ready. Type a question (Enter) or use the mic button / Alt+R.', { type: 'system' });
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
  }

  // Exports for tests/other callers
  const api = {
    init,
    bindIpc,
    bindUI,
    appendBubble: (sender, text, isUser) => appendMessage(sender, text, { type: isUser ? 'user' : 'assistant' }),
    appendMessage,
    submitText,
    toggleCapture,
    startCapture,
    stopCapture,
    getIpc,
    getState: () => ({ ...state, pcmChunks: state.pcmChunks.length }),
  };
  if (typeof window !== 'undefined') Object.assign(window, { vysperChat: api, appendBubble: api.appendBubble, initChatPipeline: init });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
