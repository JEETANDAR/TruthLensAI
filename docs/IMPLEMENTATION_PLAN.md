# TruthLens AI — Implementation Plan

## Phase 1: Foundation & Persistence
- Database schema (`server/db/schema.ts`), SQLite connection (`better-sqlite3`), seed pipeline (`server/db/seed.ts`) generating real synthetic multimodal evidence files (original + localized-tamper briefing image, synthetic MP4 test video with FFmpeg, synthetic dual-tone/voice-band WAV audio, and contradicting transcript/SRT).

## Phase 2: Forensic Engine & Trained ML Pipeline
- `server/ml/trainer.ts`: Reproducible calibration dataset generator, 70/30 held-out train/test split, Random Forest & Logistic Regression training, ROC-AUC / Precision / Recall / F1 / Confusion Matrix computation, persisted to `models/`.
- `server/forensics/image.ts`: Sharp ELA residual generator, high-pass noise metrics, EXIF parser, blockiness ratio.
- `server/forensics/video.ts`: FFprobe metadata + FFmpeg sampled keyframes + per-frame Sharp analysis + temporal drift.
- `server/forensics/audio.ts`: FFmpeg PCM extraction + waveform envelope + FFT spectrogram bands + speech segment detection.
- `server/forensics/text.ts`: TXT/JSON/SRT parser + timestamp alignment checks.

## Phase 3: Multi-Agent Orchestrator & Gemini AI
- `server/ai/gemini.ts`: `@google/genai` client (`gemini-4-hydrogen`) with retry & structured schemas.
- `server/agents/orchestrator.ts`: 9-agent dependency-aware DAG runner writing real execution records to `agent_executions`.

## Phase 4: Express API & PDF Reporting
- Modular REST endpoints under `server/routes/` + `server/reports/pdf.ts` using PDFKit.

## Phase 5: Frontend Design System & 15 Forensic Pages
- Custom dark obsidian design tokens in `src/index.css`, responsive sidebar console, interactive viewers, Recharts visualizations, SVG correlation graph, and Copilot interface.

## Phase 6: Automated Verification & Live Test
- End-to-end API, ML, forensic, and build verification (`tsc --noEmit`, `vite build`, `tsx` test suite, live curl/browser verification).
