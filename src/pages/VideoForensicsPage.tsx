import React, { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AlertTriangle, Clock } from 'lucide-react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { ConsoleShell, epistemicLayerMeta, statusTextClass } from '../components/ConsoleShell.tsx';
import { WorkflowStepper } from '../components/WorkflowStepper.tsx';
import { useChartTheme } from '../context/ThemeContext.tsx';
import { useViewMode } from '../context/ViewModeContext.tsx';
import { api } from '../services/api.ts';
import {
  getActiveCaseId,
  getDrafts,
  loadWorkspaceSnapshot,
  saveWorkspaceSnapshot,
  updateDrafts,
} from '../services/sessionStorage.ts';
import { DetectedFace, ForensicIndicator, WorkspaceBundle } from '../types/forensics.ts';
import { translateIndicatorForView, translateModelDisplay } from '../utils/plainEnglish.ts';

interface SampledFrame {
  index: number;
  timestampSec: number;
  frameUrl: string;
  elaMean: number;
  noiseFloorStd: number;
  temporalDelta: number;
  histogramDelta?: number;
  flagged: boolean;
  flagReason?: string;
  mlScore?: number;
  mlLabel?: string;
  mlModelId?: string;
  faces?: DetectedFace[];
}

interface EmbeddedAudioPayload {
  audioUrl?: string;
  metrics?: Record<string, number | string | boolean | null>;
  waveform?: Array<{ timeSec: number; rms: number; peak: number }>;
  spectrogram?: Array<{ timeSec: number; bands: number[] }>;
  segments?: Array<{ id: string; startSec: number; endSec: number; rmsDb: number; spectralFlatness: number; flagged: boolean; note: string }>;
}

