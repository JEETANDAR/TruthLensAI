import { execFile } from 'child_process';
import crypto from 'crypto';
import express, { type Request, type Response } from 'express';
import fs from 'fs';
import multer from 'multer';
import path from 'path';
import { promisify } from 'util';
import { z } from 'zod';
import {
  ALLOWED_EXTENSIONS,
  ARTIFACTS_DIR,
  EXTENSION_TO_MODALITY,
  MAX_UPLOAD_BYTES,
  REPORTS_DIR,
  UPLOADS_DIR,
  resolveSafeStoragePath,
} from '../config.ts';
import { getDb, logAudit } from '../db/database.ts';
import {
  cancelInvestigationPipeline,
  getPipelineJobStatus,
  runInvestigationPipeline,
  startAsyncInvestigationPipeline,
} from '../agents/orchestrator.ts';
import { askGeminiCopilot, isGeminiConfigured } from '../ai/gemini.ts';
import { generateInvestigationPdf } from '../reports/pdf.ts';
import { getPretrainedModelAvailability } from '../ml/pretrained.ts';
import {
  executeValidationRun,
  formatValidationCsv,
  loadBenchmarkManifest,
  runBenchmarkCollectionValidation,
  type ValidationRunRow,
  type ValidationSampleInput,
  type ValidationSampleResultRow,
} from '../ml/validation.ts';
import { datasetEvalRouter } from './datasetEval.ts';

const execFileAsync = promisify(execFile);

async function probeMediaToolchain(): Promise<{ ffmpegAvailable: boolean; ffprobeAvailable: boolean }> {
  const check = async (cmd: string) => {
    try {
      await execFileAsync(cmd, ['-version'], { timeout: 3000 });
      return true;
    } catch {
      return false;
    }
  };
  const [ffmpegAvailable, ffprobeAvailable] = await Promise.all([check('ffmpeg'), check('ffprobe')]);
  return { ffmpegAvailable, ffprobeAvailable };
}

export const apiRouter = express.Router();

apiRouter.use('/dataset-eval', datasetEvalRouter);

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      const randName = `${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}${ext}`;
      cb(null, randName);
    },
  }),
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      cb(new Error(`Unsupported file extension: ${ext}. Allowed: ${Array.from(ALLOWED_EXTENSIONS).join(', ')}`));
      return;
    }
    cb(null, true);
  },
});

function genId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

// Serve generated forensic artifacts (ELA PNGs, noise maps, keyframes) safely
apiRouter.get('/artifacts/*', (req: Request, res: Response) => {
  try {
    const rel = (req.params as Record<string, string>)[0] || '';
    const safePath = resolveSafeStoragePath(rel, ARTIFACTS_DIR);
    if (!fs.existsSync(safePath)) {
      res.status(404).json({ error: 'Artifact not found' });
      return;
    }
    res.sendFile(safePath);
  } catch {
    res.status(400).json({ error: 'Invalid artifact path' });
  }
});

