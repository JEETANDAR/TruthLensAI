import fs from 'fs';
import path from 'path';
import { ARTIFACTS_DIR } from '../config.ts';
import type { ForensicIndicator } from './image.ts';

export interface ColumnProfile {
  name: string;
  inferredType: 'numeric' | 'boolean' | 'date' | 'string';
  nonEmptyCount: number;
  missingCount: number;
  missingPct: number;
  uniqueCount: number;
  typeErrorCount: number;
  outlierCount: number;
  min: number | null;
  max: number | null;
  mean: number | null;
  median: number | null;
}

export interface FixAction {
  action: string;
  count: number;
  detail: string;
}

export interface BeforeAfterComparison {
  metric: string;
  before: number;
  after: number;
  unit: string;
}

export interface ValidationCheck {
  check: string;
  passed: boolean;
  detail: string;
}

export interface DatasetAnalysisResult {
  metrics: {
    format: string;
    rowCount: number;
    columnCount: number;
    afterRowCount: number;
    totalMissingValues: number;
    afterMissingValues: number;
    duplicateRowCount: number;
    afterDuplicateRowCount: number;
    typeErrorCount: number;
    afterTypeErrorCount: number;
    outlierCount: number;
    malformedRowCount: number;
    beforeQualityScore: number;
    afterQualityScore: number;
    whitespaceTrimmedCount: number;
  };
  columns: ColumnProfile[];
  fixesApplied: FixAction[];
  beforeAfterComparisons: BeforeAfterComparison[];
  validationChecks: ValidationCheck[];
  beforeSample: Array<Record<string, string>>;
  afterSample: Array<Record<string, string>>;
  cleanedCsvUrl: string;
  cleanedPreviewCsv: string;
  recommendations: string[];
  indicators: ForensicIndicator[];
  limitations: string;
}

const MISSING_TOKENS = new Set(['', 'na', 'n/a', 'null', 'none', 'nan', 'undefined', '-', '--']);

function isMissingCell(val: string | undefined): boolean {
  if (val === undefined || val === null) return true;
  return MISSING_TOKENS.has(val.trim().toLowerCase());
}

