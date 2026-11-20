import fs from 'fs';
import path from 'path';
import { MODELS_DIR } from '../config.ts';
import {
  type TrainedLRModel,
  type TrainedRFModel,
  ensureTrainedModels,
  predictTree,
} from './trainer.ts';
import {
  inferPretrainedAudioAasist,
  inferPretrainedImageDeepfake,
} from './pretrained.ts';
import type { DetectedFace } from './faceDetector.ts';

export interface InferenceOutput {
  modelId: string;
  predictionLabel: 'consistent_baseline' | 'inconclusive_review' | 'elevated_anomaly';
  rawScore: number;
  uncertaintyNote: string;
  featureContributions: { feature: string; value: number; impact: number }[];
}

function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
}

function classifyScore(score: number): InferenceOutput['predictionLabel'] {
  if (score >= 0.65) return 'elevated_anomaly';
  if (score >= 0.4) return 'inconclusive_review';
  return 'consistent_baseline';
}

export function inferImageForensics(features: number[]): InferenceOutput[] {
  ensureTrainedModels();
  const rfV2Path = path.join(MODELS_DIR, 'tl_img_forensics_rf_v2.json');
  const lrV2Path = path.join(MODELS_DIR, 'tl_img_forensics_lr_v2.json');
  const rfPath = fs.existsSync(rfV2Path) ? rfV2Path : path.join(MODELS_DIR, 'tl_img_forensics_rf_v1.json');
  const lrPath = fs.existsSync(lrV2Path) ? lrV2Path : path.join(MODELS_DIR, 'tl_img_forensics_lr_v1.json');

  const rf: TrainedRFModel = JSON.parse(fs.readFileSync(rfPath, 'utf8'));
  const lr: TrainedLRModel = JSON.parse(fs.readFileSync(lrPath, 'utf8'));
  const isV2 = rf.modelId.endsWith('-v2');

  // RF Inference
  const xRf = features.map((v, i) => (v - rf.scalerMean[i]) / (rf.scalerStd[i] || 1));
  const treeProbs = rf.trees.map((t) => predictTree(t, xRf));
  const rfScore = treeProbs.reduce((a, b) => a + b, 0) / treeProbs.length;
  const rfStd = Math.sqrt(
    treeProbs.reduce((acc, p) => acc + (p - rfScore) * (p - rfScore), 0) / treeProbs.length,
  );

  const rfContributions = rf.featureNames.map((fname, idx) => ({
    feature: fname,
    value: Number(features[idx].toFixed(4)),
    impact: Number(((rf.featureImportance[fname] || 0) * Math.abs(xRf[idx])).toFixed(4)),
  }));

  // LR Inference
  const xLr = features.map((v, i) => (v - lr.scalerMean[i]) / (lr.scalerStd[i] || 1));
  const z = lr.bias + xLr.reduce((acc, val, idx) => acc + val * lr.weights[idx], 0);
  const lrScore = sigmoid(z);
  const lrContributions = lr.featureNames.map((fname, idx) => ({
    feature: fname,
    value: Number(features[idx].toFixed(4)),
    impact: Number((xLr[idx] * lr.weights[idx]).toFixed(4)),
  }));

  const disagreement = Math.abs(rfScore - lrScore);

  return [
    {
      modelId: rf.modelId,
      predictionLabel: classifyScore(rfScore),
      rawScore: Number(rfScore.toFixed(4)),
      uncertaintyNote: `UNCALIBRATED RAW SCORE (${(rfScore * 100).toFixed(
        1,
      )} / 100, NOT a calibrated probability). Tree dispersion std=${rfStd.toFixed(3)}; ${
        disagreement > 0.2
          ? `disagrees with linear baseline by ${(disagreement * 100).toFixed(1)} pts (manual ELA inspection advised).`
          : 'consistent with linear baseline.'
      } ${
        isV2
          ? 'Fit on 80 disjoint real/fake JPEGs; 8D scalar stats overlap across authentic & GAN images (secondary check only).'
          : 'Fit on synthetic feature distributions; use alongside pixel/metadata forensics.'
      }`,
      featureContributions: rfContributions.sort((a, b) => b.impact - a.impact),
    },
    {
      modelId: lr.modelId,
      predictionLabel: classifyScore(lrScore),
      rawScore: Number(lrScore.toFixed(4)),
      uncertaintyNote: `UNCALIBRATED RAW SCORE (${(lrScore * 100).toFixed(
        1,
      )} / 100, NOT a calibrated probability). Linear logit z=${z.toFixed(2)}, margin=${Math.abs(
        lrScore - 0.5,
      ).toFixed(3)}. ${
        isV2
          ? 'Fit on 80 disjoint real/fake JPEGs; linear pixel-residual boundary has high overlap on compressed media.'
          : ''
      }`,
      featureContributions: lrContributions.sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact)),
    },
  ];
}

