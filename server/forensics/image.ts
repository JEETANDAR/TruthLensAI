import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import ExifParser from 'exif-parser';
import { ARTIFACTS_DIR } from '../config.ts';
import { inferImageForensicsFull, type InferenceOutput } from '../ml/inference.ts';
import {
  type DetectedFace,
  detectFacesInBuffer,
  extractAlignedFaceCrop,
  FACE_DETECTOR_MODEL_ID,
} from '../ml/faceDetector.ts';
import { inferPretrainedFaceCropDeepfake } from '../ml/pretrained.ts';

export interface ForensicIndicator {
  id: string;
  category: string;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  detail: string;
  sourceLayer?: 'forensic_signal' | 'ml_model' | 'gemini_interpretation';
  evidenceRef?: string;
  evidenceRegion?: { xPct: number; yPct: number; wPct: number; hPct: number };
}

export interface ImageAnalysisResult {
  metrics: Record<string, number | string | boolean | null>;
  exif: Record<string, unknown>;
  indicators: ForensicIndicator[];
  artifacts: {
    elaUrl: string;
    noiseUrl: string;
    tileMeans: number[];
    noiseTileMeans: number[];
    gridCols: number;
    gridRows: number;
    detectedFaces: DetectedFace[];
  };
  mlPredictions: InferenceOutput[];
  limitations: string;
}

function heatColor(norm: number): [number, number, number] {
  const t = Math.max(0, Math.min(1, norm));
  if (t < 0.25) {
    const k = t / 0.25;
    return [Math.round(12 + k * 25), Math.round(18 + k * 65), Math.round(34 + k * 140)];
  }
  if (t < 0.55) {
    const k = (t - 0.25) / 0.3;
    return [Math.round(37 + k * 200), Math.round(83 + k * 110), Math.round(174 - k * 120)];
  }
  if (t < 0.8) {
    const k = (t - 0.55) / 0.25;
    return [Math.round(237 + k * 18), Math.round(193 - k * 80), Math.round(54 - k * 34)];
  }
  const k = (t - 0.8) / 0.2;
  return [255, Math.round(113 - k * 70), Math.round(20 + k * 30)];
}

