import crypto from 'crypto';
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import { GoogleGenAI, Type } from '@google/genai';
import sharp from 'sharp';
import { ARTIFACTS_DIR, SUBPROCESS_TIMEOUT_MS } from '../config.ts';
import { getDb } from '../db/database.ts';

const execFileAsync = promisify(execFile);
const MODEL_NAME = 'gemini-4-hydrogen';

function getClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') return null;
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

export function isGeminiConfigured(): boolean {
  const key = process.env.GEMINI_API_KEY;
  return Boolean(key && key !== 'MY_GEMINI_API_KEY' && key.trim().length > 8);
}

async function withTimeout<T>(promise: Promise<T>, ms = 35000, label = 'Gemini API'): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function withRetry<T>(fn: () => Promise<T>, retries = 1): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i <= retries; i++) {
    try {
      return await withTimeout(fn(), 35000, 'Gemini request');
    } catch (err) {
      lastErr = err;
      if (i < retries) {
        await new Promise((r) => setTimeout(r, 400 * (i + 1)));
      }
    }
  }
  throw lastErr;
}

export interface CaseContextBundle {
  investigation: {
    id: string;
    case_code: string;
    title: string;
    description: string;
    status: string;
    investigator_notes: string;
  };
  evidence: Array<{
    id: string;
    original_filename: string;
    modality: string;
    sha256_hash: string;
    context_note: string;
    storage_path?: string;
    mime_type?: string;
    metrics: Record<string, unknown>;
    indicators: Array<{ title: string; detail: string; severity: string }>;
    limitations: string;
    rawPreview?: string;
    sampledFrameUrls?: string[];
    embeddedAudioUrl?: string;
    predictions: Array<{
      model_id: string;
      prediction_label: string;
      raw_score: number;
      uncertainty_note: string;
    }>;
  }>;
  correlations: Array<{
    id: string;
    source_evidence_id: string;
    target_evidence_id: string;
    relationship_type: string;
    strength: number;
    summary: string;
  }>;
}

export function shouldSendRawMediaToGemini(): boolean {
  try {
    const db = getDb();
    const user = db.prepare(`SELECT preferences_json FROM users LIMIT 1`).get() as
      | { preferences_json?: string }
      | undefined;
    if (!user?.preferences_json) return false;
    const prefs = JSON.parse(user.preferences_json);
    return Boolean(prefs.sendRawMediaToGemini);
  } catch {
    return false;
  }
}

export function retrieveCaseContext(investigationId: string): CaseContextBundle | null {
  const db = getDb();
  const inv = db
    .prepare(
      `SELECT id, case_code, title, description, status, investigator_notes
       FROM investigations WHERE id = ?`,
    )
    .get(investigationId) as CaseContextBundle['investigation'] | undefined;
  if (!inv) return null;

  const evRows = db
    .prepare(
      `SELECT id, original_filename, modality, sha256_hash, context_note, storage_path, mime_type
       FROM evidence WHERE investigation_id = ? ORDER BY uploaded_at ASC`,
    )
    .all(investigationId) as Array<{
    id: string;
    original_filename: string;
    modality: string;
    sha256_hash: string;
    context_note: string;
    storage_path: string;
    mime_type: string;
  }>;

  const evidence = evRows.map((ev) => {
    const analysis = db
      .prepare(
        `SELECT metrics_json, indicators_json, artifacts_json, limitations
         FROM forensic_analyses WHERE evidence_id = ? ORDER BY analyzed_at DESC LIMIT 1`,
      )
      .get(ev.id) as
      | { metrics_json: string; indicators_json: string; artifacts_json: string; limitations: string }
      | undefined;

    const preds = db
      .prepare(
        `SELECT model_id, prediction_label, raw_score, uncertainty_note
         FROM model_predictions WHERE evidence_id = ?`,
      )
      .all(ev.id) as Array<{
      model_id: string;
      prediction_label: string;
      raw_score: number;
      uncertainty_note: string;
    }>;

    const artifacts = analysis ? JSON.parse(analysis.artifacts_json || '{}') : {};
    const sampledFrameUrls = Array.isArray(artifacts.sampledFrames)
      ? artifacts.sampledFrames.map((f: { frameUrl?: string }) => f.frameUrl).filter(Boolean)
      : undefined;
    const embeddedAudioUrl =
      typeof artifacts.embeddedAudio?.audioUrl === 'string' ? artifacts.embeddedAudio.audioUrl : undefined;

    return {
      ...ev,
      metrics: analysis ? JSON.parse(analysis.metrics_json || '{}') : {},
      indicators: analysis ? JSON.parse(analysis.indicators_json || '[]') : [],
      limitations: analysis?.limitations || '',
      rawPreview:
        typeof artifacts.rawPreview === 'string'
          ? artifacts.rawPreview.slice(0, 1500)
          : typeof artifacts.cleanedPreviewCsv === 'string'
          ? artifacts.cleanedPreviewCsv.slice(0, 1500)
          : undefined,
      sampledFrameUrls,
      embeddedAudioUrl,
      predictions: preds,
    };
  });

  const correlations = db
    .prepare(
      `SELECT id, source_evidence_id, target_evidence_id, relationship_type, strength, summary
       FROM evidence_correlations WHERE investigation_id = ?`,
    )
    .all(investigationId) as CaseContextBundle['correlations'];

  return { investigation: inv, evidence, correlations };
}

