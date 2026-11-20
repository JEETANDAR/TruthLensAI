import fs from 'fs';
import path from 'path';
import { DATASETS_DIR, MODELS_DIR, ensureDirectories } from '../config.ts';
import { getDb } from '../db/database.ts';

// Deterministic PRNG (Mulberry32) so dataset generation & splits are 100% reproducible
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rand: () => number, mean: number, std: number): number {
  const u1 = Math.max(1e-7, rand());
  const u2 = rand();
  const z = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
  return mean + z * std;
}

export interface LabeledSample {
  id: string;
  label: 0 | 1; // 0 = authentic/baseline, 1 = manipulated/anomalous
  features: number[];
}

export interface DecisionTreeNode {
  featureIndex?: number;
  threshold?: number;
  left?: DecisionTreeNode;
  right?: DecisionTreeNode;
  probability?: number; // leaf class-1 probability
}

export interface TrainedRFModel {
  modelId: string;
  name: string;
  version: string;
  algorithm: 'RandomForest';
  featureNames: string[];
  scalerMean: number[];
  scalerStd: number[];
  trees: DecisionTreeNode[];
  featureImportance: Record<string, number>;
}

export interface TrainedLRModel {
  modelId: string;
  name: string;
  version: string;
  algorithm: 'LogisticRegression';
  featureNames: string[];
  scalerMean: number[];
  scalerStd: number[];
  weights: number[];
  bias: number;
}

export interface EvalMetrics {
  sampleCount: number;
  accuracy: number;
  precision: number;
  recall: number;
  f1: number;
  rocAuc: number;
  fpr: number;
  confusionMatrix: [[number, number], [number, number]]; // [[TN, FP], [FN, TP]]
}

export const IMAGE_FEATURES = [
  'elaMean',
  'elaP95',
  'elaSpatialVariance',
  'noiseFloorStd',
  'blockArtifactRatio',
  'saturationSkew',
  'exifIntegrityMissing',
  'highFreqDropRatio',
];

export const AUDIO_FEATURES = [
  'spectralFlatnessMean',
  'spectralFlatnessStd',
  'zcrVariance',
  'highFreqRolloffRatio',
  'silenceFloorKurtosis',
  'harmonicJitter',
];

function generateImageCalibrationDataset(): LabeledSample[] {
  const rand = mulberry32(20261118);
  const samples: LabeledSample[] = [];
  // 120 authentic samples (including natural social media recompression cases to model real-world FPR)
  for (let i = 0; i < 120; i++) {
    const isRecompressedBenign = i % 4 === 0;
    samples.push({
      id: `IMG-CAL-AUTH-${i + 1}`,
      label: 0,
      features: [
        Math.max(0.4, gaussian(rand, isRecompressedBenign ? 3.8 : 2.1, 0.9)),
        Math.max(1.5, gaussian(rand, isRecompressedBenign ? 11.2 : 6.8, 2.4)),
        Math.max(0.2, gaussian(rand, isRecompressedBenign ? 4.4 : 2.3, 1.1)),
        Math.max(0.5, gaussian(rand, isRecompressedBenign ? 6.1 : 8.2, 1.9)),
        Math.max(0.05, gaussian(rand, isRecompressedBenign ? 0.34 : 0.18, 0.08)),
        Math.abs(gaussian(rand, 0.14, 0.08)),
        isRecompressedBenign ? (rand() > 0.35 ? 1 : 0) : (rand() > 0.85 ? 1 : 0),
        Math.max(0.05, Math.min(0.95, gaussian(rand, isRecompressedBenign ? 0.42 : 0.27, 0.1))),
      ],
    });
  }
  // 120 manipulated samples (local splicing, generative inpainting, double quantization)
  for (let i = 0; i < 120; i++) {
    const subtleTamper = i % 5 === 0;
    samples.push({
      id: `IMG-CAL-MANIP-${i + 1}`,
      label: 1,
      features: [
        Math.max(1.2, gaussian(rand, subtleTamper ? 4.9 : 7.6, 1.6)),
        Math.max(4.0, gaussian(rand, subtleTamper ? 16.4 : 27.5, 5.2)),
        Math.max(1.0, gaussian(rand, subtleTamper ? 8.8 : 18.4, 4.1)),
        Math.max(0.3, gaussian(rand, subtleTamper ? 4.8 : 3.4, 1.5)),
        Math.max(0.1, gaussian(rand, subtleTamper ? 0.44 : 0.62, 0.13)),
        Math.abs(gaussian(rand, 0.31, 0.12)),
        rand() > 0.25 ? 1 : 0,
        Math.max(0.1, Math.min(0.98, gaussian(rand, subtleTamper ? 0.56 : 0.72, 0.12))),
      ],
    });
  }
  return samples;
}