export async function analyzeImageBufferMetrics(fileBuffer: Buffer): Promise<{
  width: number;
  height: number;
  format: string;
  channels: number;
  hasAlpha: boolean;
  elaMean: number;
  elaQ75Mean: number;
  elaP95: number;
  elaMax: number;
  elaSpatialVariance: number;
  noiseFloorStd: number;
  noiseSpatialVariance: number;
  blockArtifactRatio: number;
  saturationSkew: number;
  highFreqDropRatio: number;
  lumaHistogram: number[];
  tileMeans: number[];
  noiseTileMeans: number[];
  gridCols: number;
  gridRows: number;
  elaRgb: Buffer;
  noiseRgb: Buffer;
  procWidth: number;
  procHeight: number;
}> {
  if (!fileBuffer || fileBuffer.length < 16) {
    throw new Error('Image file is empty or too small to decode.');
  }
  const meta = await sharp(fileBuffer).metadata().catch((err: unknown) => {
    throw new Error(
      `Unsupported or corrupt image container: ${err instanceof Error ? err.message : 'decode failure'}`,
    );
  });
  const width = meta.width || 0;
  const height = meta.height || 0;
  if (width < 8 || height < 8) {
    throw new Error(`Invalid or corrupt image dimensions (${width}x${height}).`);
  }
  const format = meta.format || 'unknown';
  const channels = meta.channels || 3;

  // Resize working buffer to max 640px wide for bounded CPU/RAM ELA & noise computation
  const targetW = Math.min(width, 640);
  const targetH = Math.max(64, Math.round((height / width) * targetW));

  const origRaw = await sharp(fileBuffer)
    .resize(targetW, targetH, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const [recompressedQ90, recompressedQ75] = await Promise.all([
    sharp(origRaw.data, { raw: { width: targetW, height: targetH, channels: 3 } })
      .jpeg({ quality: 90 })
      .toBuffer(),
    sharp(origRaw.data, { raw: { width: targetW, height: targetH, channels: 3 } })
      .jpeg({ quality: 75 })
      .toBuffer(),
  ]);

  const [recompRaw90, recompRaw75] = await Promise.all([
    sharp(recompressedQ90).removeAlpha().raw().toBuffer(),
    sharp(recompressedQ75).removeAlpha().raw().toBuffer(),
  ]);

  const len = targetW * targetH;
  const diffs = new Float32Array(len);
  const lapField = new Float32Array(len);
  const elaRgb = Buffer.alloc(len * 3);
  const noiseRgb = Buffer.alloc(len * 3);
  const lumaHistogram = new Array(16).fill(0);

  let diffSum = 0;
  let diffQ75Sum = 0;
  let diffMax = 0;
  let satSum = 0;
  let satHighCount = 0;

  for (let i = 0; i < len; i++) {
    const idx = i * 3;
    const r = origRaw.data[idx];
    const g = origRaw.data[idx + 1];
    const b = origRaw.data[idx + 2];

    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    lumaHistogram[Math.min(15, Math.floor((lum / 256) * 16))]++;

    const dr = Math.abs(r - recompRaw90[idx]);
    const dg = Math.abs(g - recompRaw90[idx + 1]);
    const db = Math.abs(b - recompRaw90[idx + 2]);
    const d = (dr + dg + db) / 3;
    diffs[i] = d;
    diffSum += d;
    if (d > diffMax) diffMax = d;

    const d75 =
      (Math.abs(r - recompRaw75[idx]) +
        Math.abs(g - recompRaw75[idx + 1]) +
        Math.abs(b - recompRaw75[idx + 2])) /
      3;
    diffQ75Sum += d75;

    const maxC = Math.max(r, g, b);
    const minC = Math.min(r, g, b);
    const sat = maxC > 0 ? (maxC - minC) / maxC : 0;
    satSum += sat;
    if (sat > 0.72) satHighCount++;

    const [hr, hg, hb] = heatColor(d / 28);
    elaRgb[idx] = hr;
    elaRgb[idx + 1] = hg;
    elaRgb[idx + 2] = hb;
  }

  for (let b = 0; b < 16; b++) {
    lumaHistogram[b] = Number((lumaHistogram[b] / Math.max(1, len)).toFixed(4));
  }

  const elaMean = diffSum / len;
  const elaQ75Mean = diffQ75Sum / len;
  const sortedDiffs = Float32Array.from(diffs).sort();
  const elaP95 = sortedDiffs[Math.min(len - 1, Math.floor(len * 0.95))];

  // High-pass Laplacian noise residual & 8x8 JPEG block boundary ratio
  let noiseSum = 0;
  let noiseSqSum = 0;
  let boundaryDiffSum = 0;
  let boundaryCount = 0;
  let interiorDiffSum = 0;
  let interiorCount = 0;
  let highFreqEnergy = 0;
  let lowFreqEnergy = 0;

  for (let y = 1; y < targetH - 1; y++) {
    for (let x = 1; x < targetW - 1; x++) {
      const i = y * targetW + x;
      const p = i * 3;
      const lum = 0.299 * origRaw.data[p] + 0.587 * origRaw.data[p + 1] + 0.114 * origRaw.data[p + 2];
      const lumL = 0.299 * origRaw.data[p - 3] + 0.587 * origRaw.data[p - 2] + 0.114 * origRaw.data[p - 1];
      const lumR = 0.299 * origRaw.data[p + 3] + 0.587 * origRaw.data[p + 4] + 0.114 * origRaw.data[p + 5];
      const lumU =
        0.299 * origRaw.data[p - targetW * 3] +
        0.587 * origRaw.data[p - targetW * 3 + 1] +
        0.114 * origRaw.data[p - targetW * 3 + 2];
      const lumD =
        0.299 * origRaw.data[p + targetW * 3] +
        0.587 * origRaw.data[p + targetW * 3 + 1] +
        0.114 * origRaw.data[p + targetW * 3 + 2];

      const lap = Math.abs(4 * lum - lumL - lumR - lumU - lumD);
      lapField[i] = lap;
      noiseSum += lap;
      noiseSqSum += lap * lap;
      highFreqEnergy += lap;
      lowFreqEnergy += lum;

      const vis = Math.min(255, Math.round(lap * 4.5));
      noiseRgb[p] = Math.round(vis * 0.65);
      noiseRgb[p + 1] = Math.min(255, Math.round(vis * 0.96));
      noiseRgb[p + 2] = Math.min(255, Math.round(vis * 1.15));

      const gradX = Math.abs(lum - lumL);
      if (x % 8 === 0) {
        boundaryDiffSum += gradX;
        boundaryCount++;
      } else {
        interiorDiffSum += gradX;
        interiorCount++;
      }
    }
  }

  // 8x8 tile spatial variance of both ELA and Laplacian noise residuals
  const gridCols = 8;
  const gridRows = 8;
  const tileMeans: number[] = [];
  const noiseTileMeans: number[] = [];
  const tileW = Math.max(1, Math.floor(targetW / gridCols));
  const tileH = Math.max(1, Math.floor(targetH / gridRows));

  for (let gr = 0; gr < gridRows; gr++) {
    for (let gc = 0; gc < gridCols; gc++) {
      let elaSum = 0;
      let nSum = 0;
      let count = 0;
      for (let y = gr * tileH; y < Math.min(targetH, (gr + 1) * tileH); y++) {
        for (let x = gc * tileW; x < Math.min(targetW, (gc + 1) * tileW); x++) {
          const idx = y * targetW + x;
          elaSum += diffs[idx];
          nSum += lapField[idx];
          count++;
        }
      }
      tileMeans.push(Number((count > 0 ? elaSum / count : 0).toFixed(3)));
      noiseTileMeans.push(Number((count > 0 ? nSum / count : 0).toFixed(3)));
    }
  }

  const tileAvg = tileMeans.reduce((a, b) => a + b, 0) / tileMeans.length;
  const elaSpatialVariance =
    tileMeans.reduce((acc, m) => acc + (m - tileAvg) * (m - tileAvg), 0) / tileMeans.length;

  const noiseTileAvg = noiseTileMeans.reduce((a, b) => a + b, 0) / noiseTileMeans.length;
  const noiseSpatialVariance =
    noiseTileMeans.reduce((acc, m) => acc + (m - noiseTileAvg) * (m - noiseTileAvg), 0) / noiseTileMeans.length;

  const innerCount = Math.max(1, (targetW - 2) * (targetH - 2));
  const noiseMean = noiseSum / innerCount;
  const noiseFloorStd = Math.sqrt(Math.max(0, noiseSqSum / innerCount - noiseMean * noiseMean));
  const boundaryAvg = boundaryCount > 0 ? boundaryDiffSum / boundaryCount : 0;
  const interiorAvg = interiorCount > 0 ? interiorDiffSum / interiorCount : 1;
  const blockArtifactRatio = Number(Math.max(0, (boundaryAvg - interiorAvg) / (interiorAvg + 1)).toFixed(4));
  const saturationSkew = Number(((satSum / len) * 0.6 + (satHighCount / len) * 0.4).toFixed(4));
  const highFreqDropRatio = Number(
    Math.max(0.05, Math.min(0.95, 1 - highFreqEnergy / (lowFreqEnergy * 0.35 + 1))).toFixed(4),
  );

  return {
    width,
    height,
    format,
    channels,
    hasAlpha: Boolean(meta.hasAlpha),
    elaMean: Number(elaMean.toFixed(4)),
    elaQ75Mean: Number(elaQ75Mean.toFixed(4)),
    elaP95: Number(elaP95.toFixed(4)),
    elaMax: Number(diffMax.toFixed(4)),
    elaSpatialVariance: Number(elaSpatialVariance.toFixed(4)),
    noiseFloorStd: Number(noiseFloorStd.toFixed(4)),
    noiseSpatialVariance: Number(noiseSpatialVariance.toFixed(4)),
    blockArtifactRatio,
    saturationSkew,
    highFreqDropRatio,
    lumaHistogram,
    tileMeans,
    noiseTileMeans,
    gridCols,
    gridRows,
    elaRgb,
    noiseRgb,
    procWidth: targetW,
    procHeight: targetH,
  };
}

interface MetadataProbeResult {
  exifData: Record<string, unknown>;
  exifMissing: number;
  metadataFormat: string;
  aiGeneratorMarkers: string[];
  c2paPresent: boolean;
  jpegQuantTablesCount: number;
}

const AI_MARKER_PATTERNS: Array<{ label: string; regex: RegExp }> = [
  { label: 'Stable Diffusion / A1111', regex: /negative prompt:|steps:\s*\d+|sampler:|cfg scale:|automatic1111|stable diffusion/i },
  { label: 'ComfyUI Workflow', regex: /comfyui|"class_type"\s*:|"ckpt_name"\s*:/i },
  { label: 'Midjourney', regex: /midjourney|--v\s*\d|--ar\s*\d+:\d+/i },
  { label: 'DALL-E / OpenAI', regex: /dall-?e|openai|chatgpt image/i },
  { label: 'Adobe Firefly / GenAI', regex: /adobe firefly|trainedAlgorithmicMedia|digitalCapture.*false/i },
  { label: 'Flux / InvokeAI / NovelAI', regex: /invokeai|novelai|\bflux\b.*dev|\bflux\b.*schnell/i },
  { label: 'Google Imagen / SynthID', regex: /imagen|made with google ai/i },
];

function countJpegDqtTables(buf: Buffer): number {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return 0;
  let offset = 2;
  let tables = 0;
  while (offset + 4 < buf.length) {
    if (buf[offset] !== 0xff) break;
    const marker = buf[offset + 1];
    if (marker === 0xda || marker === 0xd9) break; // SOS or EOI
    if (marker >= 0xd0 && marker <= 0xd8) {
      offset += 2;
      continue;
    }
    const segLen = buf.readUInt16BE(offset + 2);
    if (segLen < 2 || offset + 2 + segLen > buf.length) break;
    if (marker === 0xdb) {
      // DQT segment can carry multiple 65-byte (8-bit) or 129-byte (16-bit) tables
      let pos = offset + 4;
      const end = offset + 2 + segLen;
      while (pos < end) {
        const pqTq = buf[pos];
        const pq = (pqTq >> 4) & 0x0f;
        const tblSize = 1 + (pq === 0 ? 64 : 128);
        tables++;
        pos += tblSize;
      }
    }
    offset += 2 + segLen;
  }
  return tables;
}

function extractJpegAppStrings(buf: Buffer): string[] {
  const strings: string[] = [];
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return strings;
  let offset = 2;
  while (offset + 4 < buf.length) {
    if (buf[offset] !== 0xff) break;
    const marker = buf[offset + 1];
    if (marker === 0xda || marker === 0xd9) break;
    if (marker >= 0xd0 && marker <= 0xd8) {
      offset += 2;
      continue;
    }
    const segLen = buf.readUInt16BE(offset + 2);
    if (segLen < 2 || offset + 2 + segLen > buf.length) break;
    if ((marker >= 0xe0 && marker <= 0xef) || marker === 0xfe) {
      const slice = buf.subarray(offset + 4, offset + 2 + segLen);
      strings.push(slice.toString('latin1'));
    }
    offset += 2 + segLen;
  }
  return strings;
}

function extractPngMetadata(buf: Buffer): { chunks: Record<string, string>; hasExif: boolean } {
  const chunks: Record<string, string> = {};
  let hasExif = false;
  const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIG)) {
    return { chunks, hasExif };
  }
  let offset = 8;
  while (offset + 12 <= buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString('ascii');
    const dataStart = offset + 8;
    const dataEnd = dataStart + len;
    if (dataEnd + 4 > buf.length) break;
    const payload = buf.subarray(dataStart, dataEnd);
    if (type === 'eXIf') {
      hasExif = true;
    } else if (type === 'tEXt') {
      const nul = payload.indexOf(0);
      if (nul > 0) {
        const key = payload.subarray(0, nul).toString('latin1');
        const val = payload.subarray(nul + 1).toString('utf8');
        chunks[key] = val.slice(0, 600);
      }
    } else if (type === 'iTXt') {
      const nul = payload.indexOf(0);
      if (nul > 0) {
        const key = payload.subarray(0, nul).toString('utf8');
        const val = payload.subarray(nul + 1).toString('utf8').replace(/\0+/g, ' ').trim();
        chunks[key] = val.slice(0, 600);
      }
    }
    if (type === 'IEND') break;
    offset = dataEnd + 4;
  }
  return { chunks, hasExif };
}

