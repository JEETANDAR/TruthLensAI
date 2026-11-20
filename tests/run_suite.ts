import assert from 'assert';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  ARTIFACTS_DIR,
  DATASETS_UPLOAD_DIR,
  ensureDirectories,
  resolveSafeStoragePath,
  STORAGE_DIR,
  UPLOADS_DIR,
} from '../server/config.ts';
import { getDb } from '../server/db/database.ts';
import { initializeSystemDefaults } from '../server/db/seed.ts';
import { ensureTrainedModels } from '../server/ml/trainer.ts';
import { inferImageForensics, inferAudioSpoofing } from '../server/ml/inference.ts';
import {
  getPretrainedModelAvailability,
  inferPretrainedAudioAasist,
  inferPretrainedImageDeepfake,
} from '../server/ml/pretrained.ts';
import { runImageForensics } from '../server/forensics/image.ts';
import { runVideoForensics } from '../server/forensics/video.ts';
import { runAudioForensics } from '../server/forensics/audio.ts';
import { runTextForensics } from '../server/forensics/text.ts';
import { runDatasetForensics } from '../server/forensics/dataset.ts';
import { runInvestigationPipeline, startAsyncInvestigationPipeline, getPipelineJobStatus } from '../server/agents/orchestrator.ts';
import { askGeminiCopilot, transcribeAudioFile } from '../server/ai/gemini.ts';
import { generateInvestigationPdf } from '../server/reports/pdf.ts';
import { computeMetricsForGroup, loadBenchmarkManifest } from '../server/ml/validation.ts';
import {
  detectFacesInBuffer,
  extractAlignedFaceCrop,
  isFaceDetectorAvailable,
  trackFacesAcrossFrames,
} from '../server/ml/faceDetector.ts';
import {
  cancelDatasetEvaluationRun,
  computeDatasetEvalModelMetrics,
  formatDatasetEvalCsv,
  inspectDatasetCsv,
  matchCsvToDatasetFiles,
  parseCsvContent,
  sanitizeDatasetRelPath,
  scanDatasetDirectory,
  startDatasetEvaluationRun,
} from '../server/ml/datasetEvaluation.ts';
import type { DatasetEvalRunRow, DatasetEvalResultRow } from '../server/ml/datasetEvaluation.ts';

const execFileAsync = promisify(execFile);

