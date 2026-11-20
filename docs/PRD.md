# TruthLens AI — Product Requirements Document (PRD)

## 1. Product Vision
**TruthLens AI** ("See Beyond the Surface. Verify What You See.") is a multimodal digital forensics and media authenticity investigation platform. Rather than issuing opaque binary "fake/real" labels, TruthLens AI equips investigators with traceable forensic evidence across **images, video, audio, and text**, combining signal-level forensic extraction, calibrated machine learning classifiers, multi-agent reasoning, cross-modal correlation, and human-reviewable PDF reporting.

## 2. Core Workflow
Every investigation follows the five-stage forensic lifecycle:
`INGEST -> ANALYZE -> CORRELATE -> REVIEW -> REPORT`

## 3. Target Users & Roles
- **Lead Forensic Investigator**: Creates investigations, uploads evidence, inspects ELA/noise/waveform/frame anomalies, reviews cross-modal contradictions, records investigator determinations, and exports signed forensic reports.
- **Technical Reviewer / Model Auditor**: Audits model lineage, confusion matrices, ROC-AUC, false-positive rates, and known evaluation limitations in the Model Evaluation Centre.

## 4. Functional Scope (15 Views)
1. **Landing Page (`/`)**: Product architecture, optical/spectral console showcase, workflow walkthrough, and immediate CTA to launch investigations.
2. **Main Dashboard (`/dashboard`)**: Live investigation metrics from SQLite, media-type distribution, detection history charts, global search, and recent agent runs.
3. **Investigation Workspace (`/investigations/:id`)**: Central case hub uniting evidence collection, inline processing progress, correlation findings, agent activity, and investigator notes.
4. **Evidence Upload Studio (`/investigations/:id/upload`)**: Drag-and-drop ingestion for JPG, JPEG, PNG, WEBP, MP4, MOV, WAV, MP3, TXT, JSON, SRT with client & server MIME/size checks, SHA-256 hashing, and contextual notes.
5. **Image Forensics (`/investigations/:id/image/:evidenceId?`)**: Interactive pan/zoom viewer, Original vs. Error Level Analysis (ELA) vs. Noise Residual comparison, EXIF inspection, dimensions, compression metrics, and ML classifier output.
6. **Video Forensics (`/investigations/:id/video/:evidenceId?`)**: HTML5 video player, FFprobe metadata (codec, FPS, duration, resolution), sampled frame strip with exact timestamps, inter-frame temporal drift chart, and clickable suspicious frame markers.
7. **Audio Forensics (`/investigations/:id/audio/:evidenceId?`)**: Audio player, time-domain waveform, spectral centroid / energy spectrogram visualization, speech segments, clickable segment playback, and acoustic spoofing ML classifier results.
8. **Text Intelligence (`/investigations/:id/text/:evidenceId?`)**: Transcript, caption, JSON, and SRT ingestion with claim/timestamp/contradiction analysis grounded via Gemini.
9. **Cross-Modal Investigation (`/investigations/:id/correlate`)**: Interactive evidence relationship graph, synchronized correlation timeline, supporting vs. weakening indicators, contradictions, and alternative benign explanations.
10. **AI Forensic Copilot (`/investigations/:id/copilot`)**: Evidence-grounded investigation assistant backed by SQLite retrieval and `@google/genai`, requiring traceable evidence IDs for factual claims.
11. **AI Agent Activity (`/agents`)**: Real-time and historical execution ledger for all 9 specialized forensic agents.
12. **Investigation Reports (`/investigations/:id/reports`)**: Structured report preview, audit history, investigator determination sign-off, and downloadable binary PDF via PDFKit.
13. **Model Evaluation Centre (`/models`)**: Transparent registry of active ML models, datasets, licenses, held-out Precision, Recall, F1, ROC-AUC, FPR, confusion matrices, and limitations.
14. **Investigation History (`/history`)**: Searchable, filterable archive of all past cases with evidence counts, assessments, and reopening.
15. **Settings (`/settings`)**: Investigator profile, backend Gemini configuration status (read-only), storage telemetry, privacy/retention controls, and system health diagnostics.

## 5. Non-Negotiable Epistemic Principles
- Distinguish explicitly between **Observed Forensic Evidence**, **ML Model Predictions**, **AI Interpretations**, and **Human Investigator Conclusions**.
- Never fabricate forensic findings, localization masks, or unverified metrics.
- Never claim full-frame video analysis when only sampled keyframes were extracted.
- Surface uncertainty, confidence bounds, and benign alternative explanations alongside every anomaly.