function inspectImageMetadata(buf: Buffer, format: string): MetadataProbeResult {
  let exifData: Record<string, unknown> = {};
  let exifMissing = 1;
  const aiMarkers = new Set<string>();
  let c2paPresent = false;
  const jpegQuantTablesCount = format === 'jpeg' ? countJpegDqtTables(buf) : 0;

  try {
    const parser = ExifParser.create(buf);
    const parsed = parser.parse();
    if (parsed && parsed.tags && Object.keys(parsed.tags).length > 0) {
      exifMissing = 0;
      exifData = {
        Make: parsed.tags.Make ?? null,
        Model: parsed.tags.Model ?? null,
        LensModel: (parsed.tags as Record<string, unknown>).LensModel ?? null,
        Software: parsed.tags.Software ?? null,
        DateTimeOriginal: parsed.tags.DateTimeOriginal ?? null,
        ModifyDate: parsed.tags.ModifyDate ?? null,
        ExposureTime: parsed.tags.ExposureTime ?? null,
        FNumber: parsed.tags.FNumber ?? null,
        ISO: parsed.tags.ISO ?? null,
        FocalLength: parsed.tags.FocalLength ?? null,
        Orientation: parsed.tags.Orientation ?? null,
        ColorSpace: parsed.tags.ColorSpace ?? null,
        GPSLatitude: parsed.tags.GPSLatitude ?? null,
        GPSLongitude: parsed.tags.GPSLongitude ?? null,
      };
    }
  } catch {
    // Non-EXIF or stripped JPEG handled below
  }

  let rawMetadataText = JSON.stringify(exifData);
  if (format === 'png') {
    const pngMeta = extractPngMetadata(buf);
    if (Object.keys(pngMeta.chunks).length > 0) {
      exifData.PNGMetadata = pngMeta.chunks;
      rawMetadataText += ' ' + Object.entries(pngMeta.chunks).map(([k, v]) => `${k}:${v}`).join(' ');
    }
    if (pngMeta.hasExif && exifMissing === 1) {
      exifData.note = 'PNG eXIf chunk present; hardware APP1 EXIF absent.';
    }
  } else if (format === 'jpeg') {
    const appStrings = extractJpegAppStrings(buf);
    if (appStrings.length > 0) {
      rawMetadataText += ' ' + appStrings.join(' ');
      const xmpMatch = appStrings.find((s) => s.includes('xmp') || s.includes('XMP') || s.includes('adobe'));
      if (xmpMatch) {
        const creatorTool = xmpMatch.match(/<xmp:CreatorTool>([^<]+)<\/xmp:CreatorTool>/i)?.[1];
        if (creatorTool) exifData.XMPCreatorTool = creatorTool;
      }
    }
  } else if (format === 'webp') {
    const headerSlice = buf.subarray(0, Math.min(buf.length, 32768)).toString('latin1');
    rawMetadataText += ' ' + headerSlice;
  }

  if (/c2pa|jumbf|urn:uuid:63327061/i.test(rawMetadataText)) {
    c2paPresent = true;
    exifData.ContentCredentials = 'C2PA / JUMBF marker present';
  }
  for (const pat of AI_MARKER_PATTERNS) {
    if (pat.regex.test(rawMetadataText)) {
      aiMarkers.add(pat.label);
    }
  }

  if (exifMissing === 1 && Object.keys(exifData).length === 0) {
    exifData = {
      note: `No hardware EXIF APP1 tags found (${format.toUpperCase()} container). Common in screenshots, social-media exports, PNG/WebP renders, or stripped files.`,
    };
  }

  return {
    exifData,
    exifMissing,
    metadataFormat: format.toUpperCase(),
    aiGeneratorMarkers: Array.from(aiMarkers),
    c2paPresent,
    jpegQuantTablesCount,
  };
}