type InlinePart = { inlineData: { mimeType: string; data: string } } | { text: string };

async function buildMultimodalEvidenceParts(context: CaseContextBundle): Promise<{
  parts: InlinePart[];
  attachedEvidenceIds: string[];
}> {
  const parts: InlinePart[] = [];
  const attachedIds: string[] = [];

  // 1. Attach up to 3 images (resized to max 1024px JPEG)
  let imageCount = 0;
  for (const ev of context.evidence) {
    if (ev.modality === 'image' && ev.storage_path && fs.existsSync(ev.storage_path) && imageCount < 3) {
      try {
        const jpgBuf = await sharp(ev.storage_path)
          .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 82 })
          .toBuffer();
        parts.push({ text: `[IMAGE EVIDENCE ${ev.id}: ${ev.original_filename}]` });
        parts.push({ inlineData: { mimeType: 'image/jpeg', data: jpgBuf.toString('base64') } });
        attachedIds.push(ev.id);
        imageCount++;
      } catch {
        // skip unreadable image
      }
    }
  }

  // 2. Attach up to 3 representative video keyframes for visual check
  for (const ev of context.evidence) {
    if (ev.modality === 'video' && ev.sampledFrameUrls && ev.sampledFrameUrls.length > 0) {
      const picks = [
        ev.sampledFrameUrls[0],
        ev.sampledFrameUrls[Math.floor(ev.sampledFrameUrls.length / 2)],
        ev.sampledFrameUrls[ev.sampledFrameUrls.length - 1],
      ].filter(Boolean);
      const uniquePicks = Array.from(new Set(picks)).slice(0, 3);
      for (const relUrl of uniquePicks) {
        const diskRel = relUrl.replace(/^\/api\/artifacts\//, '');
        const abs = path.join(ARTIFACTS_DIR, diskRel);
        if (fs.existsSync(abs)) {
          try {
            const jpgBuf = await sharp(abs)
              .resize(768, 768, { fit: 'inside', withoutEnlargement: true })
              .jpeg({ quality: 78 })
              .toBuffer();
            parts.push({ text: `[VIDEO KEYFRAME FROM ${ev.id}: ${path.basename(abs)}]` });
            parts.push({ inlineData: { mimeType: 'image/jpeg', data: jpgBuf.toString('base64') } });
            attachedIds.push(ev.id);
          } catch {
            // ignore
          }
        }
      }
    }
  }

  // 3. Attach up to 2 audio streams (standalone audio OR extracted embedded video audio) for ASR + speech comparison
  let audioAttached = 0;
  for (const ev of context.evidence) {
    if (audioAttached >= 2) break;
    let audioPath: string | null = null;
    if (ev.modality === 'audio' && ev.storage_path && fs.existsSync(ev.storage_path)) {
      audioPath = ev.storage_path;
    } else if (ev.modality === 'video' && ev.embeddedAudioUrl) {
      const diskRel = ev.embeddedAudioUrl.replace(/^\/api\/artifacts\//, '');
      const candidate = path.join(ARTIFACTS_DIR, diskRel);
      if (fs.existsSync(candidate)) audioPath = candidate;
    }
    if (!audioPath) continue;

    try {
      let sendPath = audioPath;
      let mime = audioPath.endsWith('.mp3') ? 'audio/mp3' : 'audio/wav';
      const stat = fs.statSync(audioPath);
      if (stat.size > 4 * 1024 * 1024 || (!audioPath.endsWith('.wav') && !audioPath.endsWith('.mp3'))) {
        const tmpMp3 = path.join(ARTIFACTS_DIR, `gemini_tmp_${ev.id}.mp3`);
        await execFileAsync(
          'ffmpeg',
          ['-y', '-i', audioPath, '-t', '45', '-ac', '1', '-ar', '16000', '-b:a', '48k', tmpMp3],
          { timeout: SUBPROCESS_TIMEOUT_MS },
        );
        if (fs.existsSync(tmpMp3)) {
          sendPath = tmpMp3;
          mime = 'audio/mp3';
        }
      }
      const audioBuf = fs.readFileSync(sendPath);
      if (audioBuf.length <= 7 * 1024 * 1024) {
        parts.push({
          text: `[AUDIO STREAM FOR EVIDENCE ${ev.id} (${ev.original_filename}, modality=${ev.modality}): Transcribe speech verbatim if intelligible and compare against any text/SRT transcripts.]`,
        });
        parts.push({ inlineData: { mimeType: mime, data: audioBuf.toString('base64') } });
        attachedIds.push(ev.id);
        audioAttached++;
      }
      if (sendPath !== audioPath && fs.existsSync(sendPath)) {
        try {
          fs.unlinkSync(sendPath);
        } catch {
          // ignore cleanup
        }
      }
    } catch {
      // skip failed audio attachment
    }
  }

  return { parts, attachedEvidenceIds: Array.from(new Set(attachedIds)) };
}

export async function generateGeminiSynthesis(context: CaseContextBundle): Promise<{
  available: boolean;
  rawMediaSent: boolean;
  attachedMediaIds: string[];
  error?: string;
  audioTranscripts: Array<{ evidenceId: string; transcript: string; language?: string }>;
  textContradictions: Array<{ claim: string; conflict: string; citedIds: string[]; severity: string }>;
  correlations: Array<{
    sourceId: string;
    targetId: string;
    relationshipType: 'CONTRADICTS' | 'SUPPORTS' | 'DURATION_COMPATIBLE' | 'WEAKENS';
    strength: number;
    summary: string;
    alternativeExplanations: string[];
  }>;
  alternativeExplanations: string[];
  executiveSummary: string;
  recommendedNextSteps: string[];
}> {
  const ai = getClient();
  if (!ai) {
    return {
      available: false,
      rawMediaSent: false,
      attachedMediaIds: [],
      error: 'GEMINI_API_KEY is not configured in the server environment; AI multimodal analysis, speech-to-transcript verification, and synthesis are unavailable.',
      audioTranscripts: [],
      textContradictions: [],
      correlations: [],
      alternativeExplanations: [],
      executiveSummary: '',
      recommendedNextSteps: [],
    };
  }

  try {
    const allowRawMedia = shouldSendRawMediaToGemini();
    const { parts: mediaParts, attachedEvidenceIds } = allowRawMedia
      ? await buildMultimodalEvidenceParts(context)
      : { parts: [], attachedEvidenceIds: [] };

    // Strip internal disk storage_path before serializing JSON context to Gemini
    const sanitizedContext = {
      ...context,
      evidence: context.evidence.map(({ storage_path: _sp, ...rest }) => rest),
    };

    const promptText = `You are a senior digital forensics analyst assisting an investigation.
CRITICAL EPISTEMIC RULES:
1. Base EVERY finding strictly on the JSON evidence records and any attached multimodal evidence below. Never invent measurements, timestamps, transcripts, or evidence IDs.
2. Always cite exact evidence IDs (e.g. "${context.evidence[0]?.id || 'EVID-...'}").
3. NEVER treat matching media durations (e.g., an audio clip and transcript both being 4.5s) as proof of semantic or lip-sync alignment! Use "DURATION_COMPATIBLE" (low strength <= 0.35) unless actual spoken words, textual claims, or EXIF metadata provide genuine semantic corroboration or contradiction.
4. When audio/video-audio streams are attached above, transcribe spoken words verbatim in "audioTranscripts" and explicitly compare spoken dialogue against any uploaded TXT/SRT/JSON transcripts to emit SUPPORTS or CONTRADICTS correlations.
5. Distinguish observed forensic signals, uncalibrated ML model scores, and AI reasoning. Never present an uncalibrated ML score as factual probability or proof.
6. Provide realistic benign alternative explanations (e.g., social-media re-encoding, subtitle drift, camera clock offset, audio noise gate, portrait-domain shift).

INVESTIGATION CONTEXT:
${JSON.stringify(sanitizedContext, null, 2)}`;

    const contentsPayload =
      mediaParts.length > 0
        ? { parts: [...mediaParts, { text: promptText }] }
        : promptText;

    const response = await withRetry(() =>
      ai.models.generateContent({
        model: MODEL_NAME,
        contents: contentsPayload,
        config: {
          systemInstruction:
            'Return structured forensic synthesis JSON grounded strictly in supplied evidence records and attached media.',
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              audioTranscripts: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    evidenceId: { type: Type.STRING },
                    transcript: { type: Type.STRING },
                    language: { type: Type.STRING },
                  },
                },
              },
              textContradictions: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    claim: { type: Type.STRING },
                    conflict: { type: Type.STRING },
                    citedIds: { type: Type.ARRAY, items: { type: Type.STRING } },
                    severity: { type: Type.STRING },
                  },
                },
              },
              correlations: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    sourceId: { type: Type.STRING },
                    targetId: { type: Type.STRING },
                    relationshipType: { type: Type.STRING },
                    strength: { type: Type.NUMBER },
                    summary: { type: Type.STRING },
                    alternativeExplanations: { type: Type.ARRAY, items: { type: Type.STRING } },
                  },
                },
              },
              alternativeExplanations: { type: Type.ARRAY, items: { type: Type.STRING } },
              executiveSummary: { type: Type.STRING },
              recommendedNextSteps: { type: Type.ARRAY, items: { type: Type.STRING } },
            },
          },
        },
      }),
    );

    const parsed = JSON.parse((response.text || '{}').trim());
    return {
      available: true,
      rawMediaSent: mediaParts.length > 0,
      attachedMediaIds: attachedEvidenceIds,
      audioTranscripts: Array.isArray(parsed.audioTranscripts) ? parsed.audioTranscripts : [],
      textContradictions: Array.isArray(parsed.textContradictions) ? parsed.textContradictions : [],
      correlations: Array.isArray(parsed.correlations) ? parsed.correlations : [],
      alternativeExplanations: Array.isArray(parsed.alternativeExplanations) ? parsed.alternativeExplanations : [],
      executiveSummary: typeof parsed.executiveSummary === 'string' ? parsed.executiveSummary : '',
      recommendedNextSteps: Array.isArray(parsed.recommendedNextSteps) ? parsed.recommendedNextSteps : [],
    };
  } catch (err) {
    return {
      available: false,
      rawMediaSent: false,
      attachedMediaIds: [],
      error: err instanceof Error ? err.message : 'Gemini synthesis request failed',
      audioTranscripts: [],
      textContradictions: [],
      correlations: [],
      alternativeExplanations: [],
      executiveSummary: '',
      recommendedNextSteps: [],
    };
  }
}

