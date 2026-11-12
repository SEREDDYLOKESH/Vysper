# Vysper

**Ultra-low-latency, stealth desktop AI interview & Group Discussion assistant**

Vysper is an Electron-based desktop assistant designed for real-time interview and group-discussion support. It combines 16kHz in-memory PCM audio capture (microphone + best-effort system audio loopback), screenshot-based problem solving, and Google Gemini multimodal streaming to deliver fast, context-aware responses in a stealthy overlay workflow.

> **Important:** Use Vysper responsibly and in compliance with interview/platform policies, consent requirements, and local laws.

## Project Overview & Architecture

Vysper is built as a desktop Electron app with a main process orchestrating capture, IPC, session state, and Gemini requests, plus renderer windows for the main overlay and chat/transcription UI.

- **Electron (Main + Renderer processes)**
  - **Main process (`main.js`, managers/services):** global hotkeys, window lifecycle/visibility, screenshot queue + submission, IPC routing, streaming broadcast to windows, session/event coordination.
  - **Renderer UI (`index.html`, `chat.html`, `llm-response.html`, `src/ui/*`):** stealth toolbar/main overlay, live transcription & chat panel, unified response rendering, queue/status badges, copy controls.
- **Node.js services (`src/services/*`, `src/core/*`, `src/managers/*`)**
  - Gemini request orchestration, prompt/skill routing, API key rotation/failover, screenshot/OCR buffering, speech/diagnostics/session support.
- **Web Audio API (Renderer, 16kHz PCM in-memory)**
  - Captures microphone audio as 16k-bit PCM at 16kHz, mixes best-effort desktop/system loopback audio when available, runs RMS Voice Activity Detection (VAD) for utterance segmentation, and streams audio for single-pass multimodal analysis (no temp-file transcription pipeline).
- **Google Gemini multimodal streaming**
  - Uses Gemini (default target: **`gemini-2.5-flash`**, configurable via `GEMINI_MODEL`) with streaming responses for text, queued screenshots, and audio PCM turns.
  - Supports a multi-key API pool for automatic rotation/retry on quota/rate-limit failures (HTTP 429 / `RESOURCE_EXHAUSTED`).

## Key Features

- **Real-time continuous audio capture (mic + system loopback)**
  - 16kHz PCM in-memory capture pipeline with best-effort system audio loopback mixing.
  - RMS-based Voice Activity Detection (VAD) for utterance flush/continuous listening flow.
  - Short filler-word / acknowledgment filtering to reduce accidental triggers from brief non-question audio (and non-question guard handling).

- **Multi-screenshot queuing for long coding/problems**
  - Queue multiple screenshots before submitting, ideal for multi-part or long-scrolling interview questions.
  - Capture queue flow: `Ctrl+Shift+S` to queue, `Ctrl+Enter` to solve/analyze all queued screenshots together.

- **Skill-based prompt routing with clean code output**
  - Skill modes such as **DSA**, **Programming**, **General**, and **Behavioral** tailor response behavior.
  - DSA/Programming responses are optimized for clean, copyable code with unified overlay rendering and indentation-preserving display/copy.

- **Rolling multi-turn conversation memory (chat follow-ups)**
  - Maintains rolling in-memory conversation context (capped) for follow-up questions in the side chat / voice-text flow.
  - Supports clearing context to start a fresh topic without stale carryover.

- **Multi-API key pool rotation (quota/rate-limit resilience)**
  - Configure multiple Gemini API keys (`GEMINI_API_KEY_1/2/3`) for automatic failover/rotation on quota or rate-limit errors (e.g. HTTP 429), improving continuity during long sessions.

- **Stealth overlay workflow**
  - Toggle full overlay visibility (including header/toolbar), side chat window, and live listening state via global hotkeys.
  - Unified response panel with streaming updates and one-click copy support.

## How to Create Gemini API Keys (Step-by-Step)

1. Go to **[Google AI Studio](https://aistudio.google.com/app/apikey)**.
2. Click **Create API Key**.
3. Select **Create API key in new project**.
   - **Why a new project matters:** each Google Cloud project gets its own API quota context for Gemini API usage, so creating keys in separate projects can provide independent daily free-tier/quota buckets for failover rotation.
4. Copy the generated key and paste it into your `.env` as `GEMINI_API_KEY_1`.
5. (Recommended for automatic failover) Repeat steps 2–4 in **2–3 separate projects** and add them as:
   - `GEMINI_API_KEY_2=...`
   - `GEMINI_API_KEY_3=...`

> Vysper will rotate across configured keys automatically when quota/rate-limit conditions are encountered.

## Installation & Setup

### Prerequisites
- **Node.js** (LTS recommended) and **npm**
- **Git**
- A working microphone (and system audio loopback support depends on OS/permissions/configuration)
- Internet access for Gemini API requests

### Commands

```bash
git clone https://github.com/SEREDDYLOKESH/Vysper.git
cd Vysper
npm install
cp env.example .env
```

### Configure `.env`

Open `.env` and paste your Gemini API keys (and optional model override):

```env
GEMINI_API_KEY_1=your_primary_key_here
GEMINI_API_KEY_2=your_backup_key_here
GEMINI_API_KEY_3=your_third_key_here
GEMINI_MODEL=gemini-2.5-flash
```

- `GEMINI_API_KEY_1` is required for normal Gemini-powered responses.
- `GEMINI_API_KEY_2` / `GEMINI_API_KEY_3` are optional but recommended for automatic failover rotation.
- `GEMINI_MODEL` defaults to `gemini-2.5-flash` in `env.example` (you can change it to another model available to your API key/project).

### Run the app

```bash
npm start
```

### Build/package desktop executable

```bash
npm run build
```

> Build output/configuration depends on the project’s Electron packaging setup (`electron-builder` scripts/config in this repository).

## Complete Global Hotkeys & Controls

| Hotkey | Action |
| --- | --- |
| `Ctrl + Shift + H` | Toggle full stealth visibility (hides/shows entire main overlay including header) |
| `Ctrl + Shift + C` | Toggle Live Transcription & Chat window |
| `Ctrl + Shift + S` | Capture & queue screenshot into buffer (supports multiple screenshots) |
| `Ctrl + Enter` | Submit all queued screenshots for AI analysis |
| `Ctrl + Shift + Backspace` | Clear queued screenshots |
| `Alt + R` | Start/stop continuous live voice & system loopback recording |
| `Ctrl + Shift + X` | Clear conversation context / start new topic |

### Additional useful controls (implemented)
- `Ctrl + Shift + Y` — Copy the current main overlay response/code (exact text) to clipboard
- `Ctrl + Enter` / `Ctrl + Shift + Enter` — Both submit queued screenshots for analysis (equivalent submit action)

## Notes on Privacy, Permissions, and Reliability

- **Microphone / desktop capture permissions** may be required depending on your OS and Electron runtime behavior.
- **System audio loopback** availability is best-effort and may vary by platform/device setup.
- **Model availability** can vary by account/project/region; if you see model-not-found errors, set `GEMINI_MODEL` to a model available to your key.
- **Do not commit `.env`** or API keys. This repo includes `.gitignore` rules and `env.example` placeholders for safe setup.

## Repository
- GitHub: https://github.com/SEREDDYLOKESH/Vysper
