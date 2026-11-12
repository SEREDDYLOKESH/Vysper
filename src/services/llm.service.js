const { GoogleGenerativeAI } = require('@google/generative-ai');
const logger = require('../core/logger').createServiceLogger('LLM');
const coreConfig = require('../core/config');
const {
  getApiKey,
  getActiveApiKey,
  rotateApiKey,
  isQuotaOrRateLimitError,
  withApiKeyRotation,
  PRIMARY_MODEL,
  FALLBACK_MODELS,
  GENERATION_CONFIG,
} = require('../config/config');

function normalizeSkill(skill) {
  return String(skill || 'General').trim();
}

function isCodeOnlySkill(skill) {
  const s = normalizeSkill(skill).toLowerCase();
  return s === 'dsa' || s === 'programming';
}

function stripCodeFenceMarkers(text) {
  if (typeof text !== 'string' || !text) return text || '';
  // Remove fenced code markers that can split a single code block in the overlay
  return text
    .replace(/```[a-zA-Z0-9_+-]*\r?\n?/g, '')
    .replace(/```/g, '');
}

function sanitizeStreamToken(token, skill) {
  const t = typeof token === 'string' ? token : '';
  if (!t) return '';
  return isCodeOnlySkill(skill) ? stripCodeFenceMarkers(t) : t;
}

function getPromptForSkill(skill, context = {}) {
  const normalized = normalizeSkill(skill);
  const lower = normalized.toLowerCase();
  const { hasAudio = false, hasImages = false } = context;

  const audioNoQuestionGuard = hasAudio
    ? 'If the audio only contains brief conversational acknowledgments, praise, or filler words (e.g., \'okay\', \'good\', \'thanks\', \'got it\') and NOT an actual question or technical prompt, respond ONLY with the exact token `[NO_QUESTION]`.'
    : '';

  if (lower === 'dsa' || lower === 'programming') {
    return [
      'You are an expert interview coding assistant.',
      'CRITICAL OUTPUT RULES:',
      '- Output ONLY clean, fully-implemented, executable solution code.',
      '- No markdown wrappers, no code fences, no prose, no commentary, and no conversational filler of any kind.',
      '- Do NOT leave functions incomplete or use placeholders/TODOs.',
      hasImages
        ? '- Read all provided screenshots sequentially as parts of the same problem and solve the complete problem.'
        : '- Solve the complete problem as stated.',
      hasAudio ? '- The user provided spoken interview audio; infer the problem from the audio and answer directly.' : '',
      audioNoQuestionGuard,
    ]
      .filter(Boolean)
      .join('\n');
  }

  if (lower === 'behavioral') {
    return [
      'You are a concise, articulate interview assistant helping in a live behavioral interview.',
      'CRITICAL OUTPUT RULES:',
      '- Output direct, concise, natural text suitable for spoken responses.',
      '- Speak clearly and naturally in first person when appropriate.',
      '- Do NOT output Python class templates, function boilerplates, or code unless explicitly asked.',
      '- Keep the response structured, specific, and easy to say out loud.',
      hasAudio ? '- The user provided spoken interview audio; answer the question you hear directly.' : '',
      hasImages ? '- Use any provided screenshots as context if relevant.' : '',
      audioNoQuestionGuard,
    ]
      .filter(Boolean)
      .join('\n');
  }

  // General / Conversational / fallback (natural spoken text)
  return [
    `You are a concise, articulate interview assistant for ${normalized} mode.`,
    'CRITICAL OUTPUT RULES:',
    '- Output direct, concise, natural text suitable for spoken responses.',
    '- Answer clearly and conversationally, ready to be spoken out loud.',
    '- Do NOT output Python class templates, function boilerplates, or code unless explicitly asked.',
    '- Avoid unnecessary formatting, meta-commentary, or filler.',
    hasAudio ? '- The user provided spoken interview audio; listen and answer the question directly.' : '',
    hasImages ? '- Use any provided screenshots together with the query as multimodal context.' : '',
    audioNoQuestionGuard,
  ]
    .filter(Boolean)
    .join('\n');
}

function bufferToBase64(input) {
  if (!input) return '';
  if (Buffer.isBuffer(input)) return input.toString('base64');
  if (input instanceof Uint8Array) {
    return Buffer.from(input.buffer, input.byteOffset, input.byteLength).toString('base64');
  }
  if (ArrayBuffer.isView(input) && input.buffer) {
    return Buffer.from(input.buffer, input.byteOffset, input.byteLength).toString('base64');
  }
  if (typeof input === 'object' && input.type === 'Buffer' && Array.isArray(input.data)) {
    return Buffer.from(input.data).toString('base64');
  }
  if (typeof input === 'string') {
    const match = input.match(/^data:([^;]+);base64,(.+)$/);
    return (match ? match[2] : input).trim();
  }
  return '';
}

