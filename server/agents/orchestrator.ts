import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { ARTIFACTS_DIR } from '../config.ts';
import { getDb, logAudit } from '../db/database.ts';
import { runImageForensics } from '../forensics/image.ts';
import { runVideoForensics } from '../forensics/video.ts';
import { runAudioForensics } from '../forensics/audio.ts';
import { runTextForensics } from '../forensics/text.ts';
import { runDatasetForensics, type DatasetAnalysisResult } from '../forensics/dataset.ts';
import { generateGeminiSynthesis, retrieveCaseContext, transcribeAudioFile } from '../ai/gemini.ts';

function genId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

export interface PipelineJobState {
  investigationId: string;
  status: 'running' | 'completed' | 'cancelled' | 'failed';
  currentStage: string;
  progressPct: number;
  startedAt: string;
  completedAt?: string;
  error?: string;
  cancelRequested: boolean;
}

const activePipelineJobs = new Map<string, PipelineJobState>();

export function getPipelineJobStatus(investigationId: string): PipelineJobState | null {
  return activePipelineJobs.get(investigationId) || null;
}

export function cancelInvestigationPipeline(investigationId: string): boolean {
  const job = activePipelineJobs.get(investigationId);
  if (!job || job.status !== 'running') return false;
  job.cancelRequested = true;
  return true;
}

function updateJobStage(investigationId: string, stage: string, progressPct: number): void {
  const job = activePipelineJobs.get(investigationId);
  if (job && job.status === 'running') {
    job.currentStage = stage;
    job.progressPct = progressPct;
  }
}

function isJobCancelled(investigationId: string): boolean {
  return Boolean(activePipelineJobs.get(investigationId)?.cancelRequested);
}

interface EvidenceRow {
  id: string;
  investigation_id: string;
  original_filename: string;
  storage_path: string;
  mime_type: string;
  modality: 'image' | 'video' | 'audio' | 'text' | 'dataset';
  file_size: number;
  sha256_hash: string;
  context_note: string;
}

const agentStartTimes = new Map<string, number>();

function recordAgentStart(
  investigationId: string,
  agentName: string,
  responsibility: string,
  inputSummary: Record<string, unknown>,
  relatedEvidenceIds: string[],
): string {
  const db = getDb();
  const id = genId('AGT');
  agentStartTimes.set(id, Date.now());
  db.prepare(
    `INSERT INTO agent_executions
    (id, investigation_id, agent_name, responsibility, status, started_at, input_summary_json, related_evidence_ids_json)
    VALUES (?, ?, ?, ?, 'running', ?, ?, ?)`,
  ).run(
    id,
    investigationId,
    agentName,
    responsibility,
    new Date().toISOString(),
    JSON.stringify(inputSummary),
    JSON.stringify(relatedEvidenceIds),
  );
  return id;
}

function recordAgentComplete(
  execId: string,
  status: 'completed' | 'skipped' | 'failed',
  findings: Record<string, unknown>,
  errorMessage: string | null = null,
): void {
  const startedMs = agentStartTimes.get(execId);
  const durationMs = typeof startedMs === 'number' ? Math.max(1, Date.now() - startedMs) : null;
  agentStartTimes.delete(execId);
  getDb()
    .prepare(
      `UPDATE agent_executions
       SET status = ?, completed_at = ?, findings_json = ?, error_message = ?
       WHERE id = ?`,
    )
    .run(status, new Date().toISOString(), JSON.stringify({ ...findings, durationMs }), errorMessage, execId);
}

