import crypto from 'crypto';
import express, { type Request, type Response } from 'express';
import fs from 'fs';
import multer from 'multer';
import path from 'path';
import { z } from 'zod';
import { DATASETS_UPLOAD_DIR, MAX_UPLOAD_BYTES, resolveSafeStoragePath } from '../config.ts';
import { getDb, logAudit } from '../db/database.ts';
import {
  cancelDatasetEvaluationRun,
  type DatasetEvalResultRow,
  type DatasetEvalRunRow,
  type DatasetUploadRow,
  formatDatasetEvalCsv,
  genEvalId,
  getDatasetUploadRootDir,
  inspectDatasetCsv,
  matchCsvToDatasetFiles,
  sanitizeDatasetRelPath,
  scanDatasetDirectory,
  startDatasetEvaluationRun,
  SUPPORTED_DATASET_CSV_EXTS,
  SUPPORTED_DATASET_IMAGE_EXTS,
  type UnsupportedFileRecord,
} from '../ml/datasetEvaluation.ts';

export const datasetEvalRouter = express.Router();

const STAGING_DIR = path.join(DATASETS_UPLOAD_DIR, '_staging');

const batchUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      fs.mkdirSync(STAGING_DIR, { recursive: true });
      cb(null, STAGING_DIR);
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}${ext}`);
    },
  }),
  limits: {
    fileSize: MAX_UPLOAD_BYTES,
    files: 100,
  },
});

// List uploaded datasets and recent evaluation runs
datasetEvalRouter.get('/datasets', (_req: Request, res: Response) => {
  const db = getDb();
  const datasets = db
    .prepare(`SELECT * FROM dataset_uploads ORDER BY created_at DESC LIMIT 30`)
    .all() as DatasetUploadRow[];
  const runs = db
    .prepare(`SELECT * FROM dataset_eval_runs ORDER BY started_at DESC LIMIT 40`)
    .all() as DatasetEvalRunRow[];
  res.json({ datasets, runs });
});

// Initialize a new dataset folder upload session
datasetEvalRouter.post('/datasets/init', (req: Request, res: Response) => {
  const schema = z.object({
    name: z.string().min(1).max(160),
  });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) {
    res.status(400).json({ error: 'Dataset folder name is required' });
    return;
  }

  const db = getDb();
  const id = genEvalId('DS');
  const safeRootName = parsed.data.name.replace(/[^a-zA-Z0-9._ -]/g, '_').trim() || 'uploaded_dataset';
  const storageDir = getDatasetUploadRootDir(id);
  fs.mkdirSync(storageDir, { recursive: true });

  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO dataset_uploads
     (id, name, storage_dir, total_files, image_count, csv_count, unsupported_count, total_bytes, tree_json, csv_files_json, unsupported_files_json, status, created_at)
     VALUES (?, ?, ?, 0, 0, 0, 0, 0, '{}', '[]', '[]', 'uploading', ?)`,
  ).run(id, safeRootName, storageDir, now);

  res.status(201).json({
    dataset: db.prepare(`SELECT * FROM dataset_uploads WHERE id = ?`).get(id),
  });
});