function normalizeImagePart(image) {
  if (!image) return null;
  if (image.inlineData && image.inlineData.data) {
    return {
      inlineData: {
        data: String(image.inlineData.data).replace(/^data:image\/[a-zA-Z0-9.+]+;base64,/, '').trim(),
        mimeType: image.inlineData.mimeType || 'image/png',
      },
    };
  }
  let data = '';
  let mimeType = 'image/png';
  if (Buffer.isBuffer(image) || image instanceof Uint8Array) {
    data = bufferToBase64(image);
  } else if (typeof image === 'string') {
    const mimeMatch = image.match(/^data:(image\/[a-zA-Z0-9.+]+);base64,(.+)$/);
    if (mimeMatch) {
      mimeType = mimeMatch[1];
      data = mimeMatch[2].trim();
    } else {
      data = image.trim();
      mimeType = data.startsWith('/9j/') ? 'image/jpeg' : 'image/png';
    }
  } else if (typeof image === 'object') {
    if (Buffer.isBuffer(image.buffer)) data = image.buffer.toString('base64');
    else if (typeof image.base64 === 'string') data = image.base64.replace(/^data:image\/[a-zA-Z0-9.+]+;base64,/, '').trim();
    else if (image.data) data = bufferToBase64(image.data);
    if (image.mimeType) mimeType = image.mimeType;
  }
  if (!data) return null;
  return { inlineData: { data, mimeType } };
}

function normalizePcmPart(pcmInput, mimeType = 'audio/pcm;rate=16000') {
  let raw = pcmInput;
  if (pcmInput && typeof pcmInput === 'object') {
    if (pcmInput.pcmBuffer) raw = pcmInput.pcmBuffer;
    else if (pcmInput.audioBuffer) raw = pcmInput.audioBuffer;
    else if (pcmInput.buffer && !(pcmInput instanceof Uint8Array) && !Buffer.isBuffer(pcmInput) && !Array.isArray(pcmInput?.data)) {
      // could be { buffer: ArrayBuffer } or an actual Buffer-like wrapper; handled below
      if (pcmInput.buffer instanceof ArrayBuffer || ArrayBuffer.isView(pcmInput.buffer) || Buffer.isBuffer(pcmInput.buffer)) {
        raw = pcmInput.buffer;
      }
    }
  }
  const data = bufferToBase64(raw);
  if (!data) return null;
  return { inlineData: { data, mimeType } };
}

function collectImages(payload) {
  if (!payload || typeof payload !== 'object' || Buffer.isBuffer(payload) || payload instanceof Uint8Array) return [];
  const candidates = [];
  if (Array.isArray(payload)) {
    // array can be buffers/base64 images OR (rarely) mixed; treat as images when elements look like image data/objects with image fields
    for (const item of payload) {
      if (item && typeof item === 'object' && (item.pcmBuffer || item.audioBuffer || item.mimeType?.startsWith?.('audio/'))) continue;
      candidates.push(item);
    }
  }
  if (Array.isArray(payload.imageBuffers)) candidates.push(...payload.imageBuffers);
  if (Array.isArray(payload.images)) candidates.push(...payload.images);
  if (Array.isArray(payload.screenshots)) candidates.push(...payload.screenshots);
  if (payload.imageBase64) candidates.push(payload.imageBase64);
  if (payload.image) candidates.push(payload.image);
  if (payload.screenshot) candidates.push(payload.screenshot);
  return candidates.map(normalizeImagePart).filter(Boolean);
}

function extractText(payload) {
  if (typeof payload === 'string') {
    // Avoid treating large base64 blobs as "text queries" in ambiguous cases
    if (payload.startsWith('data:image/') || (payload.length > 500 && /^[A-Za-z0-9+/=\r\n]+$/.test(payload.slice(0, 120)))) {
      return '';
    }
    return payload;
  }
  if (!payload || typeof payload !== 'object' || Buffer.isBuffer(payload) || payload instanceof Uint8Array) return '';
  return String(payload.text || payload.prompt || payload.query || payload.transcript || '').trim();
}