export async function runInvestigationPipeline(
  investigationId: string,
  actor = 'Investigator',
): Promise<{
  status: string;
  agentsExecuted: number;
  correlationsCreated: number;
  geminiUsed: boolean;
  geminiError?: string;
  rawMediaSent: boolean;
  failedAgents: Array<{ agent: string; error: string }>;
}> {
  const db = getDb();
  const inv = db.prepare(`SELECT * FROM investigations WHERE id = ?`).get(investigationId) as
    | { id: string; title: string; case_code: string }
    | undefined;
  if (!inv) throw new Error(`Investigation ${investigationId} not found`);

  const evidenceList = db
    .prepare(`SELECT * FROM evidence WHERE investigation_id = ? ORDER BY uploaded_at ASC`)
    .all(investigationId) as EvidenceRow[];

  if (evidenceList.length === 0) {
    throw new Error('Cannot execute forensic pipeline on an empty investigation. Upload evidence first.');
  }

  const existingJob = activePipelineJobs.get(investigationId);
  if (existingJob && existingJob.status === 'running') {
    throw new Error('Forensic analysis pipeline is already running for this investigation.');
  }

  db.prepare(`UPDATE investigations SET status = 'analyzing', updated_at = ? WHERE id = ?`).run(
    new Date().toISOString(),
    investigationId,
  );

  // Clear previous pipeline results for clean re-run idempotency
  db.prepare(`DELETE FROM forensic_analyses WHERE investigation_id = ?`).run(investigationId);
  db.prepare(`DELETE FROM model_predictions WHERE investigation_id = ?`).run(investigationId);
  db.prepare(`DELETE FROM evidence_correlations WHERE investigation_id = ?`).run(investigationId);

  let agentsExecuted = 0;
  const failedAgents: Array<{ agent: string; error: string }> = [];
  updateJobStage(investigationId, 'Agent 1/9: Evidence Intelligence & SHA-256 Verification', 10);

  // AGENT 1: Evidence Intelligence Agent
  const ag1 = recordAgentStart(
    investigationId,
    'Evidence Intelligence Agent',
    'Verify SHA-256 chain-of-custody integrity, catalog modalities, and schedule dependency graph',
    { evidenceCount: evidenceList.length },
    evidenceList.map((e) => e.id),
  );
  agentsExecuted++;

  const integrityResults: Array<{ id: string; verified: boolean }> = [];
  for (const ev of evidenceList) {
    if (!fs.existsSync(ev.storage_path)) {
      integrityResults.push({ id: ev.id, verified: false });
      continue;
    }
    const hash = crypto.createHash('sha256').update(fs.readFileSync(ev.storage_path)).digest('hex');
    integrityResults.push({ id: ev.id, verified: hash === ev.sha256_hash });
  }
  const byModality = {
    image: evidenceList.filter((e) => e.modality === 'image'),
    video: evidenceList.filter((e) => e.modality === 'video'),
    audio: evidenceList.filter((e) => e.modality === 'audio'),
    text: evidenceList.filter((e) => e.modality === 'text'),
    dataset: evidenceList.filter((e) => e.modality === 'dataset'),
  };
  recordAgentComplete(ag1, 'completed', {
    integrityVerifiedCount: integrityResults.filter((r) => r.verified).length,
    totalCount: evidenceList.length,
    scheduledModalities: Object.entries(byModality)
      .filter(([, arr]) => arr.length > 0)
      .map(([m]) => m),
  });

  const insertAnalysis = db.prepare(`
    INSERT INTO forensic_analyses (id, evidence_id, investigation_id, modality, metrics_json, indicators_json, artifacts_json, limitations, analyzed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertPred = db.prepare(`
    INSERT INTO model_predictions (id, evidence_id, investigation_id, model_id, prediction_label, raw_score, uncertainty_note, feature_contributions_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateEvStatus = db.prepare(`UPDATE evidence SET status = ?, metadata_json = ? WHERE id = ?`);

  // AGENT 2: Image Forensics Agent
  const ag2 = recordAgentStart(
    investigationId,
    'Image Forensics Agent',
    'Execute Sharp ELA residual mapping, noise floor analysis, EXIF parsing, and RF/LR/ViT ML inference',
    { fileCount: byModality.image.length },
    byModality.image.map((e) => e.id),
  );
  agentsExecuted++;
  if (byModality.image.length === 0) {
    recordAgentComplete(ag2, 'skipped', { reason: 'No image evidence in case' });
  } else {
    const processed: string[] = [];
    const fileErrors: string[] = [];
    for (const ev of byModality.image) {
      try {
        const res = await runImageForensics(ev.id, ev.storage_path);
        const now = new Date().toISOString();
        insertAnalysis.run(
          genId('ANL'),
          ev.id,
          investigationId,
          'image',
          JSON.stringify(res.metrics),
          JSON.stringify(res.indicators),
          JSON.stringify({ ...res.artifacts, exif: res.exif }),
          res.limitations,
          now,
        );
        for (const pred of res.mlPredictions) {
          insertPred.run(
            genId('PRD'),
            ev.id,
            investigationId,
            pred.modelId,
            pred.predictionLabel,
            pred.rawScore,
            pred.uncertaintyNote,
            JSON.stringify(pred.featureContributions),
            now,
          );
        }
        updateEvStatus.run('analyzed', JSON.stringify({ ...res.metrics, exif: res.exif }), ev.id);
        processed.push(ev.id);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Image pipeline error';
        db.prepare(`UPDATE evidence SET status = 'failed' WHERE id = ?`).run(ev.id);
        fileErrors.push(`${ev.original_filename}: ${msg}`);
      }
    }
    if (fileErrors.length > 0) {
      const joined = fileErrors.join('; ');
      failedAgents.push({ agent: 'Image Forensics Agent', error: joined });
      recordAgentComplete(
        ag2,
        processed.length > 0 ? 'completed' : 'failed',
        { analyzedImages: processed, failedFiles: fileErrors },
        joined,
      );
    } else {
      recordAgentComplete(ag2, 'completed', { analyzedImages: processed });
    }
  }

  // AGENT 3: Video Investigation Agent
  const ag3 = recordAgentStart(
    investigationId,
    'Video Investigation Agent',
    'Probe container metadata via FFprobe, extract sampled keyframes, analyze embedded audio via AASIST, and track temporal drift',
    { fileCount: byModality.video.length },
    byModality.video.map((e) => e.id),
  );
  agentsExecuted++;
  if (byModality.video.length === 0) {
    recordAgentComplete(ag3, 'skipped', { reason: 'No video evidence in case' });
  } else {
    const processed: string[] = [];
    const fileErrors: string[] = [];
    for (const ev of byModality.video) {
      try {
        const res = await runVideoForensics(ev.id, ev.storage_path);
        let embeddedTranscript: { transcript: string; model: string; error?: string } | undefined;
        if (res.embeddedAudio?.audioUrl) {
          const audRel = res.embeddedAudio.audioUrl.replace(/^\/api\/artifacts\//, '');
          const audAbs = path.join(ARTIFACTS_DIR, audRel);
          const trRes = await transcribeAudioFile(audAbs, `${ev.id}_AUD`);
          if (trRes.transcribed) {
            embeddedTranscript = { transcript: trRes.transcript, model: trRes.model };
          } else if (trRes.error) {
            embeddedTranscript = { transcript: '', model: trRes.model, error: trRes.error };
          }
        }
        const now = new Date().toISOString();
        insertAnalysis.run(
          genId('ANL'),
          ev.id,
          investigationId,
          'video',
          JSON.stringify(res.metrics),
          JSON.stringify(res.indicators),
          JSON.stringify({
            sampledFrames: res.sampledFrames,
            embeddedAudio: res.embeddedAudio,
            ...(embeddedTranscript ? { geminiTranscript: embeddedTranscript } : {}),
          }),
          res.limitations,
          now,
        );
        for (const pred of res.mlPredictions) {
          insertPred.run(
            genId('PRD'),
            ev.id,
            investigationId,
            pred.modelId,
            pred.predictionLabel,
            pred.rawScore,
            pred.uncertaintyNote,
            JSON.stringify(pred.featureContributions),
            now,
          );
        }
        updateEvStatus.run('analyzed', JSON.stringify(res.metrics), ev.id);
        processed.push(ev.id);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Video pipeline error';
        db.prepare(`UPDATE evidence SET status = 'failed' WHERE id = ?`).run(ev.id);
        fileErrors.push(`${ev.original_filename}: ${msg}`);
      }
    }
    if (fileErrors.length > 0) {
      const joined = fileErrors.join('; ');
      failedAgents.push({ agent: 'Video Investigation Agent', error: joined });
      recordAgentComplete(
        ag3,
        processed.length > 0 ? 'completed' : 'failed',
        { analyzedVideos: processed, failedFiles: fileErrors },
        joined,
      );
    } else {
      recordAgentComplete(ag3, 'completed', { analyzedVideos: processed });
    }
  }
  updateJobStage(investigationId, 'Agent 4/9: Audio Forensics & Speech Transcription', 48);
  if (isJobCancelled(investigationId)) throw new Error('Pipeline cancelled by investigator');

  // AGENT 4: Audio Investigation Agent
  const ag4 = recordAgentStart(
    investigationId,
    'Audio Investigation Agent',
    'Decode 16kHz PCM, generate 24-band FFT spectrogram, segment windows, and run AASIST + DSP spoofing ML',
    { fileCount: byModality.audio.length },
    byModality.audio.map((e) => e.id),
  );
  agentsExecuted++;
  if (byModality.audio.length === 0) {
    recordAgentComplete(ag4, 'skipped', { reason: 'No audio evidence in case' });
  } else {
    const processed: string[] = [];
    const fileErrors: string[] = [];
    for (const ev of byModality.audio) {
      try {
        const res = await runAudioForensics(ev.id, ev.storage_path);
        const trRes = await transcribeAudioFile(ev.storage_path, ev.id);
        const now = new Date().toISOString();
        const geminiTranscript = trRes.transcribed
          ? { transcript: trRes.transcript, model: trRes.model }
          : trRes.error
          ? { transcript: '', model: trRes.model, error: trRes.error }
          : undefined;
        insertAnalysis.run(
          genId('ANL'),
          ev.id,
          investigationId,
          'audio',
          JSON.stringify(res.metrics),
          JSON.stringify(res.indicators),
          JSON.stringify({
            waveform: res.waveform,
            spectrogram: res.spectrogram,
            segments: res.segments,
            ...(geminiTranscript ? { geminiTranscript } : {}),
          }),
          res.limitations,
          now,
        );
        for (const pred of res.mlPredictions) {
          insertPred.run(
            genId('PRD'),
            ev.id,
            investigationId,
            pred.modelId,
            pred.predictionLabel,
            pred.rawScore,
            pred.uncertaintyNote,
            JSON.stringify(pred.featureContributions),
            now,
          );
        }
        updateEvStatus.run('analyzed', JSON.stringify(res.metrics), ev.id);
        processed.push(ev.id);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Audio pipeline error';
        db.prepare(`UPDATE evidence SET status = 'failed' WHERE id = ?`).run(ev.id);
        fileErrors.push(`${ev.original_filename}: ${msg}`);
      }
    }
    if (fileErrors.length > 0) {
      const joined = fileErrors.join('; ');
      failedAgents.push({ agent: 'Audio Investigation Agent', error: joined });
      recordAgentComplete(
        ag4,
        processed.length > 0 ? 'completed' : 'failed',
        { analyzedAudio: processed, failedFiles: fileErrors },
        joined,
      );
    } else {
      recordAgentComplete(ag4, 'completed', { analyzedAudio: processed });
    }
  }
  updateJobStage(investigationId, 'Agent 5/9: Text & Dataset Intelligence', 62);
  if (isJobCancelled(investigationId)) throw new Error('Pipeline cancelled by investigator');

  // AGENT 5: Text & Dataset Intelligence Agent
  const textAndDatasetCount = byModality.text.length + byModality.dataset.length;
  const ag5 = recordAgentStart(
    investigationId,
    'Text Intelligence Agent',
    'Parse TXT/JSON/SRT documents and profile/clean CSV/TSV datasets for missing values, duplicates, errors, and outliers',
    { textCount: byModality.text.length, datasetCount: byModality.dataset.length },
    [...byModality.text, ...byModality.dataset].map((e) => e.id),
  );
  agentsExecuted++;
  const datasetResults: Array<{ evidenceId: string; filename: string; result: DatasetAnalysisResult }> = [];
  if (textAndDatasetCount === 0) {
    recordAgentComplete(ag5, 'skipped', { reason: 'No text, transcript, or tabular dataset evidence in case' });
  } else {
    const processedText: string[] = [];
    const processedDatasets: string[] = [];
    const fileErrors: string[] = [];
    for (const ev of byModality.text) {
      try {
        const res = runTextForensics(ev.id, ev.storage_path, ev.original_filename);
        const now = new Date().toISOString();
        insertAnalysis.run(
          genId('ANL'),
          ev.id,
          investigationId,
          'text',
          JSON.stringify(res.metrics),
          JSON.stringify(res.indicators),
          JSON.stringify({
            rawPreview: res.rawPreview,
            cues: res.cues,
            extractedClaims: res.extractedClaims,
          }),
          res.limitations,
          now,
        );
        updateEvStatus.run('analyzed', JSON.stringify(res.metrics), ev.id);
        processedText.push(ev.id);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Text analysis error';
        db.prepare(`UPDATE evidence SET status = 'failed' WHERE id = ?`).run(ev.id);
        fileErrors.push(`${ev.original_filename}: ${msg}`);
      }
    }
    for (const ev of byModality.dataset) {
      try {
        const res = runDatasetForensics(ev.id, ev.storage_path, ev.original_filename);
        const now = new Date().toISOString();
        insertAnalysis.run(
          genId('ANL'),
          ev.id,
          investigationId,
          'dataset',
          JSON.stringify(res.metrics),
          JSON.stringify(res.indicators),
          JSON.stringify({
            columns: res.columns,
            fixesApplied: res.fixesApplied,
            beforeAfterComparisons: res.beforeAfterComparisons,
            validationChecks: res.validationChecks,
            beforeSample: res.beforeSample,
            afterSample: res.afterSample,
            cleanedCsvUrl: res.cleanedCsvUrl,
            cleanedPreviewCsv: res.cleanedPreviewCsv,
            recommendations: res.recommendations,
          }),
          res.limitations,
          now,
        );
        updateEvStatus.run('analyzed', JSON.stringify(res.metrics), ev.id);
        processedDatasets.push(ev.id);
        datasetResults.push({ evidenceId: ev.id, filename: ev.original_filename, result: res });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Dataset analysis error';
        db.prepare(`UPDATE evidence SET status = 'failed' WHERE id = ?`).run(ev.id);
        fileErrors.push(`${ev.original_filename}: ${msg}`);
      }
    }
    if (fileErrors.length > 0) {
      const joined = fileErrors.join('; ');
      failedAgents.push({ agent: 'Text Intelligence Agent', error: joined });
      recordAgentComplete(
        ag5,
        processedText.length + processedDatasets.length > 0 ? 'completed' : 'failed',
        { analyzedText: processedText, analyzedDatasets: processedDatasets, failedFiles: fileErrors },
        joined,
      );
    } else {
      recordAgentComplete(ag5, 'completed', { analyzedText: processedText, analyzedDatasets: processedDatasets });
    }
  }

  // Retrieve full case bundle after local forensic + ML passes
  const context = retrieveCaseContext(investigationId)!;
  updateJobStage(investigationId, 'Agent 6/9: Cross-Modal Correlation & Synthesis', 75);
  if (isJobCancelled(investigationId)) throw new Error('Pipeline cancelled by investigator');

  // Call Gemini multimodal + cross-modal synthesis once
  const geminiSynth = await generateGeminiSynthesis(context);

  // Merge transcripts from standalone gemini-3.5-transcribe + synthesis transcripts
  const storedAudioTranscripts: Array<{ evidenceId: string; transcript: string }> = [];
  const allAnalysisRows = db
    .prepare(`SELECT id, evidence_id, artifacts_json FROM forensic_analyses WHERE investigation_id = ?`)
    .all(investigationId) as Array<{ id: string; evidence_id: string; artifacts_json: string }>;

  for (const row of allAnalysisRows) {
    const arts = JSON.parse(row.artifacts_json || '{}');
    if (arts.geminiTranscript?.transcript && !arts.geminiTranscript.transcript.includes('[No intelligible speech]')) {
      storedAudioTranscripts.push({ evidenceId: row.evidence_id, transcript: arts.geminiTranscript.transcript });
    }
  }

  // Persist Gemini synthesis transcripts when standalone transcription wasn't already populated
  if (geminiSynth.audioTranscripts.length > 0) {
    for (const tr of geminiSynth.audioTranscripts) {
      if (!tr.evidenceId || !tr.transcript) continue;
      if (!storedAudioTranscripts.some((s) => s.evidenceId === tr.evidenceId)) {
        storedAudioTranscripts.push({ evidenceId: tr.evidenceId, transcript: tr.transcript });
      }
      const row = db
        .prepare(`SELECT id, artifacts_json FROM forensic_analyses WHERE evidence_id = ? LIMIT 1`)
        .get(tr.evidenceId) as { id: string; artifacts_json: string } | undefined;
      if (row) {
        const arts = JSON.parse(row.artifacts_json || '{}');
        if (!arts.geminiTranscript?.transcript) {
          arts.geminiTranscript = {
            transcript: tr.transcript,
            language: tr.language || 'unknown',
            model: 'gemini-4-hydrogen',
          };
          db.prepare(`UPDATE forensic_analyses SET artifacts_json = ? WHERE id = ?`).run(
            JSON.stringify(arts),
            row.id,
          );
        }
      }
    }
  }

  // AGENT 6: Cross-Modal Correlation Agent
  const ag6 = recordAgentStart(
    investigationId,
    'Cross-Modal Correlation Agent',
    'Detect temporal mismatches, claim contradictions, and metadata divergence without overstating duration bounds',
    { evidenceCount: evidenceList.length, geminiAvailable: geminiSynth.available },
    evidenceList.map((e) => e.id),
  );
  agentsExecuted++;

  const insertCorr = db.prepare(`
    INSERT INTO evidence_correlations
    (id, investigation_id, source_evidence_id, target_evidence_id, relationship_type, strength, summary, supporting_refs_json, alternative_explanations_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let correlationsCreated = 0;
  const validIds = new Set(evidenceList.map((e) => e.id));
  const nowCorr = new Date().toISOString();

  // Deterministic cross-modal checks (strictly distinguishes duration compatibility from semantic alignment!)
  const videoOrAudio = context.evidence.filter((e) => e.modality === 'video' || e.modality === 'audio');
  const textDocs = context.evidence.filter((e) => e.modality === 'text');
  for (const txt of textDocs) {
    const maxTs = Number(txt.metrics.maxTimestampSec || 0);
    for (const av of videoOrAudio) {
      const avDur = Number(av.metrics.durationSec || 0);
      if (maxTs > 0 && avDur > 0 && maxTs > avDur + 0.75) {
        insertCorr.run(
          genId('COR'),
          investigationId,
          txt.id,
          av.id,
          'CONTRADICTS',
          0.86,
          `Subtitle/transcript [${txt.id}] ${txt.original_filename} references timestamp ${maxTs.toFixed(
            1,
          )}s, exceeding [${av.id}] ${av.original_filename} duration (${avDur.toFixed(1)}s) by ${(maxTs - avDur).toFixed(
            1,
          )}s.`,
          JSON.stringify([txt.id, av.id]),
          JSON.stringify([
            'Transcript may correspond to a longer unedited recording prior to social clipping.',
            'Subtitle cue timebase drift or dropped GOP frames during re-encoding.',
          ]),
          nowCorr,
        );
        correlationsCreated++;
      } else if (maxTs > 0 && avDur > 0) {
        // Matching duration bounds NEVER imply semantic or acoustic alignment!
        insertCorr.run(
          genId('COR'),
          investigationId,
          txt.id,
          av.id,
          'DURATION_COMPATIBLE',
          0.28,
          `Subtitle span (0–${maxTs.toFixed(1)}s) in [${txt.id}] fits within [${av.id}] (${avDur.toFixed(
            1,
          )}s) duration bounds. Matching duration alone does NOT prove semantic or acoustic alignment.`,
          JSON.stringify([txt.id, av.id]),
          JSON.stringify([
            'Any fabricated transcript shorter than the clip duration passes container-bound checks; human review or ASR verification is required.',
          ]),
          nowCorr,
        );
        correlationsCreated++;
      }
    }
  }

  // Video vs Audio duration cross-check (without falsely asserting semantic sync when lengths match)
  const vids = context.evidence.filter((e) => e.modality === 'video');
  const auds = context.evidence.filter((e) => e.modality === 'audio');
  for (const v of vids) {
    const vDur = Number(v.metrics.durationSec || 0);
    for (const a of auds) {
      const aDur = Number(a.metrics.durationSec || 0);
      if (vDur > 0 && aDur > 0 && Math.abs(vDur - aDur) > 0.75) {
        insertCorr.run(
          genId('COR'),
          investigationId,
          v.id,
          a.id,
          'CONTRADICTS',
          0.79,
          `Duration mismatch between video [${v.id}] (${vDur.toFixed(2)}s) and external audio [${a.id}] (${aDur.toFixed(
            2,
          )}s).`,
          JSON.stringify([v.id, a.id]),
          JSON.stringify(['External microphone recording started/stopped independently of video camera capture.']),
          nowCorr,
        );
        correlationsCreated++;
      } else if (vDur > 0 && aDur > 0) {
        insertCorr.run(
          genId('COR'),
          investigationId,
          v.id,
          a.id,
          'DURATION_COMPATIBLE',
          0.25,
          `Container durations of [${v.id}] (${vDur.toFixed(2)}s) and [${a.id}] (${aDur.toFixed(
            2,
          )}s) are similar; shared length alone does not prove synchronized capture.`,
          JSON.stringify([v.id, a.id]),
          JSON.stringify(['Both files could share a common social clip trim length while originating from unrelated sources.']),
          nowCorr,
        );
        correlationsCreated++;
      }
    }
  }

  // Pairwise image-to-image comparison (compression baseline variance != contradiction)
  const imgs = context.evidence.filter((e) => e.modality === 'image');
  for (let i = 0; i < imgs.length - 1; i++) {
    const a = imgs[i];
    const b = imgs[i + 1];
    const diffEla = Math.abs(Number(a.metrics.elaMean || 0) - Number(b.metrics.elaMean || 0));
    const spatialA = Number(a.metrics.elaSpatialVariance || 0);
    const spatialB = Number(b.metrics.elaSpatialVariance || 0);
    const localizedDivergence = Math.abs(spatialA - spatialB) > 4.0 || diffEla > 1.8;

    const aAi = Boolean(a.metrics.aiMetadataDetected);
    const bAi = Boolean(b.metrics.aiMetadataDetected);

    if (aAi !== bAi && (a.metrics.exifPresent || b.metrics.exifPresent)) {
      insertCorr.run(
        genId('COR'),
        investigationId,
        a.id,
        b.id,
        'WEAKENS',
        0.58,
        `Provenance mismatch: one image carries generative AI software tags while the other contains camera capture metadata.`,
        JSON.stringify([a.id, b.id]),
        JSON.stringify(['Both images may depict related subjects from completely separate workflows (one synthetic, one photographed).']),
        nowCorr,
      );
      correlationsCreated++;
    } else if (localizedDivergence) {
      insertCorr.run(
        genId('COR'),
        investigationId,
        a.id,
        b.id,
        'WEAKENS',
        0.32,
        `Different compression baselines observed between [${a.id}] (ELA ${a.metrics.elaMean}, var ${spatialA}) and [${b.id}] (ELA ${b.metrics.elaMean}, var ${spatialB}). This reflects separate export qualities or different devices rather than direct contradiction.`,
        JSON.stringify([a.id, b.id]),
        JSON.stringify([
          'Images saved from different cameras, screenshots, or messaging apps naturally exhibit distinct ELA levels.',
        ]),
        nowCorr,
      );
      correlationsCreated++;
    } else {
      insertCorr.run(
        genId('COR'),
        investigationId,
        a.id,
        b.id,
        'SUPPORTS',
        0.48,
        `Similar JPEG/compression quantization baseline observed between [${a.id}] and [${b.id}].`,
        JSON.stringify([a.id, b.id]),
        JSON.stringify(['Consistent baseline can occur when two separate photos are exported by the same platform.']),
        nowCorr,
      );
      correlationsCreated++;
    }
  }

  // Deterministic cross-document text numeric/percentage divergence check
  for (let i = 0; i < textDocs.length - 1; i++) {
    const tA = textDocs[i];
    const tB = textDocs[i + 1];
    const pctA = (tA.rawPreview || '').match(/(\d+(?:\.\d+)?)\s*%/g) || [];
    const pctB = (tB.rawPreview || '').match(/(\d+(?:\.\d+)?)\s*%/g) || [];
    if (pctA.length > 0 && pctB.length > 0 && pctA[0] !== pctB[0]) {
      insertCorr.run(
        genId('COR'),
        investigationId,
        tA.id,
        tB.id,
        'WEAKENS',
        0.52,
        `Documents [${tA.id}] and [${tB.id}] report differing percentage figures (${pctA[0]} vs ${pctB[0]}). Verify whether they describe different metrics or conflicting claims.`,
        JSON.stringify([tA.id, tB.id]),
        JSON.stringify(['Figures may reference different subgroups, timeframes, or reporting definitions.']),
        nowCorr,
      );
      correlationsCreated++;
    }
  }

  // Deterministic speech-to-transcript (gemini-3.5-transcribe / Gemini synthesis) vs uploaded text comparison
  if (storedAudioTranscripts.length > 0 && textDocs.length > 0) {
    for (const tr of storedAudioTranscripts) {
      if (!tr.transcript || !validIds.has(tr.evidenceId)) continue;
      const trWords = new Set(
        tr.transcript
          .toLowerCase()
          .replace(/[^a-z0-9\s]/g, '')
          .split(/\s+/)
          .filter((w) => w.length > 3),
      );
      for (const td of textDocs) {
        const docWords = (td.rawPreview || '')
          .replace(/\[\d+(?:\.\d+)?s\s*-\s*\d+(?:\.\d+)?s\]/g, ' ')
          .toLowerCase()
          .replace(/[^a-z0-9\s]/g, '')
          .split(/\s+/)
          .filter((w) => w.length > 3);
        if (trWords.size >= 4 && docWords.length >= 4) {
          const overlap = docWords.filter((w) => trWords.has(w)).length;
          const overlapRatio = overlap / Math.max(1, Math.min(trWords.size, docWords.length));
          insertCorr.run(
            genId('COR'),
            investigationId,
            tr.evidenceId,
            td.id,
            overlapRatio >= 0.35 ? 'SUPPORTS' : 'CONTRADICTS',
            overlapRatio >= 0.35 ? 0.78 : 0.74,
            overlapRatio >= 0.35
              ? `Speech transcription of [${tr.evidenceId}] aligns lexically (${(overlapRatio * 100).toFixed(0)}% keyword overlap) with text document [${td.id}].`
              : `Speech transcription of [${tr.evidenceId}] diverges significantly (${(overlapRatio * 100).toFixed(0)}% keyword overlap) from text document [${td.id}].`,
            JSON.stringify([tr.evidenceId, td.id]),
            JSON.stringify(['Transcript could capture a different speaker turn, translation, or unedited audio portion.']),
            nowCorr,
          );
          correlationsCreated++;
        }
      }
    }
  }

  // Add Gemini-discovered correlations only if grounded in valid IDs (reject naive duration-only TEMPORAL_ALIGN)
  for (const gc of geminiSynth.correlations) {
    if (validIds.has(gc.sourceId) && validIds.has(gc.targetId) && gc.sourceId !== gc.targetId) {
      const normalizedRel =
        gc.relationshipType === 'CONTRADICTS' ||
        gc.relationshipType === 'SUPPORTS' ||
        gc.relationshipType === 'WEAKENS' ||
        gc.relationshipType === 'DURATION_COMPATIBLE'
          ? gc.relationshipType
          : 'DURATION_COMPATIBLE';
      insertCorr.run(
        genId('COR'),
        investigationId,
        gc.sourceId,
        gc.targetId,
        normalizedRel,
        Math.max(0.1, Math.min(1, Number(gc.strength || 0.6))),
        `[AI Synthesis] ${gc.summary}`,
        JSON.stringify([gc.sourceId, gc.targetId]),
        JSON.stringify(gc.alternativeExplanations || []),
        nowCorr,
      );
      correlationsCreated++;
    }
  }

  // Persist Gemini text contradictions back onto text evidence indicators tagged clearly as gemini_interpretation
  if (geminiSynth.textContradictions.length > 0 && textDocs.length > 0) {
    const firstTxt = textDocs[0];
    const existingRow = db
      .prepare(`SELECT id, indicators_json FROM forensic_analyses WHERE evidence_id = ? LIMIT 1`)
      .get(firstTxt.id) as { id: string; indicators_json: string } | undefined;
    if (existingRow) {
      const curr = JSON.parse(existingRow.indicators_json || '[]');
      for (const tc of geminiSynth.textContradictions) {
        const groundedRefs = Array.isArray(tc.citedIds)
          ? tc.citedIds.filter((id) => validIds.has(id))
          : [firstTxt.id];
        curr.push({
          id: genId('IND-AI'),
          category: 'AI Claim Consistency',
          severity: tc.severity === 'critical' ? 'critical' : 'warning',
          sourceLayer: 'gemini_interpretation',
          evidenceRef: groundedRefs[0] || firstTxt.id,
          title: tc.claim,
          detail: `${tc.conflict} [Refs: ${(groundedRefs.length > 0 ? groundedRefs : [firstTxt.id]).join(', ')}]`,
        });
      }
      db.prepare(`UPDATE forensic_analyses SET indicators_json = ? WHERE id = ?`).run(
        JSON.stringify(curr),
        existingRow.id,
      );
    }
  }

  recordAgentComplete(ag6, 'completed', {
    correlationsCreated,
    geminiContradictionsFound: geminiSynth.textContradictions.length,
    audioTranscriptsExtracted: geminiSynth.audioTranscripts.length,
  });

  // AGENT 7: Risk Assessment Agent
  const ag7 = recordAgentStart(
    investigationId,
    'Risk Assessment Agent',
    'Aggregate uncalibrated raw model scores, cross-modal contradictions, failed engines, and uncertainty bounds',
    {
      predictionCount: context.evidence.reduce((a, e) => a + e.predictions.length, 0),
      failedAgentCount: failedAgents.length,
    },
    evidenceList.map((e) => e.id),
  );
  agentsExecuted++;

  const allPreds = db
    .prepare(
      `SELECT evidence_id, raw_score, prediction_label, model_id, uncertainty_note FROM model_predictions WHERE investigation_id = ?`,
    )
    .all(investigationId) as Array<{
    evidence_id: string;
    raw_score: number;
    prediction_label: string;
    model_id: string;
    uncertainty_note: string;
  }>;

  // Use primary specialist models per evidence item for verdict aggregation (ViT for visual, AASIST for audio)
  // while keeping secondary heuristics (RF-v2, LR-v2, AudSpoof-LR-v1) persisted for diagnostic transparency.
  const predsByEv = new Map<string, typeof allPreds>();
  for (const p of allPreds) {
    const arr = predsByEv.get(p.evidence_id) || [];
    arr.push(p);
    predsByEv.set(p.evidence_id, arr);
  }
  const primaryPreds: typeof allPreds = [];
  for (const evPreds of predsByEv.values()) {
    const visualVit = evPreds.find((p) => p.model_id.includes('ViT'));
    const visualFallback = evPreds.filter((p) => p.model_id.includes('ImgForensics'));
    if (visualVit) primaryPreds.push(visualVit);
    else primaryPreds.push(...visualFallback);

    const audAasist = evPreds.find((p) => p.model_id.includes('AASIST'));
    const audFallback = evPreds.filter((p) => p.model_id.includes('AudSpoof'));
    if (audAasist) primaryPreds.push(audAasist);
    else primaryPreds.push(...audFallback);

    const others = evPreds.filter(
      (p) =>
        !p.model_id.includes('ViT') &&
        !p.model_id.includes('ImgForensics') &&
        !p.model_id.includes('AASIST') &&
        !p.model_id.includes('AudSpoof'),
    );
    primaryPreds.push(...others);
  }

  const hasMlPredictions = primaryPreds.length > 0;
  const nonOodPreds = primaryPreds.filter((p) => !p.uncertainty_note.includes('[OUT-OF-DOMAIN'));
  const hasAnyOod = primaryPreds.some((p) => p.uncertainty_note.includes('[OUT-OF-DOMAIN'));
  const oodAudioOnly = hasMlPredictions && nonOodPreds.length === 0;
  const effectivePreds = nonOodPreds.length > 0 ? nonOodPreds : primaryPreds;
  const maxScore = effectivePreds.length > 0 ? Math.max(...effectivePreds.map((p) => p.raw_score)) : 0;
  const avgRawScore =
    effectivePreds.length > 0 ? effectivePreds.reduce((sum, p) => sum + p.raw_score, 0) / effectivePreds.length : 0;
  const hasAiMetadataMarker = context.evidence.some((e) => Boolean(e.metrics.aiMetadataDetected));
  const unanalyzedCount = (
    db
      .prepare(`SELECT COUNT(*) as c FROM evidence WHERE investigation_id = ? AND status != 'analyzed'`)
      .get(investigationId) as { c: number }
  ).c;
  const hasMediaEvidence = byModality.image.length + byModality.video.length + byModality.audio.length > 0;
  const mediaMissingMl = hasMediaEvidence && !hasMlPredictions;
  const embeddedAudioFailed = vids.some(
    (v) => Boolean(v.metrics.hasAudioTrack) && !Boolean(v.metrics.embeddedAudioAnalyzed),
  );
  const hasContradiction =
    (
      db
        .prepare(
          `SELECT COUNT(*) as c FROM evidence_correlations WHERE investigation_id = ? AND relationship_type = 'CONTRADICTS'`,
        )
        .get(investigationId) as { c: number }
    ).c > 0;

  const primaryModelIds = Array.from(new Set(primaryPreds.map((p) => p.model_id)));
  const maxPred =
    effectivePreds.length > 0
      ? [...effectivePreds].sort((a, b) => b.raw_score - a.raw_score)[0]
      : null;
  const maxPredEv = maxPred ? context.evidence.find((e) => e.id === maxPred.evidence_id) : undefined;

  // Gather concrete forensic observations from persisted evidence metrics
  const observedDetails: string[] = [];
  const limitDetails: string[] = [];
  const totalFacesDetected = imgs.reduce((s, e) => s + Number(e.metrics.faceCount ?? 0), 0) +
    vids.reduce((s, e) => s + Number(e.metrics.framesWithFacesCount ?? 0), 0);
  const exifMissingImgs = imgs.filter((e) => e.metrics.exifPresent === false).length;
  const exifPresentImgs = imgs.filter((e) => e.metrics.exifPresent === true).length;
  const doubleJpegImgs = imgs.filter((e) => Boolean(e.metrics.doubleJpegSuspected)).length;

  if (imgs.length > 0) {
    if (totalFacesDetected > 0) {
      observedDetails.push(`facial regions aligned and checked across ${imgs.length} image(s)`);
    } else {
      observedDetails.push(`full-frame compression and noise textures checked across ${imgs.length} image(s)`);
      limitDetails.push('no facial bounding boxes detected for face-swap cropping');
    }
    if (exifPresentImgs > 0 && exifMissingImgs === 0) {
      observedDetails.push('camera EXIF headers intact');
    } else if (exifMissingImgs > 0) {
      observedDetails.push(`camera EXIF tags absent in ${exifMissingImgs} image(s)`);
      limitDetails.push('missing EXIF camera metadata prevents device-origin verification');
    }
    if (doubleJpegImgs > 0) {
      observedDetails.push(`multi-generation JPEG re-saving detected in ${doubleJpegImgs} image(s)`);
      limitDetails.push('recompression or messaging-app resizing can alter pixel artifacts');
    }
  }
  if (vids.length > 0) {
    observedDetails.push(`${vids.length} video stream(s) sampled across keyframes`);
  }
  if (auds.length > 0) {
    observedDetails.push(`${auds.length} audio clip(s) checked for spectral and vocoder artifacts`);
  }
  if (textDocs.length > 0) {
    observedDetails.push(`${textDocs.length} text/transcript file(s) checked for claim/timestamp alignment`);
  }
  if (datasetResults.length > 0) {
    observedDetails.push(`${datasetResults.length} tabular dataset(s) profiled and validated`);
  }

  const evidenceObsText = observedDetails.length > 0 ? observedDetails.join('; ') : 'standard file integrity checks completed';
  const limitText =
    limitDetails.length > 0
      ? `Confidence is limited because ${limitDetails.slice(0, 2).join(' and ')}.`
      : 'Scores indicate how closely files match training patterns rather than mathematical certainty or proof.';

  let confidenceLevel: 'low_anomaly' | 'inconclusive' | 'requires_review' = 'low_anomaly';
  let verdictLabel: 'Likely Genuine' | 'Possibly AI-Generated or Manipulated' | 'Inconclusive — Needs Review' =
    'Likely Genuine';
  let reliabilityLevel: 'Low' | 'Moderate' | 'Limited' = hasMlPredictions ? 'Moderate' : 'Low';
  let assessmentSummary = hasMlPredictions
    ? `Primary detector(s) (${primaryModelIds.join(', ')}) found low synthetic or manipulation signal across ${evidenceList.length} file(s) (peak score ${(maxScore * 100).toFixed(1)}/100${maxPredEv ? ` on ${maxPredEv.original_filename}` : ''}); forensic checks noted ${evidenceObsText}. This indicates the submitted media aligns with typical camera or natural recordings without strong AI artifacts. ${limitText}`
    : `Forensic inspection across ${evidenceList.length} file(s) (${evidenceObsText}) found no tampering indicators. ${limitText}`;

  if (failedAgents.length > 0 || unanalyzedCount > 0 || mediaMissingMl || embeddedAudioFailed) {
    const elevatedNonOod = (!oodAudioOnly && maxScore >= 0.65) || hasContradiction || hasAiMetadataMarker;
    confidenceLevel = elevatedNonOod ? 'requires_review' : 'inconclusive';
    verdictLabel = elevatedNonOod ? 'Possibly AI-Generated or Manipulated' : 'Inconclusive — Needs Review';
    reliabilityLevel = 'Low';
    const failNames =
      failedAgents.length > 0
        ? failedAgents.map((f) => `${f.agent}: ${f.error}`).join('; ')
        : embeddedAudioFailed
        ? 'embedded video audio decode failed'
        : 'one or more media files could not be scored by forensic ML';
    assessmentSummary = `Partial analysis only — ${failNames}. Failed or unsupported files are never treated as genuine.${
      hasMlPredictions
        ? ` Among completed checks (${primaryModelIds.join(', ')}), peak score reached ${(maxScore * 100).toFixed(1)}/100.`
        : ''
    }${hasContradiction ? ' Cross-file contradictions were also detected.' : ''} Manual source verification is required before drawing conclusions.`;
  } else if (!hasMlPredictions && !hasContradiction && !hasAiMetadataMarker) {
    confidenceLevel = 'low_anomaly';
    verdictLabel = 'Likely Genuine';
    reliabilityLevel = 'Limited';
    assessmentSummary = `Structural, timing, and data-quality inspection across ${evidenceList.length} file(s) (${evidenceObsText}) passed baseline integrity checks without conflicts. Media deepfake detectors did not apply because only text or structured tabular files were supplied.`;
  } else if ((oodAudioOnly || (hasAnyOod && maxScore < 0.65)) && !hasContradiction && !hasAiMetadataMarker) {
    confidenceLevel = 'inconclusive';
    verdictLabel = 'Inconclusive — Needs Review';
    reliabilityLevel = 'Limited';
    assessmentSummary = `Voice-spoofing detector (${primaryModelIds.join(', ')}) scored ${(maxScore * 100).toFixed(
      1,
    )}/100, but the recording uses compressed web audio, non-16 kHz resampling, or high ambient noise outside the model's clean studio speech training domain. Because compression and background noise frequently elevate speech-spoof scores on genuine recordings, this result is inconclusive without supporting visual or source evidence.`;
  } else if (maxScore >= 0.65 || hasContradiction || hasAiMetadataMarker) {
    confidenceLevel = 'requires_review';
    verdictLabel = 'Possibly AI-Generated or Manipulated';
    reliabilityLevel = 'Moderate';
    assessmentSummary = `${
      hasMlPredictions
        ? `Trained detector(s) (${primaryModelIds.join(', ')}) flagged elevated synthetic or manipulation patterns (peak ${(
            maxScore * 100
          ).toFixed(1)}/100${maxPredEv ? ` on ${maxPredEv.original_filename}` : ''})`
        : 'Forensic signal inspection flagged elevated tampering indicators'
    }${hasAiMetadataMarker ? '; explicit AI generator software metadata was found in file headers' : ''}${
      hasContradiction ? '; cross-modal file discrepancies were detected' : ''
    }, alongside ${evidenceObsText}. These findings point to possible synthetic generation or editing rather than definitive proof—verify against original source files.`;
  } else if (maxScore >= 0.4) {
    confidenceLevel = 'inconclusive';
    verdictLabel = 'Inconclusive — Needs Review';
    reliabilityLevel = 'Limited';
    assessmentSummary = `Trained detector(s) (${primaryModelIds.join(', ')}) produced a borderline score (peak ${(
      maxScore * 100
    ).toFixed(1)}/100${maxPredEv ? ` on ${maxPredEv.original_filename}` : ''}), with ${evidenceObsText}. Because this falls inside the inconclusive middle band, routine re-encoding, heavy compression, or lighting/noise shifts cannot be separated from subtle edits. Original file verification is recommended.`;
  }

  db.prepare(
    `UPDATE investigations SET status = 'review_required', confidence_level = ?, assessment_summary = ?, updated_at = ? WHERE id = ?`,
  ).run(confidenceLevel, assessmentSummary, new Date().toISOString(), investigationId);

  recordAgentComplete(ag7, 'completed', {
    confidenceLevel,
    verdictLabel,
    peakRawScore: hasMlPredictions ? maxScore : null,
    primaryModelCount: primaryPreds.length,
    hasAiMetadataMarker,
    hasCrossModalContradiction: hasContradiction,
    failedAgentsCount: failedAgents.length,
  });

  // AGENT 8: Alternative Explanation Agent
  const ag8 = recordAgentStart(
    investigationId,
    'Alternative Explanation Agent',
    'Generate non-malicious technical explanations for observed forensic anomalies',
    { confidenceLevel },
    evidenceList.map((e) => e.id),
  );
  agentsExecuted++;

  const alternatives =
    geminiSynth.alternativeExplanations.length > 0
      ? geminiSynth.alternativeExplanations
      : [
          'Messaging apps and social platforms strip camera EXIF headers and re-encode JPEG/MP4 files, raising compression differences without intentional editing.',
          'Hardware noise-reduction filters, non-speech audio tones, or heavy VoIP codecs can trigger elevated audio raw model scores.',
          'Subtitle or transcript timestamp gaps commonly result from trimmed video intros or variable frame rate (VFR) transcoding.',
        ];
  recordAgentComplete(ag8, 'completed', { alternativeExplanations: alternatives });

  // AGENT 9: Report Generation Agent
  const ag9 = recordAgentStart(
    investigationId,
    'Report Generation Agent',
    'Compile plain-English and technical forensic summary, cited indicators, and recommended human checks',
    { investigationId },
    evidenceList.map((e) => e.id),
  );
  agentsExecuted++;

  const storedIndicators = db
    .prepare(`SELECT indicators_json FROM forensic_analyses WHERE investigation_id = ?`)
    .all(investigationId) as Array<{ indicators_json: string }>;
  let warningCount = 0;
  let criticalCount = 0;
  for (const row of storedIndicators) {
    const list = JSON.parse(row.indicators_json || '[]') as Array<{ severity: string }>;
    warningCount += list.filter((i) => i.severity === 'warning').length;
    criticalCount += list.filter((i) => i.severity === 'critical').length;
  }

  const totalDatasetRows = datasetResults.reduce((acc, d) => acc + d.result.metrics.rowCount, 0);
  const totalAfterRows = datasetResults.reduce((acc, d) => acc + d.result.metrics.afterRowCount, 0);
  const totalDatasetCols = datasetResults.reduce((acc, d) => acc + d.result.metrics.columnCount, 0);
  const totalMissingBefore = datasetResults.reduce((acc, d) => acc + d.result.metrics.totalMissingValues, 0);
  const totalMissingAfter = datasetResults.reduce((acc, d) => acc + d.result.metrics.afterMissingValues, 0);
  const totalDuplicatesBefore = datasetResults.reduce((acc, d) => acc + d.result.metrics.duplicateRowCount, 0);
  const totalTypeErrorsBefore = datasetResults.reduce((acc, d) => acc + d.result.metrics.typeErrorCount, 0);
  const totalOutliers = datasetResults.reduce((acc, d) => acc + d.result.metrics.outlierCount, 0);

  const avgBeforeQuality =
    datasetResults.length > 0
      ? Number(
          (
            datasetResults.reduce((acc, d) => acc + d.result.metrics.beforeQualityScore, 0) / datasetResults.length
          ).toFixed(1),
        )
      : null;
  const avgAfterQuality =
    datasetResults.length > 0
      ? Number(
          (
            datasetResults.reduce((acc, d) => acc + d.result.metrics.afterQualityScore, 0) / datasetResults.length
          ).toFixed(1),
        )
      : null;

  const combinedFixes = datasetResults.flatMap((d) =>
    d.result.fixesApplied.map((f) => ({ ...f, evidenceId: d.evidenceId, filename: d.filename })),
  );
  const combinedValidations = [
    {
      check: 'SHA-256 Chain-of-Custody Integrity',
      passed: integrityResults.every((r) => r.verified),
      detail: `${integrityResults.filter((r) => r.verified).length}/${integrityResults.length} file digests verified intact.`,
    },
    ...datasetResults.flatMap((d) =>
      d.result.validationChecks.map((v) => ({ ...v, check: `${d.filename}: ${v.check}` })),
    ),
  ];
  const datasetRecommendations = datasetResults.flatMap((d) => d.result.recommendations);
  const nextSteps = Array.from(
    new Set([
      ...datasetRecommendations,
      ...(failedAgents.length > 0
        ? [`Re-run failed forensic engine checks (${failedAgents.map((f) => f.agent).join(', ')}) after inspecting file integrity.`]
        : []),
      ...(geminiSynth.recommendedNextSteps.length > 0
        ? geminiSynth.recommendedNextSteps
        : [
            'Ask the sender for the original unedited camera file to compare file timestamps and original resolution.',
            'Inspect highlighted video timestamps, audio segments, or image regions visually before sharing conclusions.',
            'Cross-check spoken dialogue or timestamps against independent primary sources.',
          ]),
    ]),
  );

  const aiRawScorePct = hasMlPredictions ? Number((avgRawScore * 100).toFixed(1)) : null;
  const peakAiRawScorePct = hasMlPredictions ? Number((maxScore * 100).toFixed(1)) : null;
  const genuineRawScorePct = aiRawScorePct !== null ? Number((100 - aiRawScorePct).toFixed(1)) : null;

  // Missing Evidence & Coverage Gap Analysis (never treat missing evidence as proof of authenticity)
  const missingEvidence: string[] = [];
  for (const ev of context.evidence) {
    if (ev.modality === 'image' && ev.metrics.exifPresent === false) {
      missingEvidence.push(
        `[${ev.id}] ${ev.original_filename}: Missing camera EXIF hardware tags (device origin cannot be confirmed from file headers).`,
      );
    }
    if (ev.modality === 'video') {
      if (!ev.metrics.hasAudioTrack && byModality.audio.length === 0) {
        missingEvidence.push(
          `[${ev.id}] ${ev.original_filename}: Video has no embedded audio stream and no external audio file was uploaded — audio spoofing and speech sync cannot be verified.`,
        );
      } else if (ev.metrics.hasAudioTrack && !ev.metrics.embeddedAudioAnalyzed) {
        missingEvidence.push(
          `[${ev.id}] ${ev.original_filename}: Embedded audio stream failed to decode cleanly — audio authenticity remains unverified.`,
        );
      }
      if (Number(ev.metrics.framesWithFacesCount ?? 0) === 0) {
        missingEvidence.push(
          `[${ev.id}] ${ev.original_filename}: No facial regions detected across sampled keyframes — face-swap neural checks could not inspect facial crops.`,
        );
      }
    }
  }
  if (byModality.text.length > 0 && byModality.video.length === 0 && byModality.audio.length === 0) {
    missingEvidence.push(
      `Text/subtitle evidence submitted without paired audio or video recording — spoken word verification unavailable.`,
    );
  }
  if ((byModality.audio.length > 0 || vids.some((v) => v.metrics.hasAudioTrack)) && storedAudioTranscripts.length === 0) {
    missingEvidence.push(
      `Speech transcription unavailable (${
        geminiSynth.available
          ? 'Enable "Allow Raw Media Transmission to Gemini" in Settings to run ASR verification'
          : 'GEMINI_API_KEY not configured on server'
      }) — acoustic-to-text alignment unverified.`,
    );
  }
  if (failedAgents.length > 0) {
    missingEvidence.push(
      `${failedAgents.length} forensic agent(s) encountered errors (${failedAgents
        .map((f) => f.agent)
        .join(', ')}) — failed evidence is NOT marked authentic.`,
    );
  }

  const execSummary = geminiSynth.executiveSummary || assessmentSummary;
  const reportId = genId('RPT');
  const fullReportPayload = {
    caseCode: inv.case_code,
    title: inv.title,
    generatedAt: new Date().toISOString(),
    executiveSummary: execSummary,
    confidenceLevel,
    confidenceTier: confidenceLevel,
    verdict: {
      label: verdictLabel,
      aiRawScorePct,
      genuineRawScorePct,
      peakRawScorePct: peakAiRawScorePct,
      scoresCalibrated: false,
      scoreBasisLabel: hasMlPredictions
        ? 'Model Pattern Score (0–100 scale — pattern match strength, not a calibrated probability)'
        : 'Not Applicable (No media deepfake ML models run on text/tabular files)',
      reliabilityLevel,
      plainSummary: assessmentSummary,
    },
    serviceWarnings: {
      geminiAvailable: geminiSynth.available,
      geminiError: geminiSynth.error || null,
      rawMediaSent: geminiSynth.rawMediaSent,
      attachedMediaIds: geminiSynth.attachedMediaIds,
      failedAgents,
    },
    missingEvidence,
    evidenceCount: evidenceList.length,
    correlationsCreated,
    overview: {
      totalFiles: evidenceList.length,
      totalBytes: evidenceList.reduce((acc, e) => acc + e.file_size, 0),
      modalities: Object.entries(byModality)
        .filter(([, arr]) => arr.length > 0)
        .map(([k, arr]) => ({ modality: k, count: arr.length })),
      datasetCount: datasetResults.length,
      totalRows: totalDatasetRows,
      afterRows: totalAfterRows,
      totalColumns: totalDatasetCols,
    },
    qualityScores: {
      beforeQualityScore: avgBeforeQuality,
      afterQualityScore: avgAfterQuality,
      peakMlAnomalyScore: peakAiRawScorePct,
      sha256VerifiedCount: integrityResults.filter((r) => r.verified).length,
    },
    issuesSummary: {
      missingValuesBefore: totalMissingBefore,
      missingValuesAfter: totalMissingAfter,
      duplicateRowsBefore: totalDuplicatesBefore,
      duplicateRowsAfter: 0,
      typeErrorsBefore: totalTypeErrorsBefore,
      statisticalOutliers: totalOutliers,
      warningIndicators: warningCount,
      criticalIndicators: criticalCount,
    },
    automatedFixes: combinedFixes,
    beforeAfterComparisons: datasetResults[0]?.result.beforeAfterComparisons || [],
    datasetColumns: datasetResults.flatMap((d) =>
      d.result.columns.map((c) => ({ ...c, evidenceId: d.evidenceId, filename: d.filename })),
    ),
    cleanedDownloads: datasetResults.map((d) => ({
      evidenceId: d.evidenceId,
      filename: d.filename,
      url: d.result.cleanedCsvUrl,
      beforeScore: d.result.metrics.beforeQualityScore,
      afterScore: d.result.metrics.afterQualityScore,
    })),
    validationResults: combinedValidations,
    alternativeExplanations: alternatives,
    recommendedNextSteps: nextSteps,
    geminiAssisted: geminiSynth.available,
  };

  db.prepare(
    `INSERT INTO investigation_reports
    (id, investigation_id, title, executive_summary, human_conclusion, report_json, generated_by, created_at)
    VALUES (?, ?, ?, ?, 'Pending investigator review and sign-off', ?, ?, ?)`,
  ).run(
    reportId,
    investigationId,
    `TruthLens Forensic Investigation Report — ${inv.case_code}`,
    execSummary,
    JSON.stringify(fullReportPayload),
    geminiSynth.available ? 'Report Generation Agent + Gemini' : 'Report Generation Agent (Local)',
    new Date().toISOString(),
  );

  recordAgentComplete(ag9, 'completed', { reportId, nextSteps, failedAgents, missingEvidenceCount: missingEvidence.length });
  updateJobStage(investigationId, 'Completed 9-Agent Pipeline', 100);

  logAudit(investigationId, actor, 'PIPELINE_EXECUTED', 'investigation', investigationId, {
    agentsExecuted,
    correlationsCreated,
    reportId,
    geminiUsed: geminiSynth.available,
    failedAgents: failedAgents.length,
  });

  return {
    status: 'review_required',
    agentsExecuted,
    correlationsCreated,
    geminiUsed: geminiSynth.available,
    geminiError: geminiSynth.error,
    rawMediaSent: geminiSynth.rawMediaSent,
    failedAgents,
  };
}

export function startAsyncInvestigationPipeline(investigationId: string, actor = 'Investigator'): PipelineJobState {
  const existing = activePipelineJobs.get(investigationId);
  if (existing && existing.status === 'running') {
    throw new Error('Pipeline execution already in progress for this investigation');
  }

  const job: PipelineJobState = {
    investigationId,
    status: 'running',
    currentStage: 'Initializing multi-agent pipeline...',
    progressPct: 5,
    startedAt: new Date().toISOString(),
    cancelRequested: false,
  };
  activePipelineJobs.set(investigationId, job);

  void runInvestigationPipeline(investigationId, actor)
    .then(() => {
      job.status = 'completed';
      job.progressPct = 100;
      job.currentStage = 'Pipeline complete';
      job.completedAt = new Date().toISOString();
    })
    .catch((err) => {
      const msg = err instanceof Error ? err.message : 'Pipeline execution error';
      job.status = job.cancelRequested ? 'cancelled' : 'failed';
      job.error = msg;
      job.currentStage = job.cancelRequested ? 'Cancelled by investigator' : 'Failed';
      job.completedAt = new Date().toISOString();
      if (job.cancelRequested) {
        getDb()
          .prepare(`UPDATE investigations SET status = 'review_required', updated_at = ? WHERE id = ?`)
          .run(new Date().toISOString(), investigationId);
        logAudit(investigationId, actor, 'PIPELINE_CANCELLED', 'investigation', investigationId, {});
      }
    });

  return job;
}