function generateAudioCalibrationDataset(): LabeledSample[] {
  const rand = mulberry32(90441122);
  const samples: LabeledSample[] = [];
  for (let i = 0; i < 90; i++) {
    const noisyMic = i % 4 === 0;
    samples.push({
      id: `AUD-CAL-BONAFIDE-${i + 1}`,
      label: 0,
      features: [
        Math.max(0.02, Math.min(0.95, gaussian(rand, noisyMic ? 0.34 : 0.22, 0.07))),
        Math.max(0.01, gaussian(rand, 0.14, 0.04)),
        Math.max(0.001, gaussian(rand, 0.036, 0.011)),
        Math.max(0.05, Math.min(0.95, gaussian(rand, 0.38, 0.09))),
        Math.max(0.5, gaussian(rand, 2.4, 0.7)),
        Math.max(0.01, gaussian(rand, 0.19, 0.06)),
      ],
    });
  }
  for (let i = 0; i < 90; i++) {
    const vocoderClean = i % 3 === 0;
    samples.push({
      id: `AUD-CAL-SPOOF-${i + 1}`,
      label: 1,
      features: [
        Math.max(0.02, Math.min(0.95, gaussian(rand, vocoderClean ? 0.49 : 0.43, 0.08))),
        Math.max(0.01, gaussian(rand, 0.07, 0.03)),
        Math.max(0.001, gaussian(rand, 0.016, 0.007)),
        Math.max(0.05, Math.min(0.95, gaussian(rand, 0.69, 0.11))),
        Math.max(0.5, gaussian(rand, 5.1, 1.3)),
        Math.max(0.01, gaussian(rand, 0.07, 0.03)),
      ],
    });
  }
  return samples;
}

function stratifiedSplit(samples: LabeledSample[], trainRatio: number, seed: number): {
  train: LabeledSample[];
  test: LabeledSample[];
} {
  const rand = mulberry32(seed);
  const class0 = samples.filter((s) => s.label === 0).sort(() => rand() - 0.5);
  const class1 = samples.filter((s) => s.label === 1).sort(() => rand() - 0.5);
  const split0 = Math.floor(class0.length * trainRatio);
  const split1 = Math.floor(class1.length * trainRatio);
  return {
    train: [...class0.slice(0, split0), ...class1.slice(0, split1)],
    test: [...class0.slice(split0), ...class1.slice(split1)],
  };
}

function computeScaler(samples: LabeledSample[]): { mean: number[]; std: number[] } {
  const dim = samples[0].features.length;
  const mean = new Array(dim).fill(0);
  const std = new Array(dim).fill(0);
  for (const s of samples) {
    for (let j = 0; j < dim; j++) mean[j] += s.features[j];
  }
  for (let j = 0; j < dim; j++) mean[j] /= samples.length;
  for (const s of samples) {
    for (let j = 0; j < dim; j++) {
      const d = s.features[j] - mean[j];
      std[j] += d * d;
    }
  }
  for (let j = 0; j < dim; j++) {
    std[j] = Math.sqrt(std[j] / samples.length) || 1;
  }
  return { mean, std };
}

function scaleVector(v: number[], mean: number[], std: number[]): number[] {
  return v.map((val, idx) => (val - mean[idx]) / (std[idx] || 1));
}

function gini(labels: number[]): number {
  if (labels.length === 0) return 0;
  const p1 = labels.reduce((a, b) => a + b, 0) / labels.length;
  const p0 = 1 - p1;
  return 1 - p0 * p0 - p1 * p1;
}