function detectAudio(payload) {
  if (Buffer.isBuffer(payload) || payload instanceof Uint8Array) return normalizePcmPart(payload);
  if (!payload || typeof payload !== 'object') return null;
  if (payload.pcmBuffer || payload.audioBuffer || payload.audioPcm || payload.audioPCM) {
    return normalizePcmPart(payload.pcmBuffer || payload.audioBuffer || payload.audioPcm || payload.audioPCM);
  }
  if (typeof payload.mimeType === 'string' && payload.mimeType.startsWith('audio/pcm') && (payload.data || payload.buffer)) {
    return normalizePcmPart(payload.data || payload.buffer, payload.mimeType);
  }
  return null;
}

class LLMService {
  constructor() {
    this.client = null;
    this.isInitialized = false;
    this.requestCount = 0;
    this.errorCount = 0;
    this.activeSkill = 'General';
    this.modelName = PRIMARY_MODEL;
    // Rolling multi-turn conversation context: { role: 'user'|'model', parts: [{ text }] }
    // Capped at last 10 turns (20 messages)
    this.conversationHistory = [];
    this.maxHistoryMessages = 20;
    this.initializeClient();
  }

  clearConversationHistory() {
    this.conversationHistory = [];
    logger.info('Conversation history cleared');
    return { success: true };
  }

  _trimConversationHistory() {
    if (this.conversationHistory.length > this.maxHistoryMessages) {
      this.conversationHistory = this.conversationHistory.slice(-this.maxHistoryMessages);
    }
  }

  _appendConversationTurn(role, text) {
    const safeText = typeof text === 'string' ? text.trim() : String(text == null ? '' : text).trim();
    if (!safeText) return;
    this.conversationHistory.push({
      role: role === 'model' ? 'model' : 'user',
      parts: [{ text: safeText }],
    });
    this._trimConversationHistory();
  }

  getConversationHistory() {
    return [...this.conversationHistory];
  }

  isValidModelName(name) {
    if (typeof name !== 'string') return false;
    const v = name.trim();
    if (!v) return false;
    // Purge legacy 1.5 aliases and known invalid/non-generative strings
    if (/gemini-1\.5|gemini-3\.5-transcribe/i.test(v)) return false;
    return true;
  }

  getModelCandidates() {
    const primary = process.env.GEMINI_MODEL || coreConfig.get('llm.gemini.model') || PRIMARY_MODEL;
    const configured = coreConfig.get('llm.gemini.fallbackModels');
    const fallbacks = Array.isArray(configured) && configured.length ? configured : FALLBACK_MODELS;
    const cleanPrimary = this.isValidModelName(primary) ? primary : PRIMARY_MODEL;
    const cleanFallbacks = (fallbacks || []).filter((m) => this.isValidModelName(m));
    return [...new Set([cleanPrimary, ...cleanFallbacks].filter((m) => this.isValidModelName(m)))];
  }

  getGenerationConfig() {
    return {
      temperature: coreConfig.get('llm.gemini.temperature') ?? GENERATION_CONFIG.temperature,
      maxOutputTokens: coreConfig.get('llm.gemini.maxOutputTokens') ?? GENERATION_CONFIG.maxOutputTokens,
      topP: coreConfig.get('llm.gemini.topP') ?? GENERATION_CONFIG.topP,
    };
  }

  initializeClient(apiKey = getApiKey()) {
    const key = typeof apiKey === 'string' ? apiKey.trim() : apiKey;
    if (!key) {
      this.client = null;
      this.isInitialized = false;
      logger.warn('Gemini API key missing; LLM service not initialized.');
      return false;
    }
    this.client = new GoogleGenerativeAI(key);
    this.modelName = this.getModelCandidates()[0] || PRIMARY_MODEL;
    this.isInitialized = true;
    return true;
  }

  ensureInitialized() {
    if (this.isInitialized && this.client) return true;
    return this.initializeClient(getApiKey());
  }

  getPromptForSkill(skill, context) {
    return getPromptForSkill(skill, context);
  }

  getSystemPrompt(skill) {
    return getPromptForSkill(skill, {});
  }

