import fs from 'fs';
import path from 'path';
import PDFDocument from 'pdfkit';
import { ARTIFACTS_DIR, REPORTS_DIR } from '../config.ts';
import { getDb } from '../db/database.ts';

type PDFDoc = InstanceType<typeof PDFDocument>;

interface VerdictPayload {
  label?: string;
  aiRawScorePct?: number | null;
  genuineRawScorePct?: number | null;
  peakRawScorePct?: number | null;
  scoresCalibrated?: boolean;
  scoreBasisLabel?: string;
  reliabilityLevel?: string;
  plainSummary?: string;
}

interface ParsedIndicator {
  id?: string;
  category?: string;
  severity?: string;
  title: string;
  detail: string;
  sourceLayer?: string;
  evidenceRef?: string;
}

const COLORS = {
  navy: '#0F172A',
  slate: '#334155',
  muted: '#64748B',
  border: '#CBD5E1',
  surface: '#F8FAFC',
  blue: '#2563EB',
  cyan: '#0891B2',
  teal: '#0F766E',
  tealBg: '#F0FDFA',
  amber: '#B45309',
  amberBg: '#FFFBEB',
  coral: '#BE123C',
  coralBg: '#FFF1F2',
  indigo: '#4338CA',
};

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function isGenericBoilerplate(text?: string): boolean {
  if (!text || !text.trim()) return true;
  const low = text.toLowerCase();
  return (
    low.includes('consistent with standard baseline compression and spectral profiles') ||
    low.includes('human confirmation is recommended before closure') ||
    low.includes('uncalibrated raw signals requiring investigator review') ||
    low.includes('review completed across uploaded files')
  );
}

function cleanCaveatText(note: string): string {
  return String(note || '')
    .replace(/^(\[OUT-OF-DOMAIN[^\]]*\]\s*)?/i, '$1')
    .replace(/UNCALIBRATED RAW (?:MODEL |HEURISTIC )?SCORE\s*\([^)]*\)\.\s*/gi, '')
    .replace(/\s*—\s*NOT a calibrated probability/gi, '')
    .trim();
}

function describeModelPredictionPlain(
  pred: Record<string, string | number>,
  ev: Record<string, string | number> | undefined,
  metrics: Record<string, unknown>,
  mode: 'simple' | 'advanced',
): string {
  const modelId = String(pred.model_id || '');
  const scorePct = Number((Number(pred.raw_score || 0) * 100).toFixed(1));
  const label = String(pred.prediction_label || '');
  const note = String(pred.uncertainty_note || '');
  const mod = String(ev?.modality || '');
  const faceCount = typeof metrics.faceCount === 'number' ? metrics.faceCount : null;
  const exifPresent = typeof metrics.exifPresent === 'boolean' ? metrics.exifPresent : null;
  const doubleJpeg = Boolean(metrics.doubleJpegSuspected);
  const aiMeta = Boolean(metrics.aiMetadataDetected);
  const elaMean = typeof metrics.elaMean === 'number' ? metrics.elaMean : null;
  const noiseStd = typeof metrics.noiseFloorStd === 'number' ? metrics.noiseFloorStd : null;

  if (modelId.includes('ViT')) {
    const viewContext =
      mod === 'video'
        ? 'sampled keyframes'
        : faceCount !== null && faceCount > 0
        ? `${faceCount} aligned face region(s)`
        : 'full-frame visual textures (no face box detected)';
    const outcome =
      scorePct >= 65
        ? 'matched synthetic blending or AI-generation textures learned during training'
        : scorePct >= 40
        ? 'fell in the borderline zone where subtle edits overlap with normal compression'
        : 'showed minimal synthetic facial or texture anomalies';
    const limit =
      faceCount === 0
        ? 'Limitation: without a detected face crop, face-swap sensitivity drops and background textures drive the score.'
        : doubleJpeg
        ? 'Limitation: multi-save JPEG recompression was detected, which can shift visual scores on genuine photos.'
        : aiMeta
        ? 'Supporting clue: AI software tags were also found in the file metadata.'
        : 'Limitation: trained on portrait deepfake datasets; unseen diffusion generators or non-facial edits may be missed.';
    return `Checked ${viewContext} and ${outcome} (${scorePct}/100). ${limit}`;
  }

  if (modelId.includes('ImgForensics')) {
    const elaPart = elaMean !== null ? `ELA residual mean ${elaMean.toFixed(1)}` : 'compression uniformity';
    const noisePart = noiseStd !== null ? `sensor noise std ${noiseStd.toFixed(1)}` : 'high-frequency noise';
    const outcome =
      scorePct >= 65
        ? `flagged irregular ${elaPart} and ${noisePart}, suggesting possible editing or heavy post-processing`
        : scorePct >= 40
        ? `measured moderate variation in ${elaPart} and ${noisePart}`
        : `observed consistent ${elaPart} and ${noisePart} matching standard single-camera saves`;
    const limit =
      exifPresent === false
        ? 'Limitation: camera EXIF headers are absent, and social-media re-encoding can mimic editing compression.'
        : doubleJpeg
        ? 'Limitation: re-saving through messaging or editing apps alters quantization tables without semantic manipulation.'
        : 'Limitation: pixel compression checks reflect save history rather than direct visual content.';
    return `Measured ${outcome}. ${limit}`;
  }

  if (modelId.includes('AASIST')) {
    const isOod = label === 'inconclusive_review' || note.includes('[OUT-OF-DOMAIN');
    if (isOod) {
      return `Inspected 16 kHz speech windows (${scorePct}/100), but lossy compression, resampling, or ambient noise fell outside the model's clean studio speech domain. Marked inconclusive—compressed web audio frequently triggers false positives on real voices.`;
    }
    const outcome =
      scorePct >= 65
        ? 'detected vocoder or spectral discontinuities associated with synthetic or spliced speech'
        : scorePct >= 40
        ? 'found borderline acoustic variation across sampled 4s windows'
        : 'found steady harmonic structure consistent with natural speech';
    return `Analyzed 16 kHz speech windows and ${outcome} (${scorePct}/100). Limitation: short clips, heavy noise suppression, or non-speech segments reduce reliability.`;
  }

  if (modelId.includes('AudSpoof')) {
    const outcome =
      scorePct >= 65
        ? 'flagged unusual spectral flatness or abrupt energy shifts'
        : scorePct >= 40
        ? 'recorded borderline spectral variance'
        : 'measured balanced frequency energy and natural dynamic range';
    return `Evaluated audio band energy and ${outcome} (${scorePct}/100). Limitation: background noise, microphone clipping, or VoIP codecs can skew spectral thresholds.`;
  }

  return mode === 'advanced' && note
    ? cleanCaveatText(note)
    : `Model score ${scorePct}/100 reflects similarity to training examples rather than calibrated certainty.`;
}