export async function askGeminiCopilot(
  investigationId: string,
  question: string,
  history: Array<{ role: string; content: string }>,
): Promise<{ answer: string; citedEvidenceIds: string[]; geminiUsed: boolean; error?: string }> {
  const context = retrieveCaseContext(investigationId);
  if (!context) {
    throw new Error('Investigation not found');
  }

  const ai = getClient();
  const validIds = context.evidence.map((e) => e.id);

  if (!ai) {
    // Deterministic grounded retrieval summary separated cleanly by epistemic layer
    const qLower = question.toLowerCase();
    const relevantEv = context.evidence.filter(
      (ev) =>
        qLower.includes(ev.modality) ||
        qLower.includes(ev.id.toLowerCase()) ||
        qLower.includes(ev.original_filename.toLowerCase()),
    );
    const focusEv = relevantEv.length > 0 ? relevantEv : context.evidence;

    const signalLines = focusEv.map((ev) => {
      const topInd = ev.indicators.find((i) => i.severity !== 'info') || ev.indicators[0];
      return `• [${ev.id}] (${ev.original_filename}, ${ev.modality}): ${topInd ? `${topInd.title} — ${topInd.detail}` : 'Ingested'}`;
    });

    const mlLines = focusEv.flatMap((ev) =>
      ev.predictions.map(
        (p) =>
          `• [${ev.id}] ${p.model_id}: uncalibrated raw score ${(p.raw_score * 100).toFixed(1)}% (${p.prediction_label}) — ${p.uncertainty_note}`,
      ),
    );

    const corrLines = context.correlations.map(
      (c) => `• [${c.source_evidence_id}] → [${c.target_evidence_id}] (${c.relationship_type}, strength ${(c.strength * 100).toFixed(0)}%): ${c.summary}`,
    );

    const answer = [
      'UNAVAILABLE NOTICE: Gemini AI synthesis is unavailable because GEMINI_API_KEY is not configured in the server environment. Below is deterministic evidence retrieval from the local database only:',
      '',
      '1. OBSERVED FORENSIC INDICATORS (Deterministic):',
      ...(signalLines.length > 0 ? signalLines : ['• No analyzed signals stored yet.']),
      '',
      '2. UNCALIBRATED RAW ML MODEL SCORES (Not Calibrated Probabilities):',
      ...(mlLines.length > 0 ? mlLines : ['• No ML predictions recorded yet.']),
      '',
      '3. CROSS-MODAL CORRELATIONS & ALTERNATIVE CAUSES:',
      ...(corrLines.length > 0 ? corrLines : ['• No cross-modal edges computed yet.']),
      '• Benign alternatives: Social-media recompression, hardware noise suppression, and subtitle/clip trimming can produce elevated residuals without malicious tampering.',
    ].join('\n');

    return {
      answer,
      citedEvidenceIds: focusEv.map((e) => e.id),
      geminiUsed: false,
      error: 'GEMINI_API_KEY is not configured; Gemini Copilot is unavailable (showing local deterministic evidence retrieval only).',
    };
  }

  try {
    const recentHistory = history
      .slice(-6)
      .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
      .join('\n');

    const allowRawMedia = shouldSendRawMediaToGemini();
    const { parts: mediaParts } = allowRawMedia
      ? await buildMultimodalEvidenceParts(context)
      : { parts: [] };

    const sanitizedContext = {
      ...context,
      evidence: context.evidence.map(({ storage_path: _sp, ...rest }) => rest),
    };

    const prompt = `Case Evidence Store (Ground Truth):
${JSON.stringify(sanitizedContext, null, 2)}

Recent Conversation:
${recentHistory}

Investigator Question: ${question}

Instructions:
- Structure your response cleanly into:
  1. Observed Forensic Signals (exact metrics & indicators)
  2. Uncalibrated Raw Model Scores (model names, raw scores, and uncertainty bounds — NEVER state raw scores as calibrated factual probabilities)
  3. AI Interpretation & Cross-Modal Context
  4. Alternative Benign Explanations & Recommended Next Steps
- Every factual claim MUST reference exact evidence IDs in brackets like [EVID-...].
- Never treat matching file durations as proof of semantic alignment.
- Never invent evidence IDs, timestamps, or measurements not present in the Case Evidence Store.`;

    const contentsPayload =
      mediaParts.length > 0
        ? { parts: [...mediaParts, { text: prompt }] }
        : prompt;

    const response = await withRetry(() =>
      ai.models.generateContent({
        model: MODEL_NAME,
        contents: contentsPayload,
        config: {
          systemInstruction:
            'You are TruthLens Forensic Copilot. Provide precise, evidence-grounded answers citing exact evidence IDs and keeping observed signals, uncalibrated ML raw scores, and AI interpretation explicitly separated.',
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              answer: { type: Type.STRING },
              citedEvidenceIds: { type: Type.ARRAY, items: { type: Type.STRING } },
            },
          },
        },
      }),
    );

    const parsed = JSON.parse((response.text || '{}').trim());
    const citedFromJson: string[] = Array.isArray(parsed.citedEvidenceIds) ? parsed.citedEvidenceIds : [];
    const ansText = typeof parsed.answer === 'string' ? parsed.answer : 'Unable to synthesize response.';
    const citedFromText = validIds.filter((id) => ansText.includes(id));
    const cited = Array.from(new Set([...citedFromJson, ...citedFromText])).filter((id) => validIds.includes(id));

    return {
      answer: ansText,
      citedEvidenceIds: cited,
      geminiUsed: true,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Gemini request failed';
    return {
      answer: `Gemini Copilot encountered an upstream error (${msg}). Based on local SQLite records, ${context.evidence.length} evidence item(s) and ${context.correlations.length} cross-modal link(s) are available for manual verification.`,
      citedEvidenceIds: validIds.slice(0, 3),
      geminiUsed: false,
      error: msg,
    };
  }
}

