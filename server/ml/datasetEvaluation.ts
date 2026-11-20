import fs from 'fs';
import path from 'path';
import { DATASETS_UPLOAD_DIR, resolveSafeStoragePath } from '../config.ts';
import { getDb, logAudit } from '../db/database.ts';
import { runImageForensics } from '../forensics/image.ts';
import type { InferenceOutput } from './inference.ts';

export const SUPPORTED_DATASET_IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png']);
export const SUPPORTED_DATASET_CSV_EXTS = new Set(['.csv']);

export interface DatasetTreeNode {
  name: string;
  path: string;
  type: 'folder' | 'file';
  size: number;
  extension?: string;
  modality?: 'image' | 'csv' | 'unsupported';
  imageCount: number;
  csvCount: number;
  unsupportedCount: number;
  children?: DatasetTreeNode[];
}

export interface CsvFileDescriptor {
  path: string;
  name: string;
  size: number;
  inferredSplit: 'train' | 'test' | 'valid' | 'custom';
}

export interface UnsupportedFileRecord {
  path: string;
  extension: string;
  size: number;
  reason: string;
}

export interface DatasetUploadRow {
  id: string;
  name: string;
  storage_dir: string;
  total_files: number;
  image_count: number;
  csv_count: number;
  unsupported_count: number;
  total_bytes: number;
  tree_json: string;
  csv_files_json: string;
  unsupported_files_json: string;
  status: string;
  created_at: string;
}

export interface CsvInspectionResult {
  csvPath: string;
  inferredSplit: 'train' | 'test' | 'valid' | 'custom';
  columns: string[];
  rowCount: number;
  previewRows: Array<Record<string, string>>;
  detectedPathColumn: string;
  detectedLabelColumn: string;
  labelDistribution: Array<{ rawValue: string; count: number; suggestedMapping: 'real' | 'fake' | 'unmapped' }>;
  allColumnLabelHints: Record<string, Array<{ rawValue: string; count: number; suggestedMapping: 'real' | 'fake' | 'unmapped' }>>;
}

export type MatchRowStatus =
  | 'matched'
  | 'missing'
  | 'duplicate'
  | 'invalid_path'
  | 'unsupported_format'
  | 'ambiguous'
  | 'unmapped_label';

export interface MatchedSampleRecord {
  rowIndex: number;
  csvImageRef: string;
  resolvedRelPath: string;
  absPath: string;
  filename: string;
  fileSizeBytes: number;
  groundTruthLabel: 'real' | 'fake';
  rawCsvLabel: string;
  matchMethod: string;
}

export interface MatchDiagnosticRecord {
  rowIndex: number;
  csvImageRef: string;
  resolvedRelPath: string | null;
  filename: string;
  rawCsvLabel: string;
  mappedLabel: 'real' | 'fake' | 'unmapped';
  status: MatchRowStatus;
  detail: string;
}

export interface DatasetMatchSummary {
  csvPath: string;
  inferredSplit: 'train' | 'test' | 'valid' | 'custom';
  pathColumn: string;
  labelColumn: string;
  totalCsvRows: number;
  matchedCount: number;
  missingCount: number;
  duplicateCount: number;
  invalidPathCount: number;
  unsupportedFormatCount: number;
  ambiguousCount: number;
  unmappedLabelCount: number;
  unmatchedTotal: number;
  unreferencedImagesCount: number;
  groundTruthBreakdown: { real: number; fake: number };
  matchedSamples: MatchedSampleRecord[];
  diagnostics: MatchDiagnosticRecord[];
}

export interface DatasetEvalConfusionMatrix {
  tp: number; // Actual Fake, Predicted Fake
  fp: number; // Actual Real, Predicted Fake
  tn: number; // Actual Real, Predicted Real
  fn: number; // Actual Fake, Predicted Real
  inconclusiveFake: number; // Actual Fake, Predicted Inconclusive
  inconclusiveReal: number; // Actual Real, Predicted Inconclusive
  failedFake: number;
  failedReal: number;
}

export interface DatasetEvalModelMetrics {
  modelId: string;
  totalEvaluated: number;
  decisiveCount: number;
  inconclusiveCount: number;
  failedCount: number;
  actualRealCount: number;
  actualFakeCount: number;
  predictedRealCount: number;
  predictedFakeCount: number;
  confusionMatrix: DatasetEvalConfusionMatrix;
  // Metrics computed strictly on actual predictions vs ground-truth labels
  accuracy: number | null; // (TP + TN) / decisiveCount
  overallAccuracyInclInconclusive: number | null; // (TP + TN) / processedNonFailed
  precision: number | null; // TP / (TP + FP)
  fakeRecall: number | null; // TP / (TP + FN) (decisive)
  fakeRecallOverall: number | null; // TP / (TP + FN + inconclusiveFake)
  genuineRecall: number | null; // TN / (TN + FP) (decisive)
  genuineRecallOverall: number | null; // TN / (TN + FP + inconclusiveReal)
  f1Score: number | null;
  fpr: number | null; // FP / (FP + TN)
  fnr: number | null; // FN / (TP + FN)
  coverage: number | null; // decisiveCount / processedNonFailed
  meanRawScoreReal: number | null;
  meanRawScoreFake: number | null;
  scoresCalibrated: false;
  note?: string;
}

export interface DatasetEvalRunRow {
  id: string;
  dataset_id: string;
  dataset_name: string;
  csv_path: string;
  split_label: string;
  path_column: string;
  label_column: string;
  label_mapping_json: string;
  status: string;
  total_csv_rows: number;
  matched_count: number;
  unmatched_count: number;
  duplicate_count: number;
  processed_count: number;
  failed_count: number;
  inconclusive_count: number;
  primary_model_id: string;
  metrics_by_model_json: string;
  match_summary_json: string;
  current_item: string;
  error_message: string;
  started_at: string;
  completed_at: string | null;
}

export interface DatasetEvalResultRow {
  id: string;
  run_id: string;
  row_index: number;
  csv_image_ref: string;
  resolved_rel_path: string | null;
  filename: string;
  ground_truth_label: string;
  model_id: string;
  predicted_label: string;
  raw_score: number | null;
  status: string;
  correct: number | null;
  error_detail: string;
  uncertainty_note: string;
  forensic_metrics_json: string;
  evaluated_at: string;
}

const activeRunControllers = new Map<string, { cancelRequested: boolean }>();

export function genEvalId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

