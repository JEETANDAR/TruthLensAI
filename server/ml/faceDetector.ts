import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import * as ort from 'onnxruntime-node';
import { PRETRAINED_MODELS_DIR } from '../config.ts';

export const FACE_DETECTOR_MODEL_ID = 'UltraFace-RFB-320-ONNX';
const ULTRAFACE_FILENAME = 'ultraface_rfb_320.onnx';
const ULTRAFACE_WIDTH = 320;
const ULTRAFACE_HEIGHT = 240;

export interface DetectedFace {
  x: number;
  y: number;
  w: number;
  h: number;
  xPct: number;
  yPct: number;
  wPct: number;
  hPct: number;
  confidence: number;
  trackId?: string;
  mlScore?: number;
  mlLabel?: string;
}

let ultraFaceSessionPromise: Promise<ort.InferenceSession | null> | null = null;

export function isFaceDetectorAvailable(): boolean {
  const modelPath = path.join(PRETRAINED_MODELS_DIR, ULTRAFACE_FILENAME);
  return fs.existsSync(modelPath) && fs.statSync(modelPath).size > 100_000;
}

export function getFaceDetectorPath(): string {
  return `models/pretrained/${ULTRAFACE_FILENAME}`;
}

async function getUltraFaceSession(): Promise<ort.InferenceSession | null> {
  if (!ultraFaceSessionPromise) {
    ultraFaceSessionPromise = (async () => {
      const modelPath = path.join(PRETRAINED_MODELS_DIR, ULTRAFACE_FILENAME);
      if (!fs.existsSync(modelPath) || fs.statSync(modelPath).size < 100_000) {
        return null;
      }
      return ort.InferenceSession.create(modelPath, {
        executionProviders: ['cpu'],
        graphOptimizationLevel: 'all',
        logSeverityLevel: 3, // suppress benign ONNX initializer warnings
      });
    })().catch(() => null);
  }
  return ultraFaceSessionPromise;
}

function iou(a: { x1: number; y1: number; x2: number; y2: number }, b: { x1: number; y1: number; x2: number; y2: number }): number {
  const ix1 = Math.max(a.x1, b.x1);
  const iy1 = Math.max(a.y1, b.y1);
  const ix2 = Math.min(a.x2, b.x2);
  const iy2 = Math.min(a.y2, b.y2);
  const iw = Math.max(0, ix2 - ix1);
  const ih = Math.max(0, iy2 - iy1);
  const inter = iw * ih;
  if (inter <= 0) return 0;
  const areaA = Math.max(1e-6, (a.x2 - a.x1) * (a.y2 - a.y1));
  const areaB = Math.max(1e-6, (b.x2 - b.x1) * (b.y2 - b.y1));
  return inter / (areaA + areaB - inter);
}

/**
 * Runs UltraFace-RFB-320 ONNX (MIT license) face detection on an RGB image buffer.
 * Standard preprocessing: resize RGB 320x240, normalize (px - 127.0) / 128.0.
 * Output boxes are normalized [x1, y1, x2, y2] in [0, 1]; scores[:, 1] is face confidence.
 */