// Upload a batch of files into the dataset preserving nested folder structure
datasetEvalRouter.post('/datasets/:datasetId/files', (req: Request, res: Response) => {
  batchUpload.array('files', 100)(req, res, (err) => {
    if (err) {
      res.status(400).json({ error: err.message || 'Batch upload failed' });
      return;
    }

    const db = getDb();
    const ds = db.prepare(`SELECT * FROM dataset_uploads WHERE id = ?`).get(req.params.datasetId) as
      | DatasetUploadRow
      | undefined;
    if (!ds) {
      for (const f of (req.files as Express.Multer.File[]) || []) {
        if (fs.existsSync(f.path)) fs.unlinkSync(f.path);
      }
      res.status(404).json({ error: 'Dataset upload session not found' });
      return;
    }

    const uploadedFiles = (req.files as Express.Multer.File[]) || [];
    let relPaths: string[] = [];
    try {
      if (typeof req.body.relativePaths === 'string') {
        relPaths = JSON.parse(req.body.relativePaths);
      } else if (Array.isArray(req.body.relativePaths)) {
        relPaths = req.body.relativePaths.map(String);
      }
    } catch {
      relPaths = [];
    }

    const existingUnsupported = JSON.parse(ds.unsupported_files_json || '[]') as UnsupportedFileRecord[];
    let acceptedCount = 0;
    let skippedUnsupportedCount = 0;

    for (let i = 0; i < uploadedFiles.length; i++) {
      const f = uploadedFiles[i];
      const rawRel = relPaths[i] || f.originalname;

      try {
        const cleanRel = sanitizeDatasetRelPath(rawRel);
        const baseName = path.posix.basename(cleanRel);
        if (baseName === '.DS_Store' || baseName === 'Thumbs.db' || cleanRel.includes('__MACOSX/')) {
          if (fs.existsSync(f.path)) fs.unlinkSync(f.path);
          continue;
        }

        const ext = path.extname(baseName).toLowerCase();
        const isSupported = SUPPORTED_DATASET_IMAGE_EXTS.has(ext) || SUPPORTED_DATASET_CSV_EXTS.has(ext);
        if (!isSupported) {
          skippedUnsupportedCount++;
          existingUnsupported.push({
            path: cleanRel,
            extension: ext || '(none)',
            size: f.size,
            reason: `Unsupported format "${ext || 'unknown'}". Dataset evaluation supports JPG, JPEG, PNG, and CSV.`,
          });
          if (fs.existsSync(f.path)) fs.unlinkSync(f.path);
          continue;
        }

        const destAbs = resolveSafeStoragePath(cleanRel, ds.storage_dir);
        fs.mkdirSync(path.dirname(destAbs), { recursive: true });
        try {
          fs.renameSync(f.path, destAbs);
        } catch {
          fs.copyFileSync(f.path, destAbs);
          fs.unlinkSync(f.path);
        }
        acceptedCount++;
      } catch (e) {
        if (fs.existsSync(f.path)) fs.unlinkSync(f.path);
        skippedUnsupportedCount++;
        existingUnsupported.push({
          path: rawRel,
          extension: path.extname(rawRel).toLowerCase() || '(none)',
          size: f.size,
          reason: e instanceof Error ? e.message : 'Invalid file path',
        });
      }
    }

    db.prepare(`UPDATE dataset_uploads SET unsupported_files_json = ?, unsupported_count = ? WHERE id = ?`).run(
      JSON.stringify(existingUnsupported),
      existingUnsupported.length,
      ds.id,
    );

    res.json({
      datasetId: ds.id,
      acceptedCount,
      skippedUnsupportedCount,
    });
  });
});

// Finalize upload: scan directory structure, compute counts & folder tree
datasetEvalRouter.post('/datasets/:datasetId/finalize', (req: Request, res: Response) => {
  const db = getDb();
  const ds = db.prepare(`SELECT * FROM dataset_uploads WHERE id = ?`).get(req.params.datasetId) as
    | DatasetUploadRow
    | undefined;
  if (!ds) {
    res.status(404).json({ error: 'Dataset upload session not found' });
    return;
  }

  const scanned = scanDatasetDirectory(ds.storage_dir, ds.name);
  const uploadRejected = JSON.parse(ds.unsupported_files_json || '[]') as UnsupportedFileRecord[];
  const mergedUnsupported = [...uploadRejected, ...scanned.unsupportedFiles];

  const totalFiles = scanned.imageCount + scanned.csvCount + mergedUnsupported.length;

  db.prepare(
    `UPDATE dataset_uploads
     SET total_files = ?, image_count = ?, csv_count = ?, unsupported_count = ?, total_bytes = ?,
         tree_json = ?, csv_files_json = ?, unsupported_files_json = ?, status = 'ready'
     WHERE id = ?`,
  ).run(
    totalFiles,
    scanned.imageCount,
    scanned.csvCount,
    mergedUnsupported.length,
    scanned.totalBytes,
    JSON.stringify(scanned.tree),
    JSON.stringify(scanned.csvFiles),
    JSON.stringify(mergedUnsupported),
    ds.id,
  );

  logAudit(null, 'Investigator', 'DATASET_FOLDER_UPLOADED', 'dataset_upload', ds.id, {
    name: ds.name,
    imageCount: scanned.imageCount,
    csvCount: scanned.csvCount,
    unsupportedCount: mergedUnsupported.length,
    totalBytes: scanned.totalBytes,
  });

  res.json({
    dataset: db.prepare(`SELECT * FROM dataset_uploads WHERE id = ?`).get(ds.id),
  });
});