  buildMultimodalParts(promptPayload, skill) {
    const audioPart = detectAudio(promptPayload);
    const imageParts = audioPart ? [] : collectImages(promptPayload); // keep simple; payloads are usually one modality + text
    // If payload is an image array or explicit image container, prefer images even if ambiguous
    const imageParts2 = imageParts.length ? imageParts : (Array.isArray(promptPayload) && !audioPart ? promptPayload.map(normalizeImagePart).filter(Boolean) : []);
    const finalImages = imageParts.length ? imageParts : imageParts2;
    const text = extractText(promptPayload);
    const parts = [];

    if (audioPart) {
      parts.push({ text: `Listen to the provided 16kHz PCM interview audio and respond for ${normalizeSkill(skill)} mode.` });
      parts.push(audioPart);
      if (text) parts.push({ text });
      return parts;
    }

    if (finalImages.length) {
      if (finalImages.length > 1) {
        parts.push({ text: 'The following images represent parts of a single problem. Read all images sequentially and provide the complete solution.' });
      } else {
        parts.push({ text: 'Analyze the provided screenshot and provide the complete solution/answer.' });
      }
      parts.push(...finalImages);
      if (text) parts.push({ text });
      return parts;
    }

    parts.push({ text: text || String(promptPayload ?? '') });
    return parts;
  }

  async *generateStream(promptPayload, activeSkill = 'General') {
    // Ensure client can be initialized (API key may be set in env/settings)
    if (!this.ensureInitialized() && !getApiKey()) {
      throw new Error('LLM service not initialized. Check Gemini API key configuration.');
    }

    const skill = normalizeSkill(activeSkill || this.activeSkill || 'General');
    this.activeSkill = skill;
    const hasAudio = !!detectAudio(promptPayload);
    const hasImages = !hasAudio && (collectImages(promptPayload).length > 0 || Array.isArray(promptPayload));
    const systemInstruction = getPromptForSkill(skill, { hasAudio, hasImages });
    const parts = this.buildMultimodalParts(promptPayload, skill);
    const generationConfig = this.getGenerationConfig();
    const candidates = this.getModelCandidates();
    this.requestCount++;

    // Multi-turn context: append new user turn (text form) and pass full contents history.
    // For audio PCM follow-ups, recent text history turns are included before the new audio part
    // by virtue of being earlier entries in `contents`.
    const userTextForHistory = extractText(promptPayload) || (hasAudio ? '[Spoken interview question (audio)]' : (hasImages ? '[Screenshot/question context]' : String(promptPayload ?? '')));
    this._appendConversationTurn('user', userTextForHistory);

    const contents = [...this.conversationHistory.slice(0, -1), { role: 'user', parts }];

    const errorLogs = [];
    let streamResult = null;
    let selectedModel = null;

    for (const modelName of candidates) {
      if (!this.isValidModelName(modelName)) continue;
      let attempts = 0;
      while (attempts < 2) {
        try {
          const apiKey = getApiKey();
          if (!apiKey) throw new Error('Missing Gemini API key');
          this.initializeClient(apiKey);
          const model = this.client.getGenerativeModel({
            model: modelName,
            systemInstruction,
            generationConfig,
          });

          console.log(`[LLM Request] Attempting ${modelName} (attempt ${attempts + 1}/2)...`);
          streamResult = await model.generateContentStream({ contents });
          selectedModel = modelName;
          this.modelName = modelName;
          break;
        } catch (error) {
          const errMsg = `[${modelName}]: ${error?.message || String(error)}`;
          console.error(errMsg);
          logger.warn('generateStream model attempt failed', { modelName, attempt: attempts + 1, error: error?.message });
          errorLogs.push(errMsg);
          this.errorCount++;

          // Catch 429 / quota / resource exhausted => rotate key and retry same model (up to 2 attempts)
          const msg = `${error?.message || ''}`.toLowerCase();
          if (msg.includes('429') || msg.includes('resource_exhausted') || msg.includes('quota') || msg.includes('too many requests') || msg.includes('rate limit')) {
            rotateApiKey();
            attempts++;
            continue;
          }

          // Non-quota errors (404, not found, not supported, auth failure, etc.) => move to next fallback model
          break;
        }
      }
      if (streamResult) break;
    }

    if (!streamResult) {
      // Remove the optimistic user turn if the request could not be started on any model
      if (this.conversationHistory.length && this.conversationHistory[this.conversationHistory.length - 1]?.role === 'user') {
        this.conversationHistory.pop();
      }
      const diagnostics = errorLogs.length ? errorLogs.join('\n') : 'No model attempts were made (check API key/model config).';
      throw new Error(`All Gemini models failed. Diagnostics:\n${diagnostics}`);
    }

    // Yield stream tokens to caller and capture full assistant response for follow-up context
    let fullAssistantResponse = '';
    let completed = false;
    try {
      for await (const chunk of streamResult.stream) {
        const rawToken = typeof chunk?.text === 'function' ? chunk.text() : (chunk?.text || '');
        const token = sanitizeStreamToken(rawToken, skill);
        if (token) {
          fullAssistantResponse += token;
          // Yield a normalized chunk shape so downstream renderers never see code fences in DSA/Programming
          yield { text: () => token, raw: chunk };
        }
      }
      completed = true;
    } catch (streamErr) {
      // If streaming fails mid-flight, report clearly (primary/candidate root cause preserved above when setup fails)
      const msg = streamErr?.message || String(streamErr);
      throw new Error(`Gemini stream failed after connecting to ${selectedModel}. ${msg}\nDiagnostics:\n${errorLogs.join('\n')}`);
    } finally {
      if (completed) {
        const finalAssistant = String(fullAssistantResponse || '').trim();
        if (finalAssistant.startsWith('[NO_QUESTION]')) {
          // Non-question acknowledgment: do not pollute multi-turn context
          if (this.conversationHistory.length && this.conversationHistory[this.conversationHistory.length - 1]?.role === 'user') {
            this.conversationHistory.pop();
          }
        } else {
          this._appendConversationTurn('model', finalAssistant);
        }
      } else {
        // Keep history consistent on interrupted/failed streams by removing dangling user turn
        if (this.conversationHistory.length && this.conversationHistory[this.conversationHistory.length - 1]?.role === 'user') {
          this.conversationHistory.pop();
        }
      }
    }
  }

