import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import * as ort from 'onnxruntime-node';
import { PRETRAINED_MODELS_DIR } from '../config.ts';
import type { InferenceOutput } from './inference.ts';
import {
  type DetectedFace,
  extractAlignedFaceCrop,
  getFaceDetectorPath,
  isFaceDetectorAvailable,
} from './faceDetector.ts';

export const DFVREAL_MODEL_ID = 'TL-ViT-DFvReal-ONNX';
export const VIT_MODEL_ID = 'TL-ViT-Deepfake-v2-ONNX';
export const AASIST_MODEL_ID = 'TL-AASIST-ONNX';

const DFVREAL_FILENAME = 'deepfake_vs_real_int8.onnx';
const VIT_FILENAME = 'deepfake_detector_v2_q4.onnx';
const AASIST_FILENAME = 'aasist.onnx';

const DFVREAL_URL =
  'https://huggingface.co/onnx-community/deepfake_vs_real_image_detection-ONNX/resolve/main/onnx/model_int8.onnx';
const VIT_URL = 'https://huggingface.co/onnx-community/Deep-Fake-Detector-v2-Model-ONNX/resolve/main/onnx/model_q4.onnx';
const AASIST_URL = 'https://huggingface.co/SpeechAntiSpoofingBenchmarks/AASIST/resolve/main/aasist.onnx';

const AASIST_WINDOW_SAMPLES = 64600; // 4.0375s at 16kHz (fixed ASVspoof AASIST receptive window)

let dfvRealSessionPromise: Promise<ort.InferenceSession | null> | null = null;
let vitSessionPromise: Promise<ort.InferenceSession | null> | null = null;
let aasistSessionPromise: Promise<ort.InferenceSession | null> | null = null;

async function ensureModelFile(filename: string, url: string): Promise<string | null> {
  fs.mkdirSync(PRETRAINED_MODELS_DIR, { recursive: true });
  const target = path.join(PRETRAINED_MODELS_DIR, filename);
  if (fs.existsSync(target) && fs.statSync(target).size > 100_000) {
    return target;
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    clearTimeout(timer);
    if (!res.ok) return null;
    const arr = await res.arrayBuffer();
    fs.writeFileSync(target, Buffer.from(arr));
    return target;
  } catch {
    return null;
  }
}

async function getDfvRealSession(): Promise<ort.InferenceSession | null> {
  if (!dfvRealSessionPromise) {
    dfvRealSessionPromise = (async () => {
      const modelPath = await ensureModelFile(DFVREAL_FILENAME, DFVREAL_URL);
      if (!modelPath) return null;
      return ort.InferenceSession.create(modelPath, {
        executionProviders: ['cpu'],
        graphOptimizationLevel: 'all',
        logSeverityLevel: 3,
      });
    })().catch(() => null);
  }
  return dfvRealSessionPromise;
}

async function getVitSession(): Promise<ort.InferenceSession | null> {
  if (!vitSessionPromise) {
    vitSessionPromise = (async () => {
      const modelPath = await ensureModelFile(VIT_FILENAME, VIT_URL);
      if (!modelPath) return null;
      return ort.InferenceSession.create(modelPath, {
        executionProviders: ['cpu'],
        graphOptimizationLevel: 'all',
        logSeverityLevel: 3,
      });
    })().catch(() => null);
  }
  return vitSessionPromise;
}

async function getAasistSession(): Promise<ort.InferenceSession | null> {
  if (!aasistSessionPromise) {
    aasistSessionPromise = (async () => {
      const modelPath = await ensureModelFile(AASIST_FILENAME, AASIST_URL);
      if (!modelPath) return null;
      return ort.InferenceSession.create(modelPath, {
        executionProviders: ['cpu'],
        graphOptimizationLevel: 'all',
        logSeverityLevel: 3,
      });
    })().catch(() => null);
  }
  return aasistSessionPromise;
}