function buildEvidenceSpecificPdfNarrative(params: {
  resultLabel: string;
  evidence: Array<Record<string, string | number>>;
  predictions: Array<Record<string, string | number>>;
  analyses: Array<Record<string, string>>;
  correlations: Array<Record<string, string | number>>;
  aiPct: number | null;
  missingEvidenceList: string[];
}): { page1Summary: string; section1Narrative: string } {
  const { resultLabel, evidence, predictions, analyses, correlations, aiPct, missingEvidenceList } = params;
  const primaryPreds = selectPrimaryPdfPredictions(predictions);
  const modelNames = Array.from(new Set(primaryPreds.map((p) => String(p.model_id))));

  let faceSum = 0;
  let exifPresentCount = 0;
  let exifMissingCount = 0;
  let doubleJpegCount = 0;
  let aiTagCount = 0;
  let imageCount = 0;

  for (const anl of analyses) {
    if (anl.modality === 'image') {
      imageCount++;
      try {
        const m = JSON.parse(anl.metrics_json || '{}');
        faceSum += Number(m.faceCount ?? 0);
        if (m.exifPresent === true) exifPresentCount++;
        if (m.exifPresent === false) exifMissingCount++;
        if (m.doubleJpegSuspected) doubleJpegCount++;
        if (m.aiMetadataDetected) aiTagCount++;
      } catch {
        // ignore parse errors
      }
    }
  }

  const modalitiesList = Array.from(new Set(evidence.map((e) => String(e.modality).toUpperCase())));
  const obsParts: string[] = [];
  if (imageCount > 0) {
    obsParts.push(
      faceSum > 0
        ? `${faceSum} facial region(s) aligned across ${imageCount} image(s)`
        : `full-frame textures checked across ${imageCount} image(s) (no faces detected)`,
    );
    if (exifPresentCount > 0 && exifMissingCount === 0) obsParts.push('camera EXIF metadata intact');
    else if (exifMissingCount > 0) obsParts.push(`camera EXIF missing on ${exifMissingCount} image(s)`);
    if (doubleJpegCount > 0) obsParts.push(`re-saved JPEG tables in ${doubleJpegCount} image(s)`);
    if (aiTagCount > 0) obsParts.push(`AI software metadata found in ${aiTagCount} file(s)`);
  }
  const hasCorConflict = correlations.some(
    (c) => String(c.relationship_type) === 'CONTRADICTS' || String(c.relationship_type) === 'WEAKENS',
  );
  if (hasCorConflict) obsParts.push('cross-file contradictions flagged');

  const limitNotes: string[] = [];
  if (imageCount > 0 && faceSum === 0) limitNotes.push('no face bounding boxes were present for targeted face-swap scoring');
  if (exifMissingCount > 0) limitNotes.push('stripped EXIF headers prevent verifying the original capture device');
  if (doubleJpegCount > 0) limitNotes.push('repeated JPEG compression can alter pixel residuals without manipulation');
  if (missingEvidenceList.length > 0 && limitNotes.length < 2) {
    limitNotes.push('some supporting streams or camera headers were unavailable');
  }

  const modelPhrase =
    modelNames.length > 0
      ? `Trained model(s) (${modelNames.join(', ')})`
      : 'Structural and forensic signal checks';
  const scorePhrase = aiPct !== null ? ` (average pattern score ${aiPct}/100)` : '';
  const obsPhrase = obsParts.length > 0 ? obsParts.join(', ') : `${evidence.length} ${modalitiesList.join('/')} file(s) reviewed`;

  let interpretation =
    'Detected patterns align with natural or camera-captured media, showing minimal synthetic artifacts.';
  if (resultLabel === 'Possibly AI-Generated or Manipulated') {
    interpretation =
      'Multiple detector signals or metadata clues resemble synthetic generation or digital editing; verify original sources before concluding.';
  } else if (resultLabel === 'Inconclusive — Needs Review') {
    interpretation =
      'Measured scores fall in an inconclusive middle range where routine re-encoding, compression, or domain mismatch overlaps with light edits.';
  } else if (primaryPreds.length === 0) {
    interpretation =
      'Structural, timing, and data-quality checks passed without tampering indicators; deepfake media models did not apply to these files.';
  }

  const limitSentence =
    limitNotes.length > 0
      ? `Key limitations: ${limitNotes.join('; ')}.`
      : 'All scores indicate similarity to training patterns rather than calibrated probabilities or factual proof.';

  const predHighlights = primaryPreds.slice(0, 4).map((p) => {
    const ev = evidence.find((e) => String(e.id) === String(p.evidence_id));
    const fname = ev ? String(ev.original_filename) : String(p.evidence_id);
    const sp = Number((Number(p.raw_score || 0) * 100).toFixed(1));
    return `${fname} (${p.model_id}: ${sp}/100)`;
  });

  const page1Summary = `${modelPhrase} reviewed ${evidence.length} file(s)${scorePhrase}. ${interpretation}`;
  const section1Narrative = `${
    predHighlights.length > 0
      ? `Model findings by file: ${predHighlights.join('; ')}. `
      : ''
  }Observed forensic context: ${obsPhrase}. ${limitSentence}`;

  return { page1Summary, section1Narrative };
}

function translateIndicatorPlain(ind: ParsedIndicator): { title: string; detail: string } {
  const lower = `${ind.title} ${ind.category || ''} ${ind.detail}`.toLowerCase();
  const detailClean = String(ind.detail || '').trim();
  if (lower.includes('double-jpeg') || lower.includes('recompression') || lower.includes('quantization')) {
    return {
      title: 'Saved or Re-encoded Multiple Times',
      detail: detailClean
        ? `${detailClean} Multiple saves commonly occur during editing or sharing through messaging apps.`
        : 'The file shows signs of multiple JPEG saves, common after editing or sharing via messaging apps.',
    };
  }
  if (lower.includes('ela') || lower.includes('tile variance') || lower.includes('residual')) {
    return {
      title: ind.severity === 'info' ? 'Uniform Image Compression' : 'Uneven Compression Region Found',
      detail:
        ind.severity === 'info'
          ? detailClean || 'Error-level compression appears consistent across the frame without obvious pasted zones.'
          : detailClean || 'One region compresses differently than surrounding pixels, which can indicate localized editing.',
    };
  }
  if (lower.includes('ai software') || lower.includes('c2pa') || lower.includes('metadata') || lower.includes('exif')) {
    return {
      title:
        ind.severity === 'warning' || ind.severity === 'critical'
          ? 'Missing Camera Details or AI Software Tag'
          : 'Camera Information Present',
      detail: detailClean
        ? detailClean
        : ind.severity === 'info'
        ? 'Standard camera details (device make/model) were preserved in the file header.'
        : 'Camera EXIF tags were absent or stripped during export or synthetic generation.',
    };
  }
  if (lower.includes('noise') || lower.includes('block artifact')) {
    return {
      title: ind.severity === 'info' ? 'Consistent Sensor Grain' : 'Unusual Pixel Texture or Grid Pattern',
      detail: detailClean
        ? detailClean
        : ind.severity === 'info'
        ? 'Background pixel noise appears natural and consistent across the image.'
        : 'Pixel texture appears unusually smooth or blocky compared to a typical unedited camera image.',
    };
  }
  if (lower.includes('temporal') || lower.includes('luma') || lower.includes('frame')) {
    return {
      title: ind.severity === 'info' ? 'Smooth Video Motion' : 'Sudden Change Between Video Frames',
      detail: detailClean
        ? detailClean
        : ind.severity === 'info'
        ? 'Sampled keyframes transition smoothly without abrupt pixel jumps.'
        : 'One or more sampled video timestamps show abrupt frame-to-frame changes.',
    };
  }
  if (
    lower.includes('clipping') ||
    lower.includes('flatness') ||
    lower.includes('spectral') ||
    lower.includes('silence') ||
    lower.includes('spoof') ||
    lower.includes('aasist')
  ) {
    return {
      title: ind.severity === 'info' ? 'Steady Audio Sound Profile' : 'Unusual Sound Pattern Detected',
      detail: detailClean
        ? detailClean
        : ind.severity === 'info'
        ? 'Audio loudness and frequency distribution look steady.'
        : 'Segments contain unusually flat frequencies, clipping, or abrupt energy changes.',
    };
  }
  if (lower.includes('subtitle') || lower.includes('srt') || lower.includes('gap') || lower.includes('contradict')) {
    return {
      title: ind.severity === 'info' ? 'Text & Timestamps Consistent' : 'Timing or Wording Mismatch',
      detail: detailClean
        ? detailClean
        : ind.severity === 'info'
        ? 'Text structure and timestamps are internally consistent.'
        : 'Text cues or claims conflict with other files in this investigation.',
    };
  }
  return { title: ind.title, detail: detailClean };
}