export function sanitizeDatasetRelPath(rawPath: string): string {
  const normalized = String(rawPath || '')
    .replace(/\\/g, '/')
    .replace(/^(\.\/|\/)+/, '')
    .trim();
  if (!normalized) {
    throw new Error('Empty relative path');
  }
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length === 0 || parts.some((p) => p === '..' || p === '.' || p.includes('\0'))) {
    throw new Error(`Invalid relative path segment in "${rawPath}"`);
  }
  return parts.join('/');
}

export function inferSplitFromCsvPath(csvPath: string): 'train' | 'test' | 'valid' | 'custom' {
  const low = csvPath.toLowerCase();
  const base = path.basename(low);
  if (/\btest\b|test\.csv|testing/.test(base) || /\/test\//.test(low)) return 'test';
  if (/\btrain\b|train\.csv|training/.test(base) || /\/train\//.test(low)) return 'train';
  if (/\bval(id|idation)?\b|valid\.csv|val\.csv/.test(base) || /\/val(id)?\//.test(low)) return 'valid';
  return 'custom';
}

export function parseCsvContent(rawInput: string): string[][] {
  const raw = rawInput.charCodeAt(0) === 0xfeff ? rawInput.slice(1) : rawInput;
  const len = raw.length;
  const rows: string[][] = [];
  let row: string[] = [];
  let i = 0;

  while (i < len) {
    if (raw[i] === '"') {
      i++;
      let cellStart = i;
      let cell = '';
      let hasEscapedQuote = false;
      while (i < len) {
        if (raw[i] === '"') {
          if (i + 1 < len && raw[i + 1] === '"') {
            cell += raw.slice(cellStart, i) + '"';
            hasEscapedQuote = true;
            i += 2;
            cellStart = i;
            continue;
          }
          break;
        }
        i++;
      }
      const tail = raw.slice(cellStart, i);
      row.push(hasEscapedQuote ? cell + tail : tail);
      if (i < len && raw[i] === '"') i++;
      if (i < len && raw[i] === ',') {
        i++;
        if (i === len) {
          row.push('');
          rows.push(row);
          row = [];
        }
      } else if (i < len && (raw[i] === '\r' || raw[i] === '\n')) {
        if (raw[i] === '\r' && raw[i + 1] === '\n') i += 2;
        else i += 1;
        if (!(row.length === 1 && row[0].trim() === '')) rows.push(row);
        row = [];
      } else if (i >= len) {
        if (!(row.length === 1 && row[0].trim() === '')) rows.push(row);
        row = [];
      }
    } else {
      const start = i;
      while (i < len) {
        const code = raw.charCodeAt(i);
        if (code === 44 || code === 10 || code === 13) break;
        i++;
      }
      row.push(raw.slice(start, i));
      if (i < len && raw[i] === ',') {
        i++;
        if (i === len) {
          row.push('');
          rows.push(row);
          row = [];
        }
      } else if (i < len && (raw[i] === '\r' || raw[i] === '\n')) {
        if (raw[i] === '\r' && raw[i + 1] === '\n') i += 2;
        else i += 1;
        if (!(row.length === 1 && row[0].trim() === '')) rows.push(row);
        row = [];
      } else if (i >= len) {
        if (!(row.length === 1 && row[0].trim() === '')) rows.push(row);
        row = [];
      }
    }
  }
  if (row.length > 0 && !(row.length === 1 && row[0].trim() === '')) {
    rows.push(row);
  }
  return rows;
}

export function scanDatasetDirectory(datasetDir: string, rootName: string): {
  tree: DatasetTreeNode;
  totalFiles: number;
  imageCount: number;
  csvCount: number;
  unsupportedCount: number;
  totalBytes: number;
  csvFiles: CsvFileDescriptor[];
  unsupportedFiles: UnsupportedFileRecord[];
} {
  const csvFiles: CsvFileDescriptor[] = [];
  const unsupportedFiles: UnsupportedFileRecord[] = [];
  let totalFiles = 0;
  let imageCount = 0;
  let csvCount = 0;
  let unsupportedCount = 0;
  let totalBytes = 0;

  function walk(absDir: string, relDir: string, name: string): DatasetTreeNode {
    const entries = fs.readdirSync(absDir, { withFileTypes: true }).sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    const children: DatasetTreeNode[] = [];
    let dirImgCount = 0;
    let dirCsvCount = 0;
    let dirUnsupportedCount = 0;
    let dirSize = 0;

    for (const entry of entries) {
      if (entry.name === '__MACOSX' || entry.name === '.DS_Store' || entry.name === 'Thumbs.db') {
        continue;
      }
      const entryAbs = path.join(absDir, entry.name);
      const entryRel = relDir ? `${relDir}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        const subNode = walk(entryAbs, entryRel, entry.name);
        dirImgCount += subNode.imageCount;
        dirCsvCount += subNode.csvCount;
        dirUnsupportedCount += subNode.unsupportedCount;
        dirSize += subNode.size;
        children.push(subNode);
      } else if (entry.isFile()) {
        const stat = fs.statSync(entryAbs);
        const ext = path.extname(entry.name).toLowerCase();
        totalFiles++;
        totalBytes += stat.size;
        dirSize += stat.size;

        let modality: 'image' | 'csv' | 'unsupported' = 'unsupported';
        if (SUPPORTED_DATASET_IMAGE_EXTS.has(ext)) {
          modality = 'image';
          imageCount++;
          dirImgCount++;
        } else if (SUPPORTED_DATASET_CSV_EXTS.has(ext)) {
          modality = 'csv';
          csvCount++;
          dirCsvCount++;
          csvFiles.push({
            path: entryRel,
            name: entry.name,
            size: stat.size,
            inferredSplit: inferSplitFromCsvPath(entryRel),
          });
        } else {
          unsupportedCount++;
          dirUnsupportedCount++;
          unsupportedFiles.push({
            path: entryRel,
            extension: ext || '(none)',
            size: stat.size,
            reason: `Unsupported file format '${ext || 'unknown'}' (dataset evaluation supports JPG, JPEG, PNG, and CSV)`,
          });
        }

        children.push({
          name: entry.name,
          path: entryRel,
          type: 'file',
          size: stat.size,
          extension: ext,
          modality,
          imageCount: modality === 'image' ? 1 : 0,
          csvCount: modality === 'csv' ? 1 : 0,
          unsupportedCount: modality === 'unsupported' ? 1 : 0,
        });
      }
    }

    return {
      name,
      path: relDir,
      type: 'folder',
      size: dirSize,
      imageCount: dirImgCount,
      csvCount: dirCsvCount,
      unsupportedCount: dirUnsupportedCount,
      children,
    };
  }

  const tree = walk(datasetDir, '', rootName);
  return {
    tree,
    totalFiles,
    imageCount,
    csvCount,
    unsupportedCount,
    totalBytes,
    csvFiles,
    unsupportedFiles,
  };
}

export function suggestLabelMapping(rawValue: string): 'real' | 'fake' | 'unmapped' {
  const v = rawValue.trim().toLowerCase();
  if (!v) return 'unmapped';
  if (
    v === 'real' ||
    v === 'genuine' ||
    v === 'authentic' ||
    v === 'bonafide' ||
    v === 'bona_fide' ||
    v === 'original' ||
    v === 'true_real' ||
    v === 'natural'
  ) {
    return 'real';
  }
  if (
    v === 'fake' ||
    v === 'manipulated' ||
    v === 'synthetic' ||
    v === 'deepfake' ||
    v === 'ai' ||
    v === 'generated' ||
    v === 'spoof' ||
    v === 'edited' ||
    v === 'tampered' ||
    v === 'forged'
  ) {
    return 'fake';
  }
  // Common Kaggle binary convention: 1 = Real, 0 = Fake OR 0 = Real, 1 = Fake.
  // Surface explicitly in UI for verification: default 0 -> fake, 1 -> real only as editable suggestion?
  // Wait: in binary real-vs-fake datasets like JamieWithofs / Kaggle 140k, 1=Real and 0=Fake, whereas in is_fake 1=Fake and 0=Real!
  // We handle column-aware defaults below; here return 'unmapped' for raw numbers so column-aware helper handles them cleanly.
  return 'unmapped';
}

function buildLabelDistributionForColumn(
  headers: string[],
  dataRows: string[][],
  colName: string,
): Array<{ rawValue: string; count: number; suggestedMapping: 'real' | 'fake' | 'unmapped' }> {
  const colIdx = headers.indexOf(colName);
  if (colIdx < 0) return [];
  const counts = new Map<string, number>();
  for (const row of dataRows) {
    const val = (row[colIdx] ?? '').trim();
    counts.set(val, (counts.get(val) || 0) + 1);
  }
  const colLow = colName.toLowerCase();
  const isIsFakeCol = /fake|spoof|tamper|manip|synth|forged/.test(colLow) && !/real_vs_fake/.test(colLow);

  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 50)
    .map(([rawValue, count]) => {
      let suggested = suggestLabelMapping(rawValue);
      if (suggested === 'unmapped') {
        const low = rawValue.toLowerCase();
        if (low === '0' || low === '1' || low === 'true' || low === 'false') {
          if (isIsFakeCol) {
            suggested = low === '1' || low === 'true' ? 'fake' : 'real';
          } else {
            // Default common Kaggle 140k convention (0=Fake, 1=Real), editable by user in UI
            suggested = low === '1' || low === 'true' ? 'real' : 'fake';
          }
        }
      }
      return { rawValue, count, suggestedMapping: suggested };
    });
}

export function inspectDatasetCsv(datasetDir: string, csvRelPath: string): CsvInspectionResult {
  const cleanCsvRel = sanitizeDatasetRelPath(csvRelPath);
  const absCsvPath = resolveSafeStoragePath(cleanCsvRel, datasetDir);
  if (!fs.existsSync(absCsvPath) || !fs.statSync(absCsvPath).isFile()) {
    throw new Error(`CSV file not found: ${cleanCsvRel}`);
  }

  const raw = fs.readFileSync(absCsvPath, 'utf8');
  const parsedRows = parseCsvContent(raw);
  if (parsedRows.length === 0) {
    throw new Error(`CSV file "${cleanCsvRel}" is empty.`);
  }

  const headers = parsedRows[0].map((h, idx) => h.trim() || `column_${idx + 1}`);
  const dataRows = parsedRows.slice(1);
  const sampleLimit = Math.min(dataRows.length, 200);

  // Score columns for Image Path/Filename
  let bestPathCol = headers[0];
  let bestPathScore = -Infinity;

  // Score columns for Ground-Truth Label
  let bestLabelCol = headers[headers.length > 1 ? 1 : 0];
  let bestLabelScore = -Infinity;

  for (let c = 0; c < headers.length; c++) {
    const hLow = headers[c].toLowerCase().trim();
    let pathScore = 0;
    let labelScore = 0;

    if (/^(path|filepath|file_path|image_path|img_path|rel_path|filename|file_name|image|img|file)$/.test(hLow)) {
      pathScore += 60;
    } else if (/path|file|image|img|src|name/.test(hLow)) {
      pathScore += 30;
    }
    if (/original_path|id$/.test(hLow) && !/path/.test(hLow)) {
      pathScore -= 10;
    }

    if (/^(label_str|ground_truth|truth|label|class|target|is_fake|real_vs_fake|verdict|authenticity|category)$/.test(hLow)) {
      labelScore += 60;
    } else if (/label|class|target|truth|fake|real|spoof|status|y$/.test(hLow)) {
      labelScore += 30;
    }

    let imgExtHits = 0;
    let slashHits = 0;
    let realFakeWordHits = 0;
    let binaryHits = 0;
    const distinctVals = new Set<string>();

    for (let r = 0; r < sampleLimit; r++) {
      const val = (dataRows[r]?.[c] ?? '').trim();
      if (!val) continue;
      distinctVals.add(val.toLowerCase());
      if (/\.(jpe?g|png|webp|bmp|gif)$/i.test(val)) imgExtHits++;
      if (val.includes('/') || val.includes('\\')) slashHits++;
      const m = suggestLabelMapping(val);
      if (m === 'real' || m === 'fake') realFakeWordHits++;
      else if (val === '0' || val === '1' || val.toLowerCase() === 'true' || val.toLowerCase() === 'false') {
        binaryHits++;
      }
    }

    if (sampleLimit > 0) {
      pathScore += (imgExtHits / sampleLimit) * 100 + (slashHits / sampleLimit) * 35;
      labelScore += (realFakeWordHits / sampleLimit) * 110 + (binaryHits / sampleLimit) * 45;
      if (distinctVals.size >= 2 && distinctVals.size <= 6 && imgExtHits === 0) {
        labelScore += 20;
      }
      if (imgExtHits > 0) {
        labelScore -= 80;
      }
    }

    if (pathScore > bestPathScore) {
      bestPathScore = pathScore;
      bestPathCol = headers[c];
    }
    if (labelScore > bestLabelScore) {
      bestLabelScore = labelScore;
      bestLabelCol = headers[c];
    }
  }

  // Avoid picking the same column if multiple columns exist
  if (bestLabelCol === bestPathCol && headers.length > 1) {
    const fallback = headers.find((h) => h !== bestPathCol);
    if (fallback) bestLabelCol = fallback;
  }

  const previewRows = dataRows.slice(0, 15).map((r) => {
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => {
      obj[h] = r[i] ?? '';
    });
    return obj;
  });

  const allColumnLabelHints: Record<
    string,
    Array<{ rawValue: string; count: number; suggestedMapping: 'real' | 'fake' | 'unmapped' }>
  > = {};
  for (const h of headers) {
    allColumnLabelHints[h] = buildLabelDistributionForColumn(headers, dataRows, h);
  }

  return {
    csvPath: cleanCsvRel,
    inferredSplit: inferSplitFromCsvPath(cleanCsvRel),
    columns: headers,
    rowCount: dataRows.length,
    previewRows,
    detectedPathColumn: bestPathCol,
    detectedLabelColumn: bestLabelCol,
    labelDistribution: allColumnLabelHints[bestLabelCol] || [],
    allColumnLabelHints,
  };
}

interface IndexedDiskFile {
  relPath: string;
  absPath: string;
  size: number;
  ext: string;
  basenameLower: string;
}

function indexDatasetFiles(datasetDir: string): IndexedDiskFile[] {
  const files: IndexedDiskFile[] = [];
  function walk(absDir: string, relDir: string) {
    for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
      if (entry.name === '__MACOSX' || entry.name === '.DS_Store' || entry.name === 'Thumbs.db') continue;
      const abs = path.join(absDir, entry.name);
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(abs, rel);
      } else if (entry.isFile()) {
        const stat = fs.statSync(abs);
        files.push({
          relPath: rel,
          absPath: abs,
          size: stat.size,
          ext: path.extname(entry.name).toLowerCase(),
          basenameLower: entry.name.toLowerCase(),
        });
      }
    }
  }
  walk(datasetDir, '');
  return files;
}

export function matchCsvToDatasetFiles(params: {
  datasetDir: string;
  csvRelPath: string;
  pathColumn: string;
  labelColumn: string;
  labelMap?: Record<string, 'real' | 'fake' | 'unmapped'>;
}): DatasetMatchSummary {
  const cleanCsvRel = sanitizeDatasetRelPath(params.csvRelPath);
  const absCsvPath = resolveSafeStoragePath(cleanCsvRel, params.datasetDir);
  if (!fs.existsSync(absCsvPath)) {
    throw new Error(`CSV file not found: ${cleanCsvRel}`);
  }

  const raw = fs.readFileSync(absCsvPath, 'utf8');
  const parsedRows = parseCsvContent(raw);
  if (parsedRows.length < 2) {
    throw new Error(`CSV file "${cleanCsvRel}" has no data rows.`);
  }

  const headers = parsedRows[0].map((h, idx) => h.trim() || `column_${idx + 1}`);
  const dataRows = parsedRows.slice(1);
  const pathIdx = headers.indexOf(params.pathColumn);
  const labelIdx = headers.indexOf(params.labelColumn);
  if (pathIdx < 0) throw new Error(`Mapped path column "${params.pathColumn}" not found in CSV.`);
  if (labelIdx < 0) throw new Error(`Mapped label column "${params.labelColumn}" not found in CSV.`);

  // Build effective label mapping
  const defaultDist = buildLabelDistributionForColumn(headers, dataRows, params.labelColumn);
  const effectiveLabelMap = new Map<string, 'real' | 'fake' | 'unmapped'>();
  for (const item of defaultDist) {
    effectiveLabelMap.set(item.rawValue.trim().toLowerCase(), item.suggestedMapping);
  }
  if (params.labelMap) {
    for (const [k, v] of Object.entries(params.labelMap)) {
      effectiveLabelMap.set(k.trim().toLowerCase(), v);
    }
  }

  const diskFiles = indexDatasetFiles(params.datasetDir);
  const byExactRel = new Map<string, IndexedDiskFile>();
  const byLowerRel = new Map<string, IndexedDiskFile>();
  const byBasename = new Map<string, IndexedDiskFile[]>();
  const allImageFiles = diskFiles.filter((f) => SUPPORTED_DATASET_IMAGE_EXTS.has(f.ext));

  for (const f of diskFiles) {
    byExactRel.set(f.relPath, f);
    byLowerRel.set(f.relPath.toLowerCase(), f);
    const list = byBasename.get(f.basenameLower) || [];
    list.push(f);
    byBasename.set(f.basenameLower, list);
  }

  const csvParentDir = path.posix.dirname(cleanCsvRel) === '.' ? '' : path.posix.dirname(cleanCsvRel);

  const matchedSamples: MatchedSampleRecord[] = [];
  const diagnostics: MatchDiagnosticRecord[] = [];
  const seenResolvedPaths = new Set<string>();
  const seenRawRefs = new Set<string>();

  let missingCount = 0;
  let duplicateCount = 0;
  let invalidPathCount = 0;
  let unsupportedFormatCount = 0;
  let ambiguousCount = 0;
  let unmappedLabelCount = 0;

  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i];
    const rowIndex = i + 1;
    const rawRef = (row[pathIdx] ?? '').trim();
    const rawLabel = (row[labelIdx] ?? '').trim();
    const mappedLabel = effectiveLabelMap.get(rawLabel.toLowerCase()) ?? suggestLabelMapping(rawLabel);

    if (!rawRef || rawRef.includes('\0') || rawRef.split(/[\\/]/).some((seg) => seg === '..')) {
      invalidPathCount++;
      diagnostics.push({
        rowIndex,
        csvImageRef: rawRef || '(empty)',
        resolvedRelPath: null,
        filename: rawRef ? path.posix.basename(rawRef.replace(/\\/g, '/')) : '(empty)',
        rawCsvLabel: rawLabel,
        mappedLabel,
        status: 'invalid_path',
        detail: !rawRef ? 'Empty image path cell in CSV row.' : 'Invalid or unsafe path traversal segment.',
      });
      continue;
    }

    const normRef = rawRef.replace(/\\/g, '/').replace(/^(\.\/|\/)+/, '');
    const normRefLow = normRef.toLowerCase();
    const baseName = path.posix.basename(normRef);
    const baseNameLow = baseName.toLowerCase();
    const refExt = path.posix.extname(normRefLow);

    if (refExt && !SUPPORTED_DATASET_IMAGE_EXTS.has(refExt)) {
      unsupportedFormatCount++;
      diagnostics.push({
        rowIndex,
        csvImageRef: rawRef,
        resolvedRelPath: null,
        filename: baseName,
        rawCsvLabel: rawLabel,
        mappedLabel,
        status: 'unsupported_format',
        detail: `Unsupported extension "${refExt}". Only JPG, JPEG, and PNG images are evaluated.`,
      });
      continue;
    }

    // Attempt deterministic path resolution
    let matchedFile: IndexedDiskFile | null = null;
    let matchMethod = '';
    let ambiguityMessage = '';

    // 1. Exact relative path from dataset root
    if (byExactRel.has(normRef)) {
      matchedFile = byExactRel.get(normRef)!;
      matchMethod = 'exact_root_path';
    }
    // 2. Relative to CSV parent directory
    if (!matchedFile && csvParentDir) {
      const fromCsvDir = `${csvParentDir}/${normRef}`;
      if (byExactRel.has(fromCsvDir)) {
        matchedFile = byExactRel.get(fromCsvDir)!;
        matchMethod = 'csv_relative_path';
      } else if (byLowerRel.has(fromCsvDir.toLowerCase())) {
        matchedFile = byLowerRel.get(fromCsvDir.toLowerCase())!;
        matchMethod = 'csv_relative_path_ci';
      }
    }
    // 3. Case-insensitive relative path from dataset root
    if (!matchedFile && byLowerRel.has(normRefLow)) {
      matchedFile = byLowerRel.get(normRefLow)!;
      matchMethod = 'root_path_ci';
    }
    // 4. Unique path suffix match (handles extra/missing leading root segment)
    if (!matchedFile && normRef.includes('/')) {
      const suffixMatches = diskFiles.filter(
        (f) =>
          f.relPath.toLowerCase().endsWith(`/${normRefLow}`) ||
          normRefLow.endsWith(`/${f.relPath.toLowerCase()}`),
      );
      if (suffixMatches.length === 1) {
        matchedFile = suffixMatches[0];
        matchMethod = 'unique_path_suffix';
      } else if (suffixMatches.length > 1) {
        ambiguityMessage = `Ambiguous path suffix "${normRef}" matched ${suffixMatches.length} files: ${suffixMatches
          .slice(0, 3)
          .map((m) => m.relPath)
          .join(', ')}`;
      }
    }
    // 5. Fallback to unique basename (or basename inside CSV parent dir subtree)
    if (!matchedFile && !ambiguityMessage) {
      const baseMatches = byBasename.get(baseNameLow) || [];
      const scopedMatches = csvParentDir
        ? baseMatches.filter((f) => f.relPath.startsWith(`${csvParentDir}/`))
        : baseMatches;
      const candidates = scopedMatches.length === 1 ? scopedMatches : baseMatches;

      if (candidates.length === 1) {
        // Also ensure if CSV provided directory segments (other than root prefix), don't silently cross-match wildly different path segments unless basename is unique
        matchedFile = candidates[0];
        matchMethod = scopedMatches.length === 1 ? 'csv_subtree_unique_filename' : 'unique_filename';
      } else if (candidates.length > 1) {
        ambiguityMessage = `Ambiguous filename "${baseName}" found at ${candidates.length} locations: ${candidates
          .slice(0, 3)
          .map((m) => m.relPath)
          .join(', ')}`;
      }
    }

    if (ambiguityMessage) {
      ambiguousCount++;
      diagnostics.push({
        rowIndex,
        csvImageRef: rawRef,
        resolvedRelPath: null,
        filename: baseName,
        rawCsvLabel: rawLabel,
        mappedLabel,
        status: 'ambiguous',
        detail: ambiguityMessage,
      });
      continue;
    }

    if (!matchedFile) {
      if (seenRawRefs.has(normRefLow)) {
        duplicateCount++;
        diagnostics.push({
          rowIndex,
          csvImageRef: rawRef,
          resolvedRelPath: null,
          filename: baseName,
          rawCsvLabel: rawLabel,
          mappedLabel,
          status: 'duplicate',
          detail: `Duplicate CSV record for missing path "${rawRef}".`,
        });
      } else {
        seenRawRefs.add(normRefLow);
        missingCount++;
        diagnostics.push({
          rowIndex,
          csvImageRef: rawRef,
          resolvedRelPath: null,
          filename: baseName,
          rawCsvLabel: rawLabel,
          mappedLabel,
          status: 'missing',
          detail: `Image file "${normRef}" not found in uploaded dataset folders.`,
        });
      }
      continue;
    }

    if (!SUPPORTED_DATASET_IMAGE_EXTS.has(matchedFile.ext)) {
      unsupportedFormatCount++;
      diagnostics.push({
        rowIndex,
        csvImageRef: rawRef,
        resolvedRelPath: matchedFile.relPath,
        filename: path.basename(matchedFile.relPath),
        rawCsvLabel: rawLabel,
        mappedLabel,
        status: 'unsupported_format',
        detail: `Resolved file "${matchedFile.relPath}" has unsupported format "${matchedFile.ext}".`,
      });
      continue;
    }

    if (seenResolvedPaths.has(matchedFile.relPath)) {
      duplicateCount++;
      diagnostics.push({
        rowIndex,
        csvImageRef: rawRef,
        resolvedRelPath: matchedFile.relPath,
        filename: path.basename(matchedFile.relPath),
        rawCsvLabel: rawLabel,
        mappedLabel,
        status: 'duplicate',
        detail: `Duplicate CSV record: "${matchedFile.relPath}" was already matched by an earlier row.`,
      });
      continue;
    }

    if (mappedLabel !== 'real' && mappedLabel !== 'fake') {
      unmappedLabelCount++;
      diagnostics.push({
        rowIndex,
        csvImageRef: rawRef,
        resolvedRelPath: matchedFile.relPath,
        filename: path.basename(matchedFile.relPath),
        rawCsvLabel: rawLabel || '(empty)',
        mappedLabel: 'unmapped',
        status: 'unmapped_label',
        detail: `Ground-truth label "${rawLabel || '(empty)'}" is not mapped to Real or Fake.`,
      });
      continue;
    }

    seenResolvedPaths.add(matchedFile.relPath);
    seenRawRefs.add(normRefLow);

    matchedSamples.push({
      rowIndex,
      csvImageRef: rawRef,
      resolvedRelPath: matchedFile.relPath,
      absPath: matchedFile.absPath,
      filename: path.basename(matchedFile.relPath),
      fileSizeBytes: matchedFile.size,
      groundTruthLabel: mappedLabel,
      rawCsvLabel: rawLabel,
      matchMethod,
    });

    diagnostics.push({
      rowIndex,
      csvImageRef: rawRef,
      resolvedRelPath: matchedFile.relPath,
      filename: path.basename(matchedFile.relPath),
      rawCsvLabel: rawLabel,
      mappedLabel,
      status: 'matched',
      detail: `Matched via ${matchMethod} (${(matchedFile.size / 1024).toFixed(1)} KB)`,
    });
  }

  const unreferencedImagesCount = allImageFiles.filter((f) => !seenResolvedPaths.has(f.relPath)).length;
  const unmatchedTotal =
    missingCount + duplicateCount + invalidPathCount + unsupportedFormatCount + ambiguousCount + unmappedLabelCount;

  return {
    csvPath: cleanCsvRel,
    inferredSplit: inferSplitFromCsvPath(cleanCsvRel),
    pathColumn: params.pathColumn,
    labelColumn: params.labelColumn,
    totalCsvRows: dataRows.length,
    matchedCount: matchedSamples.length,
    missingCount,
    duplicateCount,
    invalidPathCount,
    unsupportedFormatCount,
    ambiguousCount,
    unmappedLabelCount,
    unmatchedTotal,
    unreferencedImagesCount,
    groundTruthBreakdown: {
      real: matchedSamples.filter((m) => m.groundTruthLabel === 'real').length,
      fake: matchedSamples.filter((m) => m.groundTruthLabel === 'fake').length,
    },
    matchedSamples,
    diagnostics,
  };
}

function mapPredictionLabel(predLabel: InferenceOutput['predictionLabel']): 'real' | 'fake' | 'inconclusive' {
  if (predLabel === 'elevated_anomaly') return 'fake';
  if (predLabel === 'consistent_baseline') return 'real';
  return 'inconclusive';
}

export function computeDatasetEvalModelMetrics(
  modelId: string,
  rows: Array<{
    groundTruth: 'real' | 'fake';
    predicted: 'real' | 'fake' | 'inconclusive' | 'failed';
    rawScore: number | null;
  }>,
): DatasetEvalModelMetrics {
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  let inconclusiveFake = 0;
  let inconclusiveReal = 0;
  let failedFake = 0;
  let failedReal = 0;

  let realScoreSum = 0;
  let realScoreN = 0;
  let fakeScoreSum = 0;
  let fakeScoreN = 0;

  for (const r of rows) {
    if (typeof r.rawScore === 'number' && Number.isFinite(r.rawScore)) {
      if (r.groundTruth === 'real') {
        realScoreSum += r.rawScore;
        realScoreN++;
      } else {
        fakeScoreSum += r.rawScore;
        fakeScoreN++;
      }
    }

    if (r.predicted === 'failed') {
      if (r.groundTruth === 'fake') failedFake++;
      else failedReal++;
      continue;
    }
    if (r.predicted === 'inconclusive') {
      if (r.groundTruth === 'fake') inconclusiveFake++;
      else inconclusiveReal++;
      continue;
    }
    if (r.groundTruth === 'fake' && r.predicted === 'fake') tp++;
    else if (r.groundTruth === 'real' && r.predicted === 'fake') fp++;
    else if (r.groundTruth === 'real' && r.predicted === 'real') tn++;
    else if (r.groundTruth === 'fake' && r.predicted === 'real') fn++;
  }

  const decisiveCount = tp + fp + tn + fn;
  const inconclusiveCount = inconclusiveFake + inconclusiveReal;
  const failedCount = failedFake + failedReal;
  const processedNonFailed = decisiveCount + inconclusiveCount;
  const actualFakeCount = tp + fn + inconclusiveFake;
  const actualRealCount = tn + fp + inconclusiveReal;
  const predictedFakeCount = tp + fp;
  const predictedRealCount = tn + fn;

  const accuracy = decisiveCount > 0 ? Number(((tp + tn) / decisiveCount).toFixed(4)) : null;
  const overallAccuracyInclInconclusive =
    processedNonFailed > 0 ? Number(((tp + tn) / processedNonFailed).toFixed(4)) : null;
  const precision = tp + fp > 0 ? Number((tp / (tp + fp)).toFixed(4)) : null;
  const fakeRecall = tp + fn > 0 ? Number((tp / (tp + fn)).toFixed(4)) : null;
  const fakeRecallOverall = actualFakeCount > 0 ? Number((tp / actualFakeCount).toFixed(4)) : null;
  const genuineRecall = tn + fp > 0 ? Number((tn / (tn + fp)).toFixed(4)) : null;
  const genuineRecallOverall = actualRealCount > 0 ? Number((tn / actualRealCount).toFixed(4)) : null;
  const f1Score =
    precision !== null && fakeRecall !== null && precision + fakeRecall > 0
      ? Number(((2 * precision * fakeRecall) / (precision + fakeRecall)).toFixed(4))
      : null;
  const fpr = fp + tn > 0 ? Number((fp / (fp + tn)).toFixed(4)) : null;
  const fnr = tp + fn > 0 ? Number((fn / (tp + fn)).toFixed(4)) : null;
  const coverage = processedNonFailed > 0 ? Number((decisiveCount / processedNonFailed).toFixed(4)) : null;

  let note: string | undefined;
  if (decisiveCount === 0 && inconclusiveCount > 0) {
    note = 'All processed samples fell into the Inconclusive band (raw score 40–65 / 100); decisive classification rates are undefined.';
  } else if (actualRealCount === 0 || actualFakeCount === 0) {
    note = 'Only one ground-truth class present in evaluated samples; single-class rates (precision/recall/FPR/FNR) may be N/A.';
  }

  return {
    modelId,
    totalEvaluated: rows.length,
    decisiveCount,
    inconclusiveCount,
    failedCount,
    actualRealCount,
    actualFakeCount,
    predictedRealCount,
    predictedFakeCount,
    confusionMatrix: {
      tp,
      fp,
      tn,
      fn,
      inconclusiveFake,
      inconclusiveReal,
      failedFake,
      failedReal,
    },
    accuracy,
    overallAccuracyInclInconclusive,
    precision,
    fakeRecall,
    fakeRecallOverall,
    genuineRecall,
    genuineRecallOverall,
    f1Score,
    fpr,
    fnr,
    coverage,
    meanRawScoreReal: realScoreN > 0 ? Number((realScoreSum / realScoreN).toFixed(4)) : null,
    meanRawScoreFake: fakeScoreN > 0 ? Number((fakeScoreSum / fakeScoreN).toFixed(4)) : null,
    scoresCalibrated: false,
    note,
  };
}

/**
 * Blinded image inference worker: strictly takes only image path & evalId (never ground-truth label or CSV metadata).
 */
async function runBlindedImageInference(
  evalId: string,
  absPath: string,
): Promise<{ predictions: InferenceOutput[]; compactMetrics: Record<string, unknown> }> {
  const res = await runImageForensics(evalId, absPath, { skipArtifactFiles: true });
  return {
    predictions: res.mlPredictions,
    compactMetrics: {
      width: res.metrics.width ?? null,
      height: res.metrics.height ?? null,
      format: res.metrics.format ?? null,
      faceCount: res.metrics.faceCount ?? 0,
      elaMean: res.metrics.elaMean ?? null,
      elaSpatialVariance: res.metrics.elaSpatialVariance ?? null,
      noiseFloorStd: res.metrics.noiseFloorStd ?? null,
      doubleJpegSuspected: res.metrics.doubleJpegSuspected ?? null,
      exifPresent: res.metrics.exifPresent ?? null,
    },
  };
}

export function startDatasetEvaluationRun(params: {
  datasetId: string;
  csvPath: string;
  pathColumn: string;
  labelColumn: string;
  labelMap?: Record<string, 'real' | 'fake' | 'unmapped'>;
  actor?: string;
}): DatasetEvalRunRow {
  const db = getDb();
  const ds = db.prepare(`SELECT * FROM dataset_uploads WHERE id = ?`).get(params.datasetId) as
    | DatasetUploadRow
    | undefined;
  if (!ds) {
    throw new Error('Uploaded dataset not found');
  }

  const matchSummary = matchCsvToDatasetFiles({
    datasetDir: ds.storage_dir,
    csvRelPath: params.csvPath,
    pathColumn: params.pathColumn,
    labelColumn: params.labelColumn,
    labelMap: params.labelMap,
  });

  if (matchSummary.matchedCount === 0) {
    throw new Error(
      `No valid images matched between CSV "${params.csvPath}" and uploaded dataset files (${matchSummary.unmatchedTotal} unmatched/invalid records).`,
    );
  }

  const runId = genEvalId('DSEVAL');
  const startedAt = new Date().toISOString();
  const primaryModelId = 'TL-ViT-DFvReal-ONNX';

  const compactMatchSummary = {
    totalCsvRows: matchSummary.totalCsvRows,
    matchedCount: matchSummary.matchedCount,
    missingCount: matchSummary.missingCount,
    duplicateCount: matchSummary.duplicateCount,
    invalidPathCount: matchSummary.invalidPathCount,
    unsupportedFormatCount: matchSummary.unsupportedFormatCount,
    ambiguousCount: matchSummary.ambiguousCount,
    unmappedLabelCount: matchSummary.unmappedLabelCount,
    unmatchedTotal: matchSummary.unmatchedTotal,
    unreferencedImagesCount: matchSummary.unreferencedImagesCount,
    groundTruthBreakdown: matchSummary.groundTruthBreakdown,
  };

  db.prepare(
    `INSERT INTO dataset_eval_runs
     (id, dataset_id, dataset_name, csv_path, split_label, path_column, label_column, label_mapping_json, status,
      total_csv_rows, matched_count, unmatched_count, duplicate_count, processed_count, failed_count, inconclusive_count,
      primary_model_id, metrics_by_model_json, match_summary_json, current_item, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, 0, 0, 0, ?, '[]', ?, ?, ?)`,
  ).run(
    runId,
    ds.id,
    ds.name,
    matchSummary.csvPath,
    matchSummary.inferredSplit,
    matchSummary.pathColumn,
    matchSummary.labelColumn,
    JSON.stringify(params.labelMap || {}),
    matchSummary.totalCsvRows,
    matchSummary.matchedCount,
    matchSummary.unmatchedTotal,
    matchSummary.duplicateCount,
    primaryModelId,
    JSON.stringify(compactMatchSummary),
    `Starting evaluation (${matchSummary.matchedCount} matched images)...`,
    startedAt,
  );

  // Persist all unmatched/duplicate/invalid CSV rows explicitly so nothing is silently skipped
  const insertRes = db.prepare(
    `INSERT INTO dataset_eval_results
     (id, run_id, row_index, csv_image_ref, resolved_rel_path, filename, ground_truth_label, model_id,
      predicted_label, raw_score, status, correct, error_detail, uncertainty_note, forensic_metrics_json, evaluated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  for (const diag of matchSummary.diagnostics) {
    if (diag.status === 'matched') continue;
    insertRes.run(
      genEvalId('DSRES'),
      runId,
      diag.rowIndex,
      diag.csvImageRef,
      diag.resolvedRelPath,
      diag.filename,
      diag.mappedLabel,
      primaryModelId,
      'unmatched',
      null,
      diag.status,
      null,
      diag.detail,
      '',
      '{}',
      startedAt,
    );
  }

  const controller = { cancelRequested: false };
  activeRunControllers.set(runId, controller);

  void executeDatasetEvaluationLoop(runId, matchSummary.matchedSamples, controller, params.actor || 'Investigator').catch(
    (err) => {
      db.prepare(`UPDATE dataset_eval_runs SET status = 'failed', error_message = ?, completed_at = ? WHERE id = ?`).run(
        err instanceof Error ? err.message : 'Evaluation run failed unexpectedly',
        new Date().toISOString(),
        runId,
      );
      activeRunControllers.delete(runId);
    },
  );

  return db.prepare(`SELECT * FROM dataset_eval_runs WHERE id = ?`).get(runId) as DatasetEvalRunRow;
}

export function cancelDatasetEvaluationRun(runId: string): boolean {
  const ctrl = activeRunControllers.get(runId);
  if (ctrl) {
    ctrl.cancelRequested = true;
    return true;
  }
  const db = getDb();
  const row = db.prepare(`SELECT status FROM dataset_eval_runs WHERE id = ?`).get(runId) as
    | { status: string }
    | undefined;
  if (row && row.status === 'running') {
    db.prepare(`UPDATE dataset_eval_runs SET status = 'cancelled', completed_at = ? WHERE id = ?`).run(
      new Date().toISOString(),
      runId,
    );
    return true;
  }
  return false;
}

async function executeDatasetEvaluationLoop(
  runId: string,
  matchedSamples: MatchedSampleRecord[],
  controller: { cancelRequested: boolean },
  actor: string,
): Promise<void> {
  const db = getDb();
  const insertRes = db.prepare(
    `INSERT INTO dataset_eval_results
     (id, run_id, row_index, csv_image_ref, resolved_rel_path, filename, ground_truth_label, model_id,
      predicted_label, raw_score, status, correct, error_detail, uncertainty_note, forensic_metrics_json, evaluated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const updateProgress = db.prepare(
    `UPDATE dataset_eval_runs
     SET processed_count = ?, failed_count = ?, inconclusive_count = ?, primary_model_id = ?, current_item = ?
     WHERE id = ?`,
  );

  let processedCount = 0;
  let failedCount = 0;
  let primaryInconclusiveCount = 0;
  let resolvedPrimaryModelId = 'TL-ViT-DFvReal-ONNX';

  const modelGroups = new Map<
    string,
    Array<{ groundTruth: 'real' | 'fake'; predicted: 'real' | 'fake' | 'inconclusive' | 'failed'; rawScore: number | null }>
  >();

  for (let idx = 0; idx < matchedSamples.length; idx++) {
    if (controller.cancelRequested) {
      break;
    }
    const sample = matchedSamples[idx];
    const evalId = `DSE_${runId}_${sample.rowIndex}`.replace(/[^a-zA-Z0-9_-]/g, '_');

    updateProgress.run(
      processedCount,
      failedCount,
      primaryInconclusiveCount,
      resolvedPrimaryModelId,
      sample.resolvedRelPath,
      runId,
    );

    const evaluatedAt = new Date().toISOString();
    try {
      if (!fs.existsSync(sample.absPath)) {
        throw new Error(`Image disappeared from storage: ${sample.resolvedRelPath}`);
      }

      // Ground-truth is strictly isolated: only evalId + absPath passed to blinded inference
      const { predictions, compactMetrics } = await runBlindedImageInference(evalId, sample.absPath);
      if (predictions.length === 0) {
        throw new Error('No image model produced predictions for this file.');
      }

      resolvedPrimaryModelId = predictions[0].modelId;

      // Join ground-truth label ONLY post-inference
      for (let pIdx = 0; pIdx < predictions.length; pIdx++) {
        const pred = predictions[pIdx];
        const predicted = mapPredictionLabel(pred.predictionLabel);
        const status = predicted === 'inconclusive' ? 'inconclusive' : 'evaluated';
        const correct = predicted === 'inconclusive' ? null : predicted === sample.groundTruthLabel ? 1 : 0;

        if (pIdx === 0 && predicted === 'inconclusive') {
          primaryInconclusiveCount++;
        }

        insertRes.run(
          genEvalId('DSRES'),
          runId,
          sample.rowIndex,
          sample.csvImageRef,
          sample.resolvedRelPath,
          sample.filename,
          sample.groundTruthLabel,
          pred.modelId,
          predicted,
          pred.rawScore,
          status,
          correct,
          '',
          pred.uncertaintyNote,
          JSON.stringify(compactMetrics),
          evaluatedAt,
        );

        const arr = modelGroups.get(pred.modelId) || [];
        arr.push({
          groundTruth: sample.groundTruthLabel,
          predicted,
          rawScore: pred.rawScore,
        });
        modelGroups.set(pred.modelId, arr);
      }

      processedCount++;
    } catch (err) {
      failedCount++;
      const errMsg = err instanceof Error ? err.message : 'Image preprocessing or inference failed';
      insertRes.run(
        genEvalId('DSRES'),
        runId,
        sample.rowIndex,
        sample.csvImageRef,
        sample.resolvedRelPath,
        sample.filename,
        sample.groundTruthLabel,
        resolvedPrimaryModelId,
        'failed',
        null,
        'failed',
        null,
        errMsg,
        '',
        '{}',
        evaluatedAt,
      );
      const arr = modelGroups.get(resolvedPrimaryModelId) || [];
      arr.push({
        groundTruth: sample.groundTruthLabel,
        predicted: 'failed',
        rawScore: null,
      });
      modelGroups.set(resolvedPrimaryModelId, arr);
    }

    updateProgress.run(
      processedCount,
      failedCount,
      primaryInconclusiveCount,
      resolvedPrimaryModelId,
      sample.resolvedRelPath,
      runId,
    );
  }

  const metricsByModel: DatasetEvalModelMetrics[] = [];
  for (const [modelId, entries] of modelGroups.entries()) {
    metricsByModel.push(computeDatasetEvalModelMetrics(modelId, entries));
  }

  const completedAt = new Date().toISOString();
  const finalStatus = controller.cancelRequested
    ? 'cancelled'
    : processedCount === 0 && failedCount > 0
    ? 'failed'
    : failedCount > 0
    ? 'completed_with_errors'
    : 'completed';

  db.prepare(
    `UPDATE dataset_eval_runs
     SET status = ?, processed_count = ?, failed_count = ?, inconclusive_count = ?,
         primary_model_id = ?, metrics_by_model_json = ?, current_item = '', completed_at = ?
     WHERE id = ?`,
  ).run(
    finalStatus,
    processedCount,
    failedCount,
    primaryInconclusiveCount,
    resolvedPrimaryModelId,
    JSON.stringify(metricsByModel),
    completedAt,
    runId,
  );

  logAudit(null, actor, 'DATASET_EVALUATION_FINISHED', 'dataset_eval_run', runId, {
    status: finalStatus,
    processedCount,
    failedCount,
    inconclusiveCount: primaryInconclusiveCount,
    primaryModelId: resolvedPrimaryModelId,
  });

  activeRunControllers.delete(runId);
}

export function formatDatasetEvalCsv(
  run: DatasetEvalRunRow,
  results: DatasetEvalResultRow[],
  scope: 'all' | 'incorrect' | 'issues',
): string {
  const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const header = [
    'run_id',
    'dataset_name',
    'csv_path',
    'split_label',
    'row_index',
    'csv_image_ref',
    'resolved_rel_path',
    'filename',
    'model_id',
    'actual_label',
    'predicted_label',
    'raw_score_uncalibrated',
    'is_calibrated',
    'status',
    'correct',
    'error_detail',
  ].join(',');

  const filtered = results.filter((r) => {
    if (scope === 'incorrect') {
      return r.correct === 0 || r.status === 'failed';
    }
    if (scope === 'issues') {
      return r.correct === 0 || r.status !== 'evaluated';
    }
    return true;
  });

  const lines = filtered.map((r) =>
    [
      esc(run.id),
      esc(run.dataset_name),
      esc(run.csv_path),
      esc(run.split_label),
      r.row_index,
      esc(r.csv_image_ref),
      esc(r.resolved_rel_path ?? ''),
      esc(r.filename),
      esc(r.model_id),
      esc(r.ground_truth_label),
      esc(r.predicted_label),
      r.raw_score !== null ? r.raw_score.toFixed(4) : '',
      'false (uncalibrated)',
      esc(r.status),
      r.correct === null ? 'N/A' : r.correct === 1 ? 'true' : 'false',
      esc(r.error_detail),
    ].join(','),
  );

  return [header, ...lines].join('\n');
}

export function getDatasetUploadRootDir(datasetId: string): string {
  return resolveSafeStoragePath(datasetId, DATASETS_UPLOAD_DIR);
}