function softmax2(a: number, b: number): [number, number] {
  const m = Math.max(a, b);
  const ea = Math.exp(a - m);
  const eb = Math.exp(b - m);
  const s = ea + eb || 1;
  return [ea / s, eb / s];
}

function classifyScore(score: number): InferenceOutput['predictionLabel'] {
  if (score >= 0.65) return 'elevated_anomaly';
  if (score >= 0.4) return 'inconclusive_review';
  return 'consistent_baseline';
}

async function runVitOnRawOrBuffer(
  session: ort.InferenceSession,
  buf: Buffer,
): Promise<{ pReal: number; pFake: number; realLogit: number; fakeLogit: number } | null> {
  // Match HuggingFace ViTFeatureExtractor: RGB bicubic resize to 224x224, normalized (px/255 - 0.5)/0.5
  const { data } = await sharp(buf)
    .removeAlpha()
    .resize(224, 224, { fit: 'fill', kernel: 'cubic' })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const pixels = 224 * 224;
  const chw = new Float32Array(3 * pixels);
  for (let i = 0; i < pixels; i++) {
    const base = i * 3;
    chw[i] = (data[base] / 255 - 0.5) / 0.5;
    chw[pixels + i] = (data[base + 1] / 255 - 0.5) / 0.5;
    chw[2 * pixels + i] = (data[base + 2] / 255 - 0.5) / 0.5;
  }

  const tensor = new ort.Tensor('float32', chw, [1, 3, 224, 224]);
  const outputs = await session.run({ pixel_values: tensor });
  const logitsData = outputs.logits?.data as Float32Array | undefined;
  if (!logitsData || logitsData.length < 2) return null;

  const realLogit = Number(logitsData[0]);
  const fakeLogit = Number(logitsData[1]);
  const [pReal, pFake] = softmax2(realLogit, fakeLogit);
  return { pReal, pFake, realLogit, fakeLogit };
}

/**
 * Runs DFvReal ViT directly on an already-extracted aligned face crop buffer.
 */
export async function inferPretrainedFaceCropDeepfake(
  cropBuffer: Buffer,
): Promise<{ rawScore: number; predictionLabel: InferenceOutput['predictionLabel']; realLogit: number; fakeLogit: number } | null> {
  const session = await getDfvRealSession();
  if (!session) return null;
  const r = await runVitOnRawOrBuffer(session, cropBuffer);
  if (!r) return null;
  const rawScore = Number(r.pFake.toFixed(4));
  return {
    rawScore,
    predictionLabel: classifyScore(rawScore),
    realLogit: r.realLogit,
    fakeLogit: r.fakeLogit,
  };
}

/**
 * Primary pretrained ViT deepfake detector:
 * onnx-community/deepfake_vs_real_image_detection-ONNX (base: dima806/deepfake_vs_real_image_detection, Apache-2.0).
 * Verified config.json: id2label = { 0: "Real", 1: "Fake" }, RGB 224x224 bicubic, norm mean=0.5 std=0.5.
 * Uses UltraFace aligned 2.0x face crop when wide scene / small face detected, else direct bicubic 224x224 portrait resize.
 */