  async *streamFromScreenshots(screenshotBuffers, activeSkill = 'DSA') {
    const buffers = Array.isArray(screenshotBuffers) ? screenshotBuffers : (screenshotBuffers ? [screenshotBuffers] : []);
    yield* this.generateStream({ imageBuffers: buffers, text: '' }, activeSkill || 'DSA');
  }

  async *streamAnswerFromText(promptText, activeSkill = 'General') {
    yield* this.generateStream(promptText, activeSkill);
  }

  async streamAnswerFromAudioPCM(accumulatedPCMBuffer, activeSkill = 'General', onTokenCallback = null) {
    let fullResponse = '';
    for await (const chunk of this.generateStream(accumulatedPCMBuffer, activeSkill)) {
      const token = typeof chunk.text === 'function' ? chunk.text() : (chunk?.text || '');
      if (token) {
        fullResponse += token;
        if (typeof onTokenCallback === 'function') onTokenCallback(token);
      }
    }
    return fullResponse.trim();
  }

  async generateAnswerFromAudio(audioData, activeSkill = 'General', onChunk = null) {
    let full = '';
    let isFirst = true;
    for await (const chunk of this.generateStream(audioData, activeSkill)) {
      const token = typeof chunk.text === 'function' ? chunk.text() : (chunk?.text || '');
      if (token) {
        full += token;
        if (typeof onChunk === 'function') {
          onChunk(token, isFirst, full);
          isFirst = false;
        }
      }
    }
    return {
      response: full.trim(),
      metadata: { skill: normalizeSkill(activeSkill), model: this.modelName, isAudioResponse: true },
    };
  }

  async generateResponseText(promptText, activeSkill = 'General', onChunk = null) {
    if (!promptText || typeof promptText !== 'string' || promptText.trim().length === 0) return '';
    let full = '';
    let isFirst = true;
    try {
      for await (const chunk of this.generateStream(promptText, activeSkill)) {
        const token = typeof chunk.text === 'function' ? chunk.text() : (chunk?.text || '');
        if (token) {
          full += token;
          if (typeof onChunk === 'function') {
            onChunk(token, isFirst, full);
            isFirst = false;
          }
        }
      }
      return full.trim();
    } catch (error) {
      logger.error('generateResponseText failed', { error: error.message, skill: activeSkill });
      return `Error generating response: ${error.message}`;
    }
  }

