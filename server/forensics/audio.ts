import { execFile } from 'child_process';
import fs from 'fs';
import { promisify } from 'util';
import { SUBPROCESS_TIMEOUT_MS } from '../config.ts';
import type { ForensicIndicator } from './image.ts';
import { inferAudioSpoofingFull, type InferenceOutput } from '../ml/inference.ts';

const execFileAsync = promisify(execFile);

export interface WaveformPoint {
  timeSec: number;
  rms: number;
  peak: number;
}

export interface SpectrogramSlice {
  timeSec: number;
  bands: number[]; // 24 frequency bands across 0-8 kHz (0..1)
}

export interface AudioSegment {
  id: string;
  startSec: number;
  endSec: number;
  rmsDb: number;
  spectralFlatness: number;
  flagged: boolean;
  note: string;
}

export interface AudioAnalysisResult {
  metrics: Record<string, number | string | boolean | null>;
  waveform: WaveformPoint[];
  spectrogram: SpectrogramSlice[];
  segments: AudioSegment[];
  indicators: ForensicIndicator[];
  mlPredictions: InferenceOutput[];
  limitations: string;
}

// In-place radix-2 Cooley-Tukey FFT on power-of-2 real array
function fftMagnitude(frame: Float32Array): Float32Array {
  const n = frame.length;
  const re = new Float32Array(n);
  const im = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    // Hann window
    const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
    re[i] = frame[i] * w;
  }

  let j = 0;
  for (let i = 0; i < n; i++) {
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
    let m = n >> 1;
    while (m >= 1 && j >= m) {
      j -= m;
      m >>= 1;
    }
    j += m;
  }

  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = (-2 * Math.PI) / size;
    for (let i = 0; i < n; i += size) {
      for (let k = 0; k < half; k++) {
        const angle = k * step;
        const wr = Math.cos(angle);
        const wi = Math.sin(angle);
        const tr = wr * re[i + k + half] - wi * im[i + k + half];
        const ti = wr * im[i + k + half] + wi * re[i + k + half];
        re[i + k + half] = re[i + k] - tr;
        im[i + k + half] = im[i + k] - ti;
        re[i + k] += tr;
        im[i + k] += ti;
      }
    }
  }

  const mag = new Float32Array(n >> 1);
  for (let i = 0; i < n >> 1; i++) {
    mag[i] = Math.sqrt(re[i] * re[i] + im[i] * im[i]);
  }
  return mag;
}