export async function inferPretrainedImageDeepfake(
  imageBuffer: Buffer,
  detectedFaces?: DetectedFace[],
): Promise<InferenceOutput | null> {
  const session = await getDfvRealSession();
  if (!session) return null;

  const meta = await sharp(imageBuffer).metadata();
  const w = meta.width || 224;
  const h = meta.height || 224;
  const aspectRatio = Math.max(w / Math.max(1, h), h / Math.max(1, w));

  const views: Array<{ label: string; buffer: Buffer }> = [];
  const primaryFace = detectedFaces && detectedFaces.length > 0 ? detectedFaces[0] : null;
  const primaryAreaFrac = primaryFace ? (primaryFace.w * primaryFace.h) / Math.max(1, w * h) : 0;

  if (primaryFace && (aspectRatio > 1.25 || primaryAreaFrac < 0.05)) {
    // Wide scene or distant subject (<5% face area): prioritize aligned 2.0x square face crop from UltraFace
    const faceCrop = await extractAlignedFaceCrop(imageBuffer, primaryFace, 2.0);
    views.push({ label: `Aligned Face Crop (${primaryFace.trackId || 'Face 1'})`, buffer: faceCrop });
  } else if (aspectRatio <= 1.25) {
    // Already tightly framed portrait / square image: evaluate directly via bicubic 224x224 without re-cropping
    views.push({ label: 'Direct Bicubic 224x224 (Portrait Preserved)', buffer: imageBuffer });
  } else {
    // Non-square wide/tall scene with no detected face: center-square crop + full bicubic view averaged
    const cropSize = Math.min(w, h);
    const left = Math.max(0, Math.floor((w - cropSize) / 2));
    const top = Math.max(0, Math.min(h - cropSize, Math.floor((h - cropSize) * 0.2)));
    const centerSquare = await sharp(imageBuffer)
      .extract({ left, top, width: cropSize, height: cropSize })
      .png()
      .toBuffer();
    views.push({ label: 'Center-Portrait Crop (No Face Box)', buffer: centerSquare });
    views.push({ label: 'Full Frame Bicubic', buffer: imageBuffer });
  }

  const results: Array<{ label: string; pReal: number; pFake: number; realLogit: number; fakeLogit: number }> = [];
  for (const v of views) {
    try {
      const r = await runVitOnRawOrBuffer(session, v.buffer);
      if (r) results.push({ label: v.label, ...r });
    } catch {
      // skip invalid sub-view
    }
  }
  if (results.length === 0) return null;

  const meanFake = Number((results.reduce((acc, r) => acc + r.pFake, 0) / results.length).toFixed(4));
  const peak = [...results].sort((a, b) => b.pFake - a.pFake)[0];
  const margin = Math.abs(meanFake - 0.5);

  return {
    modelId: DFVREAL_MODEL_ID,
    predictionLabel: classifyScore(meanFake),
    rawScore: meanFake,
    uncertaintyNote: `UNCALIBRATED RAW MODEL SCORE (${(meanFake * 100).toFixed(
      1,
    )} / 100, NOT a calibrated probability). Evaluated ${results.length} bicubic RGB view(s): mean=${(
      meanFake * 100
    ).toFixed(1)}, peak=${(peak.pFake * 100).toFixed(1)} (${peak.label}), logits [Real=${peak.realLogit.toFixed(
      2,
    )}, Fake=${peak.fakeLogit.toFixed(2)}], margin=${margin.toFixed(
      3,
    )}. Model trained on face-cropped deepfake corpora (Apache-2.0); modern diffusion generators or heavily recompressed streams remain domain-sensitive.`,
    featureContributions: results.map((cr) => ({
      feature: `${cr.label} (DFvReal ViT)`,
      value: Number(cr.pFake.toFixed(4)),
      impact: Number((cr.fakeLogit - cr.realLogit).toFixed(4)),
    })),
  };
}

/**
 * Legacy v2 ViT checkpoint retained strictly for diagnostic comparison (known inverted/high-FPR domain mismatch on portrait JPEGs).
 */
export async function inferPretrainedImageDeepfakeLegacyV2(imageBuffer: Buffer): Promise<InferenceOutput | null> {
  const session = await getVitSession();
  if (!session) return null;
  const r = await runVitOnRawOrBuffer(session, imageBuffer);
  if (!r) return null;
  const rawScore = Number(r.pFake.toFixed(4));
  return {
    modelId: VIT_MODEL_ID,
    predictionLabel: classifyScore(rawScore),
    rawScore,
    uncertaintyNote: `UNCALIBRATED RAW MODEL SCORE (${(rawScore * 100).toFixed(
      1,
    )} / 100). Legacy Deep-Fake-Detector-v2 checkpoint (diagnostic reference; high FPR observed on JPEG portraits).`,
    featureContributions: [
      {
        feature: 'Direct Bicubic 224x224 (Legacy V2)',
        value: rawScore,
        impact: Number((r.fakeLogit - r.realLogit).toFixed(4)),
      },
    ],
  };
}