  async generateResponse(input, skillContext = {}, onChunk = null) {
    let activeSkill = 'General';
    let payload = input;

    if (typeof skillContext === 'string') {
      activeSkill = skillContext;
    } else if (skillContext && typeof skillContext === 'object') {
      activeSkill = skillContext.skill || skillContext.activeSkill || skillContext.skillName || 'General';
      // Merge context (text/images) with input for multimodal
      if (!Buffer.isBuffer(input) && !(input instanceof Uint8Array)) {
        if (Array.isArray(input)) {
          payload = { imageBuffers: input, text: skillContext.text || '' };
        } else if (typeof input === 'string') {
          const isBase64Image = input.startsWith('data:image/') || (input.length > 500 && /^[A-Za-z0-9+/=\r\n]+$/.test(input.slice(0, 120)));
          payload = isBase64Image
            ? { imageBuffers: [input], text: skillContext.text || '' }
            : { text: input || skillContext.text || '' };
        } else if (input && typeof input === 'object') {
          payload = { ...skillContext, ...input };
        } else {
          payload = { ...skillContext };
        }
      }
      if (Array.isArray(skillContext.imageBuffers) && skillContext.imageBuffers.length) {
        payload = { ...(typeof payload === 'object' ? payload : {}), imageBuffers: skillContext.imageBuffers, text: (payload && payload.text) || skillContext.text || '' };
      }
    }

    let full = '';
    let isFirst = true;
    for await (const chunk of this.generateStream(payload, activeSkill)) {
      const token = typeof chunk.text === 'function' ? chunk.text() : (chunk?.text || '');
      if (!token) continue;
      full += token;
      if (typeof onChunk === 'function') {
        try {
          if (onChunk.length >= 3) onChunk(token, isFirst, full);
          else onChunk(token);
        } catch (_) {
          onChunk(token);
        }
        isFirst = false;
      }
    }
    return {
      response: full.trim(),
      text: () => full.trim(),
      metadata: { skill: normalizeSkill(activeSkill), model: this.modelName },
    };
  }

  async generateFromScreenshots(imageBuffers, skillMode = 'DSA') {
    // Back-compat: return a stream-like async iterable when possible? Root callers vary.
    // Provide an object with a .stream async iterable matching older usage.
    const gen = this.generateStream({ imageBuffers, text: '' }, skillMode);
    return gen;
  }

  async generateResponseFromScreenshots(imageBuffers, skillMode = 'DSA') {
    return this.generateFromScreenshots(imageBuffers, skillMode);
  }

  // Backward-compatible helper used by speech.service/root flows in some versions
  async transcribeAudioWithGemini() {
    throw new Error('Two-step transcription is disabled. Use single-pass multimodal PCM audio via generateStream().');
  }

  updateApiKey(newApiKey) {
    const trimmed = typeof newApiKey === 'string' ? newApiKey.trim() : newApiKey;
    if (trimmed) process.env.GEMINI_API_KEY = trimmed;
    this.isInitialized = false;
    this.initializeClient(trimmed || getApiKey());
    return { success: true, model: this.modelName };
  }

  getStats() {
    return {
      isInitialized: this.isInitialized,
      requestCount: this.requestCount,
      errorCount: this.errorCount,
      successRate: this.requestCount > 0 ? ((this.requestCount - this.errorCount) / this.requestCount) * 100 : 0,
      model: this.modelName,
      models: this.getModelCandidates(),
      generationConfig: this.getGenerationConfig(),
    };
  }

  async testConnection() {
    try {
      if (!this.ensureInitialized()) return { success: false, error: 'Service not initialized' };
      const text = await this.generateResponseText('Respond with OK.', 'General');
      const ok = /ok/i.test(text);
      return { success: ok, response: text, model: this.modelName, error: ok ? null : 'Unexpected response' };
    } catch (error) {
      return { success: false, error: error.message, model: this.modelName };
    }
  }
}

const llmServiceInstance = new LLMService();

module.exports = llmServiceInstance;
module.exports.LLMService = LLMService;
module.exports.getPromptForSkill = getPromptForSkill;
module.exports.getSystemPrompt = (skill) => getPromptForSkill(skill, {});
module.exports.getSystemPromptForSkill = (skill) => getPromptForSkill(skill, {});
module.exports.GENERATION_CONFIG = GENERATION_CONFIG;
module.exports.MODEL_NAME = PRIMARY_MODEL;
module.exports.PRIMARY_MODEL = PRIMARY_MODEL;
module.exports.FALLBACK_MODELS = FALLBACK_MODELS;
module.exports.clearConversationHistory = () => llmServiceInstance.clearConversationHistory();
module.exports.getConversationHistory = () => llmServiceInstance.getConversationHistory();
module.exports.streamFromScreenshots = (buffers, skill) => LLMService.prototype.streamFromScreenshots.call(llmServiceInstance, buffers, skill);
module.exports.generateFromScreenshots = (buffers, skill) => LLMService.prototype.generateFromScreenshots.call(llmServiceInstance, buffers, skill);
module.exports.generateResponseFromScreenshots = (buffers, skill) => LLMService.prototype.generateResponseFromScreenshots.call(llmServiceInstance, buffers, skill);