function buildTree(
  rows: { x: number[]; y: number }[],
  depth: number,
  maxDepth: number,
  minLeaf: number,
  rand: () => number,
  featureGainAccumulator: number[],
): DecisionTreeNode {
  const p1 = rows.reduce((acc, r) => acc + r.y, 0) / rows.length;
  if (depth >= maxDepth || rows.length <= minLeaf || p1 === 0 || p1 === 1) {
    return { probability: Number(p1.toFixed(4)) };
  }

  const dim = rows[0].x.length;
  const mtry = Math.max(2, Math.floor(Math.sqrt(dim)));
  const candidates = Array.from({ length: dim }, (_, i) => i)
    .sort(() => rand() - 0.5)
    .slice(0, mtry);

  const parentGini = gini(rows.map((r) => r.y));
  let bestGain = 0;
  let bestFeature = -1;
  let bestThreshold = 0;
  let bestLeft: { x: number[]; y: number }[] = [];
  let bestRight: { x: number[]; y: number }[] = [];

  for (const fIdx of candidates) {
    const values = Array.from(new Set(rows.map((r) => r.x[fIdx]))).sort((a, b) => a - b);
    if (values.length < 2) continue;
    const step = Math.max(1, Math.floor(values.length / 12));
    for (let i = 0; i < values.length - 1; i += step) {
      const thresh = (values[i] + values[i + 1]) / 2;
      const left = rows.filter((r) => r.x[fIdx] <= thresh);
      const right = rows.filter((r) => r.x[fIdx] > thresh);
      if (left.length < 2 || right.length < 2) continue;
      const weightedGini =
        (left.length / rows.length) * gini(left.map((r) => r.y)) +
        (right.length / rows.length) * gini(right.map((r) => r.y));
      const gain = parentGini - weightedGini;
      if (gain > bestGain) {
        bestGain = gain;
        bestFeature = fIdx;
        bestThreshold = thresh;
        bestLeft = left;
        bestRight = right;
      }
    }
  }

  if (bestFeature === -1 || bestGain <= 1e-5) {
    return { probability: Number(p1.toFixed(4)) };
  }

  featureGainAccumulator[bestFeature] += bestGain * rows.length;

  return {
    featureIndex: bestFeature,
    threshold: Number(bestThreshold.toFixed(5)),
    left: buildTree(bestLeft, depth + 1, maxDepth, minLeaf, rand, featureGainAccumulator),
    right: buildTree(bestRight, depth + 1, maxDepth, minLeaf, rand, featureGainAccumulator),
  };
}

export function predictTree(node: DecisionTreeNode, x: number[]): number {
  if (node.probability !== undefined) return node.probability;
  if (node.featureIndex === undefined || node.threshold === undefined) return 0.5;
  if (x[node.featureIndex] <= node.threshold) {
    return node.left ? predictTree(node.left, x) : 0.5;
  }
  return node.right ? predictTree(node.right, x) : 0.5;
}

function trainRandomForest(
  modelId: string,
  name: string,
  version: string,
  featureNames: string[],
  trainSamples: LabeledSample[],
  numTrees = 25,
): TrainedRFModel {
  const { mean, std } = computeScaler(trainSamples);
  const scaled = trainSamples.map((s) => ({ x: scaleVector(s.features, mean, std), y: s.label }));
  const rand = mulberry32(424242);
  const gainAcc = new Array(featureNames.length).fill(0);
  const trees: DecisionTreeNode[] = [];

  for (let t = 0; t < numTrees; t++) {
    const boot: { x: number[]; y: number }[] = [];
    for (let i = 0; i < scaled.length; i++) {
      boot.push(scaled[Math.floor(rand() * scaled.length)]);
    }
    trees.push(buildTree(boot, 0, 5, 4, rand, gainAcc));
  }

  const totalGain = gainAcc.reduce((a, b) => a + b, 0) || 1;
  const featureImportance: Record<string, number> = {};
  featureNames.forEach((fname, idx) => {
    featureImportance[fname] = Number((gainAcc[idx] / totalGain).toFixed(4));
  });

  return {
    modelId,
    name,
    version,
    algorithm: 'RandomForest',
    featureNames,
    scalerMean: mean,
    scalerStd: std,
    trees,
    featureImportance,
  };
}

function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
}