function tileOrSliceWindow(samples: Float32Array, start: number): Float32Array {
  const out = new Float32Array(AASIST_WINDOW_SAMPLES);
  if (samples.length === 0) return out;
  if (samples.length >= start + AASIST_WINDOW_SAMPLES) {
    out.set(samples.subarray(start, start + AASIST_WINDOW_SAMPLES));
    return out;
  }
  for (let i = 0; i < AASIST_WINDOW_SAMPLES; i++) {
    out[i] = samples[(start + i) % samples.length];
  }
  return out;
}

export interface AudioDomainContext {
  codec?: string;
  sampleRate?: number;
  clippingRatio?: number;
  silenceRatio?: number;
  flatnessMean?: number;
}

export async function inferPretrainedAudioAasist(
  samples16k: Float32Array,
  domainContext?: AudioDomainContext,
): Promise<InferenceOutput | null> {
  if (samples16k.length < 400) return null;
  const session = await getAasistSession();
  if (!session) return null;

  let sqSum = 0;
  let zc = 0;
  for (let i = 0; i < samples16k.length; i++) {
    sqSum += samples16k[i] * samples16k[i];
    if (i > 0 && (samples16k[i] >= 0) !== (samples16k[i - 1] >= 0)) zc++;
  }
  const rms = Math.sqrt(sqSum / samples16k.length);
  const clipShort = samples16k.length < 16000;
  const nearSilent = rms < 0.004;

  const starts: number[] = [0];
  if (samples16k.length > AASIST_WINDOW_SAMPLES * 1.25) {
    starts.push(Math.floor((samples16k.length - AASIST_WINDOW_SAMPLES) / 2));
  }
  if (samples16k.length > AASIST_WINDOW_SAMPLES * 2.1) {
    starts.push(samples16k.length - AASIST_WINDOW_SAMPLES);
  }

  const windowResults: Array<{ startSec: number; pSpoof: number; spoofLogit: number; bonafideLogit: number }> = [];
  for (const s of starts) {
    const win = tileOrSliceWindow(samples16k, s);
    const tensor = new ort.Tensor('float32', win, [1, AASIST_WINDOW_SAMPLES]);
    const outputs = await session.run({ wav: tensor });
    const logits = outputs.logits?.data as Float32Array | undefined;
    if (!logits || logits.length < 2) continue;
    const spoofLogit = Number(logits[0]);
    const bonafideLogit = Number(logits[1]);
    const [pSpoof] = softmax2(spoofLogit, bonafideLogit);
    windowResults.push({
      startSec: Number((s / 16000).toFixed(2)),
      pSpoof,
      spoofLogit,
      bonafideLogit,
    });
  }

  if (windowResults.length === 0) return null;

  const peak = [...windowResults].sort((a, b) => b.pSpoof - a.pSpoof)[0];
  const meanSpoof = windowResults.reduce((acc, r) => acc + r.pSpoof, 0) / windowResults.length;
  const aggregateRawScore = Number(meanSpoof.toFixed(4));

  const oodNotes: string[] = [];
  if (nearSilent) oodNotes.push('very low signal amplitude (near-silent)');
  if (clipShort) oodNotes.push('clip < 1s repeat-padded to 4.04s');
  if (zc / (samples16k.length / 16000) < 40) oodNotes.push('sparse zero-crossings (low speech density)');

  const codec = (domainContext?.codec || '').toLowerCase();
  const isCompressedWebCodec = Boolean(codec && !codec.startsWith('pcm_'));
  const isNon16kNative = typeof domainContext?.sampleRate === 'number' && domainContext.sampleRate !== 16000;
  const isHighAmbientNoise = (domainContext?.flatnessMean ?? 0) > 0.25 || (domainContext?.clippingRatio ?? 0) > 0.002;
  if (isCompressedWebCodec) {
    oodNotes.push(`compressed/transcoded container (${codec} != lossless 16kHz ASVspoof19-LA PCM)`);
  }
  if (isNon16kNative) {
    oodNotes.push(`resampled from ${domainContext?.sampleRate}Hz to 16kHz`);
  }
  if (isHighAmbientNoise) {
    oodNotes.push('ambient noise floor / clipping shifts raw ASVspoof logits');
  }

  // ASVspoof2019-LA AASIST weights exhibit ~100% FPR on YouTube/ambient/compressed in-the-wild speech.
  // Surface out-of-domain high scores honestly as inconclusive_review unless lossless 16kHz studio conditions apply.
  const outOfDomainSpeech = isCompressedWebCodec || isNon16kNative || nearSilent || isHighAmbientNoise;
  const baseLabel = classifyScore(aggregateRawScore);
  const predictionLabel: InferenceOutput['predictionLabel'] =
    outOfDomainSpeech && baseLabel !== 'consistent_baseline' ? 'inconclusive_review' : baseLabel;

  return {
    modelId: AASIST_MODEL_ID,
    predictionLabel,
    rawScore: aggregateRawScore,
    uncertaintyNote: `${
      outOfDomainSpeech
        ? '[OUT-OF-DOMAIN / INCONCLUSIVE FOR AMBIENT SPEECH] '
        : ''
    }UNCALIBRATED RAW MODEL SCORE (mean=${(aggregateRawScore * 100).toFixed(
      1,
    )} / 100, peak=${(peak.pSpoof * 100).toFixed(1)} @${peak.startSec}s — NOT a calibrated probability). Evaluated ${
      windowResults.length
    } window(s) @4.04s 16kHz; peak logits=[spoof:${peak.spoofLogit.toFixed(
      2,
    )}, bonafide:${peak.bonafideLogit.toFixed(2)}].${
      oodNotes.length > 0 ? ` [OUT-OF-DISTRIBUTION CAVEAT: ${oodNotes.join('; ')}.]` : ''
    } ASVspoof2019-LA weights achieve 0.83% EER on clean lab speech vs 43.01% EER In-The-Wild and 100% FPR on YouTube ambient speech; treat elevated raw scores on web/ambient recordings as inconclusive unless corroborated.`,
    featureContributions: windowResults.map((w, idx) => ({
      feature: `AASIST Window ${idx + 1} (${w.startSec}s)`,
      value: Number(w.pSpoof.toFixed(4)),
      impact: Number((w.spoofLogit - w.bonafideLogit).toFixed(4)),
    })),
  };
}

