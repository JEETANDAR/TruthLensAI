import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import { ARTIFACTS_DIR, SUBPROCESS_TIMEOUT_MS } from '../config.ts';
import { analyzeImageBufferMetrics, type ForensicIndicator } from './image.ts';
import { type AudioAnalysisResult, runAudioForensics } from './audio.ts';
import { inferImageForensicsFull, type InferenceOutput } from '../ml/inference.ts';
import {
  type DetectedFace,
  detectFacesInBuffer,
  FACE_DETECTOR_MODEL_ID,
  trackFacesAcrossFrames,
} from '../ml/faceDetector.ts';

const execFileAsync = promisify(execFile);

export interface VideoFrameSample {
  index: number;
  timestampSec: number;
  frameUrl: string;
  elaMean: number;
  noiseFloorStd: number;
  histogramDelta: number;
  temporalDelta: number;
  flagged: boolean;
  flagReason?: string;
  mlScore?: number;
  mlLabel?: string;
  mlModelId?: string;
  faces?: DetectedFace[];
}

export interface VideoAnalysisResult {
  metrics: Record<string, number | string | boolean | null>;
  sampledFrames: VideoFrameSample[];
  embeddedAudio: (AudioAnalysisResult & { audioUrl: string }) | null;
  indicators: ForensicIndicator[];
  mlPredictions: InferenceOutput[];
  limitations: string;
}

function parseFrameRate(rateStr?: string): number {
  if (!rateStr) return 0;
  const parts = rateStr.split('/');
  if (parts.length === 2) {
    const num = Number(parts[0]);
    const den = Number(parts[1]);
    return den > 0 ? Number((num / den).toFixed(3)) : 0;
  }
  return Number(rateStr) || 0;
}

function classifyScore(score: number): InferenceOutput['predictionLabel'] {
  if (score >= 0.65) return 'elevated_anomaly';
  if (score >= 0.4) return 'inconclusive_review';
  return 'consistent_baseline';
}