function trainLogisticRegression(
  modelId: string,
  name: string,
  version: string,
  featureNames: string[],
  trainSamples: LabeledSample[],
  lr = 0.08,
  epochs = 450,
  l2 = 0.01,
): TrainedLRModel {
  const { mean, std } = computeScaler(trainSamples);
  const scaled = trainSamples.map((s) => ({ x: scaleVector(s.features, mean, std), y: s.label }));
  const dim = featureNames.length;
  const weights = new Array(dim).fill(0);
  let bias = 0;

  for (let e = 0; e < epochs; e++) {
    const gradW = new Array(dim).fill(0);
    let gradB = 0;
    for (const row of scaled) {
      let z = bias;
      for (let j = 0; j < dim; j++) z += weights[j] * row.x[j];
      const pred = sigmoid(z);
      const err = pred - row.y;
      gradB += err;
      for (let j = 0; j < dim; j++) gradW[j] += err * row.x[j];
    }
    const n = scaled.length;
    bias -= (lr * gradB) / n;
    for (let j = 0; j < dim; j++) {
      weights[j] -= lr * (gradW[j] / n + l2 * weights[j]);
    }
  }

  return {
    modelId,
    name,
    version,
    algorithm: 'LogisticRegression',
    featureNames,
    scalerMean: mean,
    scalerStd: std,
    weights: weights.map((w) => Number(w.toFixed(6))),
    bias: Number(bias.toFixed(6)),
  };
}

export function evaluateBinaryPredictions(
  yTrue: number[],
  yProb: number[],
  threshold = 0.5,
): EvalMetrics {
  let tp = 0;
  let tn = 0;
  let fp = 0;
  let fn = 0;
  for (let i = 0; i < yTrue.length; i++) {
    const pred = yProb[i] >= threshold ? 1 : 0;
    if (yTrue[i] === 1 && pred === 1) tp++;
    else if (yTrue[i] === 0 && pred === 0) tn++;
    else if (yTrue[i] === 0 && pred === 1) fp++;
    else fn++;
  }
  const accuracy = (tp + tn) / yTrue.length;
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  const fpr = fp + tn > 0 ? fp / (fp + tn) : 0;

  // Compute exact trapezoidal ROC-AUC
  const paired = yProb.map((p, idx) => ({ p, y: yTrue[idx] })).sort((a, b) => b.p - a.p);
  const totalPos = yTrue.filter((y) => y === 1).length || 1;
  const totalNeg = yTrue.filter((y) => y === 0).length || 1;
  let curTp = 0;
  let curFp = 0;
  let prevTpr = 0;
  let prevFpr = 0;
  let auc = 0;
  for (const item of paired) {
    if (item.y === 1) curTp++;
    else curFp++;
    const tpr = curTp / totalPos;
    const fprt = curFp / totalNeg;
    auc += ((fprt - prevFpr) * (tpr + prevTpr)) / 2;
    prevTpr = tpr;
    prevFpr = fprt;
  }

  return {
    sampleCount: yTrue.length,
    accuracy: Number(accuracy.toFixed(4)),
    precision: Number(precision.toFixed(4)),
    recall: Number(recall.toFixed(4)),
    f1: Number(f1.toFixed(4)),
    rocAuc: Number(auc.toFixed(4)),
    fpr: Number(fpr.toFixed(4)),
    confusionMatrix: [
      [tn, fp],
      [fn, tp],
    ],
  };
}