export function getPretrainedModelAvailability(): {
  vitAvailable: boolean;
  dfvRealAvailable: boolean;
  aasistAvailable: boolean;
  faceDetectorAvailable: boolean;
  vitPath: string;
  dfvRealPath: string;
  aasistPath: string;
  faceDetectorPath: string;
} {
  const dfvPath = path.join(PRETRAINED_MODELS_DIR, DFVREAL_FILENAME);
  const vitPath = path.join(PRETRAINED_MODELS_DIR, VIT_FILENAME);
  const aasistPath = path.join(PRETRAINED_MODELS_DIR, AASIST_FILENAME);
  const dfvOk = fs.existsSync(dfvPath) && fs.statSync(dfvPath).size > 100_000;
  return {
    vitAvailable: dfvOk || (fs.existsSync(vitPath) && fs.statSync(vitPath).size > 100_000),
    dfvRealAvailable: dfvOk,
    aasistAvailable: fs.existsSync(aasistPath) && fs.statSync(aasistPath).size > 100_000,
    faceDetectorAvailable: isFaceDetectorAvailable(),
    vitPath: 'models/pretrained/deepfake_vs_real_int8.onnx',
    dfvRealPath: 'models/pretrained/deepfake_vs_real_int8.onnx',
    aasistPath: 'models/pretrained/aasist.onnx',
    faceDetectorPath: getFaceDetectorPath(),
  };
}