export async function runImageForensics(
  evidenceId: string,
  filePath: string,
  options?: { skipArtifactFiles?: boolean },
): Promise<ImageAnalysisResult> {
  const buf = fs.readFileSync(filePath);
  const metrics = await analyzeImageBufferMetrics(buf);
  const metaProbe = inspectImageMetadata(buf, metrics.format);
  const exifData = metaProbe.exifData;
  const exifMissing = metaProbe.exifMissing;

  const elaFilename = `ela_${evidenceId}.png`;
  const noiseFilename = `noise_${evidenceId}.png`;
  if (!options?.skipArtifactFiles) {
    await sharp(metrics.elaRgb, {
      raw: { width: metrics.procWidth, height: metrics.procHeight, channels: 3 },
    })
      .png()
      .toFile(path.join(ARTIFACTS_DIR, elaFilename));

    await sharp(metrics.noiseRgb, {
      raw: { width: metrics.procWidth, height: metrics.procHeight, channels: 3 },
    })
      .png()
      .toFile(path.join(ARTIFACTS_DIR, noiseFilename));
  }

  // Run pretrained UltraFace ONNX face detection & evaluate top detected face crops
  let detectedFaces: DetectedFace[] = [];
  try {
    detectedFaces = await detectFacesInBuffer(buf, { confThreshold: 0.65, maxFaces: 6 });
    for (let fi = 0; fi < Math.min(3, detectedFaces.length); fi++) {
      const fCrop = await extractAlignedFaceCrop(buf, detectedFaces[fi], 2.0);
      const cropPred = await inferPretrainedFaceCropDeepfake(fCrop);
      if (cropPred) {
        detectedFaces[fi].mlScore = cropPred.rawScore;
        detectedFaces[fi].mlLabel = cropPred.predictionLabel;
      }
    }
  } catch {
    detectedFaces = [];
  }

  // Build 8D feature vector matching IMAGE_FEATURES order + run DFvReal ViT / RF / LR
  const featureVector = [
    metrics.elaMean,
    metrics.elaP95,
    metrics.elaSpatialVariance,
    metrics.noiseFloorStd,
    metrics.blockArtifactRatio,
    metrics.saturationSkew,
    exifMissing,
    metrics.highFreqDropRatio,
  ];
  const mlPredictions = await inferImageForensicsFull(featureVector, buf, detectedFaces);

  const indicators: ForensicIndicator[] = [];

  if (detectedFaces.length > 0) {
    const primaryFace = detectedFaces[0];
    const hasElevatedFace = detectedFaces.some((f) => (f.mlScore ?? 0) >= 0.65);
    indicators.push({
      id: `IND-${evidenceId}-FACES`,
      category: 'Face Region Analysis',
      severity: hasElevatedFace ? 'warning' : 'info',
      sourceLayer: hasElevatedFace ? 'ml_model' : 'forensic_signal',
      evidenceRef: evidenceId,
      title: `${detectedFaces.length} face region(s) localized via ${FACE_DETECTOR_MODEL_ID}`,
      detail: `Primary face box (${primaryFace.w}×${primaryFace.h} px at ${primaryFace.xPct}%, ${primaryFace.yPct}%; detector conf ${(
        primaryFace.confidence * 100
      ).toFixed(0)}%)${
        typeof primaryFace.mlScore === 'number'
          ? ` scored ${(primaryFace.mlScore * 100).toFixed(1)}% raw score (uncalibrated) on aligned 2.0× crop`
          : ''
      }.`,
      evidenceRegion: {
        xPct: primaryFace.xPct,
        yPct: primaryFace.yPct,
        wPct: primaryFace.wPct,
        hPct: primaryFace.hPct,
      },
    });
  } else {
    indicators.push({
      id: `IND-${evidenceId}-NO-FACE`,
      category: 'Face Region Analysis',
      severity: 'info',
      sourceLayer: 'forensic_signal',
      evidenceRef: evidenceId,
      title: 'No human face regions localized by UltraFace ONNX',
      detail: `${FACE_DETECTOR_MODEL_ID} detected 0 faces above 0.65 confidence; face-crop deepfake detector fell back to global/center views.`,
    });
  }

  if (metaProbe.aiGeneratorMarkers.length > 0) {
    indicators.push({
      id: `IND-${evidenceId}-AI-META`,
      category: 'Metadata / Provenance',
      severity: 'critical',
      sourceLayer: 'forensic_signal',
      evidenceRef: evidenceId,
      title: `AI generation signature found in file metadata (${metaProbe.aiGeneratorMarkers.join(', ')})`,
      detail: `Embedded container chunks (${metaProbe.metadataFormat}) explicitly reference generative tooling or workflow parameters: ${metaProbe.aiGeneratorMarkers.join(', ')}.`,
    });
  }

  if (metaProbe.c2paPresent) {
    indicators.push({
      id: `IND-${evidenceId}-C2PA`,
      category: 'Metadata / Provenance',
      severity: 'info',
      sourceLayer: 'forensic_signal',
      evidenceRef: evidenceId,
      title: 'C2PA / Content Credentials marker present',
      detail: 'Container header includes C2PA/JUMBF provenance bytes; verify cryptographic signature externally if origin certification is required.',
    });
  }

  if (exifMissing === 1) {
    indicators.push({
      id: `IND-${evidenceId}-EXIF`,
      category: 'Metadata',
      severity: 'warning',
      sourceLayer: 'forensic_signal',
      evidenceRef: evidenceId,
      title: 'Camera EXIF provenance absent',
      detail: 'No camera hardware EXIF tags (Make/Model/DateTimeOriginal) present. Occurs after social media upload, screenshot capture, or intentional metadata stripping.',
    });
  } else if (exifData.Software && typeof exifData.Software === 'string') {
    indicators.push({
      id: `IND-${evidenceId}-SW`,
      category: 'Metadata',
      severity: 'warning',
      sourceLayer: 'forensic_signal',
      evidenceRef: evidenceId,
      title: `Editing software tag recorded (${exifData.Software})`,
      detail: `EXIF Software field indicates post-capture processing via ${exifData.Software}.`,
    });
  } else {
    indicators.push({
      id: `IND-${evidenceId}-EXIF-OK`,
      category: 'Metadata',
      severity: 'info',
      sourceLayer: 'forensic_signal',
      evidenceRef: evidenceId,
      title: 'Camera EXIF tags intact',
      detail: `Device metadata present (${exifData.Make ?? 'Unknown'} ${exifData.Model ?? ''}).`,
    });
  }

  // Dual-quality ELA + quantization table double-JPEG indicator
  const qDelta = Number((metrics.elaQ75Mean - metrics.elaMean).toFixed(2));
  const isJpeg = metrics.format === 'jpeg';
  const doubleJpegSuspected = Boolean(
    isJpeg &&
      ((qDelta < 1.2 && metrics.elaMean > 3.8) ||
        (metrics.blockArtifactRatio > 0.28 && metrics.elaSpatialVariance > 3.5) ||
        metaProbe.jpegQuantTablesCount > 2),
  );
  const doubleJpegReason = !isJpeg
    ? `Not applicable (${metrics.format.toUpperCase()} container)`
    : doubleJpegSuspected
    ? `Compressed Q90/Q75 plateau (Δ=${qDelta}), block ratio=${metrics.blockArtifactRatio.toFixed(
        3,
      )}, DQT tables=${metaProbe.jpegQuantTablesCount}`
    : `Single-pass baseline consistent (Δ=${qDelta}, DQT tables=${metaProbe.jpegQuantTablesCount})`;

  if (doubleJpegSuspected) {
    indicators.push({
      id: `IND-${evidenceId}-DBL-JPEG`,
      category: 'Compression / Quantization',
      severity: 'warning',
      sourceLayer: 'forensic_signal',
      evidenceRef: evidenceId,
      title: 'Multi-pass JPEG recompression signature detected',
      detail: `Q90 ELA mean (${metrics.elaMean.toFixed(2)}) vs Q75 mean (${metrics.elaQ75Mean.toFixed(
        2,
      )}, Δ=${qDelta}), 8×8 block ratio ${metrics.blockArtifactRatio.toFixed(3)}, and ${
        metaProbe.jpegQuantTablesCount
      } DQT table(s) suggest secondary JPEG saving.`,
    });
  }

  // Localize spatial ELA hotspot ONLY if spatial variance is genuinely elevated (> 5.0)
  const tileAvg = metrics.tileMeans.reduce((a, b) => a + b, 0) / metrics.tileMeans.length;
  const tileStd = Math.sqrt(metrics.elaSpatialVariance);
  const hotspotThreshold = tileAvg + 1.8 * tileStd;
  if (metrics.elaSpatialVariance > 5.0 && tileStd > 1.5) {
    let maxIdx = 0;
    metrics.tileMeans.forEach((v, idx) => {
      if (v > metrics.tileMeans[maxIdx]) maxIdx = idx;
    });
    const row = Math.floor(maxIdx / metrics.gridCols);
    const col = maxIdx % metrics.gridCols;
    indicators.push({
      id: `IND-${evidenceId}-ELA-LOC`,
      category: 'Compression / ELA',
      severity: metrics.tileMeans[maxIdx] > hotspotThreshold ? 'critical' : 'warning',
      sourceLayer: 'forensic_signal',
      evidenceRef: evidenceId,
      title: 'Localized compression residual divergence',
      detail: `8×8 grid tile (${col + 1}, ${row + 1}) exhibits ELA residual ${metrics.tileMeans[maxIdx].toFixed(
        2,
      )} vs image mean ${metrics.elaMean.toFixed(2)} (spatial variance ${metrics.elaSpatialVariance.toFixed(2)}).`,
      evidenceRegion: {
        xPct: Number(((col / metrics.gridCols) * 100).toFixed(1)),
        yPct: Number(((row / metrics.gridRows) * 100).toFixed(1)),
        wPct: Number((100 / metrics.gridCols).toFixed(1)),
        hPct: Number((100 / metrics.gridRows).toFixed(1)),
      },
    });
  } else {
    indicators.push({
      id: `IND-${evidenceId}-ELA-UNIF`,
      category: 'Compression / ELA',
      severity: metrics.elaMean > 5.5 ? 'warning' : 'info',
      sourceLayer: 'forensic_signal',
      evidenceRef: evidenceId,
      title: 'Uniform ELA residual distribution',
      detail: `Global ELA Q90 mean=${metrics.elaMean.toFixed(2)} (Q75=${metrics.elaQ75Mean.toFixed(
        2,
      )}), P95=${metrics.elaP95.toFixed(2)}, spatial variance=${metrics.elaSpatialVariance.toFixed(
        2,
      )}. No localized splicing bounding box isolated.`,
    });
  }

  // Spatial sensor-noise uniformity anomaly check
  if (metrics.noiseSpatialVariance > 40 && metrics.noiseFloorStd > 2.5) {
    let minIdx = 0;
    metrics.noiseTileMeans.forEach((v, idx) => {
      if (v < metrics.noiseTileMeans[minIdx]) minIdx = idx;
    });
    const nRow = Math.floor(minIdx / metrics.gridCols);
    const nCol = minIdx % metrics.gridCols;
    indicators.push({
      id: `IND-${evidenceId}-NOISE-VAR`,
      category: 'Sensor Noise',
      severity: 'info',
      sourceLayer: 'forensic_signal',
      evidenceRef: evidenceId,
      title: `Regional texture/noise floor contrast (var=${metrics.noiseSpatialVariance.toFixed(1)})`,
      detail: `Lowest Laplacian residual in tile (${nCol + 1}, ${nRow + 1}) = ${metrics.noiseTileMeans[
        minIdx
      ].toFixed(2)}. Reflects either smooth sky/backdrop regions or localized blurring/inpainting.`,
    });
  } else if (metrics.noiseFloorStd < 4.0) {
    indicators.push({
      id: `IND-${evidenceId}-NOISE-LOW`,
      category: 'Sensor Noise',
      severity: 'warning',
      sourceLayer: 'forensic_signal',
      evidenceRef: evidenceId,
      title: 'Attenuated high-frequency sensor noise',
      detail: `Laplacian noise std=${metrics.noiseFloorStd.toFixed(2)} is low; consistent with denoising, heavy smoothing, or synthetic generation.`,
    });
  }

  return {
    metrics: {
      width: metrics.width,
      height: metrics.height,
      format: metrics.format,
      channels: metrics.channels,
      hasAlpha: metrics.hasAlpha,
      elaMean: metrics.elaMean,
      elaQ75Mean: metrics.elaQ75Mean,
      elaP95: metrics.elaP95,
      elaMax: metrics.elaMax,
      elaSpatialVariance: metrics.elaSpatialVariance,
      noiseFloorStd: metrics.noiseFloorStd,
      noiseSpatialVariance: metrics.noiseSpatialVariance,
      blockArtifactRatio: metrics.blockArtifactRatio,
      saturationSkew: metrics.saturationSkew,
      highFreqDropRatio: metrics.highFreqDropRatio,
      exifPresent: exifMissing === 0,
      doubleJpegSuspected,
      doubleJpegReason,
      jpegQuantTablesCount: metaProbe.jpegQuantTablesCount,
      aiMetadataDetected: metaProbe.aiGeneratorMarkers.length > 0,
      aiMetadataMarkers: metaProbe.aiGeneratorMarkers.join(', ') || 'None',
      c2paPresent: metaProbe.c2paPresent,
      faceCount: detectedFaces.length,
      faceDetectorModel: FACE_DETECTOR_MODEL_ID,
      faceDetectionNote:
        detectedFaces.length > 0
          ? `${detectedFaces.length} face bounding box(es) extracted via ${FACE_DETECTOR_MODEL_ID}; 2.0× aligned face crop(s) analyzed`
          : `0 face bounding boxes detected (${FACE_DETECTOR_MODEL_ID}); global 8×8 ELA/noise grid + center fallback evaluated`,
    },
    exif: exifData,
    indicators,
    artifacts: {
      elaUrl: options?.skipArtifactFiles ? '' : `/api/artifacts/${elaFilename}`,
      noiseUrl: options?.skipArtifactFiles ? '' : `/api/artifacts/${noiseFilename}`,
      tileMeans: metrics.tileMeans,
      noiseTileMeans: metrics.noiseTileMeans,
      gridCols: metrics.gridCols,
      gridRows: metrics.gridRows,
      detectedFaces,
    },
    mlPredictions,
    limitations:
      'ELA and noise residuals reflect compression history rather than direct semantic truth. Multiple benign re-saves or messaging platform compression can elevate global ELA without manipulation. Face-region ViT scores remain uncalibrated indicators, and scenes without detected faces fall back to full-frame visual evaluation.',
  };
}