export const VideoForensicsPage: React.FC = () => {
  const { id, evidenceId } = useParams();
  const caseId = id && id !== 'none' ? id : getActiveCaseId();
  const chart = useChartTheme();
  const { viewMode } = useViewMode();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [bundle, setBundle] = useState<WorkspaceBundle | null>(() =>
    caseId ? loadWorkspaceSnapshot(caseId) : null,
  );
  const [selectedId, setSelectedId] = useState('');
  const [activeFrameIdx, setActiveFrameIdx] = useState<number | null>(null);

  useEffect(() => {
    if (!caseId) return;
    api.getWorkspace(caseId).then((res) => {
      setBundle(res);
      saveWorkspaceSnapshot(caseId, res);
      const vids = res.evidence.filter((e) => e.modality === 'video');
      const savedSel = getDrafts().selectedLabEvidenceByCase[caseId]?.video;
      if (evidenceId && vids.some((v) => v.id === evidenceId)) {
        setSelectedId(evidenceId);
      } else if (savedSel && vids.some((v) => v.id === savedSel)) {
        setSelectedId(savedSel);
      } else if (vids.length > 0) {
        setSelectedId(vids[0].id);
      }
    }).catch(() => {});
  }, [caseId, evidenceId]);

  const videos = bundle?.evidence.filter((e) => e.modality === 'video') || [];
  const activeEv = videos.find((v) => v.id === selectedId) || videos[0];
  const analysis = bundle?.analyses.find((a) => a.evidence_id === activeEv?.id);
  const predictions = bundle?.predictions.filter((p) => p.evidence_id === activeEv?.id) || [];

  const metrics = analysis ? JSON.parse(analysis.metrics_json || '{}') : {};
  const artifacts = analysis ? JSON.parse(analysis.artifacts_json || '{}') : {};
  const sampledFrames: SampledFrame[] = artifacts.sampledFrames || [];
  const embeddedAudio: EmbeddedAudioPayload | null = artifacts.embeddedAudio || null;
  const geminiTranscript: { transcript?: string; language?: string } | null = artifacts.geminiTranscript || null;
  const indicators: ForensicIndicator[] = analysis ? JSON.parse(analysis.indicators_json || '[]') : [];
  const durationSec = Math.max(0.1, Number(metrics.durationSec || 1));

  const seekTo = (sec: number, frameIndex?: number) => {
    if (frameIndex !== undefined) setActiveFrameIdx(frameIndex);
    if (!videoRef.current) return;
    videoRef.current.currentTime = sec;
    videoRef.current.play().catch(() => {});
  };

  const chartFrames = sampledFrames.map((f) => ({
    ...f,
    mlScorePct: typeof f.mlScore === 'number' ? Number((f.mlScore * 100).toFixed(1)) : null,
  }));

  return (
    <ConsoleShell
      title="Video Forensics Lab"
      subtitle={
        caseId
          ? `Investigation ${caseId} · Keyframe timeline, multi-frame ML scoring, embedded audio track & temporal drift`
          : 'No active investigation selected'
      }
      activeInvestigationId={caseId}
    >
      {!caseId ? (
        <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-10 text-center space-y-3">
          <p className="text-sm text-slate-700 dark:text-slate-300">
            Start or select an investigation from the Dashboard before opening the Video Forensics Lab.
          </p>
          <Link
            to="/dashboard"
            className="inline-block px-4 py-2 text-xs font-semibold bg-blue-600 text-white rounded-md"
          >
            Go to Dashboard
          </Link>
        </div>
      ) : videos.length === 0 ? (
        <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-10 text-center space-y-3">
          <p className="text-sm text-slate-700 dark:text-slate-300">No video evidence found in this investigation.</p>
          <Link
            to={`/investigations/${caseId}/upload`}
            className="inline-block px-4 py-2 text-xs font-semibold bg-blue-600 text-white rounded-md"
          >
            Upload Video Evidence
          </Link>
        </div>
      ) : (
        <div className="space-y-6">
          <WorkflowStepper caseId={caseId} bundle={bundle} />
          {/* Selector */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap gap-2">
              {videos.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => {
                    setSelectedId(v.id);
                    updateDrafts((d) => ({
                      ...d,
                      selectedLabEvidenceByCase: {
                        ...d.selectedLabEvidenceByCase,
                        [caseId]: { ...(d.selectedLabEvidenceByCase[caseId] || {}), video: v.id },
                      },
                    }));
                    setActiveFrameIdx(null);
                  }}
                  className={`px-3 py-1.5 text-xs rounded-md border transition-colors whitespace-nowrap ${
                    activeEv?.id === v.id
                      ? 'bg-blue-600 border-blue-600 text-white font-medium'
                      : 'bg-white dark:bg-[#111827] border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300'
                  }`}
                >
                  {v.original_filename}
                </button>
              ))}
            </div>
            {activeEv && (
              <Link
                to={`/investigations/${caseId}/evidence/${activeEv.id}`}
                className="text-xs font-medium text-blue-600 dark:text-sky-400 hover:underline whitespace-nowrap"
              >
                Inspect File Detail
              </Link>
            )}
          </div>

          {analysis && Number(metrics.framesWithFacesCount ?? 0) === 0 && (
            <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg px-4 py-3 text-xs text-amber-900 dark:text-amber-300">
              <span className="font-semibold">Face Detection Limitation:</span> Zero human faces were localized across
              the {sampledFrames.length} sampled keyframes. Facial deepfake scores could not evaluate aligned face crops
              and fell back to whole-frame sampling — this result must not be treated as proof of authenticity.
            </div>
          )}

          <div className="grid lg:grid-cols-12 gap-6">
            <div className="lg:col-span-7 bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-4 space-y-3">
              <video
                ref={videoRef}
                key={activeEv?.id}
                src={activeEv ? `/api/evidence/${activeEv.id}/file` : ''}
                controls
                className="w-full max-h-[340px] bg-slate-900 rounded border border-slate-200 dark:border-slate-800"
              />

              {/* Interactive Timeline Marker Bar */}
              {sampledFrames.length > 0 && (
                <div className="space-y-1.5 pt-1">
                  <div className="flex items-center justify-between text-[11px] text-slate-500">
                    <span className="flex items-center gap-1 font-medium text-slate-700 dark:text-slate-300">
                      <Clock className="w-3.5 h-3.5" />
                      Interactive Keyframe Timeline (0s – {metrics.durationSec ?? durationSec}s)
                    </span>
                    <span className="font-mono">
                      {sampledFrames.filter((f) => f.flagged).length} flagged · {sampledFrames.length} sampled
                    </span>
                  </div>
                  <div className="relative h-7 bg-slate-100 dark:bg-[#162032] border border-slate-200 dark:border-slate-700 rounded flex items-center px-2">
                    <div className="absolute inset-x-3 h-0.5 bg-slate-300 dark:bg-slate-600" />
                    {sampledFrames.map((f) => {
                      const pct = Math.min(96, Math.max(4, (f.timestampSec / durationSec) * 100));
                      const isSel = activeFrameIdx === f.index;
                      return (
                        <button
                          key={f.index}
                          type="button"
                          onClick={() => seekTo(f.timestampSec, f.index)}
                          title={`Frame #${f.index} at ${f.timestampSec}s (Δ ${f.temporalDelta})`}
                          style={{ left: `${pct}%` }}
                          className={`absolute -translate-x-1/2 w-3.5 h-3.5 rounded-full border-2 transition-transform hover:scale-125 ${
                            f.flagged
                              ? 'bg-rose-600 border-white dark:border-slate-900'
                              : isSel
                              ? 'bg-blue-600 border-white dark:border-slate-900 scale-110'
                              : 'bg-cyan-600 dark:bg-sky-400 border-white dark:border-slate-900'
                          }`}
                          aria-label={`Seek to ${f.timestampSec} seconds`}
                        />
                      );
                    })}
                  </div>
                </div>
              )}

              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600 dark:text-slate-400 pt-1">
                <span className="font-mono">
                  {metrics.resolution || '—'} · {metrics.fps || '—'} fps · {metrics.durationSec || '—'}s ·{' '}
                  {String(metrics.codec || '').toUpperCase()}
                  {typeof metrics.avDurationDesyncSec === 'number'
                    ? ` · A/V Δ ${metrics.avDurationDesyncSec}s`
                    : ''}
                </span>
                <span className="text-cyan-700 dark:text-sky-400 font-medium">
                  {metrics.samplingCoverageNote || 'Keyframe sampling active'}
                </span>
              </div>
            </div>

            <div className="lg:col-span-5 bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-4 flex flex-col">
              <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100 mb-1">
                Temporal Residual &amp; Histogram Drift
              </h2>
              <p className="text-xs text-slate-500 mb-3">
                Inter-frame pixel delta, ELA, and 16-bin luma histogram shift across keyframes
              </p>
              <div className="flex-1 min-h-[220px]">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chartFrames} margin={{ top: 8, right: 12, left: -16, bottom: 0 }}>
                    <CartesianGrid stroke={chart.gridStroke} strokeDasharray="3 3" />
                    <XAxis dataKey="timestampSec" stroke={chart.axisStroke} fontSize={11} unit="s" />
                    <YAxis stroke={chart.axisStroke} fontSize={11} />
                    <Tooltip contentStyle={chart.tooltipStyle} />
                    <Line type="monotone" dataKey="temporalDelta" name="Temporal Delta" stroke={chart.amberBar} strokeWidth={2} />
                    <Line type="monotone" dataKey="elaMean" name="Frame ELA" stroke={chart.cyanLine} strokeWidth={2} />
                    <Line type="monotone" dataKey="histogramDelta" name="Luma Hist Δ" stroke={chart.indigoBar} strokeWidth={1.75} />
                    {chartFrames.some((f) => f.mlScorePct !== null) && (
                      <Line type="monotone" dataKey="mlScorePct" name="Raw ML %" stroke={chart.coralBar} strokeWidth={2} connectNulls />
                    )}
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <div className="mt-3 pt-3 border-t border-slate-200 dark:border-slate-800 space-y-2">
                <p className="text-[11px] text-slate-500">
                  Raw Model Scores (Uncalibrated — not factual probabilities; {metrics.framesMlEvaluated ?? 1} frames evaluated):
                </p>
                {predictions.map((p) => {
                  const modelMeta = translateModelDisplay(p.model_id, viewMode);
                  return (
                    <div key={p.id} className="text-xs flex items-center justify-between gap-2">
                      <span className="font-mono text-slate-600 dark:text-slate-400 truncate">{modelMeta.name}</span>
                      <span className={`font-mono font-semibold shrink-0 ${statusTextClass(p.prediction_label)}`}>
                        Raw {(p.raw_score * 100).toFixed(1)}% ({p.prediction_label.replace(/_/g, ' ')})
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Embedded Video Audio Track Forensics */}
          {embeddedAudio && embeddedAudio.audioUrl && (
            <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-5 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                    Embedded Video Audio Track Analysis (16kHz PCM + AASIST)
                  </h2>
                  <p className="text-xs text-slate-500">
                    Demuxed audio track analyzed for voice spoofing, spectral anomalies, and speech continuity
                  </p>
                </div>
                <span className="font-mono text-xs text-teal-700 dark:text-teal-400">
                  {embeddedAudio.metrics?.durationSec ?? '—'}s · {embeddedAudio.segments?.length ?? 0} window(s)
                </span>
              </div>
              <audio src={embeddedAudio.audioUrl} controls className="w-full" />
              {embeddedAudio.waveform && embeddedAudio.waveform.length > 0 && (
                <div className="h-36">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={embeddedAudio.waveform} margin={{ top: 5, right: 12, left: -16, bottom: 0 }}>
                      <CartesianGrid stroke={chart.gridStroke} strokeDasharray="3 3" />
                      <XAxis dataKey="timeSec" stroke={chart.axisStroke} fontSize={11} unit="s" />
                      <YAxis stroke={chart.axisStroke} fontSize={11} domain={[0, 1]} />
                      <Tooltip contentStyle={chart.tooltipStyle} />
                      <Line type="monotone" dataKey="peak" name="Audio Peak" stroke={chart.tealBar} strokeWidth={1.75} dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}
              {geminiTranscript?.transcript && (
                <div className="p-3 rounded bg-slate-50 dark:bg-[#162032] border border-slate-200 dark:border-slate-700 text-xs">
                  <p className="font-semibold text-slate-900 dark:text-slate-100 mb-1">
                    Gemini Speech Transcription ({geminiTranscript.language || 'auto'})
                  </p>
                  <p className="text-slate-700 dark:text-slate-300 leading-relaxed">{geminiTranscript.transcript}</p>
                </div>
              )}
            </div>
          )}

          {/* Clickable Extracted Keyframes */}
          <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-5 space-y-4">
            <div>
              <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                Sampled Keyframe Strip ({sampledFrames.length} frames inspected · {metrics.framesMlEvaluated ?? 1} ML-scored)
              </h2>
              <p className="text-xs text-slate-500">
                Click any frame or flagged timestamp marker to jump the video player
              </p>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3">
              {sampledFrames.map((frame) => {
                const isSel = activeFrameIdx === frame.index;
                return (
                  <button
                    key={frame.index}
                    type="button"
                    onClick={() => seekTo(frame.timestampSec, frame.index)}
                    className={`text-left rounded-md overflow-hidden border transition-colors ${
                      frame.flagged
                        ? 'border-rose-500 bg-rose-50 dark:bg-rose-950/30'
                        : isSel
                        ? 'border-blue-600 dark:border-sky-400 bg-blue-50/50 dark:bg-[#162032]'
                        : 'border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#162032] hover:border-blue-500 dark:hover:border-sky-400'
                    }`}
                  >
                    <div className="relative">
                      <img
                        src={frame.frameUrl}
                        alt={`Keyframe ${frame.index} at ${frame.timestampSec}s`}
                        referrerPolicy="no-referrer"
                        className="w-full h-24 object-cover bg-slate-900"
                      />
                      {(frame.faces || []).map((face, fi) => (
                        <div
                          key={fi}
                          style={{
                            left: `${face.xPct}%`,
                            top: `${face.yPct}%`,
                            width: `${face.wPct}%`,
                            height: `${face.hPct}%`,
                          }}
                          title={`${face.trackId || 'Face'} · conf ${(face.confidence * 100).toFixed(0)}%`}
                          className="absolute border border-cyan-400 bg-cyan-400/15 pointer-events-none"
                        />
                      ))}
                    </div>
                    <div className="p-2 text-[11px]">
                      <div className="flex items-center justify-between font-mono text-slate-900 dark:text-slate-100">
                        <span>
                          #{frame.index} · {frame.timestampSec}s
                        </span>
                        {frame.flagged && <AlertTriangle className="w-3 h-3 text-rose-600 dark:text-rose-400" />}
                      </div>
                      <p className="font-mono text-slate-500 mt-0.5 tabular-nums">
                        Δ {frame.temporalDelta} · ELA {frame.elaMean}
                      </p>
                      {(frame.faces?.length || 0) > 0 && (
                        <p className="font-mono text-[10px] text-cyan-700 dark:text-sky-400 mt-0.5 tabular-nums truncate">
                          Track {frame.faces!.map((f) => f.trackId || 'F').join(', ')} ({frame.faces!.length})
                        </p>
                      )}
                      {typeof frame.mlScore === 'number' && (
                        <p className="font-mono text-[10px] text-indigo-700 dark:text-sky-400 mt-0.5 tabular-nums">
                          Face ViT {(frame.mlScore * 100).toFixed(1)}%
                        </p>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Temporal Indicators & Coverage Caveat */}
          <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-5 space-y-3">
            <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
              Temporal Indicators &amp; Sampling Scope
            </h2>
            <div className="divide-y divide-slate-200 dark:divide-slate-800">
              {indicators.map((ind) => {
                const layer = epistemicLayerMeta(ind.sourceLayer);
                const tr = translateIndicatorForView(ind, viewMode);
                return (
                  <div key={ind.id} className="text-xs py-2.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                    <div>
                      <span className={`font-semibold ${statusTextClass(ind.severity)}`}>
                        [{ind.severity.toUpperCase()}]
                      </span>{' '}
                      <span className="text-slate-900 dark:text-slate-100 font-medium">{tr.title}</span>{' '}
                      {viewMode === 'advanced' && (
                        <>
                          <span className="text-slate-400">·</span>{' '}
                          <span className={`font-mono text-[11px] ${layer.toneClass}`}>{layer.label}</span>
                        </>
                      )}
                      <p className="text-slate-600 dark:text-slate-400 mt-0.5">{tr.detail}</p>
                    </div>
                    <span className="font-mono text-[11px] text-slate-500 shrink-0">
                      {viewMode === 'simple' ? tr.categoryLabel : ind.evidenceRef || ind.category}
                    </span>
                  </div>
                );
              })}
            </div>
            {viewMode === 'advanced' && analysis?.limitations && (
              <p className="text-xs text-slate-500 pt-2 border-t border-slate-200 dark:border-slate-800">
                {analysis.limitations}
              </p>
            )}
          </div>
        </div>
      )}
    </ConsoleShell>
  );
};