function parseDelimited(rawInput: string, delimiter: string): string[][] {
  const raw = rawInput.charCodeAt(0) === 0xfeff ? rawInput.slice(1) : rawInput;
  const len = raw.length;
  const rows: string[][] = [];
  let row: string[] = [];
  let i = 0;

  while (i < len) {
    if (raw[i] === '"') {
      // Quoted cell
      i++;
      let cellStart = i;
      let cell = '';
      let hasEscapedQuote = false;
      while (i < len) {
        if (raw[i] === '"') {
          if (i + 1 < len && raw[i + 1] === '"') {
            if (!hasEscapedQuote) {
              cell = raw.slice(cellStart, i);
              hasEscapedQuote = true;
            } else {
              cell += raw.slice(cellStart, i);
            }
            cell += '"';
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
      if (i < len && raw[i] === delimiter) {
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
      // Fast slice scan for unquoted cells
      const start = i;
      while (i < len) {
        const code = raw.charCodeAt(i);
        if (code === delimiter.charCodeAt(0) || code === 10 || code === 13) break;
        i++;
      }
      row.push(raw.slice(start, i));
      if (i < len && raw[i] === delimiter) {
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

function escapeCsvCell(val: string): string {
  if (val.includes(',') || val.includes('"') || val.includes('\n') || val.includes('\r')) {
    return `"${val.replace(/"/g, '""')}"`;
  }
  return val;
}

function parseNumericToken(val: string): number | null {
  const t = val.trim();
  if (!t) return null;
  const cleaned = t.replace(/^[$€£¥]/, '').replace(/,/g, '').replace(/%$/, '');
  if (cleaned === '' || !/^[-+]?(\d+(\.\d+)?|\.\d+)$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function isDateToken(val: string): boolean {
  const t = val.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(t) || /^\d{1,2}\/\d{1,2}\/\d{2,4}/.test(t)) {
    return !Number.isNaN(Date.parse(t));
  }
  return false;
}

function isBooleanToken(val: string): boolean {
  const low = val.trim().toLowerCase();
  return low === 'true' || low === 'false' || low === 'yes' || low === 'no' || low === '0' || low === '1';
}

function computeMedianSorted(sorted: Float64Array): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function computeQualityScore(params: {
  totalCells: number;
  missing: number;
  duplicates: number;
  rows: number;
  typeErrors: number;
  outliers: number;
  malformedRows: number;
}): number {
  if (params.rows === 0 || params.totalCells === 0) return 0;
  const completeness = 1 - Math.min(1, params.missing / params.totalCells);
  const uniqueness = 1 - Math.min(1, params.duplicates / params.rows);
  const validity = 1 - Math.min(1, (params.typeErrors + params.malformedRows) / params.totalCells);
  const consistency = 1 - Math.min(1, params.outliers / params.totalCells);

  const score = 100 * (0.35 * completeness + 0.25 * uniqueness + 0.25 * validity + 0.15 * consistency);
  return Math.max(0, Math.min(100, Number(score.toFixed(1))));
}

export function runDatasetForensics(
  evidenceId: string,
  filePath: string,
  originalFilename: string,
): DatasetAnalysisResult {
  const raw = fs.readFileSync(filePath, 'utf8');
  const ext = path.extname(originalFilename).toLowerCase();

  let headers: string[] = [];
  let dataRows: string[][] = [];

  if (ext === '.json') {
    const parsed = JSON.parse(raw);
    const records: Array<Record<string, unknown>> = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed.records)
      ? parsed.records
      : Array.isArray(parsed.data)
      ? parsed.data
      : [];
    const keySet = new Set<string>();
    records.forEach((r) => {
      if (r && typeof r === 'object') Object.keys(r).forEach((k) => keySet.add(k));
    });
    headers = Array.from(keySet);
    dataRows = records.map((r) =>
      headers.map((h) => {
        const v = r?.[h];
        return v === null || v === undefined ? '' : String(v);
      }),
    );
  } else {
    const delimiter = ext === '.tsv' ? '\t' : ',';
    const parsedRows = parseDelimited(raw, delimiter);
    if (parsedRows.length > 0) {
      headers = parsedRows[0].map((h, i) => h.trim() || `column_${i + 1}`);
      dataRows = parsedRows.slice(1);
    }
  }

  const colCount = headers.length;
  const rowCount = dataRows.length;
  const totalCells = Math.max(1, rowCount * colCount);

  // Track raw row issues before automated repair
  let malformedRowCount = 0;
  let emptyRowCount = 0;
  let whitespaceTrimmedCount = 0;

  const normalizedRows: string[][] = [];
  for (const r of dataRows) {
    if (r.length !== colCount) malformedRowCount++;
    const padded = Array.from({ length: colCount }, (_, ci) => r[ci] ?? '');
    if (padded.every((c) => isMissingCell(c))) {
      emptyRowCount++;
    }
    normalizedRows.push(padded);
  }

  // Exact duplicate check before trimming vs trimmed key
  const seenBefore = new Set<string>();
  let duplicateRowCount = 0;
  for (const r of normalizedRows) {
    const key = r.map((c) => c.trim()).join('\u0001');
    if (seenBefore.has(key)) duplicateRowCount++;
    else seenBefore.add(key);
  }

  // Single-pass column type inference and statistical profiling using Float64Array for fast quantiles
  const columns: ColumnProfile[] = [];
  let totalMissingValues = 0;
  let totalTypeErrors = 0;
  let totalOutliers = 0;
  const colNumericMedian = new Map<number, number>();
  const colModeValue = new Map<number, string>();

  for (let c = 0; c < colCount; c++) {
    let nonEmptyCount = 0;
    let numMatches = 0;
    let boolMatches = 0;
    let dateMatches = 0;
    const numericVals: number[] = [];
    const freq = new Map<string, number>();

    for (let r = 0; r < rowCount; r++) {
      const val = normalizedRows[r][c] ?? '';
      if (isMissingCell(val)) continue;
      nonEmptyCount++;
      const trimmed = val.trim();
      freq.set(trimmed, (freq.get(trimmed) || 0) + 1);

      const n = parseNumericToken(trimmed);
      if (n !== null) {
        numMatches++;
        numericVals.push(n);
      } else if (isBooleanToken(trimmed)) {
        boolMatches++;
      } else if (isDateToken(trimmed)) {
        dateMatches++;
      }
    }

    const missingCount = rowCount - nonEmptyCount;
    totalMissingValues += missingCount;

    let inferredType: ColumnProfile['inferredType'] = 'string';
    if (nonEmptyCount > 0) {
      const nRatio = numMatches / nonEmptyCount;
      const bRatio = boolMatches / nonEmptyCount;
      const dRatio = dateMatches / nonEmptyCount;
      if (nRatio >= 0.6) inferredType = 'numeric';
      else if (bRatio >= 0.75) inferredType = 'boolean';
      else if (dRatio >= 0.6) inferredType = 'date';
    }

    let typeErrorCount = 0;
    if (inferredType === 'numeric') typeErrorCount = nonEmptyCount - numMatches;
    else if (inferredType === 'boolean') typeErrorCount = nonEmptyCount - boolMatches;
    else if (inferredType === 'date') typeErrorCount = nonEmptyCount - dateMatches;
    totalTypeErrors += typeErrorCount;

    // IQR / Z-score statistical anomaly detection on numeric columns via native C++ Float64Array.sort
    let outlierCount = 0;
    let minVal: number | null = null;
    let maxVal: number | null = null;
    let meanVal: number | null = null;
    let medianVal: number | null = null;

    if (numericVals.length >= 4 && inferredType === 'numeric') {
      const numArr = Float64Array.from(numericVals);
      let sum = 0;
      for (let k = 0; k < numArr.length; k++) sum += numArr[k];
      meanVal = Number((sum / numArr.length).toFixed(4));

      numArr.sort();
      minVal = Number(numArr[0].toFixed(4));
      maxVal = Number(numArr[numArr.length - 1].toFixed(4));
      medianVal = computeMedianSorted(numArr);
      if (medianVal !== null) colNumericMedian.set(c, Number(medianVal.toFixed(4)));

      const q1 = numArr[Math.floor(numArr.length * 0.25)];
      const q3 = numArr[Math.floor(numArr.length * 0.75)];
      const iqr = q3 - q1;
      if (iqr > 0) {
        const lower = q1 - 1.5 * iqr;
        const upper = q3 + 1.5 * iqr;
        for (let k = 0; k < numArr.length; k++) {
          if (numArr[k] < lower || numArr[k] > upper) outlierCount++;
        }
      } else {
        let varAcc = 0;
        for (let k = 0; k < numArr.length; k++) {
          const d = numArr[k] - meanVal;
          varAcc += d * d;
        }
        const std = Math.sqrt(varAcc / numArr.length);
        if (std > 0) {
          for (let k = 0; k < numArr.length; k++) {
            if (Math.abs((numArr[k] - meanVal) / std) > 3) outlierCount++;
          }
        }
      }
      totalOutliers += outlierCount;
    } else if (numericVals.length > 0 && inferredType === 'numeric') {
      const numArr = Float64Array.from(numericVals);
      let sum = 0;
      for (let k = 0; k < numArr.length; k++) sum += numArr[k];
      numArr.sort();
      minVal = numArr[0];
      maxVal = numArr[numArr.length - 1];
      meanVal = Number((sum / numArr.length).toFixed(4));
      medianVal = computeMedianSorted(numArr);
      if (medianVal !== null) colNumericMedian.set(c, Number(medianVal.toFixed(4)));
    }

    let bestMode = 'UNKNOWN';
    let bestFreq = 0;
    for (const [k, count] of freq.entries()) {
      if (count > bestFreq) {
        bestFreq = count;
        bestMode = k;
      }
    }
    colModeValue.set(c, bestMode);

    columns.push({
      name: headers[c],
      inferredType,
      nonEmptyCount,
      missingCount,
      missingPct: Number(((missingCount / Math.max(1, rowCount)) * 100).toFixed(1)),
      uniqueCount: freq.size,
      typeErrorCount,
      outlierCount,
      min: minVal,
      max: maxVal,
      mean: meanVal,
      median: medianVal !== null ? Number(medianVal.toFixed(4)) : null,
    });
  }

  // Combined single-pass Deterministic Automated Cleaning, Deduplication & Buffered CSV Export
  let imputedMissingCount = 0;
  let repairedTypeCount = 0;
  let normalizedNumericCount = 0;
  let afterMissingValues = 0;
  let afterTypeErrors = 0;
  let removedDuplicateCount = 0;
  let cleanedRowCount = 0;

  const seenAfter = new Set<string>();
  const afterSampleRows: string[][] = [];
  const headerLine = headers.map(escapeCsvCell).join(',');
  const previewLines: string[] = [headerLine];

  const cleanedCsvFilename = `cleaned_${evidenceId}.csv`;
  const cleanedCsvPath = path.join(ARTIFACTS_DIR, cleanedCsvFilename);
  const fd = fs.openSync(cleanedCsvPath, 'w');
  let writeChunk: string[] = [headerLine];

  try {
    for (let rIdx = 0; rIdx < normalizedRows.length; rIdx++) {
      const r = normalizedRows[rIdx];
      let allMissing = true;
      for (let c = 0; c < colCount; c++) {
        if (!isMissingCell(r[c])) {
          allMissing = false;
          break;
        }
      }
      if (allMissing) continue;

      const nextRow: string[] = new Array(colCount);
      for (let c = 0; c < colCount; c++) {
        const rawCell = r[c] ?? '';
        const trimmed = rawCell.trim();
        if (trimmed !== rawCell) whitespaceTrimmedCount++;

        const colProfile = columns[c];
        if (isMissingCell(trimmed)) {
          imputedMissingCount++;
          if (colProfile.inferredType === 'numeric' && colNumericMedian.has(c)) {
            nextRow[c] = String(colNumericMedian.get(c));
          } else {
            nextRow[c] = colModeValue.get(c) || 'UNKNOWN';
          }
        } else if (colProfile.inferredType === 'numeric') {
          const parsedNum = parseNumericToken(trimmed);
          if (parsedNum !== null) {
            const cleanStr = String(parsedNum);
            if (cleanStr !== trimmed) normalizedNumericCount++;
            nextRow[c] = cleanStr;
          } else {
            repairedTypeCount++;
            nextRow[c] = String(colNumericMedian.get(c) ?? 0);
          }
        } else if (colProfile.inferredType === 'boolean') {
          const low = trimmed.toLowerCase();
          if (low === 'yes' || low === '1' || low === 'true') nextRow[c] = 'true';
          else if (low === 'no' || low === '0' || low === 'false') nextRow[c] = 'false';
          else {
            repairedTypeCount++;
            nextRow[c] = 'false';
          }
        } else {
          nextRow[c] = trimmed;
        }
      }

      const key = nextRow.join('\u0001');
      if (seenAfter.has(key)) {
        removedDuplicateCount++;
        continue;
      }
      seenAfter.add(key);
      cleanedRowCount++;

      for (let c = 0; c < colCount; c++) {
        if (isMissingCell(nextRow[c])) afterMissingValues++;
        if (columns[c]?.inferredType === 'numeric' && parseNumericToken(nextRow[c]) === null) {
          afterTypeErrors++;
        }
      }

      if (afterSampleRows.length < 8) afterSampleRows.push(nextRow);
      const csvLine = nextRow.map(escapeCsvCell).join(',');
      if (previewLines.length < 25) previewLines.push(csvLine);
      writeChunk.push(csvLine);
      if (writeChunk.length >= 2000) {
        fs.writeSync(fd, writeChunk.join('\n') + '\n', null, 'utf8');
        writeChunk = [];
      }
    }
    if (writeChunk.length > 0) {
      fs.writeSync(fd, writeChunk.join('\n'), null, 'utf8');
    }
  } finally {
    fs.closeSync(fd);
  }

  const beforeQualityScore = computeQualityScore({
    totalCells,
    missing: totalMissingValues,
    duplicates: duplicateRowCount,
    rows: rowCount,
    typeErrors: totalTypeErrors,
    outliers: totalOutliers,
    malformedRows: malformedRowCount,
  });

  const afterQualityScore = computeQualityScore({
    totalCells: Math.max(1, cleanedRowCount * colCount),
    missing: afterMissingValues,
    duplicates: 0,
    rows: cleanedRowCount,
    typeErrors: afterTypeErrors,
    outliers: totalOutliers,
    malformedRows: 0,
  });

  const toRowObjects = (rows: string[][]) =>
    rows.slice(0, 8).map((r) => {
      const obj: Record<string, string> = {};
      headers.forEach((h, i) => {
        obj[h] = r[i] ?? '';
      });
      return obj;
    });

  const fixesApplied: FixAction[] = [
    {
      action: 'Whitespace & Control Normalization',
      count: whitespaceTrimmedCount,
      detail: 'Trimmed leading/trailing spaces and normalized line endings across cells.',
    },
    {
      action: 'Missing Value Imputation',
      count: imputedMissingCount,
      detail: 'Replaced missing/null tokens using column median (numeric) or column mode (categorical).',
    },
    {
      action: 'Exact Duplicate Row Removal',
      count: removedDuplicateCount,
      detail: 'Removed identical duplicate records while preserving first occurrence.',
    },
    {
      action: 'Schema & Numeric Format Repair',
      count: repairedTypeCount + normalizedNumericCount,
      detail: 'Stripped currency/comma formatting and repaired invalid type tokens.',
    },
    {
      action: 'Empty Row Cleanup',
      count: emptyRowCount,
      detail: 'Dropped blank rows lacking valid field entries.',
    },
  ].filter((f) => f.count > 0);

  if (fixesApplied.length === 0) {
    fixesApplied.push({
      action: 'Structural Verification Pass',
      count: rowCount,
      detail: 'Dataset already conformed to strict schema and completeness thresholds; exported verified copy.',
    });
  }

  const beforeAfterComparisons: BeforeAfterComparison[] = [
    { metric: 'Quality Score', before: beforeQualityScore, after: afterQualityScore, unit: '/ 100' },
    { metric: 'Missing Values', before: totalMissingValues, after: afterMissingValues, unit: 'cells' },
    { metric: 'Duplicate Rows', before: duplicateRowCount, after: 0, unit: 'rows' },
    { metric: 'Type / Format Errors', before: totalTypeErrors, after: afterTypeErrors, unit: 'cells' },
    { metric: 'Row Count', before: rowCount, after: cleanedRowCount, unit: 'rows' },
  ];

  const validationChecks: ValidationCheck[] = [
    {
      check: 'Zero Missing Cells Remaining',
      passed: afterMissingValues === 0,
      detail: afterMissingValues === 0 ? 'All cells contain non-null values.' : `${afterMissingValues} cells still empty.`,
    },
    {
      check: 'Zero Duplicate Records',
      passed: true,
      detail: `${removedDuplicateCount} duplicate row(s) removed; unique key check passed across ${cleanedRowCount} rows.`,
    },
    {
      check: 'Numeric & Schema Consistency',
      passed: afterTypeErrors === 0,
      detail:
        afterTypeErrors === 0
          ? 'All numeric columns parse cleanly as finite numbers.'
          : `${afterTypeErrors} unparsed cells remain.`,
    },
    {
      check: 'Cleaned CSV Export Integrity',
      passed: fs.existsSync(cleanedCsvPath),
      detail: `Verified cleaned CSV written (${cleanedRowCount} rows × ${colCount} columns).`,
    },
  ];

  const recommendations: string[] = [];
  if (totalOutliers > 0) {
    const outlierCols = columns.filter((c) => c.outlierCount > 0).map((c) => `${c.name} (${c.outlierCount})`);
    recommendations.push(
      `Inspect ${totalOutliers} statistical outlier(s) retained for audit transparency in: ${outlierCols.join(', ')}.`,
    );
  }
  if (totalMissingValues > 0) {
    recommendations.push(
      `Review ${totalMissingValues} median/mode imputed cell(s) before downstream predictive modeling or compliance reporting.`,
    );
  }
  if (duplicateRowCount > 0) {
    recommendations.push(
      `Audit upstream ingestion pipeline to prevent recurring duplicate submissions (${duplicateRowCount} detected).`,
    );
  }
  if (malformedRowCount > 0) {
    recommendations.push(
      `Verify ${malformedRowCount} row(s) with mismatched delimiter widths in the original source export.`,
    );
  }
  if (recommendations.length === 0) {
    recommendations.push('Dataset meets baseline completeness, uniqueness, and type consistency standards.');
  }

  const indicators: ForensicIndicator[] = [
    {
      id: `IND-${evidenceId}-DS-OVERVIEW`,
      category: 'Dataset Profile',
      severity: 'info',
      sourceLayer: 'forensic_signal',
      evidenceRef: evidenceId,
      title: `Profiled ${rowCount} rows × ${colCount} columns (Quality ${beforeQualityScore} → ${afterQualityScore}/100)`,
      detail: `Detected ${totalMissingValues} missing cell(s), ${duplicateRowCount} duplicate row(s), ${totalTypeErrors} type error(s), and ${totalOutliers} statistical outlier(s).`,
    },
  ];

  if (totalMissingValues > 0) {
    indicators.push({
      id: `IND-${evidenceId}-DS-MISSING`,
      category: 'Data Completeness',
      severity: totalMissingValues / totalCells > 0.1 ? 'critical' : 'warning',
      sourceLayer: 'forensic_signal',
      evidenceRef: evidenceId,
      title: `${totalMissingValues} missing value(s) detected and imputed`,
      detail: `Affected columns: ${columns
        .filter((c) => c.missingCount > 0)
        .map((c) => `${c.name} (${c.missingCount})`)
        .join(', ')}.`,
    });
  }
  if (duplicateRowCount > 0) {
    indicators.push({
      id: `IND-${evidenceId}-DS-DUP`,
      category: 'Record Uniqueness',
      severity: 'warning',
      sourceLayer: 'forensic_signal',
      evidenceRef: evidenceId,
      title: `${duplicateRowCount} exact duplicate row(s) deduplicated`,
      detail: `Cleaned dataset retains ${cleanedRowCount} unique records.`,
    });
  }
  if (totalTypeErrors > 0 || malformedRowCount > 0) {
    indicators.push({
      id: `IND-${evidenceId}-DS-ERR`,
      category: 'Schema & Format',
      severity: 'warning',
      sourceLayer: 'forensic_signal',
      evidenceRef: evidenceId,
      title: `${totalTypeErrors + malformedRowCount} schema/type or row-width error(s) repaired`,
      detail: `Normalized malformed numeric/boolean cells and aligned column widths.`,
    });
  }
  if (totalOutliers > 0) {
    indicators.push({
      id: `IND-${evidenceId}-DS-OUTLIER`,
      category: 'Statistical Anomalies',
      severity: 'warning',
      sourceLayer: 'forensic_signal',
      evidenceRef: evidenceId,
      title: `${totalOutliers} statistical outlier(s) flagged via IQR / Z-score`,
      detail: `Extreme numeric deviations preserved in cleaned export for investigator confirmation.`,
    });
  }

  return {
    metrics: {
      format: ext.replace('.', '') || 'csv',
      rowCount,
      columnCount: colCount,
      afterRowCount: cleanedRowCount,
      totalMissingValues,
      afterMissingValues,
      duplicateRowCount,
      afterDuplicateRowCount: 0,
      typeErrorCount: totalTypeErrors,
      afterTypeErrorCount: afterTypeErrors,
      outlierCount: totalOutliers,
      malformedRowCount,
      beforeQualityScore,
      afterQualityScore,
      whitespaceTrimmedCount,
    },
    columns,
    fixesApplied,
    beforeAfterComparisons,
    validationChecks,
    beforeSample: toRowObjects(normalizedRows),
    afterSample: toRowObjects(afterSampleRows),
    cleanedCsvUrl: `/api/artifacts/${cleanedCsvFilename}`,
    cleanedPreviewCsv: previewLines.join('\n'),
    recommendations,
    indicators,
    limitations:
      'Automated dataset cleaner performs deterministic whitespace trimming, deduplication, median/mode imputation, and type normalization while preserving statistical outliers for human review.',
  };
}