export function ensureTrainedModels(): void {
  ensureDirectories();
  const imgRfPath = path.join(MODELS_DIR, 'tl_img_forensics_rf_v1.json');
  const imgLrPath = path.join(MODELS_DIR, 'tl_img_forensics_lr_v1.json');
  const imgRfV2Path = path.join(MODELS_DIR, 'tl_img_forensics_rf_v2.json');
  const imgLrV2Path = path.join(MODELS_DIR, 'tl_img_forensics_lr_v2.json');
  const audLrPath = path.join(MODELS_DIR, 'tl_aud_spoof_lr_v1.json');
  const realTrainPath = path.join(DATASETS_DIR, 'train_calibration', 'image_train_real_features.json');

  const db = getDb();

  if (!fs.existsSync(imgRfPath) || !fs.existsSync(imgLrPath) || !fs.existsSync(audLrPath)) {
    // Generate synthetic calibration distributions solely to fit legacy v1 heuristic baseline weights
    const imgSamples = generateImageCalibrationDataset();
    const audSamples = generateAudioCalibrationDataset();
    fs.writeFileSync(
      path.join(DATASETS_DIR, 'image_forensics_calibration.json'),
      JSON.stringify({ license: 'CC0-1.0 (Synthetic Heuristic Fitting)', features: IMAGE_FEATURES, samples: imgSamples }, null, 2),
    );
    fs.writeFileSync(
      path.join(DATASETS_DIR, 'audio_spoofing_calibration.json'),
      JSON.stringify({ license: 'CC0-1.0 (Synthetic Heuristic Fitting)', features: AUDIO_FEATURES, samples: audSamples }, null, 2),
    );

    const imgSplit = stratifiedSplit(imgSamples, 0.7, 101);
    const audSplit = stratifiedSplit(audSamples, 0.7, 202);

    const imgRf = trainRandomForest(
      'TL-ImgForensics-RF-v1',
      'TruthLens Image Forensics Random Forest (Legacy Synthetic Baseline)',
      '1.0.0',
      IMAGE_FEATURES,
      imgSplit.train,
      25,
    );
    fs.writeFileSync(imgRfPath, JSON.stringify(imgRf, null, 2));

    const imgLr = trainLogisticRegression(
      'TL-ImgForensics-LR-v1',
      'TruthLens Image Forensics Logistic Regression (Legacy Synthetic Baseline)',
      '1.0.0',
      IMAGE_FEATURES,
      imgSplit.train,
    );
    fs.writeFileSync(imgLrPath, JSON.stringify(imgLr, null, 2));

    const audLr = trainLogisticRegression(
      'TL-AudSpoof-LR-v1',
      'TruthLens Acoustic DSP Heuristic Classifier',
      '1.0.0',
      AUDIO_FEATURES,
      audSplit.train,
    );
    fs.writeFileSync(audLrPath, JSON.stringify(audLr, null, 2));
  }

  // Fit v2 classical image models strictly on disjoint real train-split JPEG features (never dev or held-out test)
  if ((!fs.existsSync(imgRfV2Path) || !fs.existsSync(imgLrV2Path)) && fs.existsSync(realTrainPath)) {
    const parsedTrain = JSON.parse(fs.readFileSync(realTrainPath, 'utf8')) as { samples: LabeledSample[] };
    if (Array.isArray(parsedTrain.samples) && parsedTrain.samples.length >= 20) {
      const rfV2 = trainRandomForest(
        'TL-ImgForensics-RF-v2',
        'TruthLens Image Signal Random Forest (Real-Feature Fit)',
        '2.0.0',
        IMAGE_FEATURES,
        parsedTrain.samples,
        35,
      );
      fs.writeFileSync(imgRfV2Path, JSON.stringify(rfV2, null, 2));

      const lrV2 = trainLogisticRegression(
        'TL-ImgForensics-LR-v2',
        'TruthLens Image Signal Logistic Regression (Real-Feature Fit)',
        '2.0.0',
        IMAGE_FEATURES,
        parsedTrain.samples,
        0.08,
        600,
        0.02,
      );
      fs.writeFileSync(imgLrV2Path, JSON.stringify(lrV2, null, 2));
    }
  }

  // Always refresh honest model registry & evaluation rows (never expose synthetic or training fit accuracy as real benchmarks)
  const now = new Date().toISOString();
  const upsertModel = db.prepare(`
    INSERT OR REPLACE INTO model_registry
    (id, name, version, modality, algorithm, source, checkpoint_path, license, input_spec, limitations, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const upsertEval = db.prepare(`
    INSERT OR REPLACE INTO model_evaluations
    (id, model_id, dataset_name, dataset_license, sample_count, accuracy, precision_score, recall_score, f1_score, roc_auc, fpr, confusion_matrix_json, notes, evaluated_at, eval_scope, benchmark_summary)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  upsertModel.run(
    'TL-ImgForensics-RF-v1',
    'TruthLens Image Signal Random Forest (Legacy Synthetic Baseline)',
    '1.0.0',
    'image',
    '25-Tree Bootstrap Random Forest over 8D Forensic Signals',
    'Local TruthLens Heuristic Weights (server/ml/trainer.ts)',
    'models/tl_img_forensics_rf_v1.json',
    'Apache-2.0',
    '8D forensic vector: ELA mean/P95/variance, noise floor std, 8x8 block ratio, saturation skew, EXIF integrity, HF drop ratio',
    'Legacy v1 baseline fit on synthetic Gaussian distributions (ELA mean ~7.6) that do not match real 256x256 JPEG scales (ELA mean ~0.52), causing 0% fake recall in Step 5 baseline validation.',
    now,
  );
  upsertEval.run(
    'EVAL-IMG-RF-V1',
    'TL-ImgForensics-RF-v1',
    'Synthetic Heuristic Prior (Legacy Baseline)',
    'CC0-1.0 (Synthetic Distributions Only)',
    0,
    -1,
    -1,
    -1,
    -1,
    -1,
    -1,
    '[]',
    'Legacy synthetic priors omitted (-1) from accuracy claims; Step 5 validation recorded 0% fake recall due to feature scale mismatch.',
    now,
    'synthetic_heuristic_uncalibrated',
    'Legacy synthetic baseline · Superseded by TL-ImgForensics-RF-v2',
  );

  upsertModel.run(
    'TL-ImgForensics-LR-v1',
    'TruthLens Image Signal Logistic Regression (Legacy Synthetic Baseline)',
    '1.0.0',
    'image',
    'L2-Regularized Logistic Regression over 8D Forensic Signals',
    'Local TruthLens Heuristic Weights (server/ml/trainer.ts)',
    'models/tl_img_forensics_lr_v1.json',
    'Apache-2.0',
    '8D standardized forensic signal vector (identical feature space to RF baseline)',
    'Legacy v1 baseline fit on synthetic Gaussian priors; failed to detect real fake JPEGs due to 10x–300x ELA scale mismatch.',
    now,
  );
  upsertEval.run(
    'EVAL-IMG-LR-V1',
    'TL-ImgForensics-LR-v1',
    'Synthetic Heuristic Prior (Legacy Baseline)',
    'CC0-1.0 (Synthetic Distributions Only)',
    0,
    -1,
    -1,
    -1,
    -1,
    -1,
    -1,
    '[]',
    'Legacy synthetic priors omitted (-1) from accuracy claims; Step 5 validation recorded 0% fake recall due to feature scale mismatch.',
    now,
    'synthetic_heuristic_uncalibrated',
    'Legacy synthetic linear baseline · Superseded by TL-ImgForensics-LR-v2',
  );

  if (fs.existsSync(imgRfV2Path)) {
    upsertModel.run(
      'TL-ImgForensics-RF-v2',
      'TruthLens Image Signal Random Forest (Real-JPEG Fit, Uncalibrated)',
      '2.0.0',
      'image',
      '35-Tree Bootstrap Random Forest over Real 8D Forensic Signals',
      'Disjoint train-split JPEGs (datasets/train_calibration/image_train_real_features.json)',
      'models/tl_img_forensics_rf_v2.json',
      'Apache-2.0',
      '8D forensic vector standardized against real 256x256 JPEG residuals (n=80 disjoint train split)',
      'Scalar ELA/noise statistics remain weak on whole-image StyleGAN portraits and compressed video frames compared to patch-based ViT; expect high FPR on overlapping residuals. Uncalibrated raw score only.',
      now,
    );
    upsertEval.run(
      'EVAL-IMG-RF-V2',
      'TL-ImgForensics-RF-v2',
      'Disjoint Real JPEG Train Fit (See Validation Runs for Held-Out Metrics)',
      'Research Evaluation (Disjoint Train Split Only)',
      80,
      -1,
      -1,
      -1,
      -1,
      -1,
      -1,
      '[]',
      'Fit on 80 disjoint train-split JPEGs; registry accuracy omitted (-1) so only blinded held-out Validation Runs report test performance.',
      now,
      'real_feature_fit_uncalibrated',
      'Fit on real JPEG scale · See blinded Validation Runs for measured accuracy/FPR',
    );
  }

  if (fs.existsSync(imgLrV2Path)) {
    upsertModel.run(
      'TL-ImgForensics-LR-v2',
      'TruthLens Image Signal Logistic Regression (Real-JPEG Fit, Uncalibrated)',
      '2.0.0',
      'image',
      'L2-Regularized Logistic Regression over Real 8D Forensic Signals',
      'Disjoint train-split JPEGs (datasets/train_calibration/image_train_real_features.json)',
      'models/tl_img_forensics_lr_v2.json',
      'Apache-2.0',
      '8D standardized forensic vector fit on 80 disjoint train-split JPEGs',
      'Linear boundary over 8 scalar pixel statistics cannot separate complex semantic deepfakes without high false-positive overlap; use as secondary signal check only.',
      now,
    );
    upsertEval.run(
      'EVAL-IMG-LR-V2',
      'TL-ImgForensics-LR-v2',
      'Disjoint Real JPEG Train Fit (See Validation Runs for Held-Out Metrics)',
      'Research Evaluation (Disjoint Train Split Only)',
      80,
      -1,
      -1,
      -1,
      -1,
      -1,
      -1,
      '[]',
      'Fit on 80 disjoint train-split JPEGs; registry accuracy omitted (-1) so only blinded held-out Validation Runs report test performance.',
      now,
      'real_feature_fit_uncalibrated',
      'Fit on real JPEG scale · See blinded Validation Runs for measured accuracy/FPR',
    );
  }

  upsertModel.run(
    'TL-AudSpoof-LR-v1',
    'TruthLens Acoustic DSP Logistic Regression (Uncalibrated Heuristic)',
    '1.0.0',
    'audio',
    'L2-Regularized Logistic Regression over 6D Acoustic DSP Metrics',
    'Local TruthLens Heuristic Weights (server/ml/trainer.ts)',
    'models/tl_aud_spoof_lr_v1.json',
    'Apache-2.0',
    '6D acoustic vector: spectral flatness mean/std, ZCR variance, HF rolloff ratio, silence floor kurtosis, harmonic jitter',
    'Fit on synthetic DSP distributions; heavy VoIP codecs, silence, or non-speech calibration tones trigger out-of-distribution scores. Treat outputs as uncalibrated raw scores.',
    now,
  );
  upsertEval.run(
    'EVAL-AUD-LR-V1',
    'TL-AudSpoof-LR-v1',
    'Synthetic DSP Heuristic Prior (No Real-World Speech Benchmark)',
    'CC0-1.0 (Synthetic Distributions Only)',
    0,
    -1,
    -1,
    -1,
    -1,
    -1,
    -1,
    '[]',
    'Synthetic split metrics are omitted (-1) to avoid fabricating acoustic detection accuracy. Rely on TL-AASIST-ONNX published ASVspoof benchmarks and direct waveform/spectrogram inspection.',
    now,
    'synthetic_heuristic_uncalibrated',
    'Uncalibrated DSP heuristic · Not benchmarked on real speech datasets (raw score only)',
  );

  // Always ensure genuine pretrained ONNX models are registered with honest published benchmarks (no synthetic metrics)
  ensurePretrainedModelsRegistered(db);
}

function ensurePretrainedModelsRegistered(db: ReturnType<typeof getDb>): void {
  const now = new Date().toISOString();
  const upsertModel = db.prepare(`
    INSERT OR REPLACE INTO model_registry
    (id, name, version, modality, algorithm, source, checkpoint_path, license, input_spec, limitations, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const upsertEval = db.prepare(`
    INSERT OR REPLACE INTO model_evaluations
    (id, model_id, dataset_name, dataset_license, sample_count, accuracy, precision_score, recall_score, f1_score, roc_auc, fpr, confusion_matrix_json, notes, evaluated_at, eval_scope, benchmark_summary)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  upsertModel.run(
    'TL-ViT-DFvReal-ONNX',
    'ViT-Base Deepfake vs Real Image Detector (INT8 ONNX)',
    '1.0.0-int8',
    'image',
    'Vision Transformer (ViT-Base-Patch16-224, INT8 Quantized ONNX CPU)',
    'huggingface.co/onnx-community/deepfake_vs_real_image_detection-ONNX (base: dima806/deepfake_vs_real_image_detection)',
    'models/pretrained/deepfake_vs_real_int8.onnx',
    'Apache-2.0',
    'RGB 224x224 bicubic tensor [1, 3, 224, 224], normalized (px/255 - 0.5)/0.5; outputs logits [Real, Fake]',
    'Trained on face-cropped deepfake vs real portrait benchmarks. Achieves strong separation on face-centered images without gray padding, but uncropped wide video scenes without a dedicated face detector or newer out-of-domain generators remain limited. Outputs uncalibrated softmax scores.',
    now,
  );
  upsertEval.run(
    'EVAL-VIT-DFVREAL',
    'TL-ViT-DFvReal-ONNX',
    'dima806/deepfake_vs_real_image_detection Upstream Model Card',
    'Apache-2.0 (Published Model Card Benchmark)',
    0,
    -1,
    0.9809,
    -1,
    -1,
    -1,
    -1,
    '[]',
    'Upstream model card reports ~98.09% classification accuracy on its 190k Kaggle face deepfake split. Local confusion matrix omitted (-1) here; inspect Validation Runs for blinded TruthLens evaluation.',
    now,
    'published_benchmark',
    'Upstream Acc: 98.09% (Kaggle face split) · Local confusion matrix via Validation Runs',
  );

  upsertModel.run(
    'TL-ViT-Deepfake-v2-ONNX',
    'ViT-Base Deepfake Detector v2 (Legacy Diagnostic Reference)',
    '2.0.0-q4',
    'image',
    'Vision Transformer (ViT-Base-Patch16-224, 4-bit Quantized ONNX CPU)',
    'huggingface.co/onnx-community/Deep-Fake-Detector-v2-Model-ONNX (base: prithivMLmods/Deep-Fake-Detector-v2-Model)',
    'models/pretrained/deepfake_detector_v2_q4.onnx',
    'Apache-2.0',
    'RGB 224x224 tensor [1, 3, 224, 224], normalized (px/255 - 0.5)/0.5; outputs logits [Realism, Deepfake]',
    'Retained as diagnostic baseline reference. Step 6 investigation confirmed inverted score behavior on 256x256 portrait benchmarks (18.8% acc, 87.5% FPR) persisted identically in INT8, ruling out Q4 quantization and implicating upstream domain mismatch.',
    now,
  );
  upsertEval.run(
    'EVAL-VIT-DEEPFAKE-V2',
    'TL-ViT-Deepfake-v2-ONNX',
    'prithivMLmods/Deep-Fake-Detector-v2-Model Upstream Evaluation (Failed Local Generalization)',
    'Apache-2.0 (Published Model Card Benchmark)',
    0,
    -1,
    0.9212,
    -1,
    -1,
    -1,
    -1,
    '[]',
    'Upstream model card reports 92.12% on its test split, but blinded local Step 5 validation (VALRUN-MWNLAXJW-KJS9) measured 18.8% overall accuracy / 87.5% FPR. Superseded by TL-ViT-DFvReal-ONNX.',
    now,
    'published_benchmark',
    'Upstream Card: 92.12% · Local Step 5 Baseline: 18.8% Acc / 87.5% FPR (Superseded)',
  );

  upsertModel.run(
    'TL-AASIST-ONNX',
    'AASIST Audio Anti-Spoofing Graph Attention Network (ONNX)',
    '1.0.0-asvspoof19',
    'audio',
    'RawNet2 Sinc-Conv + Spectro-Temporal Graph Attention (AASIST ONNX CPU)',
    'huggingface.co/SpeechAntiSpoofingBenchmarks/AASIST (upstream: clovaai/aasist)',
    'models/pretrained/aasist.onnx',
    'MIT',
    '16kHz mono float32 PCM waveform tensor [1, 64600] (4.0375s windows); outputs logits [Spoof, Bonafide]',
    'Trained on ASVspoof2019 Logical Access clean studio utterances. Generalization degrades under telephony/VoIP codecs and noisy environments (ASVspoof2021-LA 12.35% EER, ASVspoof2021-DF 17.04% EER, In-The-Wild 43.01% EER). Pure synthetic calibration tones or silence trigger elevated spoof logits.',
    now,
  );
  upsertEval.run(
    'EVAL-AASIST-ONNX',
    'TL-AASIST-ONNX',
    'SpeechAntiSpoofingBenchmarks / ASVspoof & In-The-Wild EER Benchmarks',
    'MIT / ODC-By (ASVspoof Published EER)',
    71237,
    -1,
    -1,
    -1,
    -1,
    -1,
    -1,
    '[]',
    'Published Equal Error Rates (EER): ASVspoof2019-LA = 0.83% (n=71,237); ASVspoof2021-LA = 12.35% (n=181,566); ASVspoof2021-DF = 17.04% (n=611,829); InTheWild = 43.01% (n=31,779). Lower EER is better. No synthetic local confusion matrix fabricated.',
    now,
    'published_benchmark',
    'ASVspoof19-LA: 0.83% EER · ASVspoof21-LA: 12.35% EER · ASVspoof21-DF: 17.04% EER · InTheWild: 43.01% EER',
  );
}
