# TruthLens AI — Technical Requirements Document (TRD)

## 1. Environment Adaptation & Runtime Reality
Hardware inspection of the host sandbox confirmed:
- **OS**: Linux x86_64 (`4.19.0-gvisor`)
- **CPU / RAM**: 2 vCPUs, 4.0 GiB RAM, 0 B Swap, **no GPU**
- **Available Binaries**: Node.js `v22.23.2`, FFmpeg/FFprobe `4.4.2`, Python `3.11.2` (stdlib only, no `pip` / PyTorch / FastAPI)
- **Applet Runtime**: Single-origin Express + Vite middleware server on Port `3000` (`server.ts`).

Because PyTorch/GPU deepfake transformers (DeepfakeBench, AASIST) cannot run within a 4 GiB CPU-only container without `pip`, TruthLens AI implements a **modular monolithic TypeScript + Express backend** (`server.ts` + `server/`) with genuine native C++/CLI forensic tooling:
- **SQLite (`better-sqlite3`)**: WAL-mode relational database with foreign keys, indexes, and 13 normalized tables.
- **Image Forensics (`sharp` + `exif-parser`)**: Real pixel-buffer Error Level Analysis (JPEG recompression at quality 90 -> per-pixel residual amplification PNG), local Laplacian/high-pass noise variance, block-boundary artifact index, and binary EXIF tag extraction.
- **Video Forensics (`ffmpeg` / `ffprobe`)**: Real metadata probing, deterministic keyframe extraction (`fps` sampling), per-frame Sharp ELA & noise analysis, and inter-frame luminance/structural temporal drift tracking.
- **Audio Forensics (`ffmpeg` PCM extraction + DSP)**: Real 16kHz mono PCM decoding via FFmpeg, RMS envelope waveform extraction, radix-2 FFT spectrogram band energy, zero-crossing rate, spectral flatness, and segment energy boundary detection.
- **Genuine Trained ML Classifiers**:
  - `TL-ImgForensics-RF-v1` (Random Forest / Ensemble Decision Trees) and `TL-ImgForensics-LR-v1` (Regularized Logistic Regression) trained on extracted 8-dimensional forensic signal vectors from a labeled synthetic+benchmark calibration dataset (`datasets/calibration_dataset.json`), persisted as deterministic model weights (`models/image_forensics_model.json`), evaluated on a held-out 30% test split with exact Confusion Matrix, Precision, Recall, F1, FPR, and ROC-AUC.
  - `TL-AudSpoof-LR-v1` (Logistic Regression on acoustic spectral flatness, ZCR variance, high-frequency rolloff, and frame-energy kurtosis), evaluated on a held-out acoustic test split.
- **Gemini Intelligence (`@google/genai`, `gemini-4-hydrogen`)**: Server-side structured JSON reasoning for evidence correlation, alternative explanations, text contradiction detection, Copilot RAG Q&A, and narrative synthesis—with clean fallback when `GEMINI_API_KEY` is unavailable or quota-limited.
- **PDF Reporting (`pdfkit`)**: Server-generated multi-section forensic PDF dossier streamed directly to `/api/investigations/:id/reports/:reportId/pdf`.

## 2. Performance & Security Budgets
- Max upload size: `50 MB` per file; MIME + extension whitelist validation.
- Subprocess timeout: `20,000 ms` on `ffmpeg` / `ffprobe` executions with sanitized argument arrays (`execFile`, never shell string interpolation).
- Path traversal prevention: `path.basename` + UUID storage keys under `storage/uploads/`.
- Original evidence files remain immutable; derived artifacts (ELA maps, spectrograms, keyframes) live under `storage/artifacts/`.
