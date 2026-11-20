import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  CheckCircle2,
  ExternalLink,
  FolderPlus,
  GitBranch,
  MinusCircle,
  Play,
  RefreshCw,
  ShieldAlert,
  Square,
  Trash2,
  UploadCloud,
} from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  ConsoleShell,
  epistemicLayerMeta,
  formatBytes,
  formatStatusLabel,
  statusTextClass,
} from '../components/ConsoleShell.tsx';
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
import { ForensicIndicator, PipelineJobState, WorkspaceBundle } from '../types/forensics.ts';
import {
  resolveVerdictMeta,
  translateCorrelationForView,
  translateIndicatorForView,
  translateModelDisplay,
  translatePredictionLabelSimple,
} from '../utils/plainEnglish.ts';

export const WorkspacePage: React.FC = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const chart = useChartTheme();
  const { viewMode } = useViewMode();
  const caseId = id && id !== 'none' ? id : getActiveCaseId();
  const [bundle, setBundle] = useState<WorkspaceBundle | null>(() =>
    caseId ? loadWorkspaceSnapshot(caseId) : null,
  );
  const [loading, setLoading] = useState(Boolean(caseId && !loadWorkspaceSnapshot(caseId)));
  const [runningPipeline, setRunningPipeline] = useState(false);
  const [jobState, setJobState] = useState<PipelineJobState | null>(null);
  const [cancellingJob, setCancellingJob] = useState(false);
  const [notes, setNotes] = useState(() => (caseId ? getDrafts().workspaceNotesByCase[caseId] || '' : ''));
  const [savingNotes, setSavingNotes] = useState(false);
  const [toast, setToast] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [layerTab, setLayerTab] = useState<'all' | 'forensic_signal' | 'ml_model' | 'gemini_interpretation'>('all');
  const [sysHealth, setSysHealth] = useState<{
    geminiConfigured: boolean;
    ffmpegAvailable: boolean;
    ffprobeAvailable?: boolean;
  } | null>(null);

  const loadWorkspace = () => {
    if (!caseId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    api
      .getWorkspace(caseId)
      .then((res) => {
        setBundle(res);
        saveWorkspaceSnapshot(caseId, res);
        const draftNote = getDrafts().workspaceNotesByCase[caseId];
        setNotes(draftNote !== undefined ? draftNote : res.investigation.investigator_notes || '');
      })
      .catch((err) => setToast({ type: 'err', text: err instanceof Error ? err.message : 'Load error' }))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadWorkspace();
    if (caseId) {
      api
        .getAnalysisStatus(caseId)
        .then((st) => {
          if (st.job && st.job.status === 'running') {
            setJobState(st.job);
            setRunningPipeline(true);
          }
        })
        .catch(() => {});
    }
    api
      .getSettings()
      .then((s) =>
        setSysHealth({
          geminiConfigured: s.system.geminiConfigured,
          ffmpegAvailable: s.system.ffmpegAvailable,
          ffprobeAvailable: s.system.ffprobeAvailable,
        }),
      )
      .catch(() => {});
  }, [caseId]);

  useEffect(() => {
    if (!caseId || !runningPipeline) return;
    let active = true;
    const timer = window.setInterval(() => {
      api
        .getAnalysisStatus(caseId)
        .then((res) => {
          if (!active || !res.job) return;
          setJobState(res.job);
          if (res.job.status !== 'running') {
            setRunningPipeline(false);
            setCancellingJob(false);
            if (res.job.status === 'completed') {
              setToast({ type: 'ok', text: '9-agent multimodal forensic analysis completed.' });
            } else if (res.job.status === 'cancelled') {
              setToast({ type: 'err', text: 'Analysis run cancelled by investigator.' });
            } else if (res.job.status === 'failed') {
              setToast({ type: 'err', text: res.job.error || 'Analysis pipeline failed.' });
            }
            loadWorkspace();
          }
        })
        .catch(() => {});
    }, 1200);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [caseId, runningPipeline]);

  useEffect(() => {
    if (!caseId) return;
    updateDrafts((prev) => ({
      ...prev,
      workspaceNotesByCase: { ...prev.workspaceNotesByCase, [caseId]: notes },
    }));
  }, [caseId, notes]);

  const handleRunPipeline = async () => {
    if (!caseId || runningPipeline) return;
    setRunningPipeline(true);
    setCancellingJob(false);
    setToast(null);
    try {
      const res = await api.runAnalysisAsync(caseId);
      setJobState(res.job);
    } catch (err) {
      setRunningPipeline(false);
      setToast({ type: 'err', text: err instanceof Error ? err.message : 'Analysis failed to start' });
    }
  };

  const handleCancelPipeline = async () => {
    if (!caseId) return;
    setCancellingJob(true);
    try {
      const res = await api.cancelAnalysis(caseId);
      if (res.job) setJobState(res.job);
    } catch {
      setCancellingJob(false);
    }
  };

  const handleSaveNotes = async () => {
    if (!caseId) return;
    setSavingNotes(true);
    try {
      await api.updateInvestigation(caseId, { investigator_notes: notes });
      setToast({ type: 'ok', text: 'Notes saved to investigation record.' });
      loadWorkspace();
    } catch (err) {
      setToast({ type: 'err', text: err instanceof Error ? err.message : 'Failed to save notes' });
    } finally {
      setSavingNotes(false);
    }
  };

  const handleVerifyHash = async (evidenceId: string) => {
    try {
      const res = await api.verifyEvidenceHash(evidenceId);
      setToast({
        type: res.verified ? 'ok' : 'err',
        text: res.verified
          ? `File fingerprint verified intact for ${evidenceId}.`
          : `Hash mismatch detected for ${evidenceId}!`,
      });
    } catch (err) {
      setToast({ type: 'err', text: err instanceof Error ? err.message : 'Verification failed' });
    }
  };

  const handleDeleteEvidence = async () => {
    if (!confirmDeleteId) return;
    try {
      await api.deleteEvidence(confirmDeleteId);
      setConfirmDeleteId(null);
      setToast({ type: 'ok', text: 'File removed from investigation.' });
      loadWorkspace();
    } catch (err) {
      setToast({ type: 'err', text: err instanceof Error ? err.message : 'Delete failed' });
    }
  };

  const inv = bundle?.investigation;
  const latestReport = bundle?.reports[0];
  const latestReportJson = latestReport ? JSON.parse(latestReport.report_json || '{}') : {};
  const verdict = latestReportJson.verdict || undefined;
  const verdictMeta = resolveVerdictMeta(inv?.confidence_level, verdict);

  const allIndicators: Array<ForensicIndicator & { evidenceId: string; filename: string }> = [];
  for (const a of bundle?.analyses || []) {
    const ev = bundle?.evidence.find((e) => e.id === a.evidence_id);
    const list = JSON.parse(a.indicators_json || '[]') as ForensicIndicator[];
    for (const ind of list) {
      allIndicators.push({
        ...ind,
        evidenceId: a.evidence_id,
        filename: ev?.original_filename || a.evidence_id,
      });
    }
  }
  const filteredIndicators = allIndicators.filter((ind) => {
    if (layerTab === 'all') return true;
    const layer = ind.sourceLayer || 'forensic_signal';
    return layer === layerTab;
  });

  const severityChartData = [
    {
      name: viewMode === 'simple' ? 'High Priority' : 'Critical',
      key: 'critical',
      count: allIndicators.filter((i) => i.severity === 'critical').length,
    },
    {
      name: viewMode === 'simple' ? 'Needs Review' : 'Warning',
      key: 'warning',
      count: allIndicators.filter((i) => i.severity === 'warning').length,
    },
    {
      name: viewMode === 'simple' ? 'Normal / Info' : 'Info',
      key: 'info',
      count: allIndicators.filter((i) => i.severity !== 'critical' && i.severity !== 'warning').length,
    },
  ];

  const fileScoreChartData = (bundle?.predictions || []).map((p) => {
    const ev = bundle?.evidence.find((e) => e.id === p.evidence_id);
    const modelMeta = translateModelDisplay(p.model_id, viewMode);
    return {
      name: `${(ev?.original_filename || p.evidence_id).slice(0, 14)}`,
      score: Number((p.raw_score * 100).toFixed(1)),
      model: modelMeta.name,
    };
  });

  return (
    <ConsoleShell
      title={inv ? `${inv.case_code} · ${inv.title}` : 'Investigation Workspace'}
      subtitle={
        inv
          ? `${formatStatusLabel(inv.status)} · ${bundle?.evidence.length || 0} evidence file(s)`
          : caseId
          ? 'Loading investigation...'
          : 'No active investigation selected'
      }
      activeInvestigationId={caseId}
      actions={
        caseId ? (
          <div className="flex items-center gap-2">
            <Link
              to={`/investigations/${caseId}/upload`}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-white dark:bg-[#111827] border border-slate-300 dark:border-slate-700 hover:border-blue-600 dark:hover:border-sky-400 text-slate-800 dark:text-slate-100 rounded-md whitespace-nowrap transition-colors duration-150"
            >
              <UploadCloud className="w-3.5 h-3.5" />
              Upload Evidence
            </Link>
            <button
              type="button"
              disabled={runningPipeline || !bundle || bundle.evidence.length === 0}
              onClick={handleRunPipeline}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-md whitespace-nowrap transition-colors duration-150"
            >
              {runningPipeline ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
              {runningPipeline ? 'Analyzing...' : 'Run Full Analysis'}
            </button>
          </div>
        ) : null
      }
    >
      {!caseId ? (
        <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-10 text-center space-y-3">
          <FolderPlus className="w-8 h-8 text-blue-600 dark:text-sky-400 mx-auto" />
          <p className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
            No Active Investigation Selected
          </p>
          <p className="text-xs text-slate-500 max-w-md mx-auto">
            Start a new investigation from the Dashboard or Sidebar to upload evidence files and datasets.
          </p>
          <button
            type="button"
            onClick={() => navigate('/dashboard')}
            className="px-4 py-2 text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white rounded-md"
          >
            Open Dashboard
          </button>
        </div>
      ) : (
        <>
          <WorkflowStepper caseId={caseId} bundle={bundle} />

          {toast && (
            <div
              className={`mb-5 px-4 py-3 rounded-lg border text-xs flex items-center justify-between ${
                toast.type === 'ok'
                  ? 'bg-teal-50 dark:bg-teal-950/30 border-teal-200 dark:border-teal-700 text-teal-800 dark:text-teal-300'
                  : 'bg-rose-50 dark:bg-rose-950/30 border-rose-200 dark:border-rose-700 text-rose-700 dark:text-rose-300'
              }`}
            >
              <span>{toast.text}</span>
              <button type="button" onClick={() => setToast(null)} className="underline ml-4 font-medium">
                Dismiss
              </button>
            </div>
          )}

          {runningPipeline && jobState && (
            <div className="mb-5 bg-white dark:bg-[#111827] border border-blue-200 dark:border-sky-800 rounded-lg p-4 space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <span className="font-semibold text-blue-700 dark:text-sky-400 flex items-center gap-2">
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                  {jobState.currentStage}
                </span>
                <div className="flex items-center gap-3">
                  <span className="font-mono tabular-nums text-slate-600 dark:text-slate-300">
                    {jobState.progressPct}%
                  </span>
                  <button
                    type="button"
                    disabled={cancellingJob}
                    onClick={handleCancelPipeline}
                    className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800 text-rose-700 dark:text-rose-300 rounded whitespace-nowrap"
                  >
                    <Square className="w-3 h-3" />
                    {cancellingJob ? 'Cancelling...' : 'Cancel Run'}
                  </button>
                </div>
              </div>
              <div className="h-2 bg-slate-100 dark:bg-slate-800 rounded overflow-hidden">
                <div
                  className="h-full bg-blue-600 transition-all duration-300"
                  style={{ width: `${Math.min(100, Math.max(4, jobState.progressPct))}%` }}
                />
              </div>
            </div>
          )}

          {loading && !bundle ? (
            <div className="space-y-4">
              <div className="h-28 bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg animate-pulse" />
              <div className="h-64 bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg animate-pulse" />
            </div>
          ) : (
            <div className="space-y-6">
              {/* Missing Evidence & Coverage Gap Warnings */}
              {Array.isArray(latestReportJson.missingEvidence) && latestReportJson.missingEvidence.length > 0 && (
                <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg px-4 py-3 text-xs text-amber-900 dark:text-amber-300 space-y-1">
                  <p className="font-semibold">Missing Evidence &amp; Verification Coverage Gaps</p>
                  {(latestReportJson.missingEvidence as string[]).map((gap, idx) => (
                    <p key={idx}>• {gap}</p>
                  ))}
                </div>
              )}

              {/* Service & Engine Availability Warnings */}
              {((bundle?.agents || []).some((a) => a.status === 'failed') ||
                (sysHealth && (!sysHealth.geminiConfigured || !sysHealth.ffmpegAvailable))) && (
                <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg px-4 py-3 text-xs text-amber-900 dark:text-amber-300 space-y-1">
                  {(bundle?.agents || [])
                    .filter((a) => a.status === 'failed')
                    .map((fa) => (
                      <p key={fa.id}>
                        <span className="font-semibold text-rose-700 dark:text-rose-400">
                          {fa.agent_name} Failed:
                        </span>{' '}
                        {fa.error_message || 'Forensic engine execution error'}
                      </p>
                    ))}
                  {sysHealth && !sysHealth.geminiConfigured && (
                    <p>
                      <span className="font-semibold">AI Narrative Service Unavailable:</span>{' '}
                      <code>GEMINI_API_KEY</code> is not configured — speech-to-transcript comparison and AI synthesis
                      are disabled (local forensic engines &amp; ONNX ML remain active).
                    </p>
                  )}
                  {sysHealth && !sysHealth.ffmpegAvailable && (
                    <p>
                      <span className="font-semibold">FFmpeg Unavailable:</span> Video keyframe extraction and audio
                      decoding require FFmpeg on PATH.
                    </p>
                  )}
                </div>
              )}

              {/* Investigation Result & Overview Card */}
              <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-5 grid lg:grid-cols-12 gap-6">
                <div className="lg:col-span-8 space-y-3">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    {viewMode === 'advanced' && (
                      <>
                        <span className="font-mono font-semibold text-blue-600 dark:text-sky-400">{inv?.id}</span>
                        <span aria-hidden="true" className="text-slate-400">·</span>
                      </>
                    )}
                    <span className={`font-semibold ${verdictMeta.toneTextClass}`}>
                      {(bundle?.analyses.length || 0) > 0 ? verdictMeta.label : 'Awaiting Analysis'}
                    </span>
                    <span aria-hidden="true" className="text-slate-400">·</span>
                    <span className="text-slate-500">
                      Updated {inv ? new Date(inv.updated_at).toLocaleString() : '—'}
                    </span>
                  </div>

                  <p className="text-sm text-slate-700 dark:text-slate-300 leading-relaxed">
                    {(bundle?.analyses.length || 0) > 0
                      ? viewMode === 'simple'
                        ? verdictMeta.shortExplanation
                        : inv?.assessment_summary || verdictMeta.shortExplanation
                      : inv?.description ||
                        'Upload evidence files or datasets and click Run Full Analysis to inspect findings and generate your report.'}
                  </p>

                  {verdict && typeof verdict.aiRawScorePct === 'number' && typeof verdict.genuineRawScorePct === 'number' && (
                    <div className="pt-2 space-y-2 max-w-xl">
                      <div className="grid sm:grid-cols-2 gap-3 text-xs">
                        <div>
                          <div className="flex justify-between mb-1">
                            <span className="font-medium text-rose-700 dark:text-rose-400">
                              AI / Manipulated Raw Score
                            </span>
                            <span className="font-mono font-semibold text-rose-700 dark:text-rose-400">
                              {verdict.aiRawScorePct}%
                            </span>
                          </div>
                          <div className="h-2 bg-slate-100 dark:bg-slate-800 rounded overflow-hidden">
                            <div
                              className="h-full bg-rose-600"
                              style={{ width: `${Math.min(100, Math.max(2, verdict.aiRawScorePct))}%` }}
                            />
                          </div>
                        </div>
                        <div>
                          <div className="flex justify-between mb-1">
                            <span className="font-medium text-teal-700 dark:text-teal-400">
                              Likely Genuine Raw Score
                            </span>
                            <span className="font-mono font-semibold text-teal-700 dark:text-teal-400">
                              {verdict.genuineRawScorePct}%
                            </span>
                          </div>
                          <div className="h-2 bg-slate-100 dark:bg-slate-800 rounded overflow-hidden">
                            <div
                              className="h-full bg-teal-600"
                              style={{ width: `${Math.min(100, Math.max(2, verdict.genuineRawScorePct))}%` }}
                            />
                          </div>
                        </div>
                      </div>
                      <p className="text-[11px] text-slate-500">
                        {verdictMeta.reliabilityText} — Raw scores reflect pattern resemblance, not calibrated probabilities.
                      </p>
                    </div>
                  )}
                </div>

                <div className="lg:col-span-4 border-t lg:border-t-0 lg:border-l border-slate-200 dark:border-slate-800 pt-4 lg:pt-0 lg:pl-6 flex flex-col justify-between gap-3">
                  <div className="grid grid-cols-2 gap-3 text-xs">
                    <div>
                      <p className="text-slate-500">Evidence Files</p>
                      <p className="font-mono text-lg font-semibold text-slate-900 dark:text-slate-100 tabular-nums">
                        {bundle?.evidence.length || 0}
                      </p>
                    </div>
                    <div>
                      <p className="text-slate-500">Cross-File Links</p>
                      <p className="font-mono text-lg font-semibold text-slate-900 dark:text-slate-100 tabular-nums">
                        {bundle?.correlations.length || 0}
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <Link
                      to={`/investigations/${caseId}/correlate`}
                      className="inline-flex items-center gap-1 font-medium text-blue-600 dark:text-sky-400 hover:underline"
                    >
                      <GitBranch className="w-3.5 h-3.5" />
                      Compare Files
                    </Link>
                    <span className="text-slate-400">·</span>
                    <Link
                      to={`/investigations/${caseId}/timeline`}
                      className="font-medium text-blue-600 dark:text-sky-400 hover:underline"
                    >
                      Timeline
                    </Link>
                    <span className="text-slate-400">·</span>
                    <Link
                      to={`/investigations/${caseId}/copilot`}
                      className="font-medium text-blue-600 dark:text-sky-400 hover:underline"
                    >
                      Ask Copilot
                    </Link>
                    <span className="text-slate-400">·</span>
                    <Link
                      to={`/investigations/${caseId}/reports`}
                      className="font-medium text-blue-600 dark:text-sky-400 hover:underline"
                    >
                      Full Report &amp; PDF
                    </Link>
                  </div>
                </div>
              </div>

              {/* Workspace Visual Analytics Row when Analyses Exist */}
              {(bundle?.analyses.length || 0) > 0 && (
                <div className="grid lg:grid-cols-2 gap-6">
                  <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-5">
                    <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100 mb-1">
                      Indicator Severity Summary
                    </h2>
                    <p className="text-xs text-slate-500 mb-3">
                      {viewMode === 'simple'
                        ? 'Breakdown of normal checks vs items needing attention'
                        : 'Count of forensic, ML, and correlation indicators by severity'}
                    </p>
                    <div className="h-44">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={severityChartData} margin={{ top: 6, right: 12, left: -16, bottom: 0 }}>
                          <CartesianGrid stroke={chart.gridStroke} strokeDasharray="3 3" vertical={false} />
                          <XAxis dataKey="name" stroke={chart.axisStroke} fontSize={11} />
                          <YAxis stroke={chart.axisStroke} fontSize={11} allowDecimals={false} />
                          <Tooltip contentStyle={chart.tooltipStyle} />
                          <Bar dataKey="count" name="Clues" radius={[4, 4, 0, 0]}>
                            {severityChartData.map((entry) => (
                              <Cell
                                key={entry.key}
                                fill={
                                  entry.key === 'critical'
                                    ? chart.coralBar
                                    : entry.key === 'warning'
                                    ? chart.amberBar
                                    : chart.tealBar
                                }
                              />
                            ))}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </div>

                  <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-5">
                    <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100 mb-1">
                      Per-File Raw Detector Scores (Uncalibrated)
                    </h2>
                    <p className="text-xs text-slate-500 mb-3">
                      {fileScoreChartData.length > 0
                        ? 'Higher scores mean more unusual patterns detected (not factual probability)'
                        : 'No media ML detectors apply to text/dataset-only files'}
                    </p>
                    <div className="h-44">
                      {fileScoreChartData.length === 0 ? (
                        <div className="h-full flex items-center justify-center text-xs text-slate-400">
                          No image, video, or audio ML predictions in this investigation
                        </div>
                      ) : (
                        <ResponsiveContainer width="100%" height="100%">
                          <BarChart data={fileScoreChartData} margin={{ top: 6, right: 12, left: -12, bottom: 0 }}>
                            <CartesianGrid stroke={chart.gridStroke} strokeDasharray="3 3" vertical={false} />
                            <XAxis dataKey="name" stroke={chart.axisStroke} fontSize={11} />
                            <YAxis stroke={chart.axisStroke} fontSize={11} domain={[0, 100]} unit="%" />
                            <Tooltip
                              contentStyle={chart.tooltipStyle}
                              formatter={(val: unknown, _name: unknown, props: { payload?: { model?: string } }) => [
                                `Raw ${val}%`,
                                props?.payload?.model || 'Detector',
                              ]}
                            />
                            <Bar dataKey="score" name="Raw Score %" fill={chart.cyanLine} radius={[4, 4, 0, 0]} />
                          </BarChart>
                        </ResponsiveContainer>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* Evidence & Datasets Collection Table */}
              <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
                <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
                  <div>
                    <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                      Evidence Files &amp; Datasets
                    </h2>
                    <p className="text-xs text-slate-500">
                      Click any file to open its visual inspection lab
                    </p>
                  </div>
                  <Link
                    to={`/investigations/${caseId}/upload`}
                    className="text-xs font-medium text-blue-600 dark:text-sky-400 hover:underline whitespace-nowrap"
                  >
                    + Add Evidence
                  </Link>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-slate-50 dark:bg-[#162032] text-slate-600 dark:text-slate-300 border-b border-slate-200 dark:border-slate-800">
                      <tr>
                        <th className="py-2.5 px-4 font-medium">File Name</th>
                        <th className="py-2.5 px-4 font-medium">Type</th>
                        {viewMode === 'advanced' && <th className="py-2.5 px-4 font-medium">SHA-256 Digest</th>}
                        <th className="py-2.5 px-4 font-medium">Result / Status</th>
                        <th className="py-2.5 px-4 font-medium text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                      {(bundle?.evidence || []).map((ev) => {
                        const evPreds = bundle?.predictions.filter((p) => p.evidence_id === ev.id) || [];
                        const primaryPred = evPreds[0];
                        const evAnalysis = bundle?.analyses.find((a) => a.evidence_id === ev.id);
                        const evMetrics = evAnalysis ? JSON.parse(evAnalysis.metrics_json || '{}') : {};
                        const labRoute = `/investigations/${caseId}/${ev.modality}/${ev.id}`;
                        return (
                          <tr key={ev.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors">
                            <td className="py-3 px-4">
                              <Link
                                to={labRoute}
                                className="font-medium text-slate-900 dark:text-slate-100 hover:text-blue-600 dark:hover:text-sky-400 flex items-center gap-1.5"
                              >
                                {ev.original_filename}
                                <ExternalLink className="w-3 h-3 opacity-60" />
                              </Link>
                              <p className="font-mono text-[11px] text-slate-500 mt-0.5">
                                {viewMode === 'advanced' ? `${ev.id} · ` : ''}
                                {formatBytes(ev.file_size)}
                              </p>
                            </td>
                            <td className="py-3 px-4 font-mono uppercase text-slate-700 dark:text-slate-300">
                              {ev.modality}
                            </td>
                            {viewMode === 'advanced' && (
                              <td className="py-3 px-4 font-mono text-[11px] text-slate-500">
                                {ev.sha256_hash.slice(0, 16)}…
                              </td>
                            )}
                            <td className="py-3 px-4">
                              {ev.modality === 'dataset' && typeof evMetrics.afterQualityScore === 'number' ? (
                                <span className="font-mono font-medium text-teal-700 dark:text-teal-400">
                                  Quality {evMetrics.beforeQualityScore} → {evMetrics.afterQualityScore}/100 ({evMetrics.rowCount} rows)
                                </span>
                              ) : primaryPred ? (
                                <div>
                                  <span className={`font-medium ${statusTextClass(primaryPred.prediction_label)}`}>
                                    {viewMode === 'simple'
                                      ? `${translatePredictionLabelSimple(primaryPred.prediction_label)} (Raw ${(
                                          primaryPred.raw_score * 100
                                        ).toFixed(1)}%)`
                                      : `Raw ${(primaryPred.raw_score * 100).toFixed(1)}% (${primaryPred.model_id})`}
                                  </span>
                                  {viewMode === 'advanced' && evPreds.length > 1 && (
                                    <p className="text-[11px] text-slate-500 font-mono">
                                      +{evPreds.length - 1} classifier(s)
                                    </p>
                                  )}
                                </div>
                              ) : (
                                <span className="text-slate-500">{evAnalysis ? 'Checked' : 'Waiting to analyze'}</span>
                              )}
                            </td>
                            <td className="py-3 px-4 text-right whitespace-nowrap space-x-3">
                              {viewMode === 'advanced' && (
                                <button
                                  type="button"
                                  onClick={() => handleVerifyHash(ev.id)}
                                  className="text-teal-700 dark:text-teal-400 hover:underline font-medium"
                                >
                                  Verify Hash
                                </button>
                              )}
                              <Link
                                to={`/investigations/${caseId}/evidence/${ev.id}`}
                                className="text-slate-700 dark:text-slate-300 hover:underline font-medium"
                              >
                                Detail
                              </Link>
                              <Link to={labRoute} className="text-blue-600 dark:text-sky-400 hover:underline font-medium">
                                Lab
                              </Link>
                              <button
                                type="button"
                                onClick={() => setConfirmDeleteId(ev.id)}
                                className="text-slate-400 hover:text-rose-600 dark:hover:text-rose-400"
                                aria-label={`Remove ${ev.original_filename}`}
                              >
                                <Trash2 className="w-3.5 h-3.5 inline" />
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                      {(bundle?.evidence || []).length === 0 && (
                        <tr>
                          <td colSpan={viewMode === 'advanced' ? 5 : 4} className="py-10 text-center text-slate-500">
                            No files uploaded yet. Click Upload Evidence above to begin.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Findings Ledger */}
              {allIndicators.length > 0 && (
                <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-5 space-y-4">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div>
                      <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                        {viewMode === 'simple' ? 'Why Items Were Checked or Flagged' : 'Findings by Epistemic Layer'}
                      </h2>
                      <p className="text-xs text-slate-500">
                        {viewMode === 'simple'
                          ? 'Plain-English summary of clues found in your files'
                          : 'Separates deterministic signal observations from probabilistic ML outputs and AI synthesis'}
                      </p>
                    </div>
                    {viewMode === 'advanced' && (
                      <div className="inline-flex bg-slate-100 dark:bg-[#162032] border border-slate-200 dark:border-slate-800 rounded-md p-1 gap-1">
                        {(
                          [
                            { id: 'all', label: 'All Layers' },
                            { id: 'forensic_signal', label: 'Observed Signals' },
                            { id: 'ml_model', label: 'ML Models' },
                            { id: 'gemini_interpretation', label: 'AI Synthesis' },
                          ] as const
                        ).map((tab) => (
                          <button
                            key={tab.id}
                            type="button"
                            onClick={() => setLayerTab(tab.id)}
                            className={`px-2.5 py-1 text-xs rounded transition-colors whitespace-nowrap ${
                              layerTab === tab.id
                                ? 'bg-blue-600 text-white font-medium'
                                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                            }`}
                          >
                            {tab.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="divide-y divide-slate-200 dark:divide-slate-800 max-h-72 overflow-y-auto">
                    {filteredIndicators.map((ind) => {
                      const layer = epistemicLayerMeta(ind.sourceLayer);
                      const translated = translateIndicatorForView(ind, viewMode);
                      return (
                        <div key={`${ind.evidenceId}-${ind.id}`} className="py-3 text-xs flex flex-col sm:flex-row sm:items-start justify-between gap-2">
                          <div>
                            <div className="flex flex-wrap items-center gap-2">
                              <span className={`font-semibold ${statusTextClass(ind.severity)}`}>
                                [
                                {viewMode === 'simple'
                                  ? ind.severity === 'critical'
                                    ? 'HIGH'
                                    : ind.severity === 'warning'
                                    ? 'CHECK'
                                    : 'OK'
                                  : ind.severity.toUpperCase()}
                                ]
                              </span>
                              <span className="font-medium text-slate-900 dark:text-slate-100">{translated.title}</span>
                              {viewMode === 'advanced' && (
                                <>
                                  <span className="text-slate-400">·</span>
                                  <span className={`font-mono text-[11px] ${layer.toneClass}`}>{layer.label}</span>
                                </>
                              )}
                            </div>
                            <p className="text-slate-600 dark:text-slate-400 mt-1">{translated.detail}</p>
                          </div>
                          <span className="font-mono text-[11px] text-slate-500 shrink-0">
                            {viewMode === 'simple' ? ind.filename : ind.evidenceRef || ind.evidenceId}
                          </span>
                        </div>
                      );
                    })}
                    {filteredIndicators.length === 0 && (
                      <p className="py-4 text-xs text-slate-500">No indicators recorded in this layer.</p>
                    )}
                  </div>
                </div>
              )}

              {/* Bottom Two-Column: Correlations + Working Notes */}
              <div className="grid lg:grid-cols-12 gap-6">
                <div className="lg:col-span-6 bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-5 space-y-4">
                  <div className="flex items-center justify-between">
                    <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                      {viewMode === 'simple' ? 'How Uploaded Files Compare' : 'Cross-Modal Findings'}
                    </h2>
                    <Link
                      to={`/investigations/${caseId}/correlate`}
                      className="text-xs font-medium text-blue-600 dark:text-sky-400 hover:underline"
                    >
                      Open Comparison Graph
                    </Link>
                  </div>
                  <div className="divide-y divide-slate-200 dark:divide-slate-800">
                    {(bundle?.correlations || []).map((c) => {
                      const srcName =
                        bundle?.evidence.find((e) => e.id === c.source_evidence_id)?.original_filename ||
                        c.source_evidence_id;
                      const tgtName =
                        bundle?.evidence.find((e) => e.id === c.target_evidence_id)?.original_filename ||
                        c.target_evidence_id;
                      const translated = translateCorrelationForView(c, srcName, tgtName, viewMode);
                      return (
                        <div key={c.id} className="py-3 first:pt-0 last:pb-0 text-xs">
                          <div className="flex items-center justify-between gap-2 mb-1">
                            <span className={`font-mono font-semibold ${statusTextClass(c.relationship_type)}`}>
                              {translated.label}
                            </span>
                            {viewMode === 'advanced' && (
                              <span className="font-mono text-slate-500">
                                {c.source_evidence_id} → {c.target_evidence_id} · strength {c.strength.toFixed(2)}
                              </span>
                            )}
                          </div>
                          <p className="text-slate-700 dark:text-slate-300 leading-relaxed">{translated.summary}</p>
                        </div>
                      );
                    })}
                    {(bundle?.correlations || []).length === 0 && (
                      <p className="text-xs text-slate-500 py-4">Run Full Analysis to compare uploaded files.</p>
                    )}
                  </div>
                </div>

                <div className="lg:col-span-6 bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-5 space-y-4">
                  <div className="flex items-center justify-between">
                    <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                      Investigator Working Notes (Auto-saved)
                    </h2>
                    <button
                      type="button"
                      disabled={savingNotes}
                      onClick={handleSaveNotes}
                      className="text-xs font-semibold text-blue-600 dark:text-sky-400 hover:underline disabled:opacity-50"
                    >
                      {savingNotes ? 'Saving...' : 'Sync Notes to DB'}
                    </button>
                  </div>
                  <textarea
                    rows={4}
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Record verification steps, source details, and provisional findings..."
                    className="w-full bg-slate-50 dark:bg-[#162032] border border-slate-300 dark:border-slate-700 rounded-md p-3 text-xs text-slate-900 dark:text-slate-100 focus:outline-none focus:border-blue-600 dark:focus:border-sky-400"
                  />
                  <div className="pt-2 border-t border-slate-200 dark:border-slate-800">
                    <p className="text-xs font-medium text-slate-600 dark:text-slate-400 mb-2">Latest Agent Runs</p>
                    <div className="space-y-1.5 max-h-40 overflow-y-auto">
                      {(bundle?.agents || []).slice(0, 9).map((ag) => (
                        <div key={ag.id} className="flex items-center justify-between text-xs">
                          <span className="text-slate-700 dark:text-slate-300 flex items-center gap-1.5">
                            {ag.status === 'completed' ? (
                              <CheckCircle2 className="w-3.5 h-3.5 text-teal-600 dark:text-teal-400" />
                            ) : ag.status === 'skipped' ? (
                              <MinusCircle className="w-3.5 h-3.5 text-cyan-600 dark:text-sky-400" />
                            ) : (
                              <ShieldAlert className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" />
                            )}
                            {ag.agent_name}
                          </span>
                          <span className={`font-mono text-[11px] ${statusTextClass(ag.status)}`}>{ag.status}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {confirmDeleteId && (
            <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
              <div className="w-full max-w-sm bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-5 space-y-4 shadow-xl">
                <h3 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                  Remove Evidence Item?
                </h3>
                <p className="text-xs text-slate-600 dark:text-slate-400">
                  This removes <span className="font-mono text-slate-900 dark:text-slate-100">{confirmDeleteId}</span> and
                  its derived analyses from this investigation.
                </p>
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setConfirmDeleteId(null)}
                    className="px-3 py-1.5 text-xs bg-slate-100 dark:bg-[#162032] border border-slate-200 dark:border-slate-700 rounded text-slate-700 dark:text-slate-300"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleDeleteEvidence}
                    className="px-3 py-1.5 text-xs bg-rose-600 hover:bg-rose-700 text-white rounded font-medium"
                  >
                    Remove
                  </button>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </ConsoleShell>
  );
};