export async function runVideoForensics(
  evidenceId: string,
  filePath: string,
): Promise<VideoAnalysisResult> {
  if (!fs.existsSync(filePath) || fs.statSync(filePath).size < 64) {
    throw new Error('Video file is missing, empty, or too small to contain valid frames.');
  }

  let probe: { format?: Record<string, string | number>; streams?: Array<Record<string, string | number>> };
  try {
    const { stdout: probeOut } = await execFileAsync(
      'ffprobe',
      ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath],
      { timeout: SUBPROCESS_TIMEOUT_MS },
    );
    probe = JSON.parse(probeOut || '{}');
  } catch (err) {
    throw new Error(
      `Unsupported or corrupt video container: ${err instanceof Error ? err.message : 'ffprobe failed'}`,
    );
  }

  const videoStream = (probe.streams || []).find((s) => s.codec_type === 'video');
  const audioStream = (probe.streams || []).find((s) => s.codec_type === 'audio');

  if (!videoStream || Number(videoStream.width || 0) <= 0 || Number(videoStream.height || 0) <= 0) {
    throw new Error('Video container has no valid decodable video stream or frame dimensions.');
  }

  const durationSec = Number(Number(probe.format?.duration || videoStream.duration || 0).toFixed(3));
  const audioDurationSec = audioStream ? Number(Number(audioStream.duration || durationSec).toFixed(3)) : null;
  const avDurationDesyncSec =
    audioDurationSec !== null ? Number(Math.abs(durationSec - audioDurationSec).toFixed(3)) : 0;
  const fps = parseFrameRate(String(videoStream.avg_frame_rate || videoStream.r_frame_rate || ''));
  const width = Number(videoStream.width || 0);
  const height = Number(videoStream.height || 0);
  const codec = String(videoStream.codec_name || 'unknown');
  const estimatedTotalFrames = durationSec > 0 && fps > 0 ? Math.round(durationSec * fps) : 0;

  // Sample up to 24 evenly spaced keyframes deterministically
  const sampleCount = durationSec > 0 ? Math.min(24, Math.max(6, Math.ceil(durationSec * 2))) : 6;
  const frameDir = path.join(ARTIFACTS_DIR, `frames_${evidenceId}`);
  fs.mkdirSync(frameDir, { recursive: true });

  const sampledFrames: VideoFrameSample[] = [];
  const rawFrameFaces: DetectedFace[][] = [];
  let prevEla = 0;
  let prevNoise = 0;
  let prevHist: number[] | null = null;

  for (let i = 0; i < sampleCount; i++) {
    const t =
      durationSec > 0.2
        ? Number(((i / Math.max(1, sampleCount - 1)) * Math.max(0.1, durationSec - 0.12)).toFixed(2))
        : 0;
    const frameFile = `frame_${String(i + 1).padStart(2, '0')}.jpg`;
    const frameOutPath = path.join(frameDir, frameFile);

    try {
      await execFileAsync(
        'ffmpeg',
        ['-y', '-ss', String(t), '-i', filePath, '-frames:v', '1', '-q:v', '2', frameOutPath],
        { timeout: SUBPROCESS_TIMEOUT_MS },
      );
    } catch {
      // allow partial timestamp failure only if other frames decode cleanly
    }

    if (fs.existsSync(frameOutPath) && fs.statSync(frameOutPath).size > 64) {
      const buf = fs.readFileSync(frameOutPath);
      const fm = await analyzeImageBufferMetrics(buf);
      let frameFaces: DetectedFace[] = [];
      try {
        frameFaces = await detectFacesInBuffer(buf, { confThreshold: 0.65, maxFaces: 4 });
      } catch {
        frameFaces = [];
      }
      rawFrameFaces.push(frameFaces);

      const histDelta =
        prevHist !== null
          ? Number(
              prevHist
                .reduce((acc, v, idx) => acc + Math.abs(v - (fm.lumaHistogram[idx] || 0)), 0)
                .toFixed(4),
            )
          : 0;
      const temporalDelta =
        i === 0
          ? 0
          : Number(
              (
                Math.abs(fm.elaMean - prevEla) +
                Math.abs(fm.noiseFloorStd - prevNoise) * 0.5 +
                histDelta * 6.5
              ).toFixed(3),
            );
      prevEla = fm.elaMean;
      prevNoise = fm.noiseFloorStd;
      prevHist = fm.lumaHistogram;

      sampledFrames.push({
        index: sampledFrames.length + 1,
        timestampSec: t,
        frameUrl: `/api/artifacts/frames_${evidenceId}/${frameFile}`,
        elaMean: fm.elaMean,
        noiseFloorStd: fm.noiseFloorStd,
        histogramDelta: histDelta,
        temporalDelta,
        flagged: false,
      });
    }
  }

  if (sampledFrames.length === 0) {
    throw new Error('FFmpeg failed to extract any valid video frames from this file.');
  }

  // Cross-frame IoU + centroid tracking across sampled keyframes
  const { trackedFrames, uniqueTrackCount } = trackFacesAcrossFrames(rawFrameFaces);
  let framesWithFacesCount = 0;
  let totalDetectedFaces = 0;
  sampledFrames.forEach((frame, idx) => {
    const tracked = trackedFrames[idx] || [];
    frame.faces = tracked;
    if (tracked.length > 0) {
      framesWithFacesCount++;
      totalDetectedFaces += tracked.length;
    }
  });

  // Flag frames with temporal delta or ELA outlier (> mean + 1.35 * std)
  const deltas = sampledFrames.slice(1).map((f) => f.temporalDelta);
  const meanDelta = deltas.length > 0 ? deltas.reduce((a, b) => a + b, 0) / deltas.length : 0;
  const stdDelta =
    deltas.length > 0
      ? Math.sqrt(deltas.reduce((acc, d) => acc + (d - meanDelta) * (d - meanDelta), 0) / deltas.length)
      : 0;

  const indicators: ForensicIndicator[] = [];
  for (const frame of sampledFrames) {
    if (
      frame.index > 1 &&
      ((frame.temporalDelta > meanDelta + 1.35 * stdDelta && frame.temporalDelta > 0.9) ||
        frame.histogramDelta > 0.28)
    ) {
      frame.flagged = true;
      frame.flagReason = `Inter-frame jump (Δ=${frame.temporalDelta.toFixed(
        2,
      )}, hist=${frame.histogramDelta.toFixed(2)} vs baseline ${meanDelta.toFixed(2)})`;
      indicators.push({
        id: `IND-${evidenceId}-F${frame.index}`,
        category: 'Temporal Drift',
        severity: frame.histogramDelta > 0.38 || frame.temporalDelta > 2.2 ? 'warning' : 'info',
        sourceLayer: 'forensic_signal',
        evidenceRef: evidenceId,
        title: `Temporal residual/luminance shift at ${frame.timestampSec.toFixed(2)}s`,
        detail: `Sampled frame #${frame.index} shows inter-frame delta=${frame.temporalDelta.toFixed(
          2,
        )} (luminance histogram shift=${frame.histogramDelta.toFixed(
          2,
        )}). May reflect scene cut, splice, or GOP bitrate change.`,
      });
    }
  }

  if (audioStream && avDurationDesyncSec > 0.35) {
    indicators.push({
      id: `IND-${evidenceId}-AV-DESYNC`,
      category: 'Container Sync',
      severity: 'warning',
      sourceLayer: 'forensic_signal',
      evidenceRef: evidenceId,
      title: `Embedded A/V stream duration mismatch (${avDurationDesyncSec}s)`,
      detail: `Video stream (${durationSec}s) differs from embedded audio track (${audioDurationSec}s) by ${avDurationDesyncSec}s.`,
    });
  }

  if (framesWithFacesCount === 0) {
    indicators.push({
      id: `IND-${evidenceId}-NO-FACE`,
      category: 'Face Region Tracking',
      severity: 'warning',
      sourceLayer: 'forensic_signal',
      evidenceRef: evidenceId,
      title: 'No facial regions detected across sampled keyframes',
      detail: `${FACE_DETECTOR_MODEL_ID} found 0 faces across ${sampledFrames.length} frames; face-crop deepfake detector could not evaluate facial synthesis and fell back to whole-frame checks.`,
    });
  } else {
    const firstFaceFrame = sampledFrames.find((f) => (f.faces?.length || 0) > 0);
    const firstFace = firstFaceFrame?.faces?.[0];
    indicators.push({
      id: `IND-${evidenceId}-FACE-TRACK`,
      category: 'Face Region Tracking',
      severity: 'info',
      sourceLayer: 'forensic_signal',
      evidenceRef: evidenceId,
      title: `Tracked ${uniqueTrackCount} face track(s) across ${framesWithFacesCount}/${sampledFrames.length} keyframes`,
      detail: `${FACE_DETECTOR_MODEL_ID} localized ${totalDetectedFaces} total face detections; aligned 2.0× square face crops evaluated with ViT.`,
      evidenceRegion: firstFace
        ? { xPct: firstFace.xPct, yPct: firstFace.yPct, wPct: firstFace.wPct, hPct: firstFace.hPct }
        : undefined,
    });
  }

  // Evaluate visual ML classifiers on up to 6 distributed keyframes (prioritizing frames with tracked faces)
  const mlPredictions: InferenceOutput[] = [];
  let framesMlEvaluated = 0;
  let faceCropsEvaluated = 0;

  if (sampledFrames.length > 0) {
    const faceIdxList = sampledFrames
      .map((f, idx) => ({ idx, hasFace: (f.faces?.length || 0) > 0 }))
      .filter((x) => x.hasFace)
      .map((x) => x.idx);

    const pickIndices = new Set<number>();
    if (faceIdxList.length > 0) {
      // Sample evenly across face-bearing keyframes so face crops are inspected throughout the clip
      const targetFaceCount = Math.min(6, faceIdxList.length);
      for (let k = 0; k < targetFaceCount; k++) {
        const pos =
          targetFaceCount === 1
            ? 0
            : Math.round((k / (targetFaceCount - 1)) * (faceIdxList.length - 1));
        pickIndices.add(faceIdxList[pos]);
      }
    } else {
      pickIndices.add(0);
      pickIndices.add(Math.floor((sampledFrames.length - 1) / 2));
      pickIndices.add(sampledFrames.length - 1);
    }

    const rankedByDelta = [...sampledFrames]
      .sort((a, b) => b.temporalDelta + b.elaMean * 0.5 - (a.temporalDelta + a.elaMean * 0.5))
      .slice(0, 2);
    for (const rf of rankedByDelta) {
      if (pickIndices.size >= 6) break;
      const idx = sampledFrames.findIndex((f) => f.index === rf.index);
      if (idx >= 0 && (faceIdxList.length === 0 || (sampledFrames[idx].faces?.length || 0) > 0)) {
        pickIndices.add(idx);
      }
    }

    const chosenFrames = Array.from(pickIndices)
      .sort((a, b) => a - b)
      .slice(0, 6)
      .map((i) => sampledFrames[i]);

    const perModelSamples = new Map<
      string,
      Array<{ frameIndex: number; timestampSec: number; rawScore: number; uncertaintyNote: string; hadFace: boolean }>
    >();

    for (const frame of chosenFrames) {
      const fFile = path.basename(frame.frameUrl);
      const fPath = path.join(frameDir, fFile);
      if (!fs.existsSync(fPath)) continue;
      const fBuf = fs.readFileSync(fPath);
      const fm = await analyzeImageBufferMetrics(fBuf);
      const frameFaces = frame.faces || [];
      if (frameFaces.length > 0) faceCropsEvaluated++;

      const preds = await inferImageForensicsFull(
        [
          fm.elaMean,
          fm.elaP95,
          fm.elaSpatialVariance,
          fm.noiseFloorStd,
          fm.blockArtifactRatio,
          fm.saturationSkew,
          1, // Extracted frames lack camera EXIF
          fm.highFreqDropRatio,
        ],
        fBuf,
        frameFaces,
      );
      framesMlEvaluated++;
      const primary = preds[0];
      if (primary) {
        frame.mlScore = primary.rawScore;
        frame.mlLabel = primary.predictionLabel;
        frame.mlModelId = primary.modelId;
        if (frameFaces.length > 0) {
          frameFaces[0].mlScore = primary.rawScore;
          frameFaces[0].mlLabel = primary.predictionLabel;
        }
        if (primary.rawScore >= 0.65 && !frame.flagged) {
          frame.flagged = true;
          frame.flagReason = `Face-crop visual ML score ${(primary.rawScore * 100).toFixed(1)} (${primary.modelId})`;
        }
      }
      for (const p of preds) {
        const arr = perModelSamples.get(p.modelId) || [];
        arr.push({
          frameIndex: frame.index,
          timestampSec: frame.timestampSec,
          rawScore: p.rawScore,
          uncertaintyNote: p.uncertaintyNote,
          hadFace: frameFaces.length > 0,
        });
        perModelSamples.set(p.modelId, arr);
      }
    }

    for (const [modelId, entries] of perModelSamples.entries()) {
      const sorted = [...entries].sort((a, b) => a.rawScore - b.rawScore);
      const peak = sorted[sorted.length - 1];
      const mid = Math.floor(sorted.length / 2);
      const medianScore =
        sorted.length % 2 === 1
          ? sorted[mid].rawScore
          : (sorted[mid - 1].rawScore + sorted[mid].rawScore) / 2;
      const meanScore = entries.reduce((acc, e) => acc + e.rawScore, 0) / entries.length;
      const aggScore = Number(((medianScore + meanScore) / 2).toFixed(4));
      const faceUsed = entries.some((e) => e.hadFace);
      mlPredictions.push({
        modelId,
        predictionLabel: classifyScore(aggScore),
        rawScore: aggScore,
        uncertaintyNote: `UNCALIBRATED RAW SCORE across ${entries.length} video keyframes (${
          faceUsed
            ? `aligned 2.0× face crops via ${FACE_DETECTOR_MODEL_ID}`
            : 'NO faces detected — full/center-frame fallback only'
        }; median=${(medianScore * 100).toFixed(1)}, mean=${(meanScore * 100).toFixed(1)}, peak=${(
          peak.rawScore * 100
        ).toFixed(1)} at ${peak.timestampSec.toFixed(2)}s). ${peak.uncertaintyNote}`,
        featureContributions: entries.map((e) => ({
          feature: `Frame #${e.frameIndex} (${e.timestampSec.toFixed(2)}s${e.hadFace ? ' · Face Crop' : ''})`,
          value: e.rawScore,
          impact: Number((e.rawScore - 0.5).toFixed(4)),
        })),
      });
    }
  }

  // Extract & analyze embedded audio stream via FFmpeg + AASIST when present
  let embeddedAudio: (AudioAnalysisResult & { audioUrl: string }) | null = null;
  if (audioStream) {
    const audioFilename = `vid_audio_${evidenceId}.wav`;
    const audioOutPath = path.join(ARTIFACTS_DIR, audioFilename);
    try {
      await execFileAsync(
        'ffmpeg',
        ['-y', '-i', filePath, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', audioOutPath],
        { timeout: SUBPROCESS_TIMEOUT_MS },
      );
      if (!fs.existsSync(audioOutPath) || fs.statSync(audioOutPath).size <= 256) {
        throw new Error('Extracted audio stream produced 0 usable PCM bytes.');
      }
      const audRes = await runAudioForensics(`${evidenceId}_AUD`, audioOutPath);
      embeddedAudio = {
        ...audRes,
        audioUrl: `/api/artifacts/${audioFilename}`,
      };

      for (const aInd of audRes.indicators) {
        indicators.push({
          ...aInd,
          id: `${aInd.id}-EMB`,
          category: `Embedded Audio · ${aInd.category}`,
          evidenceRef: evidenceId,
          title: `[Video Audio Track] ${aInd.title}`,
        });
      }
      for (const aPred of audRes.mlPredictions) {
        mlPredictions.push({
          ...aPred,
          uncertaintyNote: `[Embedded Video Audio Track] ${aPred.uncertaintyNote}`,
        });
      }
    } catch (err) {
      indicators.push({
        id: `IND-${evidenceId}-AUD-ERR`,
        category: 'Embedded Audio',
        severity: 'warning',
        sourceLayer: 'forensic_signal',
        evidenceRef: evidenceId,
        title: 'Embedded audio track extraction/analysis failed',
        detail: `Video advertises an audio stream (${String(
          audioStream.codec_name || 'unknown',
        )}) that could not be decoded cleanly (not marked authentic): ${
          err instanceof Error ? err.message : 'ffmpeg audio decode error'
        }`,
      });
    }
  }

  if (indicators.length === 0) {
    indicators.push({
      id: `IND-${evidenceId}-TEMP-OK`,
      category: 'Temporal Consistency',
      severity: 'info',
      sourceLayer: 'forensic_signal',
      evidenceRef: evidenceId,
      title: 'Consistent inter-frame residuals across sampled keyframes',
      detail: `Analyzed ${sampledFrames.length} sampled keyframes across ${durationSec}s; no sharp temporal noise or histogram discontinuities observed.`,
    });
  }

  return {
    metrics: {
      durationSec,
      fps,
      width,
      height,
      resolution: `${width}x${height}`,
      codec,
      bitrateBps: Number(probe.format?.bit_rate || 0),
      hasAudioTrack: Boolean(audioStream),
      audioCodec: audioStream ? String(audioStream.codec_name || 'unknown') : 'none',
      embeddedAudioAnalyzed: Boolean(embeddedAudio),
      avDurationDesyncSec,
      sampledFrameCount: sampledFrames.length,
      framesMlEvaluated,
      faceCropsEvaluated,
      framesWithFacesCount,
      uniqueFaceTracksCount: uniqueTrackCount,
      detectedFacesCount: totalDetectedFaces,
      faceDetectorModel: FACE_DETECTOR_MODEL_ID,
      estimatedTotalFrames,
      samplingCoverageNote: `Sampled ${sampledFrames.length} of ~${estimatedTotalFrames} frames; localized faces in ${framesWithFacesCount} frames (${uniqueTrackCount} track(s)); ${faceCropsEvaluated}/${framesMlEvaluated} ML frames used aligned face crops`,
    },
    sampledFrames,
    embeddedAudio,
    indicators,
    mlPredictions,
    limitations: `Temporal analysis inspected ${sampledFrames.length} sampled keyframes (${framesMlEvaluated} evaluated with ViT/RF/LR; ${
      framesWithFacesCount > 0
        ? `${framesWithFacesCount} keyframes contained ${uniqueTrackCount} tracked face(s) evaluated via 2.0× aligned crops`
        : '0 faces detected — face-swap evaluation limited to full-frame fallback'
    })${
      embeddedAudio
        ? ', plus 16kHz embedded audio track forensics (FFT + AASIST)'
        : audioStream
        ? ', while embedded audio decoding failed (audio authenticity unverified)'
        : ', and video contains no embedded audio stream'
    }. Un-sampled intermediate frames and subtle lip-sync micro-offsets are not measured locally without multimodal AI review.`,
  };
}
