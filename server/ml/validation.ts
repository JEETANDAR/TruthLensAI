import fs from 'fs';
import path from 'path';
import { ARTIFACTS_DIR } from '../config.ts';
import { getDb, logAudit } from '../db/database.ts';
import { runImageForensics, type ForensicIndicator } from '../forensics/image.ts';
import { runVideoForensics } from '../forensics/video.ts';
import { runAudioForensics } from '../forensics/audio.ts';
import type { InferenceOutput } from './inference.ts';

export interface ValidationDatasetSource {
  name: string;
  url: string;
  license: string;
  sampleCount: number;
  breakdown: { real: number; fake: number };
  limitations: string;
}

export interface ValidationManifestItem {
  id: string;
  modality: 'image' | 'video' | 'audio';
  filename: string;
  relativePath: string;
  groundTruthLabel: 'real' | 'fake';
  rawDatasetLabel: string;
  sourceDataset: string;
  sourceLicense: string;
  fileSizeBytes: number;
}

export interface ValidationManifest {
  collectionId: string;
  name: string;
  description: string;
  sources: ValidationDatasetSource[];
  totalSamples: number;
  items: ValidationManifestItem[];
}

export interface ValidationSampleInput {
  sampleId: string;
  modality: 'image' | 'video' | 'audio';
  filename: string;
  filePath: string;
  groundTruthLabel: 'real' | 'fake';
  sourceDataset: string;
  sourceLicense?: string;
}

export interface ConfusionMatrixCounts {
  tp: number; // groundTruth=fake, predicted=fake
  fp: number; // groundTruth=real, predicted=fake
  tn: number; // groundTruth=real, predicted=real
  fn: number; // groundTruth=fake, predicted=real
}

export interface ModelValidationMetrics {
  modelId: string;
  modalityScope: 'all' | 'image' | 'video' | 'audio';
  sampleCount: number;
  realCount: number;
  fakeCount: number;
  metricsSupported: boolean;
  unsupportedReason?: string;
  confusionMatrix: ConfusionMatrixCounts;
  accuracy: number | null;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  fpr: number | null;
  meanRawScoreReal: number | null;
  meanRawScoreFake: number | null;
  scoresCalibrated: false;
}

export interface ValidationSampleResultRow {
  id: string;
  run_id: string;
  sample_id: string;
  modality: 'image' | 'video' | 'audio';
  filename: string;
  source_dataset: string;
  ground_truth_label: 'real' | 'fake';
  model_id: string;
  predicted_label: 'real' | 'fake';
  raw_score: number;
  is_calibrated: number;
  correct: number;
  flag_reasons_json: string;
  forensic_metrics_json: string;
  uncertainty_note: string;
  evaluated_at: string;
}

export interface ValidationRunRow {
  id: string;
  collection_id: string;
  collection_name: string;
  status: string;
  sample_count: number;
  real_count: number;
  fake_count: number;
  threshold: number;
  metrics_by_model_json: string;
  sources_json: string;
  notes: string;
  started_at: string;
  completed_at: string | null;
}

export type BenchmarkCollectionKey = 'held_out' | 'dev' | 'audio';

const HELD_OUT_MANIFEST_PATH = path.resolve(process.cwd(), 'datasets', 'validation_benchmark', 'manifest.json');
const DEV_MANIFEST_PATH = path.resolve(process.cwd(), 'datasets', 'dev_validation', 'manifest.json');
const AUDIO_MANIFEST_PATH = path.resolve(process.cwd(), 'datasets', 'audio_validation', 'manifest.json');

export function loadBenchmarkManifest(collection: BenchmarkCollectionKey = 'held_out'): ValidationManifest | null {
  const target =
    collection === 'dev'
      ? DEV_MANIFEST_PATH
      : collection === 'audio'
      ? AUDIO_MANIFEST_PATH
      : HELD_OUT_MANIFEST_PATH;
  if (!fs.existsSync(target)) return null;
  return JSON.parse(fs.readFileSync(target, 'utf8')) as ValidationManifest;
}