// Stream original uploaded evidence safely (read-only)
apiRouter.get('/evidence/:id/file', (req: Request, res: Response) => {
  const row = getDb()
    .prepare(`SELECT investigation_id, storage_path, mime_type, original_filename FROM evidence WHERE id = ?`)
    .get(req.params.id) as
    | { investigation_id: string; storage_path: string; mime_type: string; original_filename: string }
    | undefined;
  const invFilter = typeof req.query.investigationId === 'string' ? req.query.investigationId : '';
  if (!row || (invFilter && row.investigation_id !== invFilter) || !fs.existsSync(row.storage_path)) {
    res.status(row && invFilter && row.investigation_id !== invFilter ? 403 : 404).json({
      error: row && invFilter && row.investigation_id !== invFilter
        ? 'Evidence item does not belong to this investigation'
        : 'Evidence file not found',
    });
    return;
  }
  res.setHeader('Content-Type', row.mime_type || 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.sendFile(path.resolve(row.storage_path));
});

// Verify SHA-256 chain of custody
apiRouter.get('/evidence/:id/verify', (req: Request, res: Response) => {
  const row = getDb()
    .prepare(`SELECT id, investigation_id, storage_path, sha256_hash FROM evidence WHERE id = ?`)
    .get(req.params.id) as
    | { id: string; investigation_id: string; storage_path: string; sha256_hash: string }
    | undefined;
  const invFilter = typeof req.query.investigationId === 'string' ? req.query.investigationId : '';
  if (!row) {
    res.status(404).json({ error: 'Evidence not found' });
    return;
  }
  if (invFilter && row.investigation_id !== invFilter) {
    res.status(403).json({ error: 'Evidence item does not belong to the requested investigation' });
    return;
  }
  if (!fs.existsSync(row.storage_path)) {
    res.status(404).json({ error: 'Evidence file missing from custody storage' });
    return;
  }
  const actualHash = crypto.createHash('sha256').update(fs.readFileSync(row.storage_path)).digest('hex');
  const verified = actualHash === row.sha256_hash;
  logAudit(row.investigation_id, 'Investigator', 'SHA256_VERIFIED', 'evidence', row.id, { verified });
  res.json({ evidenceId: row.id, expectedHash: row.sha256_hash, actualHash, verified });
});

// Single evidence item detail bundle
apiRouter.get('/evidence/:id', (req: Request, res: Response) => {
  const db = getDb();
  const ev = db.prepare(`SELECT * FROM evidence WHERE id = ?`).get(req.params.id) as
    | { id: string; investigation_id: string }
    | undefined;
  if (!ev) {
    res.status(404).json({ error: 'Evidence item not found' });
    return;
  }
  const invFilter = typeof req.query.investigationId === 'string' ? req.query.investigationId : '';
  if (invFilter && ev.investigation_id !== invFilter) {
    res.status(403).json({ error: 'Evidence item does not belong to the requested investigation' });
    return;
  }
  const analysis = db.prepare(`SELECT * FROM forensic_analyses WHERE evidence_id = ? LIMIT 1`).get(ev.id);
  const predictions = db.prepare(`SELECT * FROM model_predictions WHERE evidence_id = ?`).all(ev.id);
  const correlations = db
    .prepare(`SELECT * FROM evidence_correlations WHERE source_evidence_id = ? OR target_evidence_id = ?`)
    .all(ev.id, ev.id);
  const investigation = db.prepare(`SELECT id, case_code, title, status FROM investigations WHERE id = ?`).get(ev.investigation_id);
  res.json({ evidence: ev, investigation, analysis: analysis || null, predictions, correlations });
});

// Dashboard summary metrics from SQLite
apiRouter.get('/dashboard', async (_req: Request, res: Response) => {
  try {
    const db = getDb();
  const totalInvestigations = (db.prepare('SELECT COUNT(*) as c FROM investigations').get() as { c: number }).c;
  const totalEvidence = (db.prepare('SELECT COUNT(*) as c FROM evidence').get() as { c: number }).c;
  const reviewRequiredCount = (
    db.prepare(`SELECT COUNT(*) as c FROM investigations WHERE status = 'review_required' OR confidence_level = 'requires_review'`).get() as { c: number }
  ).c;

  const analyses = db
    .prepare(`SELECT modality, metrics_json, indicators_json FROM forensic_analyses`)
    .all() as Array<{ modality: string; metrics_json: string; indicators_json: string }>;
  let suspiciousIndicators = 0;
  let infoIndicators = 0;
  let warningIndicators = 0;
  let criticalIndicators = 0;
  let datasetFilesCount = 0;
  let datasetQualitySum = 0;

  for (const a of analyses) {
    const inds = JSON.parse(a.indicators_json || '[]') as Array<{ severity: string }>;
    for (const ind of inds) {
      if (ind.severity === 'critical') {
        criticalIndicators++;
        suspiciousIndicators++;
      } else if (ind.severity === 'warning') {
        warningIndicators++;
        suspiciousIndicators++;
      } else {
        infoIndicators++;
      }
    }
    if (a.modality === 'dataset') {
      const m = JSON.parse(a.metrics_json || '{}') as { afterQualityScore?: number };
      if (typeof m.afterQualityScore === 'number') {
        datasetFilesCount++;
        datasetQualitySum += m.afterQualityScore;
      }
    }
  }

  const modalityDist = db
    .prepare(`SELECT modality, COUNT(*) as count FROM evidence GROUP BY modality`)
    .all() as Array<{ modality: string; count: number }>;

  const statusDist = db
    .prepare(`SELECT status, COUNT(*) as count FROM investigations GROUP BY status`)
    .all() as Array<{ status: string; count: number }>;

  const recentInvestigations = db
    .prepare(
      `SELECT i.*, (SELECT COUNT(*) FROM evidence e WHERE e.investigation_id = i.id) as evidence_count
       FROM investigations i ORDER BY updated_at DESC LIMIT 8`,
    )
    .all();

  const recentAgents = db
    .prepare(`SELECT * FROM agent_executions ORDER BY started_at DESC LIMIT 10`)
    .all();

  const recentAudit = db
    .prepare(`SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 12`)
    .all();

  const predictionTimeline = db
    .prepare(
      `SELECT mp.created_at, mp.raw_score, mp.prediction_label, mp.model_id, e.original_filename, e.modality
       FROM model_predictions mp
       JOIN evidence e ON e.id = mp.evidence_id
       ORDER BY mp.created_at ASC LIMIT 30`,
    )
    .all();

  const datasetQualityTimeline = db
    .prepare(
      `SELECT e.original_filename, fa.metrics_json, fa.analyzed_at
       FROM forensic_analyses fa
       JOIN evidence e ON e.id = fa.evidence_id
       WHERE fa.modality = 'dataset'
       ORDER BY fa.analyzed_at ASC LIMIT 20`,
    )
    .all()
    .map((row) => {
      const r = row as { original_filename: string; metrics_json: string; analyzed_at: string };
      const m = JSON.parse(r.metrics_json || '{}');
      return {
        filename: r.original_filename,
        beforeScore: Number(m.beforeQualityScore ?? 0),
        afterScore: Number(m.afterQualityScore ?? 0),
        missingBefore: Number(m.totalMissingValues ?? 0),
        duplicatesBefore: Number(m.duplicateRowCount ?? 0),
        analyzedAt: r.analyzed_at,
      };
    });

  const toolchain = await probeMediaToolchain();

  res.json({
    metrics: {
      totalInvestigations,
      totalEvidence,
      suspiciousIndicators,
      reviewRequiredCount,
      avgDatasetQuality: datasetFilesCount > 0 ? Number((datasetQualitySum / datasetFilesCount).toFixed(1)) : null,
    },
    indicatorSeverityBreakdown: [
      { severity: 'Info', count: infoIndicators },
      { severity: 'Warning', count: warningIndicators },
      { severity: 'Critical', count: criticalIndicators },
    ],
    modalityDistribution: modalityDist,
    statusDistribution: statusDist,
    recentInvestigations,
    recentAgents,
    recentAudit,
    predictionTimeline,
    datasetQualityTimeline,
    systemHealth: {
      geminiConfigured: isGeminiConfigured(),
      ffmpegAvailable: toolchain.ffmpegAvailable,
      ffprobeAvailable: toolchain.ffprobeAvailable,
      pretrainedModels: getPretrainedModelAvailability(),
    },
  });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to load dashboard metrics' });
  }
});

// List all investigations with search/status filter
apiRouter.get('/investigations', (req: Request, res: Response) => {
  const db = getDb();
  const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';
  const status = typeof req.query.status === 'string' ? req.query.status : 'all';

  let rows = db
    .prepare(
      `SELECT i.*,
        (SELECT COUNT(*) FROM evidence e WHERE e.investigation_id = i.id) as evidence_count,
        (SELECT COUNT(*) FROM investigation_reports r WHERE r.investigation_id = i.id) as report_count
       FROM investigations i ORDER BY i.updated_at DESC`,
    )
    .all() as Array<Record<string, unknown>>;

  if (status !== 'all') {
    rows = rows.filter((r) => r.status === status);
  }
  if (q) {
    rows = rows.filter(
      (r) =>
        String(r.title).toLowerCase().includes(q) ||
        String(r.case_code).toLowerCase().includes(q) ||
        String(r.description).toLowerCase().includes(q),
    );
  }
  res.json({ investigations: rows });
});

// Create investigation
apiRouter.post('/investigations', (req: Request, res: Response) => {
  const schema = z.object({
    title: z.string().min(3).max(160),
    description: z.string().max(2000).optional().default(''),
    investigatorNotes: z.string().max(4000).optional().default(''),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid investigation payload' });
    return;
  }

  const db = getDb();
  const id = genId('INV');
  const codeNum = Math.floor(100 + Math.random() * 899);
  const caseCode = `TL-2026-${codeNum}`;
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO investigations
     (id, case_code, title, description, status, confidence_level, investigator_notes, owner_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'ingesting', 'pending', ?, 'USR-LEAD-01', ?, ?)`,
  ).run(id, caseCode, parsed.data.title, parsed.data.description, parsed.data.investigatorNotes, now, now);

  logAudit(id, 'Investigator', 'INVESTIGATION_CREATED', 'investigation', id, { caseCode, title: parsed.data.title });
  const created = db.prepare(`SELECT * FROM investigations WHERE id = ?`).get(id);
  res.status(201).json({ investigation: created });
});

// Get full investigation workspace bundle
apiRouter.get('/investigations/:id', (req: Request, res: Response) => {
  const db = getDb();
  const inv = db.prepare(`SELECT * FROM investigations WHERE id = ?`).get(req.params.id);
  if (!inv) {
    res.status(404).json({ error: 'Investigation not found' });
    return;
  }

  const evidence = db
    .prepare(`SELECT * FROM evidence WHERE investigation_id = ? ORDER BY uploaded_at ASC`)
    .all(req.params.id);
  const analyses = db
    .prepare(`SELECT * FROM forensic_analyses WHERE investigation_id = ?`)
    .all(req.params.id);
  const predictions = db
    .prepare(`SELECT * FROM model_predictions WHERE investigation_id = ?`)
    .all(req.params.id);
  const agents = db
    .prepare(`SELECT * FROM agent_executions WHERE investigation_id = ? ORDER BY started_at DESC`)
    .all(req.params.id);
  const correlations = db
    .prepare(`SELECT * FROM evidence_correlations WHERE investigation_id = ?`)
    .all(req.params.id);
  const reports = db
    .prepare(`SELECT * FROM investigation_reports WHERE investigation_id = ? ORDER BY created_at DESC`)
    .all(req.params.id);
  const auditLogs = db
    .prepare(`SELECT * FROM audit_logs WHERE investigation_id = ? ORDER BY created_at DESC LIMIT 30`)
    .all(req.params.id);

  res.json({
    investigation: inv,
    evidence,
    analyses,
    predictions,
    agents,
    correlations,
    reports,
    auditLogs,
  });
});

// Update investigation notes / status
apiRouter.patch('/investigations/:id', (req: Request, res: Response) => {
  const schema = z.object({
    status: z.enum(['ingesting', 'analyzing', 'review_required', 'closed']).optional(),
    investigator_notes: z.string().max(8000).optional(),
    confidence_level: z.enum(['pending', 'low_anomaly', 'inconclusive', 'requires_review']).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid update fields' });
    return;
  }
  const db = getDb();
  const curr = db.prepare(`SELECT * FROM investigations WHERE id = ?`).get(req.params.id) as
    | Record<string, string>
    | undefined;
  if (!curr) {
    res.status(404).json({ error: 'Investigation not found' });
    return;
  }

  const nextStatus = parsed.data.status ?? curr.status;
  const nextNotes = parsed.data.investigator_notes ?? curr.investigator_notes;
  const nextConf = parsed.data.confidence_level ?? curr.confidence_level;
  const now = new Date().toISOString();

  db.prepare(
    `UPDATE investigations SET status = ?, investigator_notes = ?, confidence_level = ?, updated_at = ? WHERE id = ?`,
  ).run(nextStatus, nextNotes, nextConf, now, req.params.id);

  logAudit(String(req.params.id), 'Investigator', 'INVESTIGATION_UPDATED', 'investigation', String(req.params.id), {
    status: nextStatus,
    confidence_level: nextConf,
  });
  res.json({ investigation: db.prepare(`SELECT * FROM investigations WHERE id = ?`).get(req.params.id) });
});

// Upload multipart evidence files
apiRouter.post('/investigations/:id/evidence', (req: Request, res: Response) => {
  upload.array('files', 10)(req, res, (err) => {
    if (err) {
      const status = (err as { code?: string }).code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      res.status(status).json({ error: err.message || 'Upload failed validation' });
      return;
    }
    const db = getDb();
    const inv = db.prepare(`SELECT id FROM investigations WHERE id = ?`).get(req.params.id);
    if (!inv) {
      res.status(404).json({ error: 'Investigation not found' });
      return;
    }

    const uploadedFiles = (req.files as Express.Multer.File[]) || [];
    if (uploadedFiles.length === 0) {
      res.status(400).json({ error: 'No valid files received' });
      return;
    }

    const contextNote = typeof req.body.contextNote === 'string' ? req.body.contextNote.slice(0, 1000) : '';
    const insertEv = db.prepare(`
      INSERT INTO evidence
      (id, investigation_id, original_filename, storage_path, mime_type, modality, file_size, sha256_hash, context_note, status, is_demo_fixture, uploaded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ingested', 0, ?)
    `);

    const created: unknown[] = [];
    const now = new Date().toISOString();
    for (const f of uploadedFiles) {
      const ext = path.extname(f.originalname).toLowerCase();
      const modality = EXTENSION_TO_MODALITY[ext];
      const buf = fs.readFileSync(f.path);
      const hash = crypto.createHash('sha256').update(buf).digest('hex');
      const evidId = genId('EVID');
      insertEv.run(
        evidId,
        req.params.id,
        path.basename(f.originalname),
        f.path,
        f.mimetype || 'application/octet-stream',
        modality,
        f.size,
        hash,
        contextNote,
        now,
      );
      logAudit(String(req.params.id), 'Investigator', 'EVIDENCE_INGESTED', 'evidence', evidId, {
        filename: f.originalname,
        sha256: hash,
        modality,
      });
      created.push(db.prepare(`SELECT * FROM evidence WHERE id = ?`).get(evidId));
    }

    db.prepare(`UPDATE investigations SET updated_at = ? WHERE id = ?`).run(now, req.params.id);
    res.status(201).json({ evidence: created });
  });
});

// Direct text/JSON/SRT/CSV/TSV ingestion for Text & Dataset Intelligence studio
apiRouter.post('/investigations/:id/text-evidence', (req: Request, res: Response) => {
  const schema = z.object({
    filename: z.string().min(3).max(120),
    format: z.enum(['txt', 'json', 'srt', 'csv', 'tsv']).default('txt'),
    content: z.string().min(5).max(500000),
    contextNote: z.string().max(1000).optional().default(''),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid text or dataset input' });
    return;
  }
  const db = getDb();
  const inv = db.prepare(`SELECT id FROM investigations WHERE id = ?`).get(req.params.id);
  if (!inv) {
    res.status(404).json({ error: 'Investigation not found' });
    return;
  }

  const ext = `.${parsed.data.format}`;
  const cleanName = path.basename(parsed.data.filename).replace(/[^a-zA-Z0-9._-]/g, '_');
  const finalName = cleanName.endsWith(ext) ? cleanName : `${cleanName}${ext}`;
  const diskName = `${Date.now().toString(36)}-${crypto.randomBytes(5).toString('hex')}${ext}`;
  const filePath = path.join(UPLOADS_DIR, diskName);
  fs.writeFileSync(filePath, parsed.data.content, 'utf8');

  const buf = Buffer.from(parsed.data.content, 'utf8');
  const hash = crypto.createHash('sha256').update(buf).digest('hex');
  const evidId = genId('EVID');
  const now = new Date().toISOString();
  const modality = parsed.data.format === 'csv' || parsed.data.format === 'tsv' ? 'dataset' : 'text';
  const mimeType =
    parsed.data.format === 'csv'
      ? 'text/csv'
      : parsed.data.format === 'tsv'
      ? 'text/tab-separated-values'
      : parsed.data.format === 'json'
      ? 'application/json'
      : 'text/plain';

  db.prepare(
    `INSERT INTO evidence
    (id, investigation_id, original_filename, storage_path, mime_type, modality, file_size, sha256_hash, context_note, status, is_demo_fixture, uploaded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ingested', 0, ?)`,
  ).run(
    evidId,
    req.params.id,
    finalName,
    filePath,
    mimeType,
    modality,
    buf.length,
    hash,
    parsed.data.contextNote,
    now,
  );
  logAudit(String(req.params.id), 'Investigator', 'TEXT_DATASET_INGESTED', 'evidence', evidId, { finalName, modality });
  res.status(201).json({ evidence: db.prepare(`SELECT * FROM evidence WHERE id = ?`).get(evidId) });
});

// Trigger full 9-agent forensic + ML pipeline (sync or async w/ duplicate guard)
apiRouter.post('/investigations/:id/analyze', async (req: Request, res: Response) => {
  const invId = String(req.params.id);
  const existingJob = getPipelineJobStatus(invId);
  if (existingJob && existingJob.status === 'running') {
    res.status(409).json({ error: 'Forensic analysis pipeline is already running for this investigation.', job: existingJob });
    return;
  }

  const runAsync = req.query.async === 'true' || req.body?.async === true;
  if (runAsync) {
    try {
      const db = getDb();
      const inv = db.prepare(`SELECT id FROM investigations WHERE id = ?`).get(invId);
      if (!inv) {
        res.status(404).json({ error: 'Investigation not found' });
        return;
      }
      const evCount = (db.prepare(`SELECT COUNT(*) as c FROM evidence WHERE investigation_id = ?`).get(invId) as { c: number }).c;
      if (evCount === 0) {
        res.status(400).json({ error: 'Cannot execute forensic pipeline on an empty investigation. Upload evidence first.' });
        return;
      }
      const job = startAsyncInvestigationPipeline(invId, 'Investigator');
      res.status(202).json({ status: 'analyzing', job });
    } catch (err) {
      res.status(409).json({ error: err instanceof Error ? err.message : 'Unable to start pipeline' });
    }
    return;
  }

  try {
    const result = await runInvestigationPipeline(invId, 'Investigator');
    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Pipeline execution failed';
    res.status(msg.includes('already running') ? 409 : 400).json({ error: msg });
  }
});

apiRouter.get('/investigations/:id/analyze/status', (req: Request, res: Response) => {
  const invId = String(req.params.id);
  const inv = getDb().prepare(`SELECT id, status FROM investigations WHERE id = ?`).get(invId) as
    | { id: string; status: string }
    | undefined;
  if (!inv) {
    res.status(404).json({ error: 'Investigation not found' });
    return;
  }
  const job = getPipelineJobStatus(invId);
  res.json({ investigationStatus: inv.status, job });
});

apiRouter.post('/investigations/:id/analyze/cancel', (req: Request, res: Response) => {
  const invId = String(req.params.id);
  const cancelled = cancelInvestigationPipeline(invId);
  const job = getPipelineJobStatus(invId);
  res.json({ cancelled, job });
});

// Delete evidence item
apiRouter.delete('/evidence/:id', (req: Request, res: Response) => {
  const db = getDb();
  const ev = db.prepare(`SELECT * FROM evidence WHERE id = ?`).get(req.params.id) as
    | { id: string; investigation_id: string; storage_path: string; original_filename: string }
    | undefined;
  if (!ev) {
    res.status(404).json({ error: 'Evidence not found' });
    return;
  }
  const invFilter = typeof req.query.investigationId === 'string' ? req.query.investigationId : '';
  if (invFilter && ev.investigation_id !== invFilter) {
    res.status(403).json({ error: 'Evidence item does not belong to the requested investigation' });
    return;
  }
  db.prepare(`DELETE FROM evidence WHERE id = ?`).run(ev.id);
  logAudit(ev.investigation_id, 'Investigator', 'EVIDENCE_DELETED', 'evidence', ev.id, {
    filename: ev.original_filename,
  });
  res.json({ deleted: true, id: ev.id });
});

// Copilot conversations & messaging
apiRouter.get('/investigations/:id/copilot', (req: Request, res: Response) => {
  const db = getDb();
  const inv = db.prepare(`SELECT id FROM investigations WHERE id = ?`).get(req.params.id);
  if (!inv) {
    res.status(404).json({ error: 'Investigation not found' });
    return;
  }
  let conv = db
    .prepare(`SELECT * FROM copilot_conversations WHERE investigation_id = ? ORDER BY created_at DESC LIMIT 1`)
    .get(req.params.id) as { id: string; investigation_id: string; title: string; created_at: string } | undefined;

  if (!conv) {
    const convId = genId('COP');
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO copilot_conversations (id, investigation_id, title, created_at) VALUES (?, ?, ?, ?)`).run(
      convId,
      req.params.id,
      'Case Investigation Thread',
      now,
    );
    conv = { id: convId, investigation_id: String(req.params.id), title: 'Case Investigation Thread', created_at: now };
  }

  const messages = db
    .prepare(`SELECT * FROM copilot_messages WHERE conversation_id = ? ORDER BY created_at ASC`)
    .all(conv.id);
  res.json({ conversation: conv, messages, geminiConfigured: isGeminiConfigured() });
});

apiRouter.post('/investigations/:id/copilot', async (req: Request, res: Response) => {
  try {
    const schema = z.object({
      question: z.string().min(2).max(2000),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Question must be 2–2000 characters' });
      return;
    }

    const db = getDb();
  const inv = db.prepare(`SELECT id FROM investigations WHERE id = ?`).get(req.params.id);
  if (!inv) {
    res.status(404).json({ error: 'Investigation not found' });
    return;
  }
  let conv = db
    .prepare(`SELECT * FROM copilot_conversations WHERE investigation_id = ? ORDER BY created_at DESC LIMIT 1`)
    .get(req.params.id) as { id: string } | undefined;

  if (!conv) {
    const convId = genId('COP');
    db.prepare(`INSERT INTO copilot_conversations (id, investigation_id, title, created_at) VALUES (?, ?, ?, ?)`).run(
      convId,
      req.params.id,
      'Case Investigation Thread',
      new Date().toISOString(),
    );
    conv = { id: convId };
  }

  const history = db
    .prepare(`SELECT role, content FROM copilot_messages WHERE conversation_id = ? ORDER BY created_at ASC`)
    .all(conv.id) as Array<{ role: string; content: string }>;

  const userMsgId = genId('MSG');
  const nowUser = new Date().toISOString();
  db.prepare(
    `INSERT INTO copilot_messages (id, conversation_id, role, content, cited_evidence_ids_json, created_at)
     VALUES (?, ?, 'user', ?, '[]', ?)`,
  ).run(userMsgId, conv.id, parsed.data.question, nowUser);

  const reply = await askGeminiCopilot(String(req.params.id), parsed.data.question, history);
  const assistantMsgId = genId('MSG');
  const nowAsst = new Date().toISOString();
  db.prepare(
    `INSERT INTO copilot_messages (id, conversation_id, role, content, cited_evidence_ids_json, created_at)
     VALUES (?, ?, 'assistant', ?, ?, ?)`,
  ).run(assistantMsgId, conv.id, reply.answer, JSON.stringify(reply.citedEvidenceIds), nowAsst);

  logAudit(String(req.params.id), 'Investigator', 'COPILOT_QUERY', 'copilot', assistantMsgId, {
    geminiUsed: reply.geminiUsed,
    citedCount: reply.citedEvidenceIds.length,
  });

  res.json({
    userMessage: { id: userMsgId, role: 'user', content: parsed.data.question, created_at: nowUser },
    assistantMessage: {
      id: assistantMsgId,
      role: 'assistant',
      content: reply.answer,
      cited_evidence_ids_json: JSON.stringify(reply.citedEvidenceIds),
      created_at: nowAsst,
    },
      geminiUsed: reply.geminiUsed,
      error: reply.error,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Copilot query failed' });
  }
});

// Update human investigator conclusion on a report
apiRouter.patch('/reports/:reportId', (req: Request, res: Response) => {
  const schema = z.object({
    humanConclusion: z.string().min(3).max(4000),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Conclusion text is required' });
    return;
  }
  const db = getDb();
  const report = db.prepare(`SELECT * FROM investigation_reports WHERE id = ?`).get(req.params.reportId) as
    | { id: string; investigation_id: string }
    | undefined;
  if (!report) {
    res.status(404).json({ error: 'Report not found' });
    return;
  }
  db.prepare(`UPDATE investigation_reports SET human_conclusion = ? WHERE id = ?`).run(
    parsed.data.humanConclusion,
    report.id,
  );
  logAudit(report.investigation_id, 'Investigator', 'REPORT_REVIEWED', 'report', report.id, {});
  res.json({ report: db.prepare(`SELECT * FROM investigation_reports WHERE id = ?`).get(report.id) });
});

// Generate and download PDF report (?mode=simple|advanced)
apiRouter.get('/investigations/:id/reports/:reportId/pdf', async (req: Request, res: Response) => {
  try {
    const mode = req.query.mode === 'advanced' ? 'advanced' : 'simple';
    const pdfPath = await generateInvestigationPdf(String(req.params.id), String(req.params.reportId), mode);
    logAudit(String(req.params.id), 'Investigator', 'PDF_EXPORTED', 'report', String(req.params.reportId), { mode });
    res.download(pdfPath, path.basename(pdfPath));
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'PDF generation failed' });
  }
});

// Global Agent Activity ledger
apiRouter.get('/agents', (_req: Request, res: Response) => {
  const rows = getDb()
    .prepare(
      `SELECT ae.*, i.case_code, i.title as investigation_title
       FROM agent_executions ae
       JOIN investigations i ON i.id = ae.investigation_id
       ORDER BY ae.started_at DESC LIMIT 100`,
    )
    .all();
  res.json({ executions: rows });
});

// Model Evaluation Centre
apiRouter.get('/models', (_req: Request, res: Response) => {
  const db = getDb();
  const models = db.prepare(`SELECT * FROM model_registry ORDER BY modality ASC, name ASC`).all();
  const evaluations = db.prepare(`SELECT * FROM model_evaluations ORDER BY evaluated_at DESC`).all();
  res.json({ models, evaluations });
});

function serializeManifestSummary(manifest: ReturnType<typeof loadBenchmarkManifest>) {
  if (!manifest) return null;
  return {
    collectionId: manifest.collectionId,
    name: manifest.name,
    description: manifest.description,
    totalSamples: manifest.totalSamples,
    sources: manifest.sources,
    items: manifest.items.map((i) => ({
      id: i.id,
      modality: i.modality,
      filename: i.filename,
      groundTruthLabel: i.groundTruthLabel,
      sourceDataset: i.sourceDataset,
      sourceLicense: i.sourceLicense,
      fileSizeBytes: i.fileSizeBytes,
    })),
  };
}

// Real vs Fake Validation Suite endpoints (labels strictly separated from inference)
apiRouter.get('/validation', (_req: Request, res: Response) => {
  const db = getDb();
  const heldOutManifest = loadBenchmarkManifest('held_out');
  const devManifest = loadBenchmarkManifest('dev');
  const audioManifest = loadBenchmarkManifest('audio');
  const runs = db.prepare(`SELECT * FROM validation_runs ORDER BY started_at DESC LIMIT 30`).all() as ValidationRunRow[];
  const latestRun = runs[0] || null;
  const latestResults = latestRun
    ? (db
        .prepare(`SELECT * FROM validation_results WHERE run_id = ? ORDER BY modality ASC, filename ASC, model_id ASC`)
        .all(latestRun.id) as ValidationSampleResultRow[])
    : [];

  res.json({
    benchmark: serializeManifestSummary(heldOutManifest),
    devBenchmark: serializeManifestSummary(devManifest),
    audioBenchmark: serializeManifestSummary(audioManifest),
    baselineRunId: 'VALRUN-MWNLAXJW-KJS9',
    runs,
    latestResults,
  });
});

apiRouter.post('/validation/run', async (req: Request, res: Response) => {
  try {
    const schema = z.object({
      threshold: z.number().min(0.1).max(0.9).optional().default(0.5),
      async: z.boolean().optional().default(false),
      collection: z.enum(['held_out', 'dev', 'audio']).optional().default('held_out'),
    });
    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success) {
      res.status(400).json({ error: 'Threshold must be between 0.1 and 0.9 and collection must be held_out, dev, or audio' });
      return;
    }
    if (parsed.data.async) {
      const manifest = loadBenchmarkManifest(parsed.data.collection);
      if (!manifest || manifest.items.length === 0) {
        res.status(404).json({ error: `Validation benchmark manifest not found for ${parsed.data.collection}` });
        return;
      }
      const runId = genId('VALRUN');
      const now = new Date().toISOString();
      const realCount = manifest.items.filter((i) => i.groundTruthLabel === 'real').length;
      const fakeCount = manifest.items.filter((i) => i.groundTruthLabel === 'fake').length;
      getDb()
        .prepare(
          `INSERT INTO validation_runs
           (id, collection_id, collection_name, status, sample_count, real_count, fake_count, threshold, metrics_by_model_json, sources_json, notes, started_at)
           VALUES (?, ?, ?, 'running', ?, ?, ?, ?, '[]', ?, 'Starting validation pipeline...', ?)`,
        )
        .run(
          runId,
          manifest.collectionId,
          manifest.name,
          manifest.totalSamples,
          realCount,
          fakeCount,
          parsed.data.threshold,
          JSON.stringify(manifest.sources),
          now,
        );
      const pendingRun = getDb().prepare(`SELECT * FROM validation_runs WHERE id = ?`).get(runId) as ValidationRunRow;
      void runBenchmarkCollectionValidation(parsed.data.threshold, 'Investigator', runId, parsed.data.collection).catch(
        (err) => {
          getDb()
            .prepare(`UPDATE validation_runs SET status = 'failed', notes = ?, completed_at = ? WHERE id = ?`)
            .run(err instanceof Error ? err.message : 'Validation failed', new Date().toISOString(), runId);
        },
      );
      res.status(202).json({ run: pendingRun, results: [], metricsByModel: [] });
      return;
    }
    const out = await runBenchmarkCollectionValidation(
      parsed.data.threshold,
      'Investigator',
      undefined,
      parsed.data.collection,
    );
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Validation run failed' });
  }
});

apiRouter.post('/validation/custom', (req: Request, res: Response) => {
  upload.array('files', 20)(req, res, async (err) => {
    if (err) {
      res.status(400).json({ error: err.message || 'Upload validation failed' });
      return;
    }
    const uploadedFiles = (req.files as Express.Multer.File[]) || [];
    if (uploadedFiles.length === 0) {
      res.status(400).json({ error: 'At least one image or video file is required' });
      return;
    }
    try {
      const labelsRaw = req.body.labels;
      const labelsArr: string[] = Array.isArray(labelsRaw)
        ? labelsRaw.map(String)
        : typeof labelsRaw === 'string'
        ? JSON.parse(labelsRaw)
        : [];
      const threshold = Math.min(0.9, Math.max(0.1, Number(req.body.threshold || 0.5) || 0.5));
      const sourceNote =
        typeof req.body.sourceNote === 'string' && req.body.sourceNote.trim()
          ? req.body.sourceNote.trim().slice(0, 300)
          : 'User-supplied known-labelled validation batch';
      const licenseNote =
        typeof req.body.licenseNote === 'string' && req.body.licenseNote.trim()
          ? req.body.licenseNote.trim().slice(0, 200)
          : 'User-provided test media';

      const samples: ValidationSampleInput[] = [];
      for (let i = 0; i < uploadedFiles.length; i++) {
        const f = uploadedFiles[i];
        const ext = path.extname(f.originalname).toLowerCase();
        const mod = EXTENSION_TO_MODALITY[ext];
        if (mod !== 'image' && mod !== 'video' && mod !== 'audio') {
          throw new Error(`Unsupported validation modality for ${f.originalname}; only image, video, and audio files are supported.`);
        }
        const lbl = (labelsArr[i] || '').toLowerCase();
        if (lbl !== 'real' && lbl !== 'fake') {
          throw new Error(`Every uploaded sample requires an explicit ground-truth label ('real' or 'fake').`);
        }
        samples.push({
          sampleId: `CUS-${i + 1}`,
          modality: mod,
          filename: path.basename(f.originalname),
          filePath: f.path,
          groundTruthLabel: lbl,
          sourceDataset: sourceNote,
          sourceLicense: licenseNote,
        });
      }

      const realCount = samples.filter((s) => s.groundTruthLabel === 'real').length;
      const fakeCount = samples.filter((s) => s.groundTruthLabel === 'fake').length;
      const out = await executeValidationRun({
        collectionId: `CUSTOM-${Date.now().toString(36).toUpperCase()}`,
        collectionName: `Custom Validation Batch (n=${samples.length})`,
        samples,
        sources: [
          {
            name: sourceNote,
            url: 'local://user-upload',
            license: licenseNote,
            sampleCount: samples.length,
            breakdown: { real: realCount, fake: fakeCount },
            limitations: 'User-supplied evaluation batch; results apply strictly to these uploaded files.',
          },
        ],
        threshold,
        notes: `Custom labelled batch: ${realCount} real, ${fakeCount} fake. Ground truth isolated from inference.`,
        actor: 'Investigator',
      });
      res.status(201).json(out);
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : 'Custom validation failed' });
    } finally {
      for (const f of uploadedFiles) {
        if (fs.existsSync(f.path)) {
          try {
            fs.unlinkSync(f.path);
          } catch {
            // ignore cleanup error
          }
        }
      }
    }
  });
});

apiRouter.get('/validation/runs/:runId', (req: Request, res: Response) => {
  const db = getDb();
  const run = db.prepare(`SELECT * FROM validation_runs WHERE id = ?`).get(req.params.runId) as
    | ValidationRunRow
    | undefined;
  if (!run) {
    res.status(404).json({ error: 'Validation run not found' });
    return;
  }
  const results = db
    .prepare(`SELECT * FROM validation_results WHERE run_id = ? ORDER BY modality ASC, filename ASC, model_id ASC`)
    .all(run.id) as ValidationSampleResultRow[];
  res.json({ run, results });
});

apiRouter.get('/validation/runs/:runId/export', (req: Request, res: Response) => {
  const db = getDb();
  const run = db.prepare(`SELECT * FROM validation_runs WHERE id = ?`).get(req.params.runId) as
    | ValidationRunRow
    | undefined;
  if (!run) {
    res.status(404).json({ error: 'Validation run not found' });
    return;
  }
  const results = db
    .prepare(`SELECT * FROM validation_results WHERE run_id = ? ORDER BY modality ASC, filename ASC, model_id ASC`)
    .all(run.id) as ValidationSampleResultRow[];

  const format = req.query.format === 'csv' ? 'csv' : 'json';
  if (format === 'csv') {
    const csv = formatValidationCsv(run, results);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="truthlens_validation_${run.id}.csv"`);
    res.send(csv);
    return;
  }

  const payload = {
    exportedAt: new Date().toISOString(),
    scoresCalibrated: false,
    calibrationDisclaimer: 'All model raw_score values are uncalibrated raw outputs (0.0–1.0), not calibrated probabilities.',
    run: {
      ...run,
      metricsByModel: JSON.parse(run.metrics_by_model_json || '[]'),
      sources: JSON.parse(run.sources_json || '[]'),
    },
    results: results.map((r) => ({
      ...r,
      flagReasons: JSON.parse(r.flag_reasons_json || '[]'),
      forensicMetrics: JSON.parse(r.forensic_metrics_json || '{}'),
      correct: Boolean(r.correct),
      isCalibrated: false,
    })),
  };
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="truthlens_validation_${run.id}.json"`);
  res.send(JSON.stringify(payload, null, 2));
});

// Settings & System Health (never exposes secrets)
apiRouter.get('/settings', async (_req: Request, res: Response) => {
  try {
    const db = getDb();
    const user = db.prepare(`SELECT id, name, email, role, avatar_url, preferences_json, created_at FROM users LIMIT 1`).get();
    const evidenceBytes = (db.prepare(`SELECT COALESCE(SUM(file_size), 0) as total FROM evidence`).get() as { total: number })
      .total;
    const auditLogs = db.prepare(`SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 25`).all();
    const toolchain = await probeMediaToolchain();
    res.json({
      user,
      system: {
        geminiConfigured: isGeminiConfigured(),
        geminiModel: 'gemini-4-hydrogen',
        runtime: `Node.js ${process.version}`,
        ffmpegAvailable: toolchain.ffmpegAvailable,
        ffprobeAvailable: toolchain.ffprobeAvailable,
        storageUsedBytes: evidenceBytes,
        maxUploadBytes: MAX_UPLOAD_BYTES,
        pretrainedModels: getPretrainedModelAvailability(),
      },
      auditLogs,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to load settings' });
  }
});

apiRouter.patch('/settings', (req: Request, res: Response) => {
  const schema = z.object({
    name: z.string().min(2).max(100).optional(),
    role: z.string().min(2).max(100).optional(),
    preferences: z
      .object({
        retainDays: z.number().min(7).max(365),
        sendRawMediaToGemini: z.boolean(),
        showConfidenceBounds: z.boolean(),
      })
      .optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid settings payload' });
    return;
  }
  const db = getDb();
  const user = db.prepare(`SELECT * FROM users LIMIT 1`).get() as Record<string, string> | undefined;
  if (!user) {
    res.status(404).json({ error: 'User profile not found' });
    return;
  }
  db.prepare(`UPDATE users SET name = ?, role = ?, preferences_json = ? WHERE id = ?`).run(
    parsed.data.name ?? user.name,
    parsed.data.role ?? user.role,
    parsed.data.preferences ? JSON.stringify(parsed.data.preferences) : user.preferences_json,
    user.id,
  );
  logAudit(null, 'Investigator', 'SETTINGS_UPDATED', 'user', user.id, {});
  res.json({
    user: db
      .prepare(`SELECT id, name, email, role, avatar_url, preferences_json, created_at FROM users WHERE id = ?`)
      .get(user.id),
  });
});

// Clear all saved investigations, uploaded files, derived artifacts, reports, and audit logs
apiRouter.post('/system/clear-sessions', (_req: Request, res: Response) => {
  const db = getDb();
  db.prepare(`DELETE FROM audit_logs`).run();
  db.prepare(`DELETE FROM investigations`).run(); // cascades evidence, analyses, predictions, agents, correlations, reports, copilot

  for (const dir of [UPLOADS_DIR, ARTIFACTS_DIR, REPORTS_DIR]) {
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir)) {
        try {
          fs.rmSync(path.join(dir, f), { recursive: true, force: true });
        } catch {
          // ignore locked artifact
        }
      }
    }
  }

  res.json({ cleared: true });
});