function translateRelationPlain(rel: string): string {
  if (rel === 'CONTRADICTS') return 'Conflict Found';
  if (rel === 'WEAKENS') return 'Minor Difference';
  if (rel === 'SUPPORTS') return 'Consistent Match';
  return 'Same Length Only (Unverified Content)';
}

function ensureSpace(doc: PDFDoc, neededHeight: number): void {
  const bottomLimit = doc.page.height - 62;
  if (doc.y + neededHeight > bottomLimit) {
    doc.addPage();
    doc.y = 58;
  }
}

function drawSectionHeading(doc: PDFDoc, num: string, title: string, subtitle?: string): void {
  ensureSpace(doc, 46);
  doc.moveDown(0.5);
  const y = doc.y;
  doc.font('Helvetica-Bold').fontSize(12.5).fillColor(COLORS.navy).text(`${num}. ${title}`, 48, y);
  if (subtitle) {
    doc.font('Helvetica').fontSize(8.5).fillColor(COLORS.muted).text(subtitle, 48, doc.y + 1);
  }
  doc.moveTo(48, doc.y + 4).lineTo(547, doc.y + 4).lineWidth(0.75).strokeColor(COLORS.border).stroke();
  doc.y += 10;
}

function drawHorizontalBar(
  doc: PDFDoc,
  x: number,
  y: number,
  width: number,
  height: number,
  pct: number,
  fillColor: string,
  trackColor = '#E2E8F0',
): void {
  const clamped = Math.max(0, Math.min(100, pct));
  doc.save();
  doc.roundedRect(x, y, width, height, 3).fill(trackColor);
  if (clamped > 0) {
    const fillW = Math.max(4, (width * clamped) / 100);
    doc.roundedRect(x, y, fillW, height, 3).fill(fillColor);
  }
  doc.restore();
}

function selectPrimaryPdfPredictions(
  preds: Array<Record<string, string | number>>,
): Array<Record<string, string | number>> {
  const byEv = new Map<string, Array<Record<string, string | number>>>();
  for (const p of preds) {
    const id = String(p.evidence_id);
    const arr = byEv.get(id) || [];
    arr.push(p);
    byEv.set(id, arr);
  }
  const out: Array<Record<string, string | number>> = [];
  for (const evPreds of byEv.values()) {
    const vit = evPreds.find((p) => String(p.model_id).includes('ViT'));
    const imgFallback = evPreds.filter((p) => String(p.model_id).includes('ImgForensics'));
    if (vit) out.push(vit);
    else out.push(...imgFallback);

    const aasist = evPreds.find((p) => String(p.model_id).includes('AASIST'));
    const audFallback = evPreds.filter((p) => String(p.model_id).includes('AudSpoof'));
    if (aasist) out.push(aasist);
    else out.push(...audFallback);

    const others = evPreds.filter((p) => {
      const mid = String(p.model_id);
      return (
        !mid.includes('ViT') &&
        !mid.includes('ImgForensics') &&
        !mid.includes('AASIST') &&
        !mid.includes('AudSpoof')
      );
    });
    out.push(...others);
  }
  return out;
}