// Delete an uploaded dataset (does not affect existing investigations)
datasetEvalRouter.delete('/datasets/:datasetId', (req: Request, res: Response) => {
  const db = getDb();
  const ds = db.prepare(`SELECT * FROM dataset_uploads WHERE id = ?`).get(req.params.datasetId) as
    | DatasetUploadRow
    | undefined;
  if (!ds) {
    res.status(404).json({ error: 'Dataset not found' });
    return;
  }

  db.prepare(`DELETE FROM dataset_uploads WHERE id = ?`).run(ds.id);
  if (fs.existsSync(ds.storage_dir)) {
    fs.rmSync(ds.storage_dir, { recursive: true, force: true });
  }
  logAudit(null, 'Investigator', 'DATASET_FOLDER_DELETED', 'dataset_upload', ds.id, { name: ds.name });
  res.json({ deleted: true, id: ds.id });
});

// Serve an individual image file from an uploaded dataset safely for visual inspection
datasetEvalRouter.get('/datasets/:datasetId/file', (req: Request, res: Response) => {
  const db = getDb();
  const ds = db.prepare(`SELECT * FROM dataset_uploads WHERE id = ?`).get(req.params.datasetId) as
    | DatasetUploadRow
    | undefined;
  if (!ds) {
    res.status(404).json({ error: 'Dataset not found' });
    return;
  }
  const relPath = typeof req.query.path === 'string' ? req.query.path : '';
  try {
    const clean = sanitizeDatasetRelPath(relPath);
    const abs = resolveSafeStoragePath(clean, ds.storage_dir);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      res.status(404).json({ error: 'File not found in dataset' });
      return;
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(abs);
  } catch {
    res.status(400).json({ error: 'Invalid file path' });
  }
});

// Inspect selected CSV inside an uploaded dataset
datasetEvalRouter.get('/datasets/:datasetId/csv', (req: Request, res: Response) => {
  const db = getDb();
  const ds = db.prepare(`SELECT * FROM dataset_uploads WHERE id = ?`).get(req.params.datasetId) as
    | DatasetUploadRow
    | undefined;
  if (!ds) {
    res.status(404).json({ error: 'Dataset not found' });
    return;
  }
  const csvPath = typeof req.query.path === 'string' ? req.query.path : '';
  if (!csvPath) {
    res.status(400).json({ error: 'CSV path query parameter is required' });
    return;
  }
  try {
    const inspection = inspectDatasetCsv(ds.storage_dir, csvPath);
    res.json(inspection);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to inspect CSV' });
  }
});

// Match CSV rows against images inside the uploaded dataset
datasetEvalRouter.post('/datasets/:datasetId/match', (req: Request, res: Response) => {
  const schema = z.object({
    csvPath: z.string().min(1),
    pathColumn: z.string().min(1),
    labelColumn: z.string().min(1),
    labelMap: z.record(z.string(), z.enum(['real', 'fake', 'unmapped'])).optional(),
  });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid match parameters' });
    return;
  }

  const db = getDb();
  const ds = db.prepare(`SELECT * FROM dataset_uploads WHERE id = ?`).get(req.params.datasetId) as
    | DatasetUploadRow
    | undefined;
  if (!ds) {
    res.status(404).json({ error: 'Dataset not found' });
    return;
  }

  try {
    const summary = matchCsvToDatasetFiles({
      datasetDir: ds.storage_dir,
      csvRelPath: parsed.data.csvPath,
      pathColumn: parsed.data.pathColumn,
      labelColumn: parsed.data.labelColumn,
      labelMap: parsed.data.labelMap,
    });
    res.json({
      ...summary,
      // Limit returned diagnostics array if huge CSV while preserving full counts and all issue rows
      matchedSamples: summary.matchedSamples.slice(0, 100),
      diagnostics: [
        ...summary.diagnostics.filter((d) => d.status !== 'matched').slice(0, 300),
        ...summary.diagnostics.filter((d) => d.status === 'matched').slice(0, 100),
      ],
    });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Image matching failed' });
  }
});

