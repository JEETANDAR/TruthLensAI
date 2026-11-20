# TruthLens AI — Security & Evidence Integrity Specification

## 1. Evidence Chain of Custody
- **Immutable Originals**: Uploaded files are hashed (`SHA-256`) at ingestion and written once with randomized UUID filenames under `storage/uploads/`. No processing step modifies the original evidence bytes.
- **Integrity Verification**: Re-hashing any stored file on demand verifies zero tampering post-ingest (`GET /api/evidence/:id/verify`).

## 2. Upload & File Handling Controls
- **Allowlisted Extensions**: `.jpg`, `.jpeg`, `.png`, `.webp`, `.mp4`, `.mov`, `.wav`, `.mp3`, `.txt`, `.json`, `.srt`.
- **MIME Validation**: Verified against expected media categories.
- **Size Limit**: 50 MB hard cap enforced in `multer` and Express error handler.
- **Path Traversal Prevention**: All storage paths are resolved via `path.basename` + UUIDs and verified to remain inside `path.resolve('storage')`.
- **No Execution**: Uploaded files are never executed or evaluated as code.

## 3. Subprocess & API Security
- **Safe FFmpeg / FFprobe Execution**: Invoked strictly via `child_process.execFile` with fixed argument arrays and a `20s` timeout (`killSignal: 'SIGKILL'`), preventing shell injection.
- **Server-Only Secrets**: `GEMINI_API_KEY` is read exclusively in `server/ai/gemini.ts` and never serialized to client bundles or settings endpoints.
- **Audit Logging**: Every upload, analysis execution, agent run, Copilot query, and report export appends an immutable record to `audit_logs`.
- **Consent Gate for External AI**: Raw binary media is NOT transmitted to Gemini by default; only investigator-initiated local forensic summaries/transcripts are sent, with an explicit toggle in Settings for multimodal AI inspection.