export async function generateInvestigationPdf(
  investigationId: string,
  reportId: string,
  mode: 'simple' | 'advanced' = 'simple',
): Promise<string> {
  const db = getDb();
  const inv = db.prepare(`SELECT * FROM investigations WHERE id = ?`).get(investigationId) as
    | Record<string, string>
    | undefined;
  const report = db.prepare(`SELECT * FROM investigation_reports WHERE id = ?`).get(reportId) as
    | Record<string, string>
    | undefined;
  if (!inv || !report || report.investigation_id !== inv.id) {
    throw new Error('Investigation or report not found for the requested case');
  }

  const evidence = db
    .prepare(`SELECT * FROM evidence WHERE investigation_id = ? ORDER BY uploaded_at ASC`)
    .all(investigationId) as Array<Record<string, string | number>>;
  const predictions = db
    .prepare(`SELECT * FROM model_predictions WHERE investigation_id = ?`)
    .all(investigationId) as Array<Record<string, string | number>>;
  const correlations = db
    .prepare(`SELECT * FROM evidence_correlations WHERE investigation_id = ?`)
    .all(investigationId) as Array<Record<string, string | number>>;
  const analyses = db
    .prepare(`SELECT * FROM forensic_analyses WHERE investigation_id = ?`)
    .all(investigationId) as Array<Record<string, string>>;
  const agentExecs = db
    .prepare(`SELECT * FROM agent_executions WHERE investigation_id = ? ORDER BY started_at ASC`)
    .all(investigationId) as Array<Record<string, string>>;

  const reportData = JSON.parse(report.report_json || '{}');
  const verdict: VerdictPayload = reportData.verdict || {};
  const missingEvidenceList: string[] = Array.isArray(reportData.missingEvidence) ? reportData.missingEvidence : [];
  const filename = `${inv.case_code}_${reportId}_${mode}.pdf`;
  const pdfPath = path.join(REPORTS_DIR, filename);

  // Derive Page 1 result details faithfully from persisted data
  const resultLabel =
    verdict.label ||
    (inv.confidence_level === 'requires_review'
      ? 'Possibly AI-Generated or Manipulated'
      : inv.confidence_level === 'low_anomaly'
      ? 'Likely Genuine'
      : 'Inconclusive — Needs Review');

  const aiPct = typeof verdict.aiRawScorePct === 'number' ? verdict.aiRawScorePct : null;
  const genuinePct =
    typeof verdict.genuineRawScorePct === 'number'
      ? verdict.genuineRawScorePct
      : aiPct !== null
      ? Number((100 - aiPct).toFixed(1))
      : null;

  const reliabilityLevel = verdict.reliabilityLevel || (aiPct !== null ? 'Moderate' : 'Limited');
  const resultColors =
    resultLabel === 'Possibly AI-Generated or Manipulated'
      ? { fg: COLORS.coral, bg: COLORS.coralBg, border: '#FECDD3' }
      : resultLabel === 'Inconclusive — Needs Review'
      ? { fg: COLORS.amber, bg: COLORS.amberBg, border: '#FDE68A' }
      : { fg: COLORS.teal, bg: COLORS.tealBg, border: '#99F6E4' };

  const evById = new Map(evidence.map((e) => [String(e.id), e]));

  // Aggregate indicator counts & parsed artifacts
  const allIndicators: Array<ParsedIndicator & { evidenceId: string; filename: string; modality: string }> = [];
  const sampleFramesForChart: Array<{ timestampSec: number; temporalDelta: number; mlScorePct: number | null; flagged: boolean }> = [];
  const audioSegmentsForChart: Array<{ startSec: number; endSec: number; flatness: number; flagged: boolean }> = [];
  const elaImagePaths: Array<{ filename: string; filePath: string }> = [];
  const keyframeImagePaths: Array<{ label: string; filePath: string }> = [];

  for (const anl of analyses) {
    const ev = evById.get(anl.evidence_id);
    const evName = ev ? String(ev.original_filename) : anl.evidence_id;
    const inds = JSON.parse(anl.indicators_json || '[]') as ParsedIndicator[];
    for (const ind of inds) {
      allIndicators.push({ ...ind, evidenceId: anl.evidence_id, filename: evName, modality: anl.modality });
    }
    const arts = JSON.parse(anl.artifacts_json || '{}');
    if (anl.modality === 'image' && arts.elaUrl) {
      const elaRel = path.basename(String(arts.elaUrl));
      const candidate = path.join(ARTIFACTS_DIR, elaRel);
      if (fs.existsSync(candidate) && elaImagePaths.length < 2) {
        elaImagePaths.push({ filename: evName, filePath: candidate });
      }
    }
    if (anl.modality === 'video' && Array.isArray(arts.sampledFrames)) {
      for (const fr of arts.sampledFrames as Array<{
        index: number;
        timestampSec: number;
        temporalDelta: number;
        mlScore?: number;
        flagged?: boolean;
        frameUrl?: string;
      }>) {
        if (sampleFramesForChart.length < 24) {
          sampleFramesForChart.push({
            timestampSec: Number(fr.timestampSec || 0),
            temporalDelta: Number(fr.temporalDelta || 0),
            mlScorePct: typeof fr.mlScore === 'number' ? Number((fr.mlScore * 100).toFixed(1)) : null,
            flagged: Boolean(fr.flagged),
          });
        }
        if (fr.frameUrl && keyframeImagePaths.length < 3 && (fr.flagged || keyframeImagePaths.length < 2)) {
          const cleanUrl = String(fr.frameUrl).replace(/^\/api\/artifacts\//, '').replace(/^\/artifacts\//, '');
          const candidate = path.join(ARTIFACTS_DIR, cleanUrl);
          if (fs.existsSync(candidate)) {
            keyframeImagePaths.push({ label: `${fr.timestampSec}s`, filePath: candidate });
          }
        }
      }
      if (arts.embeddedAudio && Array.isArray(arts.embeddedAudio.segments)) {
        for (const seg of arts.embeddedAudio.segments as Array<{
          startSec: number;
          endSec: number;
          spectralFlatness: number;
          flagged?: boolean;
        }>) {
          if (audioSegmentsForChart.length < 16) {
            audioSegmentsForChart.push({
              startSec: Number(seg.startSec || 0),
              endSec: Number(seg.endSec || 0),
              flatness: Number(seg.spectralFlatness || 0),
              flagged: Boolean(seg.flagged),
            });
          }
        }
      }
    }
    if (anl.modality === 'audio' && Array.isArray(arts.segments)) {
      for (const seg of arts.segments as Array<{
        startSec: number;
        endSec: number;
        spectralFlatness: number;
        flagged?: boolean;
      }>) {
        if (audioSegmentsForChart.length < 16) {
          audioSegmentsForChart.push({
            startSec: Number(seg.startSec || 0),
            endSec: Number(seg.endSec || 0),
            flatness: Number(seg.spectralFlatness || 0),
            flagged: Boolean(seg.flagged),
          });
        }
      }
    }
  }

  const criticalCount = allIndicators.filter((i) => i.severity === 'critical').length;
  const warningCount = allIndicators.filter((i) => i.severity === 'warning').length;
  const infoCount = allIndicators.filter((i) => i.severity !== 'critical' && i.severity !== 'warning').length;

  await new Promise<void>((resolve, reject) => {
    const doc = new PDFDocument({
      margin: 48,
      size: 'A4',
      bufferPages: true,
      info: {
        Title: `TruthLens AI Investigation Report — ${inv.title}`,
        Author: 'TruthLens AI Digital Investigation Platform',
      },
    });
    const stream = fs.createWriteStream(pdfPath);
    doc.pipe(stream);

    // =========================================================================
    // PAGE 1 — CLEAN PLAIN-ENGLISH EXECUTIVE OVERVIEW
    // =========================================================================
    doc.rect(0, 0, doc.page.width, 74).fill(COLORS.navy);
    doc.font('Helvetica-Bold').fontSize(15).fillColor('#FFFFFF').text('TRUTHLENS AI', 48, 22);
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor('#94A3B8')
      .text(
        mode === 'advanced'
          ? 'Technical Digital Forensics Investigation Dossier (Advanced Mode)'
          : 'Media Authenticity & Plain-English Summary Report (Simple Mode)',
        48,
        41,
      );
    doc
      .font('Helvetica')
      .fontSize(8.5)
      .fillColor('#CBD5E1')
      .text(`Case ${inv.case_code}  |  ${mode.toUpperCase()}  |  ${new Date().toLocaleDateString()}`, 300, 26, {
        width: 247,
        align: 'right',
      });

    doc.y = 92;

    // Investigation Name & Uploaded Files
    doc.font('Helvetica-Bold').fontSize(17).fillColor(COLORS.navy).text(inv.title, 48, doc.y, { width: 499 });
    doc.moveDown(0.35);
    const uploadedNames = evidence.map((e) => `${e.original_filename} (${String(e.modality).toUpperCase()})`);
    doc
      .font('Helvetica')
      .fontSize(9.5)
      .fillColor(COLORS.slate)
      .text(
        `Files Checked (${evidence.length}): ${uploadedNames.length > 0 ? uploadedNames.join(', ') : 'None attached'}`,
        48,
        doc.y,
        { width: 499 },
      );

    doc.moveDown(0.7);

    // Pre-build evidence-specific summaries (automatically upgrades legacy generic boilerplate)
    const { page1Summary, section1Narrative } = buildEvidenceSpecificPdfNarrative({
      resultLabel,
      evidence,
      predictions,
      analyses,
      correlations,
      aiPct,
      missingEvidenceList,
    });
    const rawStoredPlain = verdict.plainSummary || inv.assessment_summary;
    const rawStoredExec = report.executive_summary;
    const shortExplanation = !isGenericBoilerplate(rawStoredPlain) ? String(rawStoredPlain) : page1Summary;
    const execSummaryText =
      !isGenericBoilerplate(rawStoredExec) && String(rawStoredExec).trim() !== shortExplanation.trim()
        ? String(rawStoredExec)
        : section1Narrative;

    const analysisMetricsByEv = new Map<string, Record<string, unknown>>();
    for (const anl of analyses) {
      try {
        analysisMetricsByEv.set(String(anl.evidence_id), JSON.parse(anl.metrics_json || '{}'));
      } catch {
        // ignore
      }
    }

    // Overall Result Highlight Box on Page 1 (dynamically sized for wrapped explanation)
    const cardTop = doc.y;
    doc.font('Helvetica').fontSize(9.5);
    const shortTextH = doc.heightOfString(shortExplanation, { width: 467, lineGap: 2 });
    const barsSectionH = aiPct !== null ? 54 : 26;
    const cardHeight = Math.max(114, 58 + shortTextH + 10 + barsSectionH);
    doc.roundedRect(48, cardTop, 499, cardHeight, 6).fillAndStroke(resultColors.bg, resultColors.border);

    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(COLORS.muted).text('OVERALL RESULT', 64, cardTop + 14);
    doc.font('Helvetica-Bold').fontSize(17).fillColor(resultColors.fg).text(resultLabel, 64, cardTop + 27);

    doc
      .font('Helvetica-Bold')
      .fontSize(9)
      .fillColor(COLORS.slate)
      .text(`Evidence Confidence: ${reliabilityLevel}`, 335, cardTop + 18, { width: 196, align: 'right' });

    doc
      .font('Helvetica')
      .fontSize(9.5)
      .fillColor(COLORS.navy)
      .text(shortExplanation, 64, cardTop + 54, { width: 467, lineGap: 2 });

    if (aiPct !== null && genuinePct !== null) {
      const barY = cardTop + 58 + shortTextH + 8;
      doc
        .font('Helvetica-Bold')
        .fontSize(8.5)
        .fillColor(COLORS.coral)
        .text(`Synthetic / Manipulation Pattern Score: ${aiPct} / 100`, 64, barY);
      drawHorizontalBar(doc, 64, barY + 12, 215, 9, aiPct, COLORS.coral);

      doc
        .font('Helvetica-Bold')
        .fontSize(8.5)
        .fillColor(COLORS.teal)
        .text(`Genuine Pattern Score: ${genuinePct} / 100`, 300, barY);
      drawHorizontalBar(doc, 300, barY + 12, 231, 9, genuinePct, COLORS.teal);

      doc
        .font('Helvetica')
        .fontSize(7.5)
        .fillColor(COLORS.muted)
        .text(
          'Scores reflect how closely patterns match training data (0–100 scale), not factual certainty or probability.',
          64,
          barY + 27,
          { width: 467 },
        );
    } else {
      doc
        .font('Helvetica')
        .fontSize(8)
        .fillColor(COLORS.muted)
        .text(
          'Deepfake media scores do not apply because only text or structured dataset files were submitted.',
          64,
          cardTop + 58 + shortTextH + 6,
          { width: 467 },
        );
    }

    doc.y = cardTop + cardHeight + 14;

    // =========================================================================
    // SECTION 1: QUICK SUMMARY
    // =========================================================================
    drawSectionHeading(doc, '1', 'Quick Summary', 'Model detections, forensic context, and key confidence limits');
    doc
      .font('Helvetica')
      .fontSize(9.5)
      .fillColor(COLORS.navy)
      .text(execSummaryText, 48, doc.y, { width: 499, lineGap: 2 });
    doc.moveDown(0.4);
    doc
      .font('Helvetica-Bold')
      .fontSize(9)
      .fillColor(COLORS.slate)
      .text(`Human Reviewer Status: `, 48, doc.y, { continued: true })
      .font('Helvetica')
      .fillColor(COLORS.navy)
      .text(report.human_conclusion || 'Pending human review.');

    if (reportData.overview && reportData.overview.datasetCount > 0) {
      const ov = reportData.overview;
      const qs = reportData.qualityScores || {};
      doc.moveDown(0.35);
      doc
        .font('Helvetica')
        .fontSize(9)
        .fillColor(COLORS.slate)
        .text(
          `Dataset Summary: ${ov.totalRows ?? 0} rows across ${ov.totalColumns ?? 0} columns inspected; quality improved from ${
            qs.beforeQualityScore ?? '—'
          }/100 to ${qs.afterQualityScore ?? '—'}/100 after automated cleanup.`,
          48,
          doc.y,
          { width: 499 },
        );
    }

    // =========================================================================
    // SECTION 2: FILES ANALYSED
    // =========================================================================
    drawSectionHeading(doc, '2', 'Files Analysed', 'All images, videos, audio clips, text files, and datasets reviewed');
    ensureSpace(doc, 28);
    const tblTop = doc.y;
    doc.rect(48, tblTop, 499, 20).fill('#F1F5F9');
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(COLORS.slate);
    doc.text('File Name', 56, tblTop + 6, { width: 225 });
    doc.text('Type', 288, tblTop + 6, { width: 70 });
    doc.text('File Size', 364, tblTop + 6, { width: 75, align: 'right' });
    doc.text('Status', 450, tblTop + 6, { width: 90, align: 'right' });
    doc.y = tblTop + 22;

    for (const ev of evidence) {
      ensureSpace(doc, 22);
      const rowY = doc.y;
      doc.font('Helvetica').fontSize(8.5).fillColor(COLORS.navy).text(String(ev.original_filename), 56, rowY + 3, {
        width: 225,
        ellipsis: true,
      });
      doc.font('Helvetica').fontSize(8.5).fillColor(COLORS.slate).text(String(ev.modality).toUpperCase(), 288, rowY + 3, {
        width: 70,
      });
      doc.text(formatFileSize(Number(ev.file_size || 0)), 364, rowY + 3, { width: 75, align: 'right' });
      const evStatus = String(ev.status || '').toLowerCase();
      const statusText = evStatus === 'analyzed' ? 'Checked' : evStatus === 'failed' ? 'Failed' : 'Incomplete';
      const statusColor = evStatus === 'analyzed' ? COLORS.teal : evStatus === 'failed' ? COLORS.coral : COLORS.amber;
      doc.fillColor(statusColor).text(statusText, 450, rowY + 3, { width: 90, align: 'right' });
      doc.moveTo(48, rowY + 18).lineTo(547, rowY + 18).lineWidth(0.5).strokeColor('#E2E8F0').stroke();
      doc.y = rowY + 20;
    }

    // =========================================================================
    // SECTION 3: DETECTION RESULTS
    // =========================================================================
    drawSectionHeading(
      doc,
      '3',
      'Detection Results',
      'What each trained model inspected, detected patterns, and result limitations',
    );
    if (predictions.length === 0 && (!reportData.beforeAfterComparisons || reportData.beforeAfterComparisons.length === 0)) {
      doc
        .font('Helvetica')
        .fontSize(9)
        .fillColor(COLORS.muted)
        .text('No automated media deepfake detectors were needed for these files.', 48, doc.y);
    } else {
      const displayPreds = mode === 'simple' ? selectPrimaryPdfPredictions(predictions) : predictions;
      for (const pred of displayPreds) {
        const ev = evById.get(String(pred.evidence_id));
        const evLabel = ev ? String(ev.original_filename) : String(pred.evidence_id);
        const pct = Number((Number(pred.raw_score || 0) * 100).toFixed(1));
        const friendlyRole = String(pred.model_id).includes('ViT')
          ? 'Visual AI Pattern Check'
          : String(pred.model_id).includes('AASIST')
          ? 'Voice Spoofing Neural Check'
          : String(pred.model_id).includes('RF')
          ? 'Texture & Compression Check'
          : String(pred.model_id).includes('AudSpoof')
          ? 'Sound Spectrum Check'
          : 'Baseline Statistical Check';
        const barColor = pct >= 65 ? COLORS.coral : pct >= 40 ? COLORS.amber : COLORS.teal;
        const evMetrics = analysisMetricsByEv.get(String(pred.evidence_id)) || {};
        const plainFinding = describeModelPredictionPlain(pred, ev, evMetrics, mode);

        doc.font('Helvetica').fontSize(8);
        const findingH = doc.heightOfString(plainFinding, { width: 499, lineGap: 1.5 });
        ensureSpace(doc, 30 + findingH);

        const y = doc.y;
        doc
          .font('Helvetica-Bold')
          .fontSize(9)
          .fillColor(COLORS.navy)
          .text(`${evLabel} — ${friendlyRole}`, 48, y, { width: 340, ellipsis: true });
        doc
          .font('Helvetica-Bold')
          .fontSize(9)
          .fillColor(barColor)
          .text(`Pattern Score: ${pct} / 100`, 400, y, { width: 147, align: 'right' });
        drawHorizontalBar(doc, 48, y + 14, 499, 7, pct, barColor);
        doc
          .font('Helvetica')
          .fontSize(8)
          .fillColor(COLORS.slate)
          .text(plainFinding, 48, y + 24, { width: 499, lineGap: 1.5 });
        doc.y = y + 28 + findingH + 6;
      }

      if (Array.isArray(reportData.beforeAfterComparisons) && reportData.beforeAfterComparisons.length > 0) {
        ensureSpace(doc, 26);
        doc.font('Helvetica-Bold').fontSize(9.5).fillColor(COLORS.navy).text('Dataset Cleaning Improvements:', 48, doc.y + 4);
        doc.y += 16;
        for (const cmp of reportData.beforeAfterComparisons as Array<{
          metric: string;
          before: number;
          after: number;
          unit: string;
        }>) {
          ensureSpace(doc, 16);
          doc
            .font('Helvetica')
            .fontSize(8.5)
            .fillColor(COLORS.slate)
            .text(`• ${cmp.metric}: Before ${cmp.before} ${cmp.unit} -> After ${cmp.after} ${cmp.unit}`, 56, doc.y);
          doc.y += 13;
        }
      }
    }

    // =========================================================================
    // SECTION 4: WHY WAS IT FLAGGED?
    // =========================================================================
    drawSectionHeading(
      doc,
      '4',
      'Why Was It Flagged?',
      'Plain-English explanation of notable clues and innocent alternative causes',
    );
    const flaggedIndicators = allIndicators.filter((i) => i.severity === 'critical' || i.severity === 'warning');
    const itemsToShow = flaggedIndicators.length > 0 ? flaggedIndicators.slice(0, 10) : allIndicators.slice(0, 6);
    if (itemsToShow.length === 0) {
      doc.font('Helvetica').fontSize(9).fillColor(COLORS.muted).text('No suspicious flags were raised.', 48, doc.y);
    } else {
      for (const ind of itemsToShow) {
        const plain = translateIndicatorPlain(ind);
        ensureSpace(doc, 38);
        const y = doc.y;
        const badgeColor =
          ind.severity === 'critical' ? COLORS.coral : ind.severity === 'warning' ? COLORS.amber : COLORS.teal;
        const sevWord = ind.severity === 'critical' ? 'HIGH' : ind.severity === 'warning' ? 'CHECK' : 'INFO';
        doc.font('Helvetica-Bold').fontSize(8.5).fillColor(badgeColor).text(`[${sevWord}]`, 48, y);
        doc
          .font('Helvetica-Bold')
          .fontSize(9)
          .fillColor(COLORS.navy)
          .text(`${plain.title} (${ind.filename})`, 92, y, { width: 455 });
        doc
          .font('Helvetica')
          .fontSize(8.5)
          .fillColor(COLORS.slate)
          .text(plain.detail, 92, doc.y + 1, { width: 455 });
        doc.moveDown(0.35);
      }
    }

    const alts: string[] = reportData.alternativeExplanations || [];
    if (alts.length > 0) {
      ensureSpace(doc, 40);
      doc.moveDown(0.2);
      doc
        .font('Helvetica-Bold')
        .fontSize(9.5)
        .fillColor(COLORS.amber)
        .text('Common Innocent Reasons These Clues Appear:', 48, doc.y);
      doc.moveDown(0.25);
      for (const alt of alts.slice(0, 4)) {
        ensureSpace(doc, 18);
        doc.font('Helvetica').fontSize(8.5).fillColor(COLORS.slate).text(`• ${alt}`, 56, doc.y, { width: 490 });
        doc.moveDown(0.15);
      }
    }

    // =========================================================================
    // SECTION 5: VISUAL ANALYSIS
    // =========================================================================
    drawSectionHeading(
      doc,
      '5',
      'Visual Analysis',
      'Real-data charts, suspicious timelines, and extracted evidence previews',
    );

    // Chart A: Indicator Severity Breakdown + Modality Scores Side-by-Side
    ensureSpace(doc, 128);
    const chartsY = doc.y;
    doc.roundedRect(48, chartsY, 240, 114, 5).fillAndStroke(COLORS.surface, COLORS.border);
    doc
      .font('Helvetica-Bold')
      .fontSize(9)
      .fillColor(COLORS.navy)
      .text('Indicator Severity Breakdown', 60, chartsY + 10);
    const maxSev = Math.max(1, criticalCount, warningCount, infoCount);
    const sevRows = [
      { label: 'High Priority', count: criticalCount, color: COLORS.coral },
      { label: 'Needs Review', count: warningCount, color: COLORS.amber },
      { label: 'Normal / Info', count: infoCount, color: COLORS.teal },
    ];
    sevRows.forEach((sr, idx) => {
      const ry = chartsY + 32 + idx * 24;
      doc.font('Helvetica').fontSize(8).fillColor(COLORS.slate).text(sr.label, 60, ry);
      doc.font('Helvetica-Bold').fontSize(8).fillColor(COLORS.navy).text(String(sr.count), 255, ry, {
        width: 22,
        align: 'right',
      });
      drawHorizontalBar(doc, 60, ry + 11, 217, 6, (sr.count / maxSev) * 100, sr.color);
    });

    // Right chart: Modality Score Comparison OR Genuine vs AI Raw Comparison
    doc.roundedRect(307, chartsY, 240, 114, 5).fillAndStroke(COLORS.surface, COLORS.border);
    doc
      .font('Helvetica-Bold')
      .fontSize(9)
      .fillColor(COLORS.navy)
      .text('Model Signal by Media Type', 319, chartsY + 10);

    const primaryChartPreds = selectPrimaryPdfPredictions(predictions);
    const modGroups: Array<{ label: string; scorePct: number }> = [];
    for (const mod of ['image', 'video', 'audio']) {
      const modPreds = primaryChartPreds.filter((p) => {
        const ev = evById.get(String(p.evidence_id));
        return ev && String(ev.modality) === mod;
      });
      if (modPreds.length > 0) {
        const avg = (modPreds.reduce((s, p) => s + Number(p.raw_score || 0), 0) / modPreds.length) * 100;
        modGroups.push({ label: mod.toUpperCase(), scorePct: Number(avg.toFixed(1)) });
      }
    }
    if (modGroups.length === 0) {
      doc
        .font('Helvetica')
        .fontSize(8.5)
        .fillColor(COLORS.muted)
        .text('No image, video, or audio model scores in this case.', 319, chartsY + 46, { width: 215 });
    } else {
      modGroups.forEach((mg, idx) => {
        const ry = chartsY + 32 + idx * 24;
        const c = mg.scorePct >= 65 ? COLORS.coral : mg.scorePct >= 40 ? COLORS.amber : COLORS.blue;
        doc.font('Helvetica').fontSize(8).fillColor(COLORS.slate).text(mg.label, 319, ry);
        doc.font('Helvetica-Bold').fontSize(8).fillColor(c).text(`${mg.scorePct} / 100`, 470, ry, {
          width: 64,
          align: 'right',
        });
        drawHorizontalBar(doc, 319, ry + 11, 215, 6, mg.scorePct, c);
      });
    }
    doc.y = chartsY + 124;

    // Chart B: Video Timestamp Timeline if present
    if (sampleFramesForChart.length > 0) {
      ensureSpace(doc, 108);
      const vy = doc.y;
      doc.roundedRect(48, vy, 499, 98, 5).fillAndStroke(COLORS.surface, COLORS.border);
      doc
        .font('Helvetica-Bold')
        .fontSize(9)
        .fillColor(COLORS.navy)
        .text('Video Frame-by-Frame Anomaly Timeline (Sampled Timestamps)', 60, vy + 10);
      const maxDelta = Math.max(10, ...sampleFramesForChart.map((f) => f.temporalDelta));
      const plotW = 468;
      const barW = Math.max(6, Math.min(18, Math.floor(plotW / sampleFramesForChart.length) - 3));
      sampleFramesForChart.forEach((fr, idx) => {
        const bx = 62 + idx * ((plotW - barW) / Math.max(1, sampleFramesForChart.length - 1));
        const val = fr.mlScorePct !== null ? fr.mlScorePct : (fr.temporalDelta / maxDelta) * 100;
        const bh = Math.max(4, (Math.min(100, val) / 100) * 44);
        const by = vy + 74 - bh;
        doc.rect(bx, by, barW, bh).fill(fr.flagged ? COLORS.coral : COLORS.cyan);
        if (idx === 0 || idx === sampleFramesForChart.length - 1 || fr.flagged) {
          doc
            .font('Helvetica')
            .fontSize(6.5)
            .fillColor(COLORS.muted)
            .text(`${fr.timestampSec}s`, bx - 4, vy + 78, { width: barW + 12, align: 'center' });
        }
      });
      doc.y = vy + 106;
    }

    // Chart C: Audio Segment Anomaly Timeline if present
    if (audioSegmentsForChart.length > 0) {
      ensureSpace(doc, 96);
      const ay = doc.y;
      doc.roundedRect(48, ay, 499, 86, 5).fillAndStroke(COLORS.surface, COLORS.border);
      doc
        .font('Helvetica-Bold')
        .fontSize(9)
        .fillColor(COLORS.navy)
        .text('Audio Segment Spectral Flatness Timeline (Red = Flagged Window)', 60, ay + 10);
      const plotW = 468;
      const barW = Math.max(10, Math.min(28, Math.floor(plotW / audioSegmentsForChart.length) - 4));
      audioSegmentsForChart.forEach((seg, idx) => {
        const bx = 62 + idx * ((plotW - barW) / Math.max(1, audioSegmentsForChart.length - 1));
        const bh = Math.max(4, Math.min(1, seg.flatness) * 38);
        const by = ay + 64 - bh;
        doc.rect(bx, by, barW, bh).fill(seg.flagged ? COLORS.coral : COLORS.teal);
        doc
          .font('Helvetica')
          .fontSize(6.5)
          .fillColor(COLORS.muted)
          .text(`${seg.startSec}s`, bx - 4, ay + 68, { width: barW + 10, align: 'center' });
      });
      doc.y = ay + 94;
    }

    // Embedded Visual Evidence Thumbnails (ELA PNG + Video Keyframe JPGs)
    if (elaImagePaths.length > 0 || keyframeImagePaths.length > 0) {
      ensureSpace(doc, 130);
      const imgTop = doc.y;
      doc
        .font('Helvetica-Bold')
        .fontSize(9)
        .fillColor(COLORS.navy)
        .text('Generated Visual Inspection Maps & Sampled Video Frames:', 48, imgTop);
      let cursorX = 48;
      const thumbY = imgTop + 16;
      for (const ela of elaImagePaths) {
        try {
          doc.image(ela.filePath, cursorX, thumbY, { fit: [145, 92] });
          doc
            .font('Helvetica')
            .fontSize(7.5)
            .fillColor(COLORS.muted)
            .text(`ELA Map: ${ela.filename.slice(0, 22)}`, cursorX, thumbY + 95, { width: 145 });
          cursorX += 160;
        } catch {
          // skip unreadable image safely
        }
      }
      for (const kf of keyframeImagePaths) {
        if (cursorX + 110 > 547) break;
        try {
          doc.image(kf.filePath, cursorX, thumbY, { fit: [105, 82] });
          doc
            .font('Helvetica')
            .fontSize(7.5)
            .fillColor(COLORS.muted)
            .text(`Frame @ ${kf.label}`, cursorX, thumbY + 86, { width: 105 });
          cursorX += 116;
        } catch {
          // skip unreadable frame safely
        }
      }
      doc.y = thumbY + 114;
    }

    // =========================================================================
    // SECTION 6: EVIDENCE COMPARISON
    // =========================================================================
    drawSectionHeading(
      doc,
      '6',
      'Evidence Comparison',
      'How uploaded images, videos, audio, and text agree or contradict each other',
    );
    if (correlations.length === 0) {
      doc
        .font('Helvetica')
        .fontSize(9)
        .fillColor(COLORS.muted)
        .text('Only one file was uploaded or no cross-file links were recorded.', 48, doc.y);
    } else {
      for (const cor of correlations) {
        ensureSpace(doc, 32);
        const src = evById.get(String(cor.source_evidence_id));
        const tgt = evById.get(String(cor.target_evidence_id));
        const rel = String(cor.relationship_type);
        const relColor =
          rel === 'CONTRADICTS' || rel === 'WEAKENS'
            ? COLORS.coral
            : rel === 'SUPPORTS'
            ? COLORS.teal
            : COLORS.cyan;
        const y = doc.y;
        doc
          .font('Helvetica-Bold')
          .fontSize(8.5)
          .fillColor(relColor)
          .text(
            `${translateRelationPlain(rel)}: ${src ? src.original_filename : cor.source_evidence_id}  vs  ${
              tgt ? tgt.original_filename : cor.target_evidence_id
            }`,
            48,
            y,
            { width: 499 },
          );
        doc.font('Helvetica').fontSize(8.5).fillColor(COLORS.slate).text(String(cor.summary), 56, doc.y + 1, {
          width: 490,
        });
        doc.moveDown(0.3);
      }
    }

    if (missingEvidenceList.length > 0) {
      ensureSpace(doc, 38);
      doc.moveDown(0.3);
      doc
        .font('Helvetica-Bold')
        .fontSize(9.5)
        .fillColor(COLORS.amber)
        .text('Missing Evidence & Coverage Gaps (Not Treated as Proof of Authenticity):', 48, doc.y);
      doc.moveDown(0.2);
      for (const gap of missingEvidenceList) {
        ensureSpace(doc, 18);
        doc.font('Helvetica').fontSize(8.5).fillColor(COLORS.slate).text(`• ${gap}`, 56, doc.y, { width: 490 });
        doc.moveDown(0.15);
      }
    }

    // Audio Speech Transcripts (gemini-3.5-transcribe / Gemini ASR) if extracted
    const transcriptEntries: Array<{ file: string; model: string; transcript: string }> = [];
    for (const anl of analyses) {
      const arts = JSON.parse(anl.artifacts_json || '{}');
      const ev = evById.get(anl.evidence_id);
      if (arts.geminiTranscript?.transcript) {
        transcriptEntries.push({
          file: ev ? String(ev.original_filename) : anl.evidence_id,
          model: String(arts.geminiTranscript.model || 'gemini-3.5-transcribe'),
          transcript: String(arts.geminiTranscript.transcript),
        });
      }
    }
    if (transcriptEntries.length > 0) {
      ensureSpace(doc, 40);
      doc.moveDown(0.3);
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor(COLORS.navy).text('Extracted Audio Speech Transcripts:', 48, doc.y);
      doc.moveDown(0.2);
      for (const tr of transcriptEntries) {
        ensureSpace(doc, 32);
        doc.font('Helvetica-Bold').fontSize(8).fillColor(COLORS.indigo).text(`${tr.file} (${tr.model}):`, 56, doc.y);
        doc.font('Helvetica').fontSize(8.5).fillColor(COLORS.slate).text(tr.transcript.slice(0, 600), 64, doc.y, { width: 480 });
        doc.moveDown(0.2);
      }
    }

    // =========================================================================
    // SECTION 7: SUGGESTED NEXT STEPS
    // =========================================================================
    drawSectionHeading(doc, '7', 'Suggested Next Steps & Human Sign-Off', 'Practical verification actions and reviewer conclusion');
    const steps: string[] = reportData.recommendedNextSteps || [];
    if (steps.length === 0) {
      doc
        .font('Helvetica')
        .fontSize(9)
        .fillColor(COLORS.slate)
        .text('• Keep original unedited copies and inspect flagged areas visually.', 56, doc.y);
    } else {
      for (const step of steps) {
        ensureSpace(doc, 20);
        doc.font('Helvetica').fontSize(9).fillColor(COLORS.navy).text(`• ${step}`, 56, doc.y, { width: 490 });
        doc.moveDown(0.25);
      }
    }

    // =========================================================================
    // SECTIONS 8–13: TECHNICAL DETAILS, AGENT LEDGER, & METHODOLOGY (ADVANCED REFERENCE)
    // =========================================================================
    if (mode === 'advanced') {
      doc.addPage();
      doc.y = 54;
      drawSectionHeading(
        doc,
        '8',
        'Technical Details & Cryptographic Custody (Advanced)',
        'Complete SHA-256 digests, localized face regions, 9-agent execution timings, raw model scores, and methodological limits',
      );

      doc.font('Helvetica-Bold').fontSize(9.5).fillColor(COLORS.navy).text('Chain-of-Custody Hashes & Identifiers');
      doc.moveDown(0.25);
      for (const ev of evidence) {
        ensureSpace(doc, 26);
        doc
          .font('Courier')
          .fontSize(8)
          .fillColor(COLORS.navy)
          .text(`[${ev.id}] ${ev.original_filename} (${String(ev.modality).toUpperCase()}, ${ev.file_size} bytes)`, 48, doc.y);
        doc.font('Courier').fontSize(7.5).fillColor(COLORS.muted).text(`SHA-256: ${ev.sha256_hash}`, 56, doc.y);
        doc.moveDown(0.2);
      }

      if (agentExecs.length > 0) {
        doc.moveDown(0.4);
        ensureSpace(doc, 54);
        doc.font('Helvetica-Bold').fontSize(9.5).fillColor(COLORS.navy).text('9-Agent Orchestration Execution Log & Durations');
        doc.moveDown(0.25);
        for (const ag of agentExecs) {
          ensureSpace(doc, 22);
          const findings = JSON.parse(ag.findings_json || '{}');
          const durText = typeof findings.durationMs === 'number' ? `${findings.durationMs}ms` : '—';
          doc
            .font('Courier')
            .fontSize(8)
            .fillColor(ag.status === 'failed' ? COLORS.coral : COLORS.navy)
            .text(`• ${ag.agent_name} | status=${ag.status} | duration=${durText}`, 48, doc.y, { width: 499 });
          if (ag.error_message) {
            doc.font('Helvetica').fontSize(7.5).fillColor(COLORS.coral).text(`  Error: ${ag.error_message}`, 56, doc.y);
          }
          doc.moveDown(0.15);
        }
      }

      doc.moveDown(0.4);
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor(COLORS.navy).text('Technical Model Outputs & Domain Limits');
      doc.moveDown(0.25);
      if (predictions.length === 0) {
        doc.font('Helvetica').fontSize(8.5).fillColor(COLORS.muted).text('No media ML models executed.', 48, doc.y);
      } else {
        for (const pred of predictions) {
          ensureSpace(doc, 26);
          doc
            .font('Courier')
            .fontSize(8)
            .fillColor(COLORS.indigo)
            .text(
              `• [${pred.evidence_id}] ${pred.model_id}: label=${pred.prediction_label}, score=${Number(
                pred.raw_score || 0,
              ).toFixed(4)}`,
              48,
              doc.y,
              { width: 499 },
            );
          doc
            .font('Helvetica')
            .fontSize(7.5)
            .fillColor(COLORS.slate)
            .text(`  Details & Scope: ${cleanCaveatText(String(pred.uncertainty_note || ''))}`, 52, doc.y, {
              width: 495,
            });
          doc.moveDown(0.2);
        }
      }

      doc.moveDown(0.4);
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor(COLORS.navy).text('Per-File Modality Metrics, Face Tracking & Methodological Limits');
      doc.moveDown(0.25);
      for (const anl of analyses) {
        ensureSpace(doc, 38);
        const ev = evById.get(anl.evidence_id);
        const metricsObj = JSON.parse(anl.metrics_json || '{}');
        const compactMetrics = Object.entries(metricsObj)
          .filter(([, v]) => typeof v !== 'object' && v !== null && v !== undefined)
          .slice(0, 10)
          .map(([k, v]) => `${k}=${v}`)
          .join(', ');
        doc
          .font('Courier')
          .fontSize(8)
          .fillColor(COLORS.navy)
          .text(`[${anl.evidence_id}] ${ev ? ev.original_filename : ''} (${anl.modality}): ${compactMetrics}`, 48, doc.y, {
            width: 499,
          });
        doc
          .font('Helvetica')
          .fontSize(7.5)
          .fillColor(COLORS.muted)
          .text(`Limitations: ${anl.limitations}`, 52, doc.y, { width: 495 });
        doc.moveDown(0.25);
      }
    }

    ensureSpace(doc, 44);
    doc.moveDown(0.4);
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor(COLORS.muted)
      .text(
        `Scope & Limitations: Report ${reportId} (${mode.toUpperCase()}) | Case ${inv.case_code}. Automated scores measure how closely files match patterns in training datasets rather than factual certainty or calibrated probabilities. Interpret findings alongside original source files and provenance context (Reviewer status: ${report.human_conclusion || 'Pending'}).`,
        48,
        doc.y,
        { width: 499 },
      );

    // Apply clean Page X of Y footers & top continuation strip on pages 2..N
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      if (i > 0) {
        doc
          .font('Helvetica')
          .fontSize(7.5)
          .fillColor(COLORS.muted)
          .text(`TruthLens AI Report · ${inv.case_code} · ${inv.title}`, 48, 22, { width: 350, ellipsis: true });
        doc.moveTo(48, 36).lineTo(547, 36).lineWidth(0.5).strokeColor('#E2E8F0').stroke();
      }
      doc
        .font('Helvetica')
        .fontSize(7.5)
        .fillColor(COLORS.muted)
        .text(`Page ${i + 1} of ${range.count}`, 48, doc.page.height - 34, { width: 499, align: 'right' });
    }

    doc.end();
    stream.on('finish', () => resolve());
    stream.on('error', reject);
  });

  db.prepare(`UPDATE investigation_reports SET pdf_path = ? WHERE id = ?`).run(pdfPath, reportId);
  return pdfPath;
}