export async function detectFacesInBuffer(
  imageBuffer: Buffer,
  opts?: { confThreshold?: number; iouThreshold?: number; maxFaces?: number; minBoxRatio?: number },
): Promise<DetectedFace[]> {
  const session = await getUltraFaceSession();
  if (!session) return [];

  const confThreshold = opts?.confThreshold ?? 0.65;
  const iouThreshold = opts?.iouThreshold ?? 0.3;
  const maxFaces = opts?.maxFaces ?? 8;
  const minBoxRatio = opts?.minBoxRatio ?? 0.04;

  const meta = await sharp(imageBuffer).metadata();
  const imgW = meta.width || 0;
  const imgH = meta.height || 0;
  if (imgW < 16 || imgH < 16) return [];

  const { data } = await sharp(imageBuffer)
    .removeAlpha()
    .resize(ULTRAFACE_WIDTH, ULTRAFACE_HEIGHT, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const pixels = ULTRAFACE_WIDTH * ULTRAFACE_HEIGHT;
  const chw = new Float32Array(3 * pixels);
  for (let i = 0; i < pixels; i++) {
    const base = i * 3;
    chw[i] = (data[base] - 127.0) / 128.0;
    chw[pixels + i] = (data[base + 1] - 127.0) / 128.0;
    chw[2 * pixels + i] = (data[base + 2] - 127.0) / 128.0;
  }

  const tensor = new ort.Tensor('float32', chw, [1, 3, ULTRAFACE_HEIGHT, ULTRAFACE_WIDTH]);
  const outputs = await session.run({ input: tensor });

  const scoresData = outputs.scores?.data as Float32Array | undefined;
  const boxesData = outputs.boxes?.data as Float32Array | undefined;
  if (!scoresData || !boxesData) return [];

  const count = Math.min(Math.floor(scoresData.length / 2), Math.floor(boxesData.length / 4));
  const candidates: Array<{ x1: number; y1: number; x2: number; y2: number; conf: number }> = [];

  for (let i = 0; i < count; i++) {
    const conf = Number(scoresData[i * 2 + 1]);
    if (conf < confThreshold) continue;
    const x1 = Math.max(0, Math.min(1, Number(boxesData[i * 4])));
    const y1 = Math.max(0, Math.min(1, Number(boxesData[i * 4 + 1])));
    const x2 = Math.max(0, Math.min(1, Number(boxesData[i * 4 + 2])));
    const y2 = Math.max(0, Math.min(1, Number(boxesData[i * 4 + 3])));
    const wNorm = x2 - x1;
    const hNorm = y2 - y1;
    if (wNorm < minBoxRatio || hNorm < minBoxRatio) continue;
    candidates.push({ x1, y1, x2, y2, conf });
  }

  candidates.sort((a, b) => b.conf - a.conf);

  const selected: typeof candidates = [];
  for (const c of candidates) {
    let suppressed = false;
    for (const s of selected) {
      if (iou(c, s) > iouThreshold) {
        suppressed = true;
        break;
      }
    }
    if (!suppressed) {
      selected.push(c);
      if (selected.length >= maxFaces) break;
    }
  }

  return selected
    .map((c) => {
      const x = Math.max(0, Math.round(c.x1 * imgW));
      const y = Math.max(0, Math.round(c.y1 * imgH));
      const w = Math.max(1, Math.min(imgW - x, Math.round((c.x2 - c.x1) * imgW)));
      const h = Math.max(1, Math.min(imgH - y, Math.round((c.y2 - c.y1) * imgH)));
      return {
        x,
        y,
        w,
        h,
        xPct: Number((c.x1 * 100).toFixed(1)),
        yPct: Number((c.y1 * 100).toFixed(1)),
        wPct: Number(((c.x2 - c.x1) * 100).toFixed(1)),
        hPct: Number(((c.y2 - c.y1) * 100).toFixed(1)),
        confidence: Number(c.conf.toFixed(4)),
      };
    })
    .sort((a, b) => b.confidence * b.w * b.h - a.confidence * a.w * a.h);
}

/**
 * Extracts a head-and-shoulders padded square face crop (default 2.0x face box) centered on the detected face,
 * matching ViT portrait training distributions without tight-crop clipping or double-JPEG artifacts.
 */
export async function extractAlignedFaceCrop(
  imageBuffer: Buffer,
  face: DetectedFace,
  paddingScale = 2.0,
): Promise<Buffer> {
  const meta = await sharp(imageBuffer).metadata();
  const imgW = meta.width || 1;
  const imgH = meta.height || 1;

  const cx = face.x + face.w / 2;
  const cy = face.y + face.h / 2;
  const side = Math.min(Math.min(imgW, imgH), Math.max(32, Math.round(Math.max(face.w, face.h) * paddingScale)));

  const left = Math.max(0, Math.min(imgW - side, Math.round(cx - side / 2)));
  const top = Math.max(0, Math.min(imgH - side, Math.round(cy - side / 2)));
  const extractW = Math.min(imgW - left, side);
  const extractH = Math.min(imgH - top, side);

  return sharp(imageBuffer)
    .extract({ left, top, width: Math.max(1, extractW), height: Math.max(1, extractH) })
    .png()
    .toBuffer();
}

/**
 * Lightweight IoU + centroid distance cross-frame face tracker.
 * Assigns deterministic trackId labels (F-1, F-2, ...) across sampled video keyframes.
 */
export function trackFacesAcrossFrames(perFrameFaces: DetectedFace[][]): {
  trackedFrames: DetectedFace[][];
  uniqueTrackCount: number;
} {
  interface ActiveTrack {
    trackId: string;
    xPct: number;
    yPct: number;
    wPct: number;
    hPct: number;
  }

  const activeTracks: ActiveTrack[] = [];
  let nextTrackNum = 1;
  const trackedFrames: DetectedFace[][] = [];

  for (const faces of perFrameFaces) {
    const usedTrackIds = new Set<string>();
    const assigned: DetectedFace[] = [];

    for (const face of faces) {
      let bestTrack: ActiveTrack | null = null;
      let bestScore = -1;

      const fx1 = face.xPct;
      const fy1 = face.yPct;
      const fx2 = face.xPct + face.wPct;
      const fy2 = face.yPct + face.hPct;
      const fcx = face.xPct + face.wPct / 2;
      const fcy = face.yPct + face.hPct / 2;

      for (const tr of activeTracks) {
        if (usedTrackIds.has(tr.trackId)) continue;
        const boxOverlap = iou(
          { x1: fx1, y1: fy1, x2: fx2, y2: fy2 },
          { x1: tr.xPct, y1: tr.yPct, x2: tr.xPct + tr.wPct, y2: tr.yPct + tr.hPct },
        );
        const tcx = tr.xPct + tr.wPct / 2;
        const tcy = tr.yPct + tr.hPct / 2;
        const centerDist = Math.hypot(fcx - tcx, fcy - tcy);

        if (boxOverlap >= 0.15 || centerDist <= 18) {
          const matchScore = boxOverlap * 2 + Math.max(0, 1 - centerDist / 25);
          if (matchScore > bestScore) {
            bestScore = matchScore;
            bestTrack = tr;
          }
        }
      }

      if (bestTrack) {
        usedTrackIds.add(bestTrack.trackId);
        bestTrack.xPct = face.xPct;
        bestTrack.yPct = face.yPct;
        bestTrack.wPct = face.wPct;
        bestTrack.hPct = face.hPct;
        assigned.push({ ...face, trackId: bestTrack.trackId });
      } else {
        const trackId = `F-${nextTrackNum++}`;
        const newTrack: ActiveTrack = {
          trackId,
          xPct: face.xPct,
          yPct: face.yPct,
          wPct: face.wPct,
          hPct: face.hPct,
        };
        activeTracks.push(newTrack);
        usedTrackIds.add(trackId);
        assigned.push({ ...face, trackId });
      }
    }

    trackedFrames.push(assigned);
  }

  return { trackedFrames, uniqueTrackCount: nextTrackNum - 1 };
}
