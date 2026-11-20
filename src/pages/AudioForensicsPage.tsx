import React, { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Play } from 'lucide-react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
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
import { ForensicIndicator, WorkspaceBundle } from '../types/forensics.ts';
import { translateIndicatorForView, translateModelDisplay } from '../utils/plainEnglish.ts';

interface AudioSegment {
  id: string;
  startSec: number;
  endSec: number;
  rmsDb: number;
  spectralFlatness: number;
  flagged: boolean;
  note: string;
}

export const AudioForensicsPage: React.FC = () => {
  const { id, evidenceId } = useParams();
  const caseId = id && id !== 'none' ? id : getActiveCaseId();
  const chart = useChartTheme();
  const { viewMode } = useViewMode();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [bundle, setBundle] = useState<WorkspaceBundle | null>(() =>
    caseId ? loadWorkspaceSnapshot(caseId) : null,
  );
  const [selectedId, setSelectedId] = useState('');
  const [activeSegEnd, setActiveSegEnd] = useState<number | null>(null);
  const [hoveredSlice, setHoveredSlice] = useState<{ timeSec: number; peakBandHz: string; energy: number } | null>(null);

  useEffect(() => {
    if (!caseId) return;
    api.getWorkspace(caseId).then((res) => {
      setBundle(res);
      saveWorkspaceSnapshot(caseId, res);
      const auds = res.evidence.filter((e) => e.modality === 'audio');
      const savedSel = getDrafts().selectedLabEvidenceByCase[caseId]?.audio;
      if (evidenceId && auds.some((a) => a.id === evidenceId)) {
        setSelectedId(evidenceId);
      } else if (savedSel && auds.some((a) => a.id === savedSel)) {
        setSelectedId(savedSel);
      } else if (auds.length > 0) {
        setSelectedId(auds[0].id);
      }
    }).catch(() => {});
  }, [caseId, evidenceId]);

  const audios = bundle?.evidence.filter((e) => e.modality === 'audio') || [];
  const activeEv = audios.find((a) => a.id === selectedId) || audios[0];
  const analysis = bundle?.analyses.find((a) => a.evidence_id === activeEv?.id);
  const predictions = bundle?.predictions.filter((p) => p.evidence_id === activeEv?.id) || [];

  const metrics = analysis ? JSON.parse(analysis.metrics_json || '{}') : {};
  const artifacts = analysis ? JSON.parse(analysis.artifacts_json || '{}') : {};
  const waveform: Array<{ timeSec: number; rms: number; peak: number }> = artifacts.waveform || [];
  const spectrogram: Array<{ timeSec: number; bands: number[] }> = artifacts.spectrogram || [];
  const segments: AudioSegment[] = artifacts.segments || [];
  const geminiTranscript: { transcript?: string; language?: string } | null = artifacts.geminiTranscript || null;
  const indicators: ForensicIndicator[] = analysis ? JSON.parse(analysis.indicators_json || '[]') : [];
  const bandCount = spectrogram[0]?.bands.length || 24;

  const playSegment = (startSec: number, endSec: number) => {
    if (!audioRef.current) return;
    setActiveSegEnd(endSec);
    audioRef.current.currentTime = startSec;
    audioRef.current.play().catch(() => {});
  };

  const segmentChartData = segments.map((s) => ({
    window: `${s.startSec}-${s.endSec}s`,
    flatnessPct: Number((s.spectralFlatness * 100).toFixed(1)),
    flagged: s.flagged,
  }));

  return (
    <ConsoleShell
      title="Audio Forensics Lab"
      subtitle={
        caseId
          ? `Investigation ${caseId} · 16kHz PCM waveform, 24-band 512-pt FFT spectrogram, speech windows & AASIST`
          : 'No active investigation selected'
      }
      activeInvestigationId={caseId}
    >
      {!caseId ? (
        <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-10 text-center space-y-3">
          <p className="text-sm text-slate-700 dark:text-slate-300">
            Start or select an investigation from the Dashboard before opening the Audio Forensics Lab.
          </p>
          <Link
            to="/dashboard"
            className="inline-block px-4 py-2 text-xs font-semibold bg-blue-600 text-white rounded-md"
          >
            Go to Dashboard
          </Link>
        </div>
      ) : audios.length === 0 ? (
        <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-10 text-center space-y-3">
          <p className="text-sm text-slate-700 dark:text-slate-300">No audio evidence found in this investigation.</p>
          <Link
            to={`/investigations/${caseId}/upload`}
            className="inline-block px-4 py-2 text-xs font-semibold bg-blue-600 text-white rounded-md"
          >
            Upload Audio Evidence
          </Link>
        </div>
      ) : (
        <div className="space-y-6">
          <WorkflowStepper caseId={caseId} bundle={bundle} />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap gap-2">
              {audios.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => {
                    setSelectedId(a.id);
                    updateDrafts((d) => ({
                      ...d,
                      selectedLabEvidenceByCase: {
                        ...d.selectedLabEvidenceByCase,
                        [caseId]: { ...(d.selectedLabEvidenceByCase[caseId] || {}), audio: a.id },
                      },
                    }));
                  }}
                  className={`px-3 py-1.5 text-xs rounded-md border transition-colors whitespace-nowrap ${
                    activeEv?.id === a.id
                      ? 'bg-blue-600 border-blue-600 text-white font-medium'
                      : 'bg-white dark:bg-[#111827] border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300'
                  }`}
                >
                  {a.original_filename}
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

          {/* Player + Acoustic Metadata + ML Predictions */}
          <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-5 grid lg:grid-cols-12 gap-6 items-start">
            <div className="lg:col-span-6 space-y-3">
              <audio
                ref={audioRef}
                key={activeEv?.id}
                src={activeEv ? `/api/evidence/${activeEv.id}/file` : ''}
                controls
                onTimeUpdate={() => {
                  if (activeSegEnd !== null && audioRef.current && audioRef.current.currentTime >= activeSegEnd) {
                    audioRef.current.pause();
                    setActiveSegEnd(null);
                  }
                }}
                className="w-full"
              />
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2 text-xs">
                <div>
                  <p className="text-slate-500">Duration</p>
                  <p className="font-mono font-medium text-slate-900 dark:text-slate-100 tabular-nums">
                    {metrics.durationSec ?? '—'} s
                  </p>
                </div>
                <div>
                  <p className="text-slate-500">Sample Rate</p>
                  <p className="font-mono font-medium text-slate-900 dark:text-slate-100 tabular-nums">
                    {metrics.sampleRate ?? '—'} Hz
                  </p>
                </div>
                <div>
                  <p className="text-slate-500">Clipping Ratio</p>
                  <p className="font-mono font-medium text-slate-900 dark:text-slate-100 tabular-nums">
                    {typeof metrics.clippingRatio === 'number'
                      ? `${(metrics.clippingRatio * 100).toFixed(2)}%`
                      : '—'}
                  </p>
                </div>
                <div>
                  <p className="text-slate-500">Silence Ratio</p>
                  <p className="font-mono font-medium text-slate-900 dark:text-slate-100 tabular-nums">
                    {typeof metrics.silenceRatio === 'number'
                      ? `${(metrics.silenceRatio * 100).toFixed(1)}%`
                      : '—'}
                  </p>
                </div>
              </div>
            </div>

            <div className="lg:col-span-6 border-t lg:border-t-0 lg:border-l border-slate-200 dark:border-slate-800 pt-3 lg:pt-0 lg:pl-6 space-y-3">
              <div>
                <h2 className="font-display text-xs font-semibold text-slate-900 dark:text-slate-100">
                  Anti-Spoofing Raw Model Scores (Uncalibrated)
                </h2>
                <p className="text-[11px] text-slate-500">
                  Raw scores indicate acoustic anomaly resemblance — not calibrated probability of spoofing.
                </p>
              </div>
              {predictions.some((p) => p.uncertainty_note.includes('[OUT-OF-DOMAIN')) && (
                <div className="p-3 rounded bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 text-[11px] text-amber-800 dark:text-amber-300 leading-relaxed">
                  <span className="font-semibold">Out-of-Domain / Inconclusive Audio Notice:</span> Compressed, resampled, or ambient speech falls outside <span className="font-mono">TL-AASIST-ONNX</span>&apos;s lossless 16kHz ASVspoof2019-LA training domain (observed 100% FPR on YouTube human speech). Raw scores below are reported as inconclusive and require acoustic/transcript corroboration.
                </div>
              )}
              {predictions.map((p) => {
                const modelMeta = translateModelDisplay(p.model_id, viewMode);
                return (
                  <div key={p.id} className="space-y-1 pt-2 first:pt-0 border-t first:border-t-0 border-slate-200 dark:border-slate-800">
                    <div className="flex justify-between text-xs gap-2">
                      <span className="font-mono font-medium text-slate-800 dark:text-slate-200">{modelMeta.name}</span>
                      <span className={`font-mono font-semibold shrink-0 ${statusTextClass(p.prediction_label)}`}>
                        Raw {(p.raw_score * 100).toFixed(1)}% ({p.prediction_label.replace(/_/g, ' ')})
                      </span>
                    </div>
                    <p className="text-[11px] text-slate-600 dark:text-slate-400 leading-relaxed">
                      {p.uncertainty_note}
                    </p>
                  </div>
                );
              })}
              {predictions.length === 0 && (
                <p className="text-xs text-slate-500">Run Forensic Analysis from Workspace to score this audio track.</p>
              )}
              {geminiTranscript && (geminiTranscript.transcript || (geminiTranscript as { error?: string }).error) && (
                <div className="p-3 rounded bg-slate-50 dark:bg-[#162032] border border-slate-200 dark:border-slate-700 text-xs space-y-1">
                  <p className="font-semibold text-slate-900 dark:text-slate-100">
                    Speech Transcription ({(geminiTranscript as { model?: string }).model || 'gemini-3.5-transcribe'}
                    {geminiTranscript.language ? ` · ${geminiTranscript.language}` : ''})
                  </p>
                  {geminiTranscript.transcript ? (
                    <p className="text-slate-700 dark:text-slate-300 leading-relaxed whitespace-pre-wrap">
                      {geminiTranscript.transcript}
                    </p>
                  ) : (
                    <p className="text-amber-700 dark:text-amber-400">
                      Transcription skipped: {(geminiTranscript as { error?: string }).error}
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Waveform + Spectrogram */}
          <div className="grid lg:grid-cols-2 gap-6">
            <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-5">
              <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100 mb-1">
                Time-Domain RMS &amp; Peak Waveform
              </h2>
              <p className="text-xs text-slate-500 mb-4">Normalized 16kHz PCM amplitude envelope</p>
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={waveform} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
                    <CartesianGrid stroke={chart.gridStroke} strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="timeSec" stroke={chart.axisStroke} fontSize={11} unit="s" />
                    <YAxis stroke={chart.axisStroke} fontSize={11} domain={[0, 1]} />
                    <Tooltip contentStyle={chart.tooltipStyle} />
                    <Area
                      type="monotone"
                      dataKey="peak"
                      name="Peak Amplitude"
                      stroke={chart.cyanLine}
                      fill={chart.primaryBar}
                      fillOpacity={0.28}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-5 flex flex-col">
              <div className="flex items-center justify-between gap-2 mb-1">
                <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                  {bandCount}-Band FFT Spectrogram (0–8 kHz)
                </h2>
                {hoveredSlice && (
                  <span className="font-mono text-[11px] text-cyan-700 dark:text-sky-400">
                    t={hoveredSlice.timeSec}s · {hoveredSlice.peakBandHz} · {Math.round(hoveredSlice.energy * 100)}%
                  </span>
                )}
              </div>
              <p className="text-xs text-slate-500 mb-4">
                512-point Radix-2 FFT frequency distribution across time slices
              </p>
              <div className="flex gap-2 flex-1 min-h-[210px]">
                <div className="flex flex-col justify-between text-[10px] font-mono text-slate-500 py-1 shrink-0">
                  <span>8 kHz</span>
                  <span>4 kHz</span>
                  <span>0 Hz</span>
                </div>
                <div className="flex-1 bg-slate-950 dark:bg-[#0B1120] border border-slate-200 dark:border-slate-800 rounded p-2 flex items-stretch gap-0.5 overflow-hidden">
                  {spectrogram.map((slice, idx) => (
                    <div
                      key={idx}
                      className="flex-1 flex flex-col-reverse gap-px cursor-crosshair"
                      onMouseEnter={() => {
                        let maxE = 0;
                        let maxB = 0;
                        slice.bands.forEach((e, bi) => {
                          if (e > maxE) {
                            maxE = e;
                            maxB = bi;
                          }
                        });
                        const hzLow = Math.round((maxB / slice.bands.length) * 8000);
                        const hzHigh = Math.round(((maxB + 1) / slice.bands.length) * 8000);
                        setHoveredSlice({
                          timeSec: slice.timeSec,
                          peakBandHz: `${hzLow}-${hzHigh} Hz`,
                          energy: Number(maxE.toFixed(2)),
                        });
                      }}
                    >
                      {slice.bands.map((energy, bIdx) => (
                        <div
                          key={bIdx}
                          className="flex-1 rounded-[1px]"
                          style={{
                            backgroundColor:
                              energy > 0.7
                                ? `rgba(244, 63, 94, ${Math.min(1, energy)})`
                                : energy > 0.4
                                ? `rgba(56, 189, 248, ${Math.min(1, energy)})`
                                : `rgba(37, 99, 235, ${Math.max(0.1, energy)})`,
                          }}
                        />
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* Audio Segment Anomaly Timeline Chart */}
          {segmentChartData.length > 0 && (
            <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-5 space-y-2">
              <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                Segment Spectral Flatness Timeline (Red = Flagged Acoustic Window)
              </h2>
              <p className="text-xs text-slate-500">
                Highlights unusual tonal flatness, clipping, or noise-floor jumps across time segments
              </p>
              <div className="h-44 pt-2">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={segmentChartData} margin={{ top: 6, right: 12, left: -14, bottom: 0 }}>
                    <CartesianGrid stroke={chart.gridStroke} strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="window" stroke={chart.axisStroke} fontSize={10} />
                    <YAxis stroke={chart.axisStroke} fontSize={11} domain={[0, 100]} unit="%" />
                    <Tooltip contentStyle={chart.tooltipStyle} />
                    <Bar dataKey="flatnessPct" name="Spectral Flatness %" radius={[3, 3, 0, 0]}>
                      {segmentChartData.map((entry, idx) => (
                        <Cell key={idx} fill={entry.flagged ? chart.coralBar : chart.tealBar} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* Clickable Segments */}
          <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-5 space-y-4">
            <div>
              <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                Acoustic Window Segments ({segments.length})
              </h2>
              <p className="text-xs text-slate-500">Click any segment to audition that exact time window</p>
            </div>
            <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
              {segments.map((seg) => (
                <button
                  key={seg.id}
                  type="button"
                  onClick={() => playSegment(seg.startSec, seg.endSec)}
                  className={`text-left p-3 rounded-md border transition-colors ${
                    seg.flagged
                      ? 'bg-rose-50 dark:bg-rose-950/30 border-rose-300 dark:border-rose-600/60 hover:border-rose-500'
                      : 'bg-slate-50 dark:bg-[#162032] border-slate-200 dark:border-slate-700 hover:border-blue-600 dark:hover:border-sky-400'
                  }`}
                >
                  <div className="flex items-center justify-between text-xs font-mono text-slate-900 dark:text-slate-100">
                    <span>
                      {seg.startSec}s – {seg.endSec}s
                    </span>
                    <Play className="w-3.5 h-3.5 text-blue-600 dark:text-sky-400" />
                  </div>
                  <p className="font-mono text-[11px] text-slate-600 dark:text-slate-400 mt-1 tabular-nums">
                    {seg.rmsDb} dBFS · Flatness {seg.spectralFlatness}
                  </p>
                  <p
                    className={`text-[11px] mt-1 ${
                      seg.flagged ? 'text-amber-700 dark:text-amber-400 font-medium' : 'text-slate-500'
                    }`}
                  >
                    {seg.note}
                  </p>
                </button>
              ))}
            </div>
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
                      <span className="font-medium text-slate-900 dark:text-slate-100">{tr.title}</span>{' '}
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