export async function inferImageForensicsFull(
  features: number[],
  imageBuffer?: Buffer,
  detectedFaces?: DetectedFace[],
): Promise<InferenceOutput[]> {
  const classical = inferImageForensics(features);
  if (!imageBuffer) return classical;
  try {
    const vit = await inferPretrainedImageDeepfake(imageBuffer, detectedFaces);
    if (vit) return [vit, ...classical];
  } catch {
    // Non-fatal fallback to classical models if ONNX fails on unusual image
  }
  return classical;
}

export function inferAudioSpoofing(
  features: number[],
  domainContext?: { codec?: string; sampleRate?: number },
): InferenceOutput {
  ensureTrainedModels();
  const lr: TrainedLRModel = JSON.parse(
    fs.readFileSync(path.join(MODELS_DIR, 'tl_aud_spoof_lr_v1.json'), 'utf8'),
  );
  const x = features.map((v, i) => (v - lr.scalerMean[i]) / (lr.scalerStd[i] || 1));
  const z = lr.bias + x.reduce((acc, val, idx) => acc + val * lr.weights[idx], 0);
  const score = sigmoid(z);
  const contributions = lr.featureNames.map((fname, idx) => ({
    feature: fname,
    value: Number(features[idx].toFixed(4)),
    impact: Number((x[idx] * lr.weights[idx]).toFixed(4)),
  }));

  const isRealSpeechOod =
    (domainContext?.codec && !domainContext.codec.toLowerCase().startsWith('pcm_')) ||
    (typeof domainContext?.sampleRate === 'number' && domainContext.sampleRate !== 16000) ||
    score < 0.005;

  return {
    modelId: lr.modelId,
    predictionLabel: isRealSpeechOod ? 'inconclusive_review' : classifyScore(score),
    rawScore: Number(score.toFixed(4)),
    uncertaintyNote: `${
      isRealSpeechOod
        ? '[OUT-OF-DOMAIN / INCONCLUSIVE BASELINE: synthetic DSP Logistic Regression saturates near 0 on real-world speech waveforms — NOT evidence of authenticity.] '
        : ''
    }UNCALIBRATED RAW HEURISTIC SCORE (${(score * 100).toFixed(
      1,
    )} / 100, NOT a calibrated probability). Acoustic logistic margin=${Math.abs(score - 0.5).toFixed(
      3,
    )}. Codec compression, silence, or ambient speech fall outside this heuristic baseline.`,
    featureContributions: contributions.sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact)),
  };
}

export async function inferAudioSpoofingFull(
  features: number[],
  samples16k?: Float32Array,
  domainContext?: { codec?: string; sampleRate?: number; clippingRatio?: number; silenceRatio?: number; flatnessMean?: number },
): Promise<InferenceOutput[]> {
  const lrPred = inferAudioSpoofing(features, domainContext);
  if (!samples16k || samples16k.length < 400) return [lrPred];
  try {
    const aasist = await inferPretrainedAudioAasist(samples16k, domainContext);
    if (aasist) return [aasist, lrPred];
  } catch {
    // Non-fatal fallback to classical DSP model
  }
  return [lrPred];
}