function genId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

function cleanupValidationArtifacts(evalId: string): void {
  const candidates = [
    path.join(ARTIFACTS_DIR, `ela_${evalId}.png`),
    path.join(ARTIFACTS_DIR, `noise_${evalId}.png`),
    path.join(ARTIFACTS_DIR, `vid_audio_${evalId}.wav`),
    path.join(ARTIFACTS_DIR, `frames_${evalId}`),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      fs.rmSync(p, { recursive: true, force: true });
    }
  }
}

function buildFlagExplanation(
  modality: 'image' | 'video' | 'audio',
  pred: InferenceOutput,
  predictedBinary: 'real' | 'fake',
  threshold: number,
  metrics: Record<string, number | string | boolean | null>,
  indicators: ForensicIndicator[],
): string[] {
  const reasons: string[] = [];
  const scorePct = (pred.rawScore * 100).toFixed(1);
  const threshPct = (threshold * 100).toFixed(0);

  if (predictedBinary === 'fake') {
    reasons.push(
      `Model ${pred.modelId} emitted uncalibrated raw score ${scorePct}/100 (>= ${threshPct}/100 threshold), triggering a manipulation flag.`,
    );
  } else {
    reasons.push(
      `Model ${pred.modelId} emitted uncalibrated raw score ${scorePct}/100 (< ${threshPct}/100 threshold), below the flag cutoff.`,
    );
  }

  if (pred.featureContributions && pred.featureContributions.length > 0) {
    const topContrib = [...pred.featureContributions]
      .sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact))
      .slice(0, 2)
      .map((c) => `${c.feature}=${(c.value * 100).toFixed(1)} (logit Δ=${c.impact.toFixed(2)})`)
      .join('; ');
    reasons.push(`Top model drivers: ${topContrib}.`);
  }

  if (modality === 'image') {
    const elaMean = Number(metrics.elaMean ?? 0);
    const elaVar = Number(metrics.elaSpatialVariance ?? 0);
    const noiseStd = Number(metrics.noiseFloorStd ?? 0);
    const dblJpeg = Boolean(metrics.doubleJpegSuspected);
    reasons.push(
      `Image forensics: ${metrics.width}x${metrics.height} ${String(metrics.format || '').toUpperCase()}, faces=${metrics.faceCount ?? 0}, ELA mean=${elaMean.toFixed(2)}, spatial var=${elaVar.toFixed(2)}, noise std=${noiseStd.toFixed(2)}, EXIF=${metrics.exifPresent ? 'present' : 'absent'}, double-JPEG=${dblJpeg ? 'suspected' : 'baseline'}.`,
    );
  } else if (modality === 'video') {
    const framesEvaluated = Number(metrics.framesMlEvaluated ?? 0);
    const sampledCount = Number(metrics.sampledFrameCount ?? 0);
    reasons.push(
      `Video forensics: ${metrics.resolution} (${metrics.codec}, ${metrics.durationSec}s), ${sampledCount} keyframes sampled (${framesEvaluated} scored, ${metrics.framesWithFacesCount ?? 0} w/ faces, tracks=${metrics.uniqueFaceTracksCount ?? 0}), embedded audio=${metrics.hasAudioTrack ? 'present' : 'absent'}.`,
    );
  } else {
    reasons.push(
      `Audio forensics: ${metrics.durationSec}s @ ${metrics.sampleRate}Hz (${metrics.codec}), spectral flatness=${metrics.spectralFlatnessMean}, clipping=${metrics.clippingRatio}, silence=${metrics.silenceRatio}.`,
    );
  }

  const elevatedInds = indicators.filter((ind) => ind.severity === 'warning' || ind.severity === 'critical');
  if (elevatedInds.length > 0) {
    reasons.push(
      `Forensic signals (${elevatedInds.length}): ${elevatedInds
        .slice(0, 2)
        .map((i) => i.title)
        .join(' | ')}.`,
    );
  }

  return reasons;
}