// Start a real dataset evaluation run
datasetEvalRouter.post('/runs', (req: Request, res: Response) => {
  const schema = z.object({
    datasetId: z.string().min(1),
    csvPath: z.string().min(1),
    pathColumn: z.string().min(1),
    labelColumn: z.string().min(1),
    labelMap: z.record(z.string(), z.enum(['real', 'fake', 'unmapped'])).optional(),
  });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid evaluation payload' });
    return;
  }

  try {
    const run = startDatasetEvaluationRun({
      datasetId: parsed.data.datasetId,
      csvPath: parsed.data.csvPath,
      pathColumn: parsed.data.pathColumn,
      labelColumn: parsed.data.labelColumn,
      labelMap: parsed.data.labelMap,
      actor: 'Investigator',
    });
    res.status(202).json({ run });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Unable to start evaluation run' });
  }
});

// List persisted evaluation runs
datasetEvalRouter.get('/runs', (_req: Request, res: Response) => {
  const runs = getDb()
    .prepare(`SELECT * FROM dataset_eval_runs ORDER BY started_at DESC LIMIT 50`)
    .all() as DatasetEvalRunRow[];
  res.json({ runs });
});

// Get evaluation run details, metrics, and per-image results
datasetEvalRouter.get('/runs/:runId', (req: Request, res: Response) => {
  const db = getDb();
  const run = db.prepare(`SELECT * FROM dataset_eval_runs WHERE id = ?`).get(req.params.runId) as
    | DatasetEvalRunRow
    | undefined;
  if (!run) {
    res.status(404).json({ error: 'Evaluation run not found' });
    return;
  }
  const results = db
    .prepare(`SELECT * FROM dataset_eval_results WHERE run_id = ? ORDER BY row_index ASC, model_id ASC`)
    .all(run.id) as DatasetEvalResultRow[];
  res.json({ run, results });
});

// Cancel an active evaluation run
datasetEvalRouter.post('/runs/:runId/cancel', (req: Request, res: Response) => {
  const cancelled = cancelDatasetEvaluationRun(String(req.params.runId));
  const run = getDb().prepare(`SELECT * FROM dataset_eval_runs WHERE id = ?`).get(req.params.runId);
  res.json({ cancelled, run });
});

// Export evaluation report or incorrect predictions as CSV or JSON
datasetEvalRouter.get('/runs/:runId/export', (req: Request, res: Response) => {
  const db = getDb();
  const run = db.prepare(`SELECT * FROM dataset_eval_runs WHERE id = ?`).get(req.params.runId) as
    | DatasetEvalRunRow
    | undefined;
  if (!run) {
    res.status(404).json({ error: 'Evaluation run not found' });
    return;
  }
  const results = db
    .prepare(`SELECT * FROM dataset_eval_results WHERE run_id = ? ORDER BY row_index ASC, model_id ASC`)
    .all(run.id) as DatasetEvalResultRow[];

  const format = req.query.format === 'json' ? 'json' : 'csv';
  const scope = req.query.scope === 'incorrect' ? 'incorrect' : req.query.scope === 'issues' ? 'issues' : 'all';

  if (format === 'csv') {
    const csv = formatDatasetEvalCsv(run, results, scope);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="truthlens_eval_${run.id}_${scope}.csv"`);
    res.send(csv);
    return;
  }

  const filtered = results.filter((r) => {
    if (scope === 'incorrect') return r.correct === 0 || r.status === 'failed';
    if (scope === 'issues') return r.correct === 0 || r.status !== 'evaluated';
    return true;
  });

  const payload = {
    exportedAt: new Date().toISOString(),
    scope,
    scoresCalibrated: false,
    calibrationNotice:
      'All raw_score values are uncalibrated raw model outputs (0.0–1.0), not calibrated probabilities. Predictions with raw scores in [0.40, 0.65) are reported as inconclusive.',
    run: {
      ...run,
      labelMapping: JSON.parse(run.label_mapping_json || '{}'),
      metricsByModel: JSON.parse(run.metrics_by_model_json || '[]'),
      matchSummary: JSON.parse(run.match_summary_json || '{}'),
    },
    results: filtered.map((r) => ({
      ...r,
      correct: r.correct === null ? null : Boolean(r.correct),
      forensicMetrics: JSON.parse(r.forensic_metrics_json || '{}'),
    })),
  };

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="truthlens_eval_${run.id}_${scope}.json"`);
  res.send(JSON.stringify(payload, null, 2));
});