export async function runAudioForensics(
  evidenceId: string,
  filePath: string,
): Promise<AudioAnalysisResult> {
  if (!fs.existsSync(filePath) || fs.statSync(filePath).size < 64) {
    throw new Error('Audio file is missing, empty, or too small to contain valid audio data.');
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
      `Unsupported or corrupt audio container: ${err instanceof Error ? err.message : 'ffprobe failed'}`,
    );
  }

  const audioStream = (probe.streams || []).find((s) => s.codec_type === 'audio');
  if (!audioStream) {
    throw new Error('Container has no valid decodable audio stream (never marked authentic).');
  }

  const durationSec = Number(Number(probe.format?.duration || audioStream.duration || 0).toFixed(3));
  const sampleRate = Number(audioStream.sample_rate || 16000);
  const channels = Number(audioStream.channels || 1);
  const codec = String(audioStream.codec_name || 'unknown');

  // Decode to 16kHz mono signed 16-bit PCM
  let pcmBuf: Buffer;
  try {
    const out = await execFileAsync(
      'ffmpeg',
      ['-v', 'error', '-i', filePath, '-f', 's16le', '-ac', '1', '-ar', '16000', 'pipe:1'],
      { encoding: 'buffer', maxBuffer: 25 * 1024 * 1024, timeout: SUBPROCESS_TIMEOUT_MS },
    );
    pcmBuf = out.stdout;
  } catch (err) {
    throw new Error(
      `Audio stream PCM decode failed (never marked authentic): ${err instanceof Error ? err.message : 'ffmpeg error'}`,
    );
  }

  const totalSamples = Math.floor(pcmBuf.length / 2);
  if (totalSamples < 400) {
    throw new Error(
      `Decoded PCM stream is too short or corrupt (${totalSamples} samples at 16kHz); audio analysis failed.`,
    );
  }

  const samples = new Float32Array(totalSamples);
  let clippedCount = 0;
  let silentCount = 0;
  for (let i = 0; i < totalSamples; i++) {
    const val = pcmBuf.readInt16LE(i * 2) / 32768;
    samples[i] = val;
    const av = Math.abs(val);
    if (av >= 0.99) clippedCount++;
    if (av < 0.002) silentCount++;
  }

  const effectiveDuration = durationSec > 0 ? durationSec : Number((totalSamples / 16000).toFixed(3));
  const clippingRatio = Number((clippedCount / Math.max(1, totalSamples)).toFixed(5));
  const silenceRatio = Number((silentCount / Math.max(1, totalSamples)).toFixed(4));

  // Waveform (100 bins)
  const bins = Math.min(100, Math.max(10, Math.floor(totalSamples / 160)));
  const binSize = Math.max(1, Math.floor(totalSamples / bins));
  const waveform: WaveformPoint[] = [];
  for (let b = 0; b < bins; b++) {
    const start = b * binSize;
    const end = Math.min(totalSamples, start + binSize);
    let sq = 0;
    let peak = 0;
    for (let i = start; i < end; i++) {
      const v = Math.abs(samples[i]);
      sq += v * v;
      if (v > peak) peak = v;
    }
    const rms = Math.sqrt(sq / Math.max(1, end - start));
    waveform.push({
      timeSec: Number(((start / Math.max(1, totalSamples)) * effectiveDuration).toFixed(2)),
      rms: Number(rms.toFixed(4)),
      peak: Number(peak.toFixed(4)),
    });
  }

  // Frame-level 512-pt FFT spectrogram (256 magnitude bins -> 24 frequency bands across 0-8kHz)
  const fftSize = 512;
  const bandCount = 24;
  const frameStep = Math.max(256, Math.floor(totalSamples / 64));
  const spectrogram: SpectrogramSlice[] = [];
  const flatnessValues: number[] = [];
  const zcrValues: number[] = [];
  const hfRatios: number[] = [];
  const frameEnergies: number[] = [];

  for (let pos = 0; pos + fftSize <= totalSamples; pos += frameStep) {
    const slice = samples.subarray(pos, pos + fftSize);
    const mag = fftMagnitude(slice);

    let zcr = 0;
    let energy = 0;
    for (let i = 1; i < fftSize; i++) {
      if ((slice[i] >= 0 && slice[i - 1] < 0) || (slice[i] < 0 && slice[i - 1] >= 0)) zcr++;
      energy += slice[i] * slice[i];
    }
    zcrValues.push(zcr / fftSize);
    frameEnergies.push(energy / fftSize);

    let logSum = 0;
    let arithSum = 0;
    let lowE = 0;
    let highE = 0;
    for (let k = 1; k < mag.length; k++) {
      const p = mag[k] + 1e-7;
      logSum += Math.log(p);
      arithSum += p;
      if (k < mag.length / 2) lowE += p;
      else highE += p;
    }
    const gmean = Math.exp(logSum / (mag.length - 1));
    const amean = arithSum / (mag.length - 1);
    flatnessValues.push(amean > 0 ? gmean / amean : 0);
    hfRatios.push(lowE + highE > 0 ? highE / (lowE + highE) : 0);

    // Group 256 magnitude bins into 24 frequency bands (~333 Hz per band up to 8kHz)
    const binsPerBand = Math.floor(mag.length / bandCount);
    const bands: number[] = [];
    for (let bd = 0; bd < bandCount; bd++) {
      let bSum = 0;
      const startK = bd * binsPerBand;
      const endK = bd === bandCount - 1 ? mag.length : (bd + 1) * binsPerBand;
      for (let k = startK; k < endK; k++) bSum += mag[k];
      bands.push(Number(Math.min(1, Math.log1p(bSum / Math.max(1, endK - startK)) / 3.8).toFixed(3)));
    }
    spectrogram.push({
      timeSec: Number(((pos / Math.max(1, totalSamples)) * effectiveDuration).toFixed(2)),
      bands,
    });
  }

  const mean = (arr: number[]) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
  const std = (arr: number[], m: number) =>
    arr.length ? Math.sqrt(arr.reduce((acc, v) => acc + (v - m) * (v - m), 0) / arr.length) : 0;

  const flatMean = mean(flatnessValues);
  const flatStd = std(flatnessValues, flatMean);
  const zcrMean = mean(zcrValues);
  const zcrStd = std(zcrValues, zcrMean);
  const hfMean = mean(hfRatios);
  const eMean = mean(frameEnergies);
  const eStd = std(frameEnergies, eMean) || 1e-6;
  const kurtosis =
    frameEnergies.length > 0
      ? frameEnergies.reduce((acc, e) => acc + Math.pow((e - eMean) / eStd, 4), 0) / frameEnergies.length
      : 2.0;

  // Segment into ~1.5s acoustic windows for clickable player playback
  const segCount = Math.min(8, Math.max(2, Math.round(effectiveDuration / 1.5)));
  const segDur = effectiveDuration / segCount;
  const segments: AudioSegment[] = [];
  let prevRmsDb = 0;
  for (let s = 0; s < segCount; s++) {
    const startSec = Number((s * segDur).toFixed(2));
    const endSec = Number(((s + 1) * segDur).toFixed(2));
    const startIdx = Math.floor((s / segCount) * flatnessValues.length);
    const endIdx = Math.max(startIdx + 1, Math.floor(((s + 1) / segCount) * flatnessValues.length));
    const segFlat = mean(flatnessValues.slice(startIdx, endIdx));
    const segEnergy = mean(frameEnergies.slice(startIdx, endIdx));
    const rmsDb = Number((20 * Math.log10(Math.sqrt(segEnergy) + 1e-6)).toFixed(1));
    const dbJump = s > 0 ? Math.abs(rmsDb - prevRmsDb) : 0;
    prevRmsDb = rmsDb;

    const silentAnomaly = segEnergy < 1e-5 && s > 0 && s < segCount - 1;
    const jumpAnomaly = dbJump > 16 && segEnergy < 1e-4;
    const flagged = segFlat > 0.42 || silentAnomaly || jumpAnomaly;

    segments.push({
      id: `SEG-${evidenceId}-${s + 1}`,
      startSec,
      endSec,
      rmsDb,
      spectralFlatness: Number(segFlat.toFixed(3)),
      flagged,
      note: silentAnomaly
        ? 'Abrupt mid-stream silence splice transition'
        : segFlat > 0.42
        ? 'Elevated spectral flatness (noise/vocoder candidate)'
        : jumpAnomaly
        ? `Sharp level discontinuity (Δ${dbJump.toFixed(1)} dB)`
        : 'Consistent acoustic energy envelope',
    });
  }

  // Build 6D feature vector matching AUDIO_FEATURES + run AASIST ONNX + LR
  const harmonicJitter = Math.max(0.01, Math.min(0.4, zcrStd * 4.2));
  const featureVec = [
    Number(flatMean.toFixed(4)),
    Number(flatStd.toFixed(4)),
    Number((zcrStd * zcrStd * 10).toFixed(5)),
    Number(hfMean.toFixed(4)),
    Number(Math.min(12, kurtosis).toFixed(4)),
    Number(harmonicJitter.toFixed(4)),
  ];
  const mlPredictions = await inferAudioSpoofingFull(featureVec, samples, {
    codec,
    sampleRate,
    clippingRatio,
    silenceRatio,
    flatnessMean: flatMean,
  });

  const indicators: ForensicIndicator[] = [];
  const flaggedSegs = segments.filter((s) => s.flagged);
  if (flaggedSegs.length > 0) {
    indicators.push({
      id: `IND-${evidenceId}-SPEC`,
      category: 'Spectral Envelope',
      severity: 'warning',
      sourceLayer: 'forensic_signal',
      evidenceRef: evidenceId,
      title: `${flaggedSegs.length} acoustic segment(s) show spectral flatness or splice transitions`,
      detail: `Segments starting at ${flaggedSegs
        .map((s) => `${s.startSec}s`)
        .join(', ')} exhibit flatness > 0.42 or abrupt silence/level discontinuities.`,
    });
  } else {
    indicators.push({
      id: `IND-${evidenceId}-SPEC-OK`,
      category: 'Spectral Envelope',
      severity: 'info',
      sourceLayer: 'forensic_signal',
      evidenceRef: evidenceId,
      title: 'Natural spectral variation across windows',
      detail: `Mean spectral flatness=${flatMean.toFixed(3)} (std=${flatStd.toFixed(
        3,
      )}), HF rolloff ratio=${hfMean.toFixed(3)}.`,
    });
  }

  if (clippingRatio > 0.005) {
    indicators.push({
      id: `IND-${evidenceId}-CLIP`,
      category: 'Waveform Integrity',
      severity: 'warning',
      sourceLayer: 'forensic_signal',
      evidenceRef: evidenceId,
      title: `Digital clipping detected (${(clippingRatio * 100).toFixed(2)}% samples saturated)`,
      detail: 'Sample amplitude saturation can distort harmonic formants and elevate anti-spoofing logits.',
    });
  }

  return {
    metrics: {
      durationSec: effectiveDuration,
      sampleRate,
      channels,
      codec,
      bitrateBps: Number(probe.format?.bit_rate || 0),
      spectralFlatnessMean: Number(flatMean.toFixed(4)),
      spectralFlatnessStd: Number(flatStd.toFixed(4)),
      zcrVariance: Number((zcrStd * zcrStd).toFixed(6)),
      highFreqRolloffRatio: Number(hfMean.toFixed(4)),
      silenceFloorKurtosis: Number(kurtosis.toFixed(3)),
      clippingRatio,
      silenceRatio,
      activeWindowsCount: segments.filter((s) => s.rmsDb > -45).length,
    },
    waveform,
    spectrogram,
    segments,
    indicators,
    mlPredictions,
    limitations:
      'Audio pipeline executes 512-pt FFT spectral forensics, AASIST Graph-Attention ONNX (ASVspoof2019-LA weights), and DSP Logistic Regression. No neural ASR transcription model is run locally; AASIST error rates rise under VoIP compression or non-speech calibration tones.',
  };
}