export function computeMetricsForGroup(
  modelId: string,
  modalityScope: 'all' | 'image' | 'video' | 'audio',
  rows: Array<{ groundTruth: 'real' | 'fake'; predicted: 'real' | 'fake'; rawScore: number }>,
): ModelValidationMetrics {
  const realRows = rows.filter((r) => r.groundTruth === 'real');
  const fakeRows = rows.filter((r) => r.groundTruth === 'fake');
  const sampleCount = rows.length;
  const realCount = realRows.length;
  const fakeCount = fakeRows.length;

  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  for (const r of rows) {
    if (r.groundTruth === 'fake' && r.predicted === 'fake') tp++;
    else if (r.groundTruth === 'real' && r.predicted === 'fake') fp++;
    else if (r.groundTruth === 'real' && r.predicted === 'real') tn++;
    else if (r.groundTruth === 'fake' && r.predicted === 'real') fn++;
  }

  const meanRawScoreReal =
    realCount > 0 ? Number((realRows.reduce((s, r) => s + r.rawScore, 0) / realCount).toFixed(4)) : null;
  const meanRawScoreFake =
    fakeCount > 0 ? Number((fakeRows.reduce((s, r) => s + r.rawScore, 0) / fakeCount).toFixed(4)) : null;

  // Only emit classification metrics when sample size (>=4) and both classes are present
  if (sampleCount < 4 || realCount === 0 || fakeCount === 0) {
    return {
      modelId,
      modalityScope,
      sampleCount,
      realCount,
      fakeCount,
      metricsSupported: false,
      unsupportedReason:
        sampleCount < 4
          ? `Sample size n=${sampleCount} < 4 minimum required for confusion matrix rates.`
          : 'Both verified Real and Fake samples are required to compute precision, recall, F1, and FPR.',
      confusionMatrix: { tp, fp, tn, fn },
      accuracy: null,
      precision: null,
      recall: null,
      f1: null,
      fpr: null,
      meanRawScoreReal,
      meanRawScoreFake,
      scoresCalibrated: false,
    };
  }

  const accuracy = Number(((tp + tn) / sampleCount).toFixed(4));
  const precision = tp + fp > 0 ? Number((tp / (tp + fp)).toFixed(4)) : null;
  const recall = tp + fn > 0 ? Number((tp / (tp + fn)).toFixed(4)) : null;
  const f1 =
    precision !== null && recall !== null && precision + recall > 0
      ? Number(((2 * precision * recall) / (precision + recall)).toFixed(4))
      : null;
  const fpr = fp + tn > 0 ? Number((fp / (fp + tn)).toFixed(4)) : null;

  return {
    modelId,
    modalityScope,
    sampleCount,
    realCount,
    fakeCount,
    metricsSupported: true,
    confusionMatrix: { tp, fp, tn, fn },
    accuracy,
    precision,
    recall,
    f1,
    fpr,
    meanRawScoreReal,
    meanRawScoreFake,
    scoresCalibrated: false,
  };
}

/**
 * Runs actual pretrained ONNX models & forensic pipelines on known-labelled samples.
 * Ground-truth labels are strictly isolated from inference and only joined post-inference for evaluation.
 */
