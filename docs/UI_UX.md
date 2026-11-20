# TruthLens AI — UI/UX Architecture

## Workspace Layout Shell
- **Landing View (`/`)**: Clean 3-zone top navigation bar (Wordmark · 4 concise section links · `"Start Investigation"` CTA), split hero with scientific forensic instrument graphic (`16:9`), workflow architecture (`INGEST -> ANALYZE -> CORRELATE -> REVIEW -> REPORT`), multimodal modality breakdown, evidence traceability guarantee, and quiet footer.
- **Application Console Shell (Pages 2–15)**:
  - Collapsible/responsive `248px` left rail grouped into:
    - **Case Operations**: Dashboard, Active Workspace, Investigation History
    - **Modality Labs**: Evidence Upload, Image Forensics, Video Forensics, Audio Forensics, Text Intelligence
    - **Synthesis & Oversight**: Cross-Modal Graph, Forensic Copilot, Agent Activity, Reports, Model Evaluation, Settings
  - Top contextual header with active case selector, global search input, notification drawer trigger (real backend audit events), and investigator profile menu.

## Key Interactive Visualizations
- **Image Forensics**: Dual-mode interactive canvas with zoom (`0.5x–4x`), pan, split/toggle overlay (`Original` | `ELA Residual` | `High-Pass Noise`), and EXIF/hash inspection drawer.
- **Video Forensics**: Synchronized HTML5 player + clickable keyframe strip + Recharts temporal luminance/noise drift chart; clicking any frame marker seeks the video to that exact timestamp.
- **Audio Forensics**: HTML5 audio player + clickable RMS waveform & frequency-band spectrogram chart; clicking any speech/anomaly segment seeks and plays that window.
- **Cross-Modal Graph**: Interactive SVG/force-positioned evidence correlation graph showing directional edges (`SUPPORTS`, `CONTRADICTS`, `TEMPORAL_ALIGN`, `ALTERNATIVE`) with clickable edge inspector detailing evidence IDs and benign explanations.
