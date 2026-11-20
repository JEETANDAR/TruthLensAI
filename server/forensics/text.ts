import fs from 'fs';
import path from 'path';
import type { ForensicIndicator } from './image.ts';

export interface ParsedCue {
  index: number;
  startSec: number;
  endSec: number;
  text: string;
}

export interface TextAnalysisResult {
  metrics: Record<string, number | string | boolean | null>;
  rawPreview: string;
  cues: ParsedCue[];
  extractedClaims: string[];
  indicators: ForensicIndicator[];
  limitations: string;
}

function parseSrtTimestamp(ts: string): number {
  const m = ts.trim().match(/(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/);
  if (!m) return 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
}

export function runTextForensics(
  evidenceId: string,
  filePath: string,
  originalFilename: string,
): TextAnalysisResult {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Text file not found: ${originalFilename}`);
  }
  const rawBuf = fs.readFileSync(filePath);
  if (rawBuf.length === 0) {
    throw new Error(`Text file "${originalFilename}" is empty (0 bytes).`);
  }
  if (rawBuf.includes(0)) {
    throw new Error(`Text file "${originalFilename}" contains binary null bytes and is corrupt/unsupported.`);
  }
  const raw = rawBuf.toString('utf8');
  const ext = path.extname(originalFilename).toLowerCase();
  const cues: ParsedCue[] = [];
  let plainText = raw;
  let jsonParseFailed = false;

  if (ext === '.srt') {
    const blocks = raw.replace(/\r\n/g, '\n').split(/\n\s*\n/);
    for (const block of blocks) {
      const lines = block.trim().split('\n');
      if (lines.length >= 3 && lines[1].includes('-->')) {
        const [startStr, endStr] = lines[1].split('-->');
        cues.push({
          index: Number(lines[0]) || cues.length + 1,
          startSec: Number(parseSrtTimestamp(startStr).toFixed(3)),
          endSec: Number(parseSrtTimestamp(endStr).toFixed(3)),
          text: lines.slice(2).join(' ').trim(),
        });
      }
    }
    plainText = cues.map((c) => `[${c.startSec}s - ${c.endSec}s] ${c.text}`).join('\n');
  } else if (ext === '.json') {
    try {
      const parsed = JSON.parse(raw);
      plainText = JSON.stringify(parsed, null, 2);
      const list = Array.isArray(parsed.segments)
        ? parsed.segments
        : Array.isArray(parsed.cues)
        ? parsed.cues
        : Array.isArray(parsed.transcript)
        ? parsed.transcript
        : [];
      list.forEach((seg: { start?: number; end?: number; text?: string; claim?: string }, idx: number) => {
        const txt = typeof seg.text === 'string' ? seg.text : typeof seg.claim === 'string' ? seg.claim : '';
        if (txt) {
          cues.push({
            index: idx + 1,
            startSec: Number(seg.start || 0),
            endSec: Number(seg.end || 0),
            text: txt,
          });
        }
      });
    } catch {
      plainText = raw;
      jsonParseFailed = true;
    }
  }

  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const wordCount = plainText.split(/\s+/).filter(Boolean).length;

  // Extract sentences containing numbers, dates, locations, or named assertions as claims
  const rawSentences = (cues.length > 0 ? cues.map((c) => c.text).join(' ') : plainText)
    .replace(/\n+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 10);

  const extractedClaims = rawSentences
    .filter((s) =>
      /\d|said|announced|confirmed|signed|at|on|never|always|zero|suspended|terminated|million|percent|approved|denied/i.test(
        s,
      ),
    )
    .slice(0, 14);

  const maxCueEnd = cues.length > 0 ? Math.max(...cues.map((c) => c.endSec)) : 0;
  const indicators: ForensicIndicator[] = [
    {
      id: `IND-${evidenceId}-TXT-BASE`,
      category: 'Text Structure',
      severity: 'info',
      sourceLayer: 'forensic_signal',
      evidenceRef: evidenceId,
      title: `Parsed ${ext.toUpperCase()} document (${wordCount} words)`,
      detail:
        cues.length > 0
          ? `Extracted ${cues.length} timestamped subtitle/transcript cues spanning 0s to ${maxCueEnd}s.`
          : `Extracted ${lines.length} lines and ${extractedClaims.length} factual assertion candidate(s).`,
    },
  ];

  // Check overlapping, inverted, or unusually gapped SRT timestamps
  for (let i = 0; i < cues.length; i++) {
    if (cues[i].endSec < cues[i].startSec) {
      indicators.push({
        id: `IND-${evidenceId}-TS-INV-${i}`,
        category: 'Timestamp Integrity',
        severity: 'warning',
        sourceLayer: 'forensic_signal',
        evidenceRef: evidenceId,
        title: `Inverted cue timestamp at #${cues[i].index}`,
        detail: `Cue #${cues[i].index} ends (${cues[i].endSec}s) before it starts (${cues[i].startSec}s).`,
      });
    }
    if (i > 0 && cues[i].startSec < cues[i - 1].endSec - 0.05) {
      indicators.push({
        id: `IND-${evidenceId}-TS-OVL-${i}`,
        category: 'Timestamp Integrity',
        severity: 'info',
        sourceLayer: 'forensic_signal',
        evidenceRef: evidenceId,
        title: `Overlapping subtitle cue #${cues[i].index}`,
        detail: `Starts at ${cues[i].startSec}s before cue #${cues[i - 1].index} ends at ${cues[i - 1].endSec}s.`,
      });
    }
    if (i > 0 && cues[i].startSec - cues[i - 1].endSec > 1.2) {
      indicators.push({
        id: `IND-${evidenceId}-TS-GAP-${i}`,
        category: 'Timestamp Continuity',
        severity: 'info',
        sourceLayer: 'forensic_signal',
        evidenceRef: evidenceId,
        title: `Abrupt cue gap before #${cues[i].index} (${(cues[i].startSec - cues[i - 1].endSec).toFixed(1)}s)`,
        detail: `Interval from ${cues[i - 1].endSec}s to ${cues[i].startSec}s has no transcript cues.`,
      });
    }
  }

  // Deterministic internal claim contradiction check (polarity reversal or conflicting percentages/counts)
  if (extractedClaims.length >= 2) {
    const pctMatches = extractedClaims
      .map((c, idx) => ({ idx, c, m: c.match(/(\d+(?:\.\d+)?)\s*%|\b(\d+(?:\.\d+)?)\s+percent\b/i) }))
      .filter((x) => x.m);
    if (pctMatches.length >= 2) {
      const vals = Array.from(new Set(pctMatches.map((x) => x.m![1] || x.m![2])));
      if (vals.length >= 2) {
        indicators.push({
          id: `IND-${evidenceId}-CLAIM-PCT`,
          category: 'Claim Comparison',
          severity: 'warning',
          sourceLayer: 'forensic_signal',
          evidenceRef: evidenceId,
          title: `Divergent numeric percentages reported (${vals.join('% vs ')}%)`,
          detail: 'Multiple percentage assertions appear within the same document; verify whether they refer to separate periods or contradict each other.',
        });
      }
    }

    const positiveTone = extractedClaims.some((c) => /\b(zero irregularities|normal|approved|confirmed safe|no issues)\b/i.test(c));
    const negativeTone = extractedClaims.some((c) => /\b(suspending|suspended|emergency|breach|violation|irregularities found|halted)\b/i.test(c));
    if (positiveTone && negativeTone) {
      indicators.push({
        id: `IND-${evidenceId}-CLAIM-POL`,
        category: 'Internal Claim Conflict',
        severity: 'warning',
        sourceLayer: 'forensic_signal',
        evidenceRef: evidenceId,
        title: 'Potentially conflicting operational claims within document',
        detail: 'Document asserts both normal/zero-irregularity audit findings and emergency suspension/escalation statements; review context and timestamps.',
      });
    }
  }

  return {
    metrics: {
      format: ext.replace('.', ''),
      characterCount: raw.length,
      wordCount,
      lineCount: lines.length,
      cueCount: cues.length,
      maxTimestampSec: maxCueEnd,
      claimCount: extractedClaims.length,
    },
    rawPreview: plainText.slice(0, 8000),
    cues,
    extractedClaims,
    indicators,
    limitations:
      'Local text parser performs structural, cue-timestamp, numeric/polarity, and assertion extraction. Cross-document semantic contradiction analysis uses Gemini reasoning when available plus human review.',
  };
}