export async function executeValidationRun(params: {
  runId?: string;
  collectionId: string;
  collectionName: string;
  samples: ValidationSampleInput[];
  sources: ValidationDatasetSource[];
  threshold?: number;
  notes?: string;
  actor?: string;
}): Promise<{
  run: ValidationRunRow;
  results: ValidationSampleResultRow[];
  metricsByModel: ModelValidationMetrics[];
}> {
  const db = getDb();
  const threshold = typeof params.threshold === 'number' && params.threshold > 0 && params.threshold < 1 ? params.threshold : 0.5;
  const runId = params.runId || genId('VALRUN');
  const startedAt = new Date().toISOString();
  const realCount = params.samples.filter((s) => s.groundTruthLabel === 'real').length;
  const fakeCount = params.samples.filter((s) => s.groundTruthLabel === 'fake').length;

  db.prepare(
    `INSERT OR REPLACE INTO validation_runs
     (id, collection_id, collection_name, status, sample_count, real_count, fake_count, threshold, metrics_by_model_json, sources_json, notes, started_at)
     VALUES (?, ?, ?, 'running', ?, ?, ?, ?, '[]', ?, ?, ?)`,
  ).run(
    runId,
    params.collectionId,
    params.collectionName,
    params.samples.length,
    realCount,
    fakeCount,
    threshold,
    JSON.stringify(params.sources),
    params.notes || '',
    startedAt,
  );

  // Blinded inference phase: groundTruthLabel is NOT passed into forensic or ML functions
  const blindedOutputs: Array<{
    sample: ValidationSampleInput;
    metrics: Record<string, number | string | boolean | null>;
    indicators: ForensicIndicator[];
    predictions: InferenceOutput[];
    error?: string;
  }> = [];

  for (let idx = 0; idx < params.samples.length; idx++) {
    const sample = params.samples[idx];
    const evalId = `VAL_${runId}_${sample.sampleId}`.replace(/[^a-zA-Z0-9_-]/g, '_');
    db.prepare(`UPDATE validation_runs SET notes = ? WHERE id = ?`).run(
      `Evaluating sample ${idx + 1}/${params.samples.length}: ${sample.filename}`,
      runId,
    );
    try {
      if (!fs.existsSync(sample.filePath)) {
        throw new Error(`Missing validation file: ${sample.filename}`);
      }
      if (sample.modality === 'image') {
        const res = await runImageForensics(evalId, sample.filePath);
        blindedOutputs.push({
          sample,
          metrics: res.metrics,
          indicators: res.indicators,
          predictions: res.mlPredictions,
        });
      } else if (sample.modality === 'video') {
        const res = await runVideoForensics(evalId, sample.filePath);
        blindedOutputs.push({
          sample,
          metrics: res.metrics,
          indicators: res.indicators,
          predictions: res.mlPredictions,
        });
      } else {
        const res = await runAudioForensics(evalId, sample.filePath);
        blindedOutputs.push({
          sample,
          metrics: res.metrics,
          indicators: res.indicators,
          predictions: res.mlPredictions,
        });
      }
    } catch (err) {
      blindedOutputs.push({
        sample,
        metrics: {},
        indicators: [],
        predictions: [],
        error: err instanceof Error ? err.message : 'Forensic pipeline execution failed',
      });
    } finally {
      cleanupValidationArtifacts(evalId);
    }
  }

  // Post-inference evaluation phase: compare uncalibrated predictions against isolated ground-truth labels
  const insertRes = db.prepare(
    `INSERT INTO validation_results
     (id, run_id, sample_id, modality, filename, source_dataset, ground_truth_label, model_id, predicted_label, raw_score, is_calibrated, correct, flag_reasons_json, forensic_metrics_json, uncertainty_note, evaluated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
  );

  const evaluatedAt = new Date().toISOString();
  const groupedForMetrics = new Map<
    string,
    {
      modelId: string;
      modalityScope: 'all' | 'image' | 'video' | 'audio';
      entries: Array<{ groundTruth: 'real' | 'fake'; predicted: 'real' | 'fake'; rawScore: number }>;
    }
  >();

  const resultRows: ValidationSampleResultRow[] = [];
  const failures: string[] = [];

  for (const item of blindedOutputs) {
    if (item.error) {
      failures.push(`${item.sample.filename}: ${item.error}`);
      continue;
    }

    for (const pred of item.predictions) {
      const predictedBinary: 'real' | 'fake' = pred.rawScore >= threshold ? 'fake' : 'real';
      const correct = predictedBinary === item.sample.groundTruthLabel ? 1 : 0;
      const flagReasons = buildFlagExplanation(
        item.sample.modality,
        pred,
        predictedBinary,
        threshold,
        item.metrics,
        item.indicators,
      );
      const compactMetrics: Record<string, number | string | boolean | null> =
        item.sample.modality === 'image'
          ? {
              width: item.metrics.width ?? null,
              height: item.metrics.height ?? null,
              format: item.metrics.format ?? null,
              faceCount: item.metrics.faceCount ?? 0,
              elaMean: item.metrics.elaMean ?? null,
              elaSpatialVariance: item.metrics.elaSpatialVariance ?? null,
              noiseFloorStd: item.metrics.noiseFloorStd ?? null,
              doubleJpegSuspected: item.metrics.doubleJpegSuspected ?? null,
              exifPresent: item.metrics.exifPresent ?? null,
            }
          : item.sample.modality === 'video'
          ? {
              resolution: item.metrics.resolution ?? null,
              durationSec: item.metrics.durationSec ?? null,
              codec: item.metrics.codec ?? null,
              sampledFrameCount: item.metrics.sampledFrameCount ?? null,
              framesMlEvaluated: item.metrics.framesMlEvaluated ?? null,
              framesWithFacesCount: item.metrics.framesWithFacesCount ?? 0,
              uniqueFaceTracksCount: item.metrics.uniqueFaceTracksCount ?? 0,
              hasAudioTrack: item.metrics.hasAudioTrack ?? null,
            }
          : {
              durationSec: item.metrics.durationSec ?? null,
              sampleRate: item.metrics.sampleRate ?? null,
              codec: item.metrics.codec ?? null,
              spectralFlatnessMean: item.metrics.spectralFlatnessMean ?? null,
              zcrVariance: item.metrics.zcrVariance ?? null,
              clippingRatio: item.metrics.clippingRatio ?? null,
              silenceRatio: item.metrics.silenceRatio ?? null,
            };

      const rowId = genId('VALRES');
      insertRes.run(
        rowId,
        runId,
        item.sample.sampleId,
        item.sample.modality,
        item.sample.filename,
        item.sample.sourceDataset,
        item.sample.groundTruthLabel,
        pred.modelId,
        predictedBinary,
        pred.rawScore,
        correct,
        JSON.stringify(flagReasons),
        JSON.stringify(compactMetrics),
        pred.uncertaintyNote,
        evaluatedAt,
      );

      resultRows.push({
        id: rowId,
        run_id: runId,
        sample_id: item.sample.sampleId,
        modality: item.sample.modality,
        filename: item.sample.filename,
        source_dataset: item.sample.sourceDataset,
        ground_truth_label: item.sample.groundTruthLabel,
        model_id: pred.modelId,
        predicted_label: predictedBinary,
        raw_score: pred.rawScore,
        is_calibrated: 0,
        correct,
        flag_reasons_json: JSON.stringify(flagReasons),
        forensic_metrics_json: JSON.stringify(compactMetrics),
        uncertainty_note: pred.uncertaintyNote,
        evaluated_at: evaluatedAt,
      });

      const allKey = `${pred.modelId}::all`;
      if (!groupedForMetrics.has(allKey)) {
        groupedForMetrics.set(allKey, { modelId: pred.modelId, modalityScope: 'all', entries: [] });
      }
      groupedForMetrics.get(allKey)!.entries.push({
        groundTruth: item.sample.groundTruthLabel,
        predicted: predictedBinary,
        rawScore: pred.rawScore,
      });

      const modKey = `${pred.modelId}::${item.sample.modality}`;
      if (!groupedForMetrics.has(modKey)) {
        groupedForMetrics.set(modKey, { modelId: pred.modelId, modalityScope: item.sample.modality, entries: [] });
      }
      groupedForMetrics.get(modKey)!.entries.push({
        groundTruth: item.sample.groundTruthLabel,
        predicted: predictedBinary,
        rawScore: pred.rawScore,
      });
    }
  }

  const metricsByModel: ModelValidationMetrics[] = [];
  for (const g of groupedForMetrics.values()) {
    // Skip duplicate modalityScope entry if all samples are single-modality
    if (g.modalityScope !== 'all') {
      const allGroup = groupedForMetrics.get(`${g.modelId}::all`);
      if (allGroup && allGroup.entries.length === g.entries.length) {
        continue;
      }
    }
    metricsByModel.push(computeMetricsForGroup(g.modelId, g.modalityScope, g.entries));
  }

  const completedAt = new Date().toISOString();
  const finalStatus = failures.length === params.samples.length ? 'failed' : failures.length > 0 ? 'completed_with_errors' : 'completed';
  const finalNotes = [
    params.notes || '',
    failures.length > 0 ? `Failures (${failures.length}): ${failures.join('; ')}` : '',
  ]
    .filter(Boolean)
    .join(' | ');

  db.prepare(
    `UPDATE validation_runs SET status = ?, metrics_by_model_json = ?, notes = ?, completed_at = ? WHERE id = ?`,
  ).run(finalStatus, JSON.stringify(metricsByModel), finalNotes, completedAt, runId);

  logAudit(null, params.actor || 'Investigator', 'VALIDATION_RUN_COMPLETED', 'validation_run', runId, {
    collectionId: params.collectionId,
    sampleCount: params.samples.length,
    threshold,
    failures: failures.length,
  });

  const runRow = db.prepare(`SELECT * FROM validation_runs WHERE id = ?`).get(runId) as ValidationRunRow;
  return { run: runRow, results: resultRows, metricsByModel };
}

export async function runBenchmarkCollectionValidation(
  threshold = 0.5,
  actor = 'Investigator',
  runId?: string,
  collection: BenchmarkCollectionKey = 'held_out',
) {
  const manifest = loadBenchmarkManifest(collection);
  if (!manifest || manifest.items.length === 0) {
    throw new Error(
      `Validation benchmark manifest not found for collection '${collection}'`,
    );
  }
  const samples: ValidationSampleInput[] = manifest.items.map((item) => ({
    sampleId: item.id,
    modality: item.modality,
    filename: item.filename,
    filePath: path.resolve(process.cwd(), item.relativePath),
    groundTruthLabel: item.groundTruthLabel,
    sourceDataset: item.sourceDataset,
    sourceLicense: item.sourceLicense,
  }));

  return executeValidationRun({
    runId,
    collectionId: manifest.collectionId,
    collectionName: manifest.name,
    samples,
    sources: manifest.sources,
    threshold,
    notes: manifest.description,
    actor,
  });
}

export function formatValidationCsv(run: ValidationRunRow, results: ValidationSampleResultRow[]): string {
  const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const header = [
    'run_id',
    'collection_id',
    'sample_id',
    'modality',
    'filename',
    'source_dataset',
    'ground_truth_label',
    'model_id',
    'predicted_label',
    'raw_score_uncalibrated',
    'threshold_used',
    'is_calibrated',
    'correct',
    'flag_reasons',
    'forensic_metrics',
  ].join(',');

  const lines = results.map((r) =>
    [
      esc(run.id),
      esc(run.collection_id),
      esc(r.sample_id),
      esc(r.modality),
      esc(r.filename),
      esc(r.source_dataset),
      esc(r.ground_truth_label),
      esc(r.model_id),
      esc(r.predicted_label),
      r.raw_score.toFixed(4),
      run.threshold.toFixed(2),
      'false (uncalibrated)',
      r.correct ? 'true' : 'false',
      esc((JSON.parse(r.flag_reasons_json || '[]') as string[]).join(' | ')),
      esc(r.forensic_metrics_json),
    ].join(','),
  );

  return [header, ...lines].join('\n');
}