export async function transcribeAudioFile(
  filePath: string,
  evidenceId: string,
): Promise<{
  available: boolean;
  transcribed: boolean;
  rawMediaSent: boolean;
  transcript: string;
  model: string;
  error?: string;
}> {
  const TRANSCRIBE_MODEL = 'gemini-3.5-transcribe';
  const ai = getClient();
  if (!ai) {
    return {
      available: false,
      transcribed: false,
      rawMediaSent: false,
      transcript: '',
      model: TRANSCRIBE_MODEL,
      error: 'GEMINI_API_KEY is not configured; speech transcription unavailable.',
    };
  }
  if (!shouldSendRawMediaToGemini()) {
    return {
      available: true,
      transcribed: false,
      rawMediaSent: false,
      transcript: '',
      model: TRANSCRIBE_MODEL,
      error: 'Raw media transmission to Gemini is disabled in Investigator Settings.',
    };
  }
  if (!fs.existsSync(filePath)) {
    return {
      available: true,
      transcribed: false,
      rawMediaSent: false,
      transcript: '',
      model: TRANSCRIBE_MODEL,
      error: 'Audio file not found on storage.',
    };
  }

  let sendPath = filePath;
  let cleanupTmp = false;
  let mimeType = filePath.toLowerCase().endsWith('.mp3') ? 'audio/mp3' : 'audio/wav';
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > 4 * 1024 * 1024 || (!filePath.toLowerCase().endsWith('.wav') && !filePath.toLowerCase().endsWith('.mp3'))) {
      const tmpMp3 = path.join(ARTIFACTS_DIR, `transcribe_tmp_${evidenceId}_${Date.now()}.mp3`);
      await execFileAsync(
        'ffmpeg',
        ['-y', '-i', filePath, '-t', '120', '-ac', '1', '-ar', '16000', '-b:a', '48k', tmpMp3],
        { timeout: SUBPROCESS_TIMEOUT_MS },
      );
      if (fs.existsSync(tmpMp3)) {
        sendPath = tmpMp3;
        mimeType = 'audio/mp3';
        cleanupTmp = true;
      }
    }

    const audioBase64 = fs.readFileSync(sendPath).toString('base64');
    const response = await withRetry(() =>
      ai.models.generateContent({
        model: TRANSCRIBE_MODEL,
        contents: {
          parts: [
            { inlineData: { mimeType, data: audioBase64 } },
            { text: 'Transcribe all intelligible speech verbatim into plain text. If there is no intelligible speech, reply with "[No intelligible speech]".' },
          ],
        },
      }),
    );

    const text = (response.text || '').trim();
    return {
      available: true,
      transcribed: text.length > 0,
      rawMediaSent: true,
      transcript: text,
      model: TRANSCRIBE_MODEL,
    };
  } catch (err) {
    return {
      available: true,
      transcribed: false,
      rawMediaSent: false,
      transcript: '',
      model: TRANSCRIBE_MODEL,
      error: err instanceof Error ? err.message : 'Speech transcription failed',
    };
  } finally {
    if (cleanupTmp && fs.existsSync(sendPath)) {
      try {
        fs.unlinkSync(sendPath);
      } catch {
        // ignore cleanup error
      }
    }
  }
}

export function getGeminiContextHash(investigationId: string): string {
  return crypto.createHash('sha256').update(investigationId).digest('hex').slice(0, 8);
}
