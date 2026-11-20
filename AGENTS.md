# TruthLens AI — Multi-Agent Architecture (`AGENTS.md`)

TruthLens AI coordinates **9 specialized forensic agents** through a dependency-aware orchestrator (`server/agents/orchestrator.ts`). Every agent operates strictly on persisted evidence and forensic measurements—never hallucinating raw pixel/audio metrics.

| # | Agent | Responsibility | Trigger Condition | Inputs | Outputs |
|---|---|---|---|---|---|
| 1 | **Evidence Intelligence Agent** | Catalogs ingested files, verifies SHA-256 hashes, inventories modalities, plans required downstream agents. | Always first | Investigation + Evidence rows | Execution plan, hash integrity summary |
| 2 | **Image Forensics Agent** | Runs Sharp ELA, noise variance, EXIF integrity check, and `TL-ImgForensics-RF-v1` inference. | Only if image evidence exists | Image `evidence` records | `forensic_analyses` + `model_predictions` + ELA PNGs |
| 3 | **Video Investigation Agent** | Runs FFprobe metadata, FFmpeg keyframe sampling, per-frame ELA/noise drift, and temporal anomaly detection. | Only if video evidence exists | Video `evidence` records | Keyframe artifacts, temporal drift metrics |
| 4 | **Audio Investigation Agent** | Extracts PCM via FFmpeg, computes waveform/spectrogram/flatness, detects speech segments, runs `TL-AudSpoof-LR-v1`. | Only if audio evidence exists | Audio `evidence` records | Waveform, band energies, spoofing scores |
| 5 | **Text Intelligence Agent** | Parses TXT/JSON/SRT, compares claims/timestamps, invokes Gemini for grounded textual inconsistency analysis. | Only if text evidence exists | Text `evidence` + context | Claim/timestamp findings |
| 6 | **Cross-Modal Correlation Agent** | Correlates timestamps, metadata, and anomalies across modalities; builds directional evidence graph edges. | After modality agents complete | All modality `forensic_analyses` | `evidence_correlations` edges |
| 7 | **Risk Assessment Agent** | Aggregates ML predictions, uncertainty margins, and corroboration strength without overstating proof. | After Correlation Agent | Predictions + Correlations | Calibrated assessment summary |
| 8 | **Alternative Explanation Agent** | Generates plausible benign causes (re-encoding, social media compression, mic clipping, transcription drift). | After Risk Assessment | Observed indicators + metadata | Benign alternative hypotheses |
| 9 | **Report Generation Agent** | Compiles executive summary, evidence citations, limitations, and recommended human checks. | On pipeline finish or report request | Full case state | `investigation_reports` draft |