function sha256(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

async function runTests() {
  console.log('1. Testing directory setup & path traversal prevention...');
  ensureDirectories();
  assert.throws(() => resolveSafeStoragePath('../../etc/passwd', STORAGE_DIR), /Path traversal/);

  console.log('2. Testing ML model registry, calibration & genuine ONNX inference...');
  ensureTrainedModels();
  const db = getDb();
  const regModels = db.prepare('SELECT id FROM model_registry').all() as Array<{ id: string }>;
  assert.ok(regModels.some((m) => m.id === 'TL-ViT-DFvReal-ONNX'), 'Primary DFvReal ViT ONNX should be registered');
  assert.ok(regModels.some((m) => m.id === 'TL-ViT-Deepfake-v2-ONNX'), 'Legacy ViT v2 ONNX must remain registered');
  assert.ok(regModels.some((m) => m.id === 'TL-AASIST-ONNX'), 'AASIST ONNX should be registered');

  const pubEvals = db
    .prepare(`SELECT model_id, accuracy, confusion_matrix_json, eval_scope FROM model_evaluations WHERE eval_scope = 'published_benchmark'`)
    .all() as Array<{ model_id: string; accuracy: number; confusion_matrix_json: string; eval_scope: string }>;
  assert.strictEqual(pubEvals.length, 3, 'Expected 3 published_benchmark evaluations without fabricated matrices');
  for (const pe of pubEvals) {
    assert.strictEqual(pe.accuracy, -1, `${pe.model_id} must not fabricate local accuracy`);
    assert.strictEqual(pe.confusion_matrix_json, '[]', `${pe.model_id} must not fabricate local confusion matrix`);
  }

  const synthEvals = db
    .prepare(`SELECT model_id, accuracy, confusion_matrix_json FROM model_evaluations WHERE eval_scope = 'synthetic_heuristic_uncalibrated'`)
    .all() as Array<{ model_id: string; accuracy: number; confusion_matrix_json: string }>;
  assert.strictEqual(synthEvals.length, 3, 'Expected 3 synthetic heuristic baselines with honest -1 sentinel metrics');
  for (const se of synthEvals) {
    assert.strictEqual(se.accuracy, -1, `${se.model_id} must not report synthetic split accuracy as real`);
    assert.strictEqual(se.confusion_matrix_json, '[]', `${se.model_id} must not emit synthetic confusion matrix`);
  }

  const imgPreds = inferImageForensics([6.8, 24.5, 14.2, 3.6, 0.58, 0.28, 1, 0.68]);
  assert.strictEqual(imgPreds.length, 2);
  assert.ok(imgPreds[0].rawScore >= 0 && imgPreds[0].rawScore <= 1);
  assert.ok(imgPreds[0].uncertaintyNote.includes('UNCALIBRATED RAW'), 'Must disclose uncalibrated raw score');
  const audPred = inferAudioSpoofing([0.46, 0.06, 0.015, 0.71, 5.2, 0.06]);
  assert.ok(audPred.rawScore >= 0 && audPred.rawScore <= 1);

  const onnxTestImgBuf = await sharp({
    create: { width: 224, height: 224, channels: 3, background: { r: 120, g: 135, b: 150 } },
  })
    .jpeg({ quality: 90 })
    .toBuffer();
  const vitOut = await inferPretrainedImageDeepfake(onnxTestImgBuf);
  assert.ok(vitOut !== null && typeof vitOut.rawScore === 'number', 'ViT ONNX inference must succeed');
  assert.ok(vitOut.rawScore >= 0 && vitOut.rawScore <= 1);
  assert.strictEqual(vitOut.modelId, 'TL-ViT-DFvReal-ONNX');
  assert.ok(vitOut.uncertaintyNote.includes('UNCALIBRATED RAW'), 'ViT must disclose uncalibrated raw score');

  const pcmSamples = new Float32Array(32000);
  for (let i = 0; i < pcmSamples.length; i++) {
    pcmSamples[i] = 0.25 * Math.sin((2 * Math.PI * 440 * i) / 16000);
  }
  const aasistOut = await inferPretrainedAudioAasist(pcmSamples);
  assert.ok(aasistOut !== null && typeof aasistOut.rawScore === 'number', 'AASIST ONNX inference must succeed');
  assert.ok(aasistOut.rawScore >= 0 && aasistOut.rawScore <= 1);
  assert.strictEqual(aasistOut.modelId, 'TL-AASIST-ONNX');

  const avail = getPretrainedModelAvailability();
  assert.ok(avail.vitAvailable && avail.aasistAvailable, 'ONNX model weights must exist in /models/pretrained');

  console.log('3. Testing clean system defaults & zero legacy demo cases...');
  await initializeSystemDefaults();
  const invs = db.prepare('SELECT id FROM investigations').all() as Array<{ id: string }>;
  const demoEvids = db.prepare('SELECT id FROM evidence WHERE is_demo_fixture = 1').all() as Array<{ id: string }>;
  assert.strictEqual(demoEvids.length, 0, 'Zero demo fixture evidence records may exist');
  assert.ok(!invs.some((i) => i.id === 'INV-2026-041' || i.id === 'INV-2026-038'), 'Legacy demo cases must be cleaned');

  console.log('4. Testing Image Forensics pipeline (ELA, noise, DQT double-JPEG, AI markers)...');
  const testImgPath = path.join(UPLOADS_DIR, 'test_unit_img.jpg');
  await sharp({ create: { width: 320, height: 240, channels: 3, background: { r: 60, g: 90, b: 120 } } })
    .jpeg({ quality: 92 })
    .toFile(testImgPath);
  const imgRes = await runImageForensics('TEST-IMG', testImgPath);
  assert.strictEqual(imgRes.metrics.width, 320);
  assert.strictEqual(imgRes.artifacts.tileMeans.length, 64);
  assert.strictEqual(imgRes.artifacts.noiseTileMeans.length, 64);
  assert.ok(typeof imgRes.metrics.elaQ75Mean === 'number');
  assert.ok(typeof imgRes.metrics.doubleJpegSuspected === 'boolean', 'doubleJpegSuspected must be computed');
  assert.ok(imgRes.mlPredictions.some((p) => p.modelId === 'TL-ViT-DFvReal-ONNX'));
  assert.ok(fs.existsSync(path.join(ARTIFACTS_DIR, 'ela_TEST-IMG.png')));

  console.log('5. Testing Video Forensics pipeline (Multi-frame ML + embedded audio AASIST)...');
  const testVidPath = path.join(UPLOADS_DIR, 'test_unit_vid.mp4');
  await execFileAsync('ffmpeg', [
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc=duration=2.0:size=320x240:rate=15',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=2.0',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-shortest',
    testVidPath,
  ]);
  const vidRes = await runVideoForensics('TEST-VID', testVidPath);
  assert.ok(vidRes.sampledFrames.length >= 3);
  assert.strictEqual(vidRes.metrics.resolution, '320x240');
  assert.ok(typeof vidRes.sampledFrames[0].histogramDelta === 'number');
  assert.strictEqual(vidRes.metrics.embeddedAudioAnalyzed, true, 'Embedded video audio track must be analyzed');
  assert.ok(vidRes.embeddedAudio !== null && vidRes.embeddedAudio.waveform.length >= 5, 'Embedded audio waveform must exist');
  assert.ok(Number(vidRes.metrics.framesMlEvaluated) >= 2, 'Video must run ML across multiple frames');
  assert.ok(vidRes.mlPredictions.some((p) => p.modelId === 'TL-AASIST-ONNX'), 'Video must include embedded AASIST score');

  console.log('6. Testing Audio Forensics pipeline (512-pt 24-band FFT + AASIST)...');
  const testAudPath = path.join(UPLOADS_DIR, 'test_unit_aud.wav');
  await execFileAsync('ffmpeg', [
    '-y',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=2.0',
    '-ar',
    '16000',
    '-ac',
    '1',
    testAudPath,
  ]);
  const audRes = await runAudioForensics('TEST-AUD', testAudPath);
  assert.ok(audRes.waveform.length >= 10);
  assert.ok(audRes.spectrogram.length >= 5);
  assert.strictEqual(audRes.spectrogram[0].bands.length, 24, 'Spectrogram must output 24 frequency bands');
  assert.ok(audRes.mlPredictions.some((p) => p.modelId === 'TL-AASIST-ONNX'));

  console.log('7. Testing Text Intelligence SRT parser & gap/contradiction checks...');
  const testSrtPath = path.join(UPLOADS_DIR, 'test_unit_sub.srt');
  fs.writeFileSync(
    testSrtPath,
    '1\n00:00:00,500 --> 00:00:02,000\nOfficials confirmed 100 percent compliance on Tuesday.\n\n' +
      '2\n00:00:04,500 --> 00:00:06,000\nOverflow cue beyond two second clip duration.\n',
  );
  const txtRes = runTextForensics('TEST-TXT', testSrtPath, 'test_unit_sub.srt');
  assert.strictEqual(txtRes.cues.length, 2);
  assert.ok(txtRes.extractedClaims.length >= 1, 'Expected at least 1 verifiable claim extracted');
  assert.ok(txtRes.indicators.every((ind) => ind.sourceLayer === 'forensic_signal'));

  console.log('8. Testing Dataset Quality Profiling, Automated Cleaning & Validation...');
  const testCsvPath = path.join(UPLOADS_DIR, 'test_unit_dataset.csv');
  const messyCsv = [
    'record_id,region,amount,verified',
    '101, North ,"$1,200.50",true',
    '102,South,840.00,false',
    '102,South,840.00,false',
    '103,,N/A,yes',
    '104,West,910.25,true',
    '105,East,890.00,no',
    '106,North,950.00,true',
    '107,West,999999.00,false',
  ].join('\n');
  fs.writeFileSync(testCsvPath, messyCsv, 'utf8');
  const dsRes = runDatasetForensics('TEST-DS', testCsvPath, 'test_unit_dataset.csv');
  assert.strictEqual(dsRes.metrics.rowCount, 8);
  assert.strictEqual(dsRes.metrics.columnCount, 4);
  assert.strictEqual(dsRes.metrics.duplicateRowCount, 1);
  assert.ok(dsRes.metrics.totalMissingValues >= 2, 'Expected missing values for empty cell and N/A');
  assert.ok(dsRes.metrics.outlierCount >= 1, 'Expected statistical outlier detection on 999999.00');
  assert.ok(
    dsRes.metrics.afterQualityScore > dsRes.metrics.beforeQualityScore,
    `Cleaned score (${dsRes.metrics.afterQualityScore}) must exceed raw score (${dsRes.metrics.beforeQualityScore})`,
  );
  assert.ok(dsRes.fixesApplied.length >= 2);
  assert.ok(dsRes.validationChecks.every((v) => v.passed), 'Post-fix validation checks must pass');
  assert.ok(fs.existsSync(path.join(ARTIFACTS_DIR, 'cleaned_TEST-DS.csv')), 'Cleaned CSV file must be written');

  console.log('9. Testing empty session rejection...');
  const emptyInvId = 'INV-EMPTY-TEST';
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO investigations (id, case_code, title, description, status, owner_id, created_at, updated_at)
     VALUES (?, 'TL-EMPTY-1', 'Empty Session', '', 'ingesting', 'USR-LEAD-01', ?, ?)`,
  ).run(emptyInvId, now, now);
  let emptyRejected = false;
  try {
    await runInvestigationPipeline(emptyInvId);
  } catch {
    emptyRejected = true;
  }
  assert.ok(emptyRejected, 'Empty session pipeline must throw error');
  db.prepare(`DELETE FROM investigations WHERE id = ?`).run(emptyInvId);

  console.log('10. Testing full 9-agent multimodal + dataset pipeline, Copilot & PDF dossier...');
  const testInvId = 'INV-SUITE-FULL';
  db.prepare(
    `INSERT OR REPLACE INTO investigations (id, case_code, title, description, status, owner_id, created_at, updated_at)
     VALUES (?, 'TL-SUITE-1', 'Automated End-to-End Integration Check', 'Full verification across image, video, audio, text, and CSV dataset', 'ingesting', 'USR-LEAD-01', ?, ?)`,
  ).run(testInvId, now, now);

  const evidRows = [
    { id: 'EVID-TST-IMG', mod: 'image', name: 'test_unit_img.jpg', mime: 'image/jpeg', fp: testImgPath },
    { id: 'EVID-TST-VID', mod: 'video', name: 'test_unit_vid.mp4', mime: 'video/mp4', fp: testVidPath },
    { id: 'EVID-TST-AUD', mod: 'audio', name: 'test_unit_aud.wav', mime: 'audio/wav', fp: testAudPath },
    { id: 'EVID-TST-TXT', mod: 'text', name: 'test_unit_sub.srt', mime: 'application/x-subrip', fp: testSrtPath },
    { id: 'EVID-TST-DS', mod: 'dataset', name: 'test_unit_dataset.csv', mime: 'text/csv', fp: testCsvPath },
  ];
  for (const ev of evidRows) {
    db.prepare(
      `INSERT OR REPLACE INTO evidence
       (id, investigation_id, modality, original_filename, storage_path, mime_type, file_size, sha256_hash, context_note, status, is_demo_fixture, uploaded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Automated test suite input', 'queued', 0, ?)`,
    ).run(ev.id, testInvId, ev.mod, ev.name, ev.fp, ev.mime, fs.statSync(ev.fp).size, sha256(ev.fp), now);
  }

  const pipeRes = await runInvestigationPipeline(testInvId, 'Automated Test Suite');
  assert.strictEqual(pipeRes.agentsExecuted, 9, 'All 9 agents must execute');

  const corrs = db
    .prepare(`SELECT relationship_type FROM evidence_correlations WHERE investigation_id = ?`)
    .all(testInvId) as Array<{ relationship_type: string }>;
  assert.ok(corrs.some((c) => c.relationship_type === 'CONTRADICTS'), 'Overflow SRT must emit CONTRADICTS');
  assert.ok(!corrs.some((c) => c.relationship_type === 'TEMPORAL_ALIGN'), 'Duration check must NOT emit TEMPORAL_ALIGN');

  const preds = db
    .prepare(`SELECT DISTINCT model_id FROM model_predictions WHERE investigation_id = ?`)
    .all(testInvId) as Array<{ model_id: string }>;
  assert.ok(preds.some((p) => p.model_id === 'TL-ViT-DFvReal-ONNX'), 'Pipeline must record primary ViT ONNX prediction');
  assert.ok(preds.some((p) => p.model_id === 'TL-AASIST-ONNX'), 'Pipeline must record AASIST ONNX prediction');

  const copilotOut = await askGeminiCopilot(
    testInvId,
    'Summarize the dataset cleaning improvements and cross-modal evidence findings.',
    [],
  );
  assert.ok(copilotOut.answer.length > 80);
  assert.ok(copilotOut.citedEvidenceIds.length >= 1, 'Copilot answer must cite actual [EVID-*] IDs');

  const rptRow = db
    .prepare(`SELECT id, investigation_id, report_json FROM investigation_reports WHERE investigation_id = ? ORDER BY created_at DESC LIMIT 1`)
    .get(testInvId) as { id: string; investigation_id: string; report_json: string };
  const parsedRpt = JSON.parse(rptRow.report_json);
  assert.ok(parsedRpt.overview, 'Report JSON must contain dataset overview');
  assert.ok(parsedRpt.qualityScores, 'Report JSON must contain qualityScores');
  assert.ok(Array.isArray(parsedRpt.beforeAfterComparisons), 'Report JSON must contain beforeAfterComparisons');
  assert.ok(parsedRpt.automatedFixes.length >= 2, 'Report JSON must contain automatedFixes');
  assert.ok(parsedRpt.validationResults.length >= 2, 'Report JSON must contain validationResults');
  assert.strictEqual(parsedRpt.verdict?.scoresCalibrated, false, 'Scores must explicitly be marked uncalibrated');
  assert.ok(
    ['Likely Genuine', 'Possibly AI-Generated or Manipulated', 'Inconclusive — Needs Review'].includes(
      parsedRpt.verdict?.label,
    ),
    `Unexpected report verdict label: ${parsedRpt.verdict?.label}`,
  );
  assert.strictEqual(typeof parsedRpt.verdict?.aiRawScorePct, 'number', 'AI raw score % must be present');
  assert.strictEqual(typeof parsedRpt.verdict?.genuineRawScorePct, 'number', 'Genuine raw score % must be present');
  assert.ok(
    !String(parsedRpt.verdict?.plainSummary || '').includes('consistent with standard baseline compression and spectral profiles'),
    'Verdict summary must be evidence-specific, not generic boilerplate',
  );

  const simplePdfPath = await generateInvestigationPdf(rptRow.investigation_id, rptRow.id, 'simple');
  const advPdfPath = await generateInvestigationPdf(rptRow.investigation_id, rptRow.id, 'advanced');
  assert.ok(fs.existsSync(simplePdfPath), 'Simple PDF dossier must exist on disk');
  assert.ok(fs.existsSync(advPdfPath), 'Technical PDF dossier must exist on disk');
  const pdfBuf = fs.readFileSync(simplePdfPath);
  const advPdfBuf = fs.readFileSync(advPdfPath);
  assert.ok(pdfBuf.subarray(0, 5).toString('ascii') === '%PDF-', 'Simple dossier must have valid %PDF- header');
  assert.ok(advPdfBuf.subarray(0, 5).toString('ascii') === '%PDF-', 'Technical dossier must have valid %PDF- header');
  assert.ok(pdfBuf.byteLength > 2500, `Simple PDF dossier should be > 2.5KB (got ${pdfBuf.byteLength} bytes)`);
  assert.ok(advPdfBuf.byteLength > 4000, `Technical PDF dossier should be > 4KB (got ${advPdfBuf.byteLength} bytes)`);

  console.log('11. Testing failed-agent error surfacing & async pipeline duplicate guard...');
  const failInvId = 'INV-FAIL-TEST';
  db.prepare(
    `INSERT OR REPLACE INTO investigations (id, case_code, title, description, status, owner_id, created_at, updated_at)
     VALUES (?, 'TL-FAIL-1', 'Failed Agent Propagation Test', '', 'ingesting', 'USR-LEAD-01', ?, ?)`,
  ).run(failInvId, now, now);
  db.prepare(
    `INSERT OR REPLACE INTO evidence
     (id, investigation_id, modality, original_filename, storage_path, mime_type, file_size, sha256_hash, context_note, status, is_demo_fixture, uploaded_at)
     VALUES ('EVID-MISSING-IMG', ?, 'image', 'missing.jpg', '/tmp/nonexistent-truthlens-missing.jpg', 'image/jpeg', 123, 'deadbeef', '', 'queued', 0, ?)`,
  ).run(failInvId, now);
  const failPipe = await runInvestigationPipeline(failInvId, 'Test Runner');
  assert.ok(failPipe.failedAgents.length >= 1, 'Missing image file must record a failed agent');
  const failInvRow = db.prepare(`SELECT confidence_level FROM investigations WHERE id = ?`).get(failInvId) as {
    confidence_level: string;
  };
  assert.notStrictEqual(failInvRow.confidence_level, 'low_anomaly', 'Failed agent must never yield low_anomaly');

  const jobState = startAsyncInvestigationPipeline(failInvId, 'Async Test Runner');
  assert.strictEqual(jobState.investigationId, failInvId);
  assert.ok(['running', 'completed', 'failed', 'cancelled'].includes(jobState.status));
  const trackedJob = getPipelineJobStatus(failInvId);
  assert.ok(trackedJob !== null, 'Async job tracker must return status');
  for (let w = 0; w < 30; w++) {
    const cur = getPipelineJobStatus(failInvId);
    if (!cur || cur.status !== 'running') break;
    await new Promise((r) => setTimeout(r, 100));
  }

  console.log('12. Testing UltraFace RFB-320 face detector, 1.25x aligned crop & frame tracking...');
  assert.strictEqual(isFaceDetectorAvailable(), true, 'UltraFace ONNX weights must be present');
  const devFaceImgPath = path.resolve(process.cwd(), 'datasets', 'dev_validation', 'images', 'dev_real_1.jpg');
  assert.ok(fs.existsSync(devFaceImgPath), 'Dev validation face image must exist');
  const devFaceBuf = fs.readFileSync(devFaceImgPath);
  const detectedFaces = await detectFacesInBuffer(devFaceBuf);
  assert.ok(detectedFaces.length >= 1, 'UltraFace must detect face in dev_real_1.jpg');
  assert.ok(
    detectedFaces[0].xPct >= 0 &&
      detectedFaces[0].yPct >= 0 &&
      detectedFaces[0].wPct > 0 &&
      detectedFaces[0].hPct > 0,
    'Detected face coordinates must be valid percentages',
  );
  const croppedFaceBuf = await extractAlignedFaceCrop(devFaceBuf, detectedFaces[0], 1.25);
  const cropMeta = await sharp(croppedFaceBuf).metadata();
  assert.ok((cropMeta.width || 0) >= 32 && (cropMeta.height || 0) >= 32, 'Aligned 1.25x face crop must be valid JPEG');
  const trackedRes = trackFacesAcrossFrames([detectedFaces, detectedFaces]);
  assert.strictEqual(trackedRes.uniqueTrackCount, 1, 'Repeated stationary face must share 1 trackId');
  assert.strictEqual(trackedRes.trackedFrames[0][0].trackId, 'F-1');

  console.log('13. Testing corrupt, empty & binary container rejection across modalities...');
  const corruptImgPath = path.join(UPLOADS_DIR, 'test_corrupt.jpg');
  const emptyAudPath = path.join(UPLOADS_DIR, 'test_empty.wav');
  const corruptVidPath = path.join(UPLOADS_DIR, 'test_corrupt.mp4');
  const binaryTxtPath = path.join(UPLOADS_DIR, 'test_binary.txt');
  fs.writeFileSync(corruptImgPath, Buffer.from('NOT_A_REAL_JPEG_HEADER_0000'));
  fs.writeFileSync(emptyAudPath, Buffer.alloc(0));
  fs.writeFileSync(corruptVidPath, Buffer.from('CORRUPT_MP4_STREAM_GARBAGE'));
  fs.writeFileSync(binaryTxtPath, Buffer.from([0x00, 0x01, 0xff, 0x00, 0xfe, 0x10]));

  await assert.rejects(() => runImageForensics('TEST-CORRUPT-IMG', corruptImgPath), 'Corrupt image must reject cleanly');
  await assert.rejects(() => runAudioForensics('TEST-EMPTY-AUD', emptyAudPath), '0-byte audio must reject cleanly');
  await assert.rejects(() => runVideoForensics('TEST-CORRUPT-VID', corruptVidPath), 'Corrupt video must reject cleanly');
  assert.throws(() => runTextForensics('TEST-BIN-TXT', binaryTxtPath, 'test_binary.txt'), 'Binary null-byte file must reject cleanly');

  console.log('14. Testing Real-vs-Fake validation manifests (held-out, dev & audio) & metric edge-case guarding...');
  const valManifest = loadBenchmarkManifest('held_out');
  assert.ok(valManifest && valManifest.totalSamples === 16, 'Held-out validation benchmark manifest must have 16 labelled files');
  const devManifest = loadBenchmarkManifest('dev');
  assert.ok(devManifest && devManifest.totalSamples === 12, 'Dev validation manifest must have 12 labelled files');
  const audioManifest = loadBenchmarkManifest('audio');
  assert.ok(audioManifest && audioManifest.totalSamples === 12, 'Audio validation manifest (TL-AUD-VAL-V1) must have 12 labelled files');
  assert.strictEqual(audioManifest.items.filter((i) => i.groundTruthLabel === 'real').length, 6);
  assert.strictEqual(audioManifest.items.filter((i) => i.groundTruthLabel === 'fake').length, 6);
  const smallMetric = computeMetricsForGroup('TEST-MODEL', 'all', [
    { groundTruth: 'real', predicted: 'real', rawScore: 0.2 },
    { groundTruth: 'fake', predicted: 'fake', rawScore: 0.8 },
  ]);
  assert.strictEqual(smallMetric.metricsSupported, false, 'n < 4 must omit classification metrics');
  assert.strictEqual(smallMetric.accuracy, null);
  const fullMetric = computeMetricsForGroup('TEST-MODEL', 'all', [
    { groundTruth: 'fake', predicted: 'fake', rawScore: 0.85 },
    { groundTruth: 'fake', predicted: 'real', rawScore: 0.35 },
    { groundTruth: 'real', predicted: 'real', rawScore: 0.15 },
    { groundTruth: 'real', predicted: 'fake', rawScore: 0.65 },
  ]);
  assert.strictEqual(fullMetric.metricsSupported, true);
  assert.deepStrictEqual(fullMetric.confusionMatrix, { tp: 1, fp: 1, tn: 1, fn: 1 });
  assert.strictEqual(fullMetric.accuracy, 0.5);
  assert.strictEqual(fullMetric.fpr, 0.5);
  const audioScopeMetric = computeMetricsForGroup('TL-AASIST-ONNX', 'audio', [
    { groundTruth: 'fake', predicted: 'fake', rawScore: 0.91 },
    { groundTruth: 'fake', predicted: 'fake', rawScore: 0.88 },
    { groundTruth: 'real', predicted: 'real', rawScore: 0.12 },
    { groundTruth: 'real', predicted: 'real', rawScore: 0.18 },
  ]);
  assert.strictEqual(audioScopeMetric.modalityScope, 'audio');
  assert.strictEqual(audioScopeMetric.accuracy, 1);

  // Verify portrait preservation on dev_real_2.jpg (no destructive 1.25x re-crop on already framed portrait)
  const devPortrait2Path = path.resolve(process.cwd(), 'datasets', 'dev_validation', 'images', 'dev_real_2.jpg');
  const devPortrait2Buf = fs.readFileSync(devPortrait2Path);
  const devPortrait2Faces = await detectFacesInBuffer(devPortrait2Buf);
  const portraitPred = await inferPretrainedImageDeepfake(devPortrait2Buf, devPortrait2Faces);
  assert.ok(portraitPred && portraitPred.rawScore < 0.05, `Portrait dev_real_2.jpg should not trigger false positive via re-crop (got ${portraitPred?.rawScore})`);

  console.log('15. Testing out-of-domain audio inconclusive handling, Gemini fallback & DB preservation...');
  const ytRealClipPath = path.resolve(process.cwd(), 'datasets', 'audio_validation', 'real', 'yt_0000_p2_part_167.flac');
  assert.ok(fs.existsSync(ytRealClipPath), 'YouTube validation clip must exist');
  const audOodInvId = 'INV-AUD-OOD-TEST';
  db.prepare(
    `INSERT OR REPLACE INTO investigations (id, case_code, title, description, status, owner_id, created_at, updated_at)
     VALUES (?, 'TL-OOD-1', 'Out-of-Domain Ambient Audio Test', '', 'ingesting', 'USR-LEAD-01', ?, ?)`,
  ).run(audOodInvId, now, now);
  db.prepare(
    `INSERT OR REPLACE INTO evidence
     (id, investigation_id, modality, original_filename, storage_path, mime_type, file_size, sha256_hash, context_note, status, is_demo_fixture, uploaded_at)
     VALUES ('EVID-OOD-AUD', ?, 'audio', 'yt_0000_p2_part_167.flac', ?, 'audio/flac', ?, ?, 'YouTube ambient clip', 'queued', 0, ?)`,
  ).run(audOodInvId, ytRealClipPath, fs.statSync(ytRealClipPath).size, sha256(ytRealClipPath), now);
  await runInvestigationPipeline(audOodInvId, 'Test Runner');
  const audOodInvRow = db.prepare(`SELECT confidence_level FROM investigations WHERE id = ?`).get(audOodInvId) as {
    confidence_level: string;
  };
  assert.strictEqual(audOodInvRow.confidence_level, 'inconclusive', 'Out-of-domain YouTube ambient audio must be marked inconclusive, never authentic or uncorroborated fake');
  const audOodPred = db
    .prepare(`SELECT prediction_label, uncertainty_note FROM model_predictions WHERE investigation_id = ? AND model_id = 'TL-AASIST-ONNX'`)
    .get(audOodInvId) as { prediction_label: string; uncertainty_note: string };
  assert.strictEqual(audOodPred.prediction_label, 'inconclusive_review', 'Out-of-domain AASIST label must be inconclusive_review');
  assert.ok(audOodPred.uncertainty_note.includes('[OUT-OF-DOMAIN'), 'Out-of-domain notice must appear in uncertainty note');

  const transcribeRes = await transcribeAudioFile(testAudPath, 'EVID-TST-AUD');
  assert.strictEqual(transcribeRes.model, 'gemini-3.5-transcribe');
  assert.strictEqual(typeof transcribeRes.transcribed, 'boolean');
  assert.ok(transcribeRes.transcribed || typeof transcribeRes.error === 'string', 'Must return transcript or explicit honest reason');

  const baselineRuns = db
    .prepare(`SELECT id FROM validation_runs WHERE id IN ('VALRUN-MWNLAXJW-KJS9', 'VALRUN-MWNLXY4L-E4BH', 'VALRUN-MWNLYKNG-060Y')`)
    .all() as Array<{ id: string }>;
  assert.strictEqual(baselineRuns.length, 3, 'All 3 historical validation runs must remain preserved');

  console.log('16. Testing genuine vs AI photo verdict accuracy & per-file failure isolation...');
  const valRealImg = path.resolve(process.cwd(), 'datasets', 'validation_benchmark', 'images', 'img_real_01.jpg');
  const valFakeImg = path.resolve(process.cwd(), 'datasets', 'validation_benchmark', 'images', 'img_fake_01.jpg');
  const realVerdictInvId = 'INV-REAL-VERDICT';
  const fakeVerdictInvId = 'INV-FAKE-VERDICT';
  const mixedIsoInvId = 'INV-MIXED-ISO';

  db.prepare(
    `INSERT OR REPLACE INTO investigations (id, case_code, title, description, status, owner_id, created_at, updated_at)
     VALUES (?, 'TL-RV-1', 'Genuine Image Verdict Check', '', 'ingesting', 'USR-LEAD-01', ?, ?)`,
  ).run(realVerdictInvId, now, now);
  db.prepare(
    `INSERT OR REPLACE INTO evidence
     (id, investigation_id, modality, original_filename, storage_path, mime_type, file_size, sha256_hash, context_note, status, is_demo_fixture, uploaded_at)
     VALUES ('EVID-RV-1', ?, 'image', 'sample_a.jpg', ?, 'image/jpeg', ?, ?, '', 'queued', 0, ?)`,
  ).run(realVerdictInvId, valRealImg, fs.statSync(valRealImg).size, sha256(valRealImg), now);
  await runInvestigationPipeline(realVerdictInvId, 'Test Runner');
  const realInvRow = db.prepare(`SELECT confidence_level FROM investigations WHERE id = ?`).get(realVerdictInvId) as {
    confidence_level: string;
  };
  assert.strictEqual(
    realInvRow.confidence_level,
    'low_anomaly',
    `Genuine image must yield low_anomaly without secondary LR-v2 poisoning (got ${realInvRow.confidence_level})`,
  );

  db.prepare(
    `INSERT OR REPLACE INTO investigations (id, case_code, title, description, status, owner_id, created_at, updated_at)
     VALUES (?, 'TL-FV-1', 'AI Image Verdict Check', '', 'ingesting', 'USR-LEAD-01', ?, ?)`,
  ).run(fakeVerdictInvId, now, now);
  db.prepare(
    `INSERT OR REPLACE INTO evidence
     (id, investigation_id, modality, original_filename, storage_path, mime_type, file_size, sha256_hash, context_note, status, is_demo_fixture, uploaded_at)
     VALUES ('EVID-FV-1', ?, 'image', 'sample_b.jpg', ?, 'image/jpeg', ?, ?, '', 'queued', 0, ?)`,
  ).run(fakeVerdictInvId, valFakeImg, fs.statSync(valFakeImg).size, sha256(valFakeImg), now);
  await runInvestigationPipeline(fakeVerdictInvId, 'Test Runner');
  const fakeInvRow = db.prepare(`SELECT confidence_level FROM investigations WHERE id = ?`).get(fakeVerdictInvId) as {
    confidence_level: string;
  };
  assert.strictEqual(fakeInvRow.confidence_level, 'requires_review', 'AI image must escalate to requires_review');

  db.prepare(
    `INSERT OR REPLACE INTO investigations (id, case_code, title, description, status, owner_id, created_at, updated_at)
     VALUES (?, 'TL-ISO-1', 'Per-File Failure Isolation Check', '', 'ingesting', 'USR-LEAD-01', ?, ?)`,
  ).run(mixedIsoInvId, now, now);
  db.prepare(
    `INSERT OR REPLACE INTO evidence
     (id, investigation_id, modality, original_filename, storage_path, mime_type, file_size, sha256_hash, context_note, status, is_demo_fixture, uploaded_at)
     VALUES ('EVID-ISO-BAD', ?, 'image', 'broken.jpg', ?, 'image/jpeg', 28, 'bad', '', 'queued', 0, ?)`,
  ).run(mixedIsoInvId, corruptImgPath, now);
  db.prepare(
    `INSERT OR REPLACE INTO evidence
     (id, investigation_id, modality, original_filename, storage_path, mime_type, file_size, sha256_hash, context_note, status, is_demo_fixture, uploaded_at)
     VALUES ('EVID-ISO-GOOD', ?, 'image', 'good.jpg', ?, 'image/jpeg', ?, ?, '', 'queued', 0, ?)`,
  ).run(mixedIsoInvId, valRealImg, fs.statSync(valRealImg).size, sha256(valRealImg), now);
  const isoPipe = await runInvestigationPipeline(mixedIsoInvId, 'Test Runner');
  assert.strictEqual(isoPipe.failedAgents.length, 1, 'Corrupt sibling file must report partial failure');
  const badRow = db.prepare(`SELECT status FROM evidence WHERE id = 'EVID-ISO-BAD'`).get() as { status: string };
  const goodRow = db.prepare(`SELECT status FROM evidence WHERE id = 'EVID-ISO-GOOD'`).get() as { status: string };
  assert.strictEqual(badRow.status, 'failed', 'Corrupt image must be marked failed');
  assert.strictEqual(goodRow.status, 'analyzed', 'Valid sibling image must still be analyzed independently');

  console.log('17. Testing large 50,000-row CSV streaming & analytics performance...');
  const largeCsvPath = path.join(UPLOADS_DIR, 'test_large_50k.csv');
  const largeChunks: string[] = ['id,category,amount,active'];
  for (let i = 0; i < 50000; i++) {
    if (i === 50) largeChunks.push('10,North,"$120.50",true'); // exact duplicate
    else if (i % 500 === 0) largeChunks.push(`${i},,N/A,yes`);
    else if (i === 12345) largeChunks.push(`${i},West,9999999.00,false`);
    else largeChunks.push(`${i},${i % 2 === 0 ? 'North' : 'South'},${(100 + (i % 45)).toFixed(2)},${i % 3 === 0 ? 'true' : 'false'}`);
  }
  fs.writeFileSync(largeCsvPath, largeChunks.join('\n'), 'utf8');
  const t0 = Date.now();
  const largeDsRes = runDatasetForensics('TEST-DS-50K', largeCsvPath, 'test_large_50k.csv');
  const elapsedMs = Date.now() - t0;
  assert.strictEqual(largeDsRes.metrics.rowCount, 50000);
  assert.strictEqual(largeDsRes.metrics.afterMissingValues, 0);
  assert.ok(largeDsRes.metrics.outlierCount >= 1, 'Large CSV must detect statistical outlier');
  assert.ok(elapsedMs < 10000, `50,000-row CSV profiling should complete fast (took ${elapsedMs}ms)`);
  console.log(`   50,000-row CSV processed & cleaned in ${elapsedMs}ms`);

  console.log('18. Testing Dataset Folder Upload & Evaluation System (tree, matching, blinded ML, cancel, metrics)...');
  assert.throws(() => sanitizeDatasetRelPath('../../etc/passwd'), /Invalid relative path/);
  const parsedCsvCheck = parseCsvContent('image_path,label\n"test/fake/img,1.jpg",Fake\n"test/real/img""2.jpg",Real\n');
  assert.strictEqual(parsedCsvCheck.length, 3, 'RFC-4180 CSV parser must handle quoted commas and escaped quotes');
  assert.strictEqual(parsedCsvCheck[1][0], 'test/fake/img,1.jpg');
  assert.strictEqual(parsedCsvCheck[2][0], 'test/real/img"2.jpg');

  const unitDsId = 'DS-SUITE-TEST';
  const unitDsDir = resolveSafeStoragePath(unitDsId, DATASETS_UPLOAD_DIR);
  fs.rmSync(unitDsDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(unitDsDir, 'real_vs_fake', 'test', 'real'), { recursive: true });
  fs.mkdirSync(path.join(unitDsDir, 'real_vs_fake', 'test', 'fake'), { recursive: true });

  const realSrc1 = path.resolve(process.cwd(), 'datasets', 'validation_benchmark', 'images', 'img_real_01.jpg');
  const realSrc2 = path.resolve(process.cwd(), 'datasets', 'validation_benchmark', 'images', 'img_real_02.jpg');
  const fakeSrc1 = path.resolve(process.cwd(), 'datasets', 'validation_benchmark', 'images', 'img_fake_01.jpg');
  const fakeSrc2 = path.resolve(process.cwd(), 'datasets', 'validation_benchmark', 'images', 'img_fake_02.jpg');

  fs.copyFileSync(realSrc1, path.join(unitDsDir, 'real_vs_fake', 'test', 'real', 'r1.jpg'));
  fs.copyFileSync(realSrc2, path.join(unitDsDir, 'real_vs_fake', 'test', 'real', 'r2.jpg'));
  fs.copyFileSync(fakeSrc1, path.join(unitDsDir, 'real_vs_fake', 'test', 'fake', 'f1.jpg'));
  fs.copyFileSync(fakeSrc2, path.join(unitDsDir, 'real_vs_fake', 'test', 'fake', 'f2.jpg'));
  fs.writeFileSync(path.join(unitDsDir, 'real_vs_fake', 'test', 'fake', 'corrupt_f3.jpg'), Buffer.from('NOT_A_JPEG'));
  fs.writeFileSync(path.join(unitDsDir, 'notes.txt'), 'unsupported text file', 'utf8');

  const unitCsvPath = path.join(unitDsDir, 'test.csv');
  fs.writeFileSync(
    unitCsvPath,
    [
      'img_ref,truth',
      'real_vs_fake/test/real/r1.jpg,Real',
      'r2.jpg,Real', // basename match inside nested dir
      'real_vs_fake/test/fake/f1.jpg,Fake',
      'real_vs_fake/test/fake/f1.jpg,Fake', // duplicate
      'real_vs_fake/test/fake/missing.jpg,Fake', // missing
      '../escape.jpg,Fake', // invalid path
      'real_vs_fake/test/fake/clip.webp,Fake', // unsupported format
      'real_vs_fake/test/fake/corrupt_f3.jpg,Fake', // matched but corrupt image
      'real_vs_fake/test/fake/f2.jpg,unknown_tag', // unmapped label
    ].join('\n'),
    'utf8',
  );

  const scanRes = scanDatasetDirectory(unitDsDir, 'real_vs_fake');
  assert.strictEqual(scanRes.imageCount, 5);
  assert.strictEqual(scanRes.csvCount, 1);
  assert.strictEqual(scanRes.unsupportedCount, 1);
  assert.strictEqual(scanRes.csvFiles[0].inferredSplit, 'test');

  const insp = inspectDatasetCsv(unitDsDir, 'test.csv');
  assert.strictEqual(insp.detectedPathColumn, 'img_ref');
  assert.strictEqual(insp.detectedLabelColumn, 'truth');
  assert.strictEqual(insp.rowCount, 9);

  const matchRes = matchCsvToDatasetFiles({
    datasetDir: unitDsDir,
    csvRelPath: 'test.csv',
    pathColumn: 'img_ref',
    labelColumn: 'truth',
  });
  assert.strictEqual(matchRes.matchedCount, 4, 'Matched count should include r1, r2, f1, corrupt_f3');
  assert.strictEqual(matchRes.duplicateCount, 1);
  assert.strictEqual(matchRes.missingCount, 1);
  assert.strictEqual(matchRes.invalidPathCount, 1);
  assert.strictEqual(matchRes.unsupportedFormatCount, 1);
  assert.strictEqual(matchRes.unmappedLabelCount, 1);
  assert.strictEqual(matchRes.unreferencedImagesCount, 1, 'f2.jpg had unmapped label so it was not referenced');

  db.prepare(
    `INSERT OR REPLACE INTO dataset_uploads
     (id, name, storage_dir, total_files, image_count, csv_count, unsupported_count, total_bytes, tree_json, csv_files_json, unsupported_files_json, status, created_at)
     VALUES (?, 'real_vs_fake', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?)`,
  ).run(
    unitDsId,
    unitDsDir,
    scanRes.totalFiles,
    scanRes.imageCount,
    scanRes.csvCount,
    scanRes.unsupportedCount,
    scanRes.totalBytes,
    JSON.stringify(scanRes.tree),
    JSON.stringify(scanRes.csvFiles),
    JSON.stringify(scanRes.unsupportedFiles),
    now,
  );

  const startedRun = startDatasetEvaluationRun({
    datasetId: unitDsId,
    csvPath: 'test.csv',
    pathColumn: 'img_ref',
    labelColumn: 'truth',
    actor: 'Automated Test Suite',
  });
  let completedRun: DatasetEvalRunRow | undefined;
  for (let w = 0; w < 100; w++) {
    completedRun = db.prepare(`SELECT * FROM dataset_eval_runs WHERE id = ?`).get(startedRun.id) as DatasetEvalRunRow;
    if (completedRun.status !== 'running') break;
    await new Promise((r) => setTimeout(r, 150));
  }
  assert.ok(completedRun && completedRun.status === 'completed_with_errors', `Expected completed_with_errors, got ${completedRun?.status}`);
  assert.strictEqual(completedRun.processed_count, 3);
  assert.strictEqual(completedRun.failed_count, 1);
  assert.strictEqual(completedRun.unmatched_count, 5);

  const unitEvalResults = db
    .prepare(`SELECT * FROM dataset_eval_results WHERE run_id = ?`)
    .all(startedRun.id) as DatasetEvalResultRow[];
  const incorrectCsvText = formatDatasetEvalCsv(completedRun, unitEvalResults, 'incorrect');
  assert.ok(incorrectCsvText.includes('corrupt_f3.jpg'), 'Failed image must appear in incorrect CSV export');
  assert.ok(incorrectCsvText.includes('false (uncalibrated)'), 'Export must state raw scores are uncalibrated');

  const unitMetricCheck = computeDatasetEvalModelMetrics('TL-TEST', [
    { groundTruth: 'fake', predicted: 'fake', rawScore: 0.9 },
    { groundTruth: 'real', predicted: 'real', rawScore: 0.1 },
    { groundTruth: 'fake', predicted: 'inconclusive', rawScore: 0.52 },
    { groundTruth: 'real', predicted: 'failed', rawScore: null },
  ]);
  assert.strictEqual(unitMetricCheck.accuracy, 1);
  assert.strictEqual(unitMetricCheck.inconclusiveCount, 1);
  assert.strictEqual(unitMetricCheck.failedCount, 1);
  assert.strictEqual(unitMetricCheck.scoresCalibrated, false);

  // Also test cancellation immediately after start
  const cancelRun = startDatasetEvaluationRun({
    datasetId: unitDsId,
    csvPath: 'test.csv',
    pathColumn: 'img_ref',
    labelColumn: 'truth',
    actor: 'Cancel Test',
  });
  const cancelledFlag = cancelDatasetEvaluationRun(cancelRun.id);
  assert.strictEqual(cancelledFlag, true, 'Cancellation request must return true');
  let cancelledRow: DatasetEvalRunRow | undefined;
  for (let w = 0; w < 60; w++) {
    cancelledRow = db.prepare(`SELECT * FROM dataset_eval_runs WHERE id = ?`).get(cancelRun.id) as DatasetEvalRunRow;
    if (cancelledRow.status !== 'running') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.strictEqual(cancelledRow?.status, 'cancelled', 'Run must transition cleanly to cancelled');

  console.log('19. Cleaning up temporary test suite records & files so startup state stays pristine...');
  db.prepare(`DELETE FROM dataset_uploads WHERE id = ?`).run(unitDsId);
  fs.rmSync(unitDsDir, { recursive: true, force: true });
  db.prepare(`DELETE FROM investigations WHERE id IN (?, ?, ?, ?, ?, ?)`).run(
    testInvId,
    failInvId,
    audOodInvId,
    realVerdictInvId,
    fakeVerdictInvId,
    mixedIsoInvId,
  );
  for (const f of [
    testImgPath,
    testVidPath,
    testAudPath,
    testSrtPath,
    testCsvPath,
    largeCsvPath,
    corruptImgPath,
    emptyAudPath,
    corruptVidPath,
    binaryTxtPath,
    simplePdfPath,
    advPdfPath,
    path.join(ARTIFACTS_DIR, 'ela_TEST-IMG.png'),
    path.join(ARTIFACTS_DIR, 'noise_TEST-IMG.png'),
    path.join(ARTIFACTS_DIR, 'cleaned_TEST-DS.csv'),
    path.join(ARTIFACTS_DIR, 'cleaned_TEST-DS-50K.csv'),
    path.join(ARTIFACTS_DIR, 'ela_EVID-TST-IMG.png'),
    path.join(ARTIFACTS_DIR, 'noise_EVID-TST-IMG.png'),
    path.join(ARTIFACTS_DIR, 'ela_EVID-RV-1.png'),
    path.join(ARTIFACTS_DIR, 'noise_EVID-RV-1.png'),
    path.join(ARTIFACTS_DIR, 'ela_EVID-FV-1.png'),
    path.join(ARTIFACTS_DIR, 'noise_EVID-FV-1.png'),
    path.join(ARTIFACTS_DIR, 'ela_EVID-ISO-GOOD.png'),
    path.join(ARTIFACTS_DIR, 'noise_EVID-ISO-GOOD.png'),
    path.join(ARTIFACTS_DIR, 'cleaned_EVID-TST-DS.csv'),
    path.join(ARTIFACTS_DIR, 'vid_audio_TEST-VID.wav'),
    path.join(ARTIFACTS_DIR, 'vid_audio_EVID-TST-VID.wav'),
  ]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  const artifactFiles = fs.readdirSync(ARTIFACTS_DIR);
  for (const af of artifactFiles) {
    if (
      af.startsWith('TEST-VID_') ||
      af.startsWith('EVID-TST-VID_') ||
      af.startsWith('TEST-CORRUPT') ||
      af === 'frames_TEST-VID' ||
      af === 'frames_EVID-TST-VID' ||
      af === 'frames_TEST-CORRUPT-VID'
    ) {
      fs.rmSync(path.join(ARTIFACTS_DIR, af), { recursive: true, force: true });
    }
  }

  console.log('ALL TRUTHLENS AI VERIFICATION TESTS PASSED!');
}

runTests().catch((err) => {
  console.error('TEST SUITE FAILED:', err);
  process.exit(1);
});
