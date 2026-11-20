import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Check, CheckCircle2, ChevronDown, ChevronUp, Download, FolderPlus, ShieldCheck, Sparkles } from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { ConsoleShell, formatBytes, statusTextClass } from '../components/ConsoleShell.tsx';
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
import {
  BeforeAfterComparison,
  DatasetColumnProfile,
  DatasetFixAction,
  ForensicIndicator,
  ValidationCheck,
  WorkspaceBundle,
} from '../types/forensics.ts';
import {
  resolveVerdictMeta,
  translateCorrelationForView,
  translateIndicatorForView,
  translateModelDisplay,
  translatePredictionLabelSimple,
} from '../utils/plainEnglish.ts';

export const ReportsPage: React.FC = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const chart = useChartTheme();
  const { viewMode } = useViewMode();
  const caseId = id && id !== 'none' ? id : getActiveCaseId();

  const [bundle, setBundle] = useState<WorkspaceBundle | null>(() =>
    caseId ? loadWorkspaceSnapshot(caseId) : null,
  );
  const [selectedReportId, setSelectedReportId] = useState(() => bundle?.reports[0]?.id || '');
  const [conclusion, setConclusion] = useState(() => {
    const firstRpt = bundle?.reports[0];
    if (!firstRpt) return '';
    const draft = getDrafts().reportConclusionByReport[firstRpt.id];
    return draft && draft.trim().length > 0 ? draft : firstRpt.human_conclusion || '';
  });
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState('');
  const [techExpanded, setTechExpanded] = useState(false);

  const load = () => {
    if (!caseId) return;
    api
      .getWorkspace(caseId)
      .then((res) => {
        setBundle(res);
        saveWorkspaceSnapshot(caseId, res);
        if (res.reports.length > 0) {
          const rptId = res.reports[0].id;
          setSelectedReportId(rptId);
          const draft = getDrafts().reportConclusionByReport[rptId];
          const dbVal = res.reports[0].human_conclusion || '';
          setConclusion(draft && draft.trim().length > 0 ? draft : dbVal);
        }
      })
      .catch(() => {});
  };

  useEffect(() => {
    load();
  }, [caseId]);

  const report = bundle?.reports.find((r) => r.id === selectedReportId) || bundle?.reports[0];

  useEffect(() => {
    if (!report || !conclusion) return;
    updateDrafts((prev) => ({
      ...prev,
      reportConclusionByReport: { ...prev.reportConclusionByReport, [report.id]: conclusion },
    }));
  }, [report?.id, conclusion]);

  const parsed = report ? JSON.parse(report.report_json || '{}') : {};
  const verdict = parsed.verdict || undefined;
  const inv = bundle?.investigation;
  const verdictMeta = resolveVerdictMeta(inv?.confidence_level || parsed.confidenceLevel, verdict);

  const aiPct: number | null = typeof verdict?.aiRawScorePct === 'number' ? verdict.aiRawScorePct : null;
  const genuinePct: number | null =
    typeof verdict?.genuineRawScorePct === 'number'
      ? verdict.genuineRawScorePct
      : aiPct !== null
      ? Number((100 - aiPct).toFixed(1))
      : null;

  const automatedFixes: DatasetFixAction[] = parsed.automatedFixes || [];
  const beforeAfter: BeforeAfterComparison[] = parsed.beforeAfterComparisons || [];
  const datasetColumns: Array<DatasetColumnProfile & { filename?: string }> = parsed.datasetColumns || [];
  const cleanedDownloads: Array<{ evidenceId: string; filename: string; url: string; beforeScore: number; afterScore: number }> =
    parsed.cleanedDownloads || [];
  const validationResults: ValidationCheck[] = parsed.validationResults || [];

  const allIndicators: Array<ForensicIndicator & { evidenceId: string; filename: string }> = [];
  const videoTimeline: Array<{ timeSec: number; mlPct: number | null; temporalDelta: number; flagged: boolean }> = [];
  const audioTimeline: Array<{ label: string; flatness: number; rmsDb: number; flagged: boolean }> = [];
  const visualPreviews: Array<{ type: string; filename: string; url: string }> = [];

  for (const anl of bundle?.analyses || []) {
    const ev = bundle?.evidence.find((e) => e.id === anl.evidence_id);
    const filename = ev?.original_filename || anl.evidence_id;
    const inds = JSON.parse(anl.indicators_json || '[]') as ForensicIndicator[];
    inds.forEach((i) => allIndicators.push({ ...i, evidenceId: anl.evidence_id, filename }));

    const arts = JSON.parse(anl.artifacts_json || '{}');
    if (anl.modality === 'image' && arts.elaUrl) {
      visualPreviews.push({ type: 'ELA Difference Map', filename, url: arts.elaUrl });
    }
    if (anl.modality === 'video' && Array.isArray(arts.sampledFrames)) {
      arts.sampledFrames.forEach((fr: { timestampSec: number; mlScore?: number; temporalDelta: number; flagged?: boolean; frameUrl?: string }) => {
        if (videoTimeline.length < 24) {
          videoTimeline.push({
            timeSec: fr.timestampSec,
            mlPct: typeof fr.mlScore === 'number' ? Number((fr.mlScore * 100).toFixed(1)) : null,
            temporalDelta: fr.temporalDelta,
            flagged: Boolean(fr.flagged),
          });
        }
        if (fr.frameUrl && visualPreviews.length < 4 && fr.flagged) {
          visualPreviews.push({ type: `Video Frame @ ${fr.timestampSec}s`, filename, url: fr.frameUrl });
        }
      });
      if (arts.embeddedAudio && Array.isArray(arts.embeddedAudio.segments)) {
        arts.embeddedAudio.segments.forEach((seg: { startSec: number; endSec: number; spectralFlatness: number; rmsDb: number; flagged?: boolean }) => {
          if (audioTimeline.length < 16) {
            audioTimeline.push({
              label: `${seg.startSec}-${seg.endSec}s`,
              flatness: Number((seg.spectralFlatness * 100).toFixed(1)),
              rmsDb: seg.rmsDb,
              flagged: Boolean(seg.flagged),
            });
          }
        });
      }
    }
    if (anl.modality === 'audio' && Array.isArray(arts.segments)) {
      arts.segments.forEach((seg: { startSec: number; endSec: number; spectralFlatness: number; rmsDb: number; flagged?: boolean }) => {
        if (audioTimeline.length < 16) {
          audioTimeline.push({
            label: `${seg.startSec}-${seg.endSec}s`,
            flatness: Number((seg.spectralFlatness * 100).toFixed(1)),
            rmsDb: seg.rmsDb,
            flagged: Boolean(seg.flagged),
          });
        }
      });
    }
  }

  const flaggedIndicators = allIndicators.filter((i) => i.severity === 'critical' || i.severity === 'warning');
  const indicatorsForWhy = flaggedIndicators.length > 0 ? flaggedIndicators : allIndicators.slice(0, 6);

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

  const primaryPredictions = React.useMemo(() => {
    const preds = bundle?.predictions || [];
    const byEv = new Map<string, typeof preds>();
    for (const p of preds) {
      const arr = byEv.get(p.evidence_id) || [];
      arr.push(p);
      byEv.set(p.evidence_id, arr);
    }
    const out: typeof preds = [];
    for (const evPreds of byEv.values()) {
      const vit = evPreds.find((p) => p.model_id.includes('ViT'));
      const imgFallback = evPreds.filter((p) => p.model_id.includes('ImgForensics'));
      if (vit) out.push(vit);
      else out.push(...imgFallback);

      const aasist = evPreds.find((p) => p.model_id.includes('AASIST'));
      const audFallback = evPreds.filter((p) => p.model_id.includes('AudSpoof'));
      if (aasist) out.push(aasist);
      else out.push(...audFallback);

      const others = evPreds.filter(
        (p) =>
          !p.model_id.includes('ViT') &&
          !p.model_id.includes('ImgForensics') &&
          !p.model_id.includes('AASIST') &&
          !p.model_id.includes('AudSpoof'),
      );
      out.push(...others);
    }
    return out;
  }, [bundle?.predictions]);

  const modalityScoreChartData = ['image', 'video', 'audio']
    .map((mod) => {
      const preds = primaryPredictions.filter((p) => {
        const ev = bundle?.evidence.find((e) => e.id === p.evidence_id);
        return ev?.modality === mod;
      });
      if (preds.length === 0) return null;
      const avg = (preds.reduce((s, p) => s + p.raw_score, 0) / preds.length) * 100;
      return { modality: mod.toUpperCase(), score: Number(avg.toFixed(1)) };
    })
    .filter(Boolean) as Array<{ modality: string; score: number }>;

  const beforeAfterChartData = beforeAfter
    .filter((b) => b.metric !== 'Row Count')
    .map((b) => ({ metric: b.metric, Before: b.before, After: b.after }));

  const columnIssuesChartData = datasetColumns.slice(0, 14).map((c) => ({
    name: c.name.slice(0, 12),
    Missing: c.missingCount,
    Errors: c.typeErrorCount,
    Outliers: c.outlierCount,
  }));

  const handleSaveConclusion = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!report) return;
    setSaving(true);
    setSavedMsg('');
    try {
      await api.updateReportConclusion(report.id, conclusion);
      setSavedMsg('Conclusion saved and synced to PDF report.');
      load();
    } finally {
      setSaving(false);
    }
  };

  const showTechnical = viewMode === 'advanced' || techExpanded;

  return (
    <ConsoleShell
      title="Investigation Report & PDF Export"
      subtitle={
        caseId
          ? `Investigation ${caseId} · Plain-English summary, visual charts, and downloadable 8-section PDF report`
          : 'Create or select an investigation to generate reports'
      }
      activeInvestigationId={caseId}
      actions={
        report && caseId ? (
          <div className="flex flex-wrap items-center gap-2">
            {cleanedDownloads.map((dl) => (
              <a
                key={dl.evidenceId}
                href={dl.url}
                download={`cleaned_${dl.filename}`}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-white dark:bg-[#111827] border border-slate-300 dark:border-slate-700 hover:border-teal-600 text-slate-800 dark:text-slate-100 rounded-md whitespace-nowrap"
              >
                <Download className="w-3.5 h-3.5 text-teal-600" />
                Cleaned {dl.filename}
              </a>
            ))}
            <a
              href={`/api/investigations/${caseId}/reports/${report.id}/pdf?mode=simple`}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-white dark:bg-[#111827] border border-slate-300 dark:border-slate-700 hover:border-blue-600 text-slate-800 dark:text-slate-100 rounded-md whitespace-nowrap transition-colors shrink-0"
            >
              <Download className="w-3.5 h-3.5" />
              Download Simple PDF
            </a>
            <a
              href={`/api/investigations/${caseId}/reports/${report.id}/pdf?mode=advanced`}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white rounded-md whitespace-nowrap transition-colors shrink-0"
            >
              <Download className="w-3.5 h-3.5" />
              Download Technical PDF
            </a>
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
            Create an investigation, upload evidence files, and run analysis to compile your report.
          </p>
          <button
            type="button"
            onClick={() => navigate('/dashboard')}
            className="px-4 py-2 text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white rounded-md"
          >
            Go to Dashboard
          </button>
        </div>
      ) : (
        <>
          <WorkflowStepper caseId={caseId} bundle={bundle} />

          {!report ? (
            <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-10 text-center space-y-3">
              <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
                No report compiled for this investigation yet.
              </p>
              <p className="text-xs text-slate-500">
                Upload evidence files and click Run Full Analysis in the Workspace to generate this report.
              </p>
              <button
                type="button"
                onClick={() => navigate(`/investigations/${caseId}`)}
                className="px-4 py-2 text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white rounded-md"
              >
                Open Investigation Workspace
              </button>
            </div>
          ) : (
            <div className="space-y-6">
              {/* PAGE-1 STYLE OVERALL VERDICT & RAW SCORE BANNER */}
              <div className={`rounded-lg border p-6 space-y-4 ${verdictMeta.toneBgClass} ${verdictMeta.toneBorderClass}`}>
                <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4">
                  <div className="space-y-1.5">
                    <p className="text-xs font-mono text-slate-600 dark:text-slate-400">
                      {inv?.case_code || parsed.caseCode} · {new Date(report.created_at).toLocaleString()}
                    </p>
                    <h2 className="font-display text-xl font-bold text-slate-900 dark:text-slate-100">
                      {inv?.title || report.title}
                    </h2>
                    <p className="text-xs text-slate-600 dark:text-slate-300">
                      Uploaded Files ({bundle?.evidence.length || 0}):{' '}
                      {(bundle?.evidence || []).map((e) => e.original_filename).join(', ') || 'None'}
                    </p>
                  </div>
                  <div className="lg:text-right shrink-0">
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Overall Result</p>
                    <p className={`font-display text-xl font-bold ${verdictMeta.toneTextClass}`}>
                      {verdictMeta.label}
                    </p>
                    <p className="text-xs text-slate-600 dark:text-slate-400 mt-0.5">{verdictMeta.reliabilityText}</p>
                  </div>
                </div>

                {aiPct !== null && genuinePct !== null ? (
                  <div className="bg-white/90 dark:bg-[#0B1120]/80 border border-slate-200 dark:border-slate-800 rounded-md p-4 space-y-3">
                    <div className="grid sm:grid-cols-2 gap-4 text-xs">
                      <div>
                        <div className="flex justify-between font-semibold mb-1.5">
                          <span className="text-rose-700 dark:text-rose-400">AI-Generated / Manipulated Raw Score</span>
                          <span className="font-mono text-rose-700 dark:text-rose-400">{aiPct}%</span>
                        </div>
                        <div className="h-2.5 bg-slate-200 dark:bg-slate-800 rounded overflow-hidden">
                          <div
                            className="h-full bg-rose-600"
                            style={{ width: `${Math.min(100, Math.max(2, aiPct))}%` }}
                          />
                        </div>
                      </div>
                      <div>
                        <div className="flex justify-between font-semibold mb-1.5">
                          <span className="text-teal-700 dark:text-teal-400">Likely Genuine Raw Score</span>
                          <span className="font-mono text-teal-700 dark:text-teal-400">{genuinePct}%</span>
                        </div>
                        <div className="h-2.5 bg-slate-200 dark:bg-slate-800 rounded overflow-hidden">
                          <div
                            className="h-full bg-teal-600"
                            style={{ width: `${Math.min(100, Math.max(2, genuinePct))}%` }}
                          />
                        </div>
                      </div>
                    </div>
                    <p className="text-[11px] text-slate-500">
                      Honesty Notice: These percentages reflect <strong>Uncalibrated Raw Model Scores</strong> from
                      automated pattern detectors — NOT calibrated factual probabilities.
                    </p>
                  </div>
                ) : (
                  <p className="text-xs text-slate-600 dark:text-slate-300 bg-white/70 dark:bg-[#0B1120]/70 border border-slate-200 dark:border-slate-800 rounded px-3 py-2">
                    Deepfake media probabilities do not apply because this investigation contains only text or tabular
                    dataset files.
                  </p>
                )}

                <p className="text-sm text-slate-800 dark:text-slate-200 leading-relaxed">{verdictMeta.shortExplanation}</p>
              </div>

              {/* 8-SECTION REPORT BODY + SIGN-OFF SIDEBAR */}
              <div className="grid lg:grid-cols-12 gap-6">
                <div className="lg:col-span-8 space-y-6">
                  {/* SECTION 1: QUICK SUMMARY */}
                  <section className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-5 space-y-3">
                    <h3 className="font-display text-sm font-bold text-slate-900 dark:text-slate-100">
                      1. Quick Summary
                    </h3>
                    <p className="text-sm text-slate-700 dark:text-slate-300 leading-relaxed">
                      {report.executive_summary}
                    </p>
                    <p className="text-xs text-teal-800 dark:text-teal-300 bg-teal-50 dark:bg-teal-950/30 border border-teal-200 dark:border-teal-800 rounded p-3">
                      <span className="font-semibold">Human Reviewer Status:</span> {report.human_conclusion}
                    </p>
                  </section>

                  {/* SECTION 2: FILES ANALYSED */}
                  <section className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-5 space-y-3">
                    <h3 className="font-display text-sm font-bold text-slate-900 dark:text-slate-100">
                      2. Files Analysed ({bundle?.evidence.length || 0})
                    </h3>
                    <div className="overflow-x-auto border border-slate-200 dark:border-slate-800 rounded-md">
                      <table className="w-full text-left text-xs">
                        <thead className="bg-slate-50 dark:bg-[#162032] text-slate-600 dark:text-slate-300 border-b border-slate-200 dark:border-slate-800">
                          <tr>
                            <th className="py-2 px-3 font-medium">File Name</th>
                            <th className="py-2 px-3 font-medium">Type</th>
                            <th className="py-2 px-3 font-medium text-right">Size</th>
                            <th className="py-2 px-3 font-medium text-right">Inspect</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                          {(bundle?.evidence || []).map((ev) => (
                            <tr key={ev.id}>
                              <td className="py-2 px-3 font-medium text-slate-900 dark:text-slate-100">
                                {ev.original_filename}
                              </td>
                              <td className="py-2 px-3 font-mono uppercase text-slate-600 dark:text-slate-400">
                                {ev.modality}
                              </td>
                              <td className="py-2 px-3 text-right font-mono text-slate-600 dark:text-slate-400">
                                {formatBytes(ev.file_size)}
                              </td>
                              <td className="py-2 px-3 text-right">
                                <Link
                                  to={`/investigations/${caseId}/${ev.modality}/${ev.id}`}
                                  className="text-blue-600 dark:text-sky-400 hover:underline font-medium"
                                >
                                  Open Lab
                                </Link>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </section>

                  {/* SECTION 3: DETECTION RESULTS */}
                  <section className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-5 space-y-4">
                    <div>
                      <h3 className="font-display text-sm font-bold text-slate-900 dark:text-slate-100">
                        3. Detection Results
                      </h3>
                      <p className="text-xs text-slate-500">
                        Individual detector scores (uncalibrated raw scores — higher means stronger anomaly pattern)
                      </p>
                    </div>
                    {primaryPredictions.length === 0 ? (
                      <p className="text-xs text-slate-500">
                        No media deepfake detectors were needed for these files.
                      </p>
                    ) : (
                      <div className="space-y-3">
                        {(viewMode === 'simple' ? primaryPredictions : bundle?.predictions || []).map((pred) => {
                          const ev = bundle?.evidence.find((e) => e.id === pred.evidence_id);
                          const pct = Number((pred.raw_score * 100).toFixed(1));
                          const modelInfo = translateModelDisplay(pred.model_id, viewMode);
                          return (
                            <div key={pred.id} className="space-y-1 text-xs">
                              <div className="flex items-center justify-between gap-2">
                                <span className="font-medium text-slate-900 dark:text-slate-100">
                                  {ev?.original_filename || pred.evidence_id} ·{' '}
                                  <span className="text-slate-500">{modelInfo.name}</span>
                                </span>
                                <span className={`font-mono font-semibold ${statusTextClass(pred.prediction_label)}`}>
                                  Raw {pct}% — {translatePredictionLabelSimple(pred.prediction_label)}
                                </span>
                              </div>
                              <div className="h-2 bg-slate-100 dark:bg-slate-800 rounded overflow-hidden">
                                <div
                                  className={`h-full ${
                                    pct >= 65 ? 'bg-rose-600' : pct >= 40 ? 'bg-amber-500' : 'bg-teal-600'
                                  }`}
                                  style={{ width: `${Math.min(100, Math.max(2, pct))}%` }}
                                />
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {/* Dataset Before-vs-After Table + Automated Fixes */}
                    {beforeAfter.length > 0 && (
                      <div className="pt-3 border-t border-slate-200 dark:border-slate-800 space-y-3">
                        <h4 className="font-display text-xs font-semibold text-slate-900 dark:text-slate-100">
                          Dataset Quality Before &amp; After Cleaning
                        </h4>
                        <div className="overflow-x-auto border border-slate-200 dark:border-slate-800 rounded-md">
                          <table className="w-full text-left text-xs">
                            <thead className="bg-slate-50 dark:bg-[#162032] text-slate-600 dark:text-slate-300 border-b border-slate-200 dark:border-slate-800">
                              <tr>
                                <th className="py-2 px-3 font-medium">Metric</th>
                                <th className="py-2 px-3 font-medium text-right">Before</th>
                                <th className="py-2 px-3 font-medium text-right">After</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-200 dark:divide-slate-800 font-mono tabular-nums">
                              {beforeAfter.map((row) => (
                                <tr key={row.metric}>
                                  <td className="py-2 px-3 font-sans font-medium text-slate-900 dark:text-slate-100">
                                    {row.metric}
                                  </td>
                                  <td className="py-2 px-3 text-right text-amber-700 dark:text-amber-400">
                                    {row.before} {row.unit}
                                  </td>
                                  <td className="py-2 px-3 text-right text-teal-700 dark:text-teal-400 font-semibold">
                                    {row.after} {row.unit}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                        {(automatedFixes.length > 0 || validationResults.length > 0) && (
                          <div className="grid sm:grid-cols-2 gap-4 pt-2">
                            <div className="space-y-1.5">
                              <p className="text-xs font-semibold text-blue-600 dark:text-sky-400 flex items-center gap-1">
                                <Sparkles className="w-3.5 h-3.5" /> Automated Fixes
                              </p>
                              {automatedFixes.map((fx, i) => (
                                <p key={i} className="text-[11px] text-slate-600 dark:text-slate-400">
                                  • {fx.action} ({fx.count}): {fx.detail}
                                </p>
                              ))}
                            </div>
                            <div className="space-y-1.5">
                              <p className="text-xs font-semibold text-teal-700 dark:text-teal-400 flex items-center gap-1">
                                <ShieldCheck className="w-3.5 h-3.5" /> Validation Checks
                              </p>
                              {validationResults.map((vr, i) => (
                                <p key={i} className="text-[11px] text-slate-600 dark:text-slate-400 flex items-center gap-1">
                                  <CheckCircle2 className="w-3 h-3 text-teal-600 shrink-0" />
                                  {vr.check}: {vr.passed ? 'PASS' : 'CHECK'}
                                </p>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </section>

                  {/* SECTION 4: WHY WAS IT FLAGGED? */}
                  <section className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-5 space-y-4">
                    <h3 className="font-display text-sm font-bold text-slate-900 dark:text-slate-100">
                      4. Why Was It Flagged?
                    </h3>
                    <div className="divide-y divide-slate-200 dark:divide-slate-800">
                      {indicatorsForWhy.map((ind) => {
                        const tr = translateIndicatorForView(ind, viewMode);
                        return (
                          <div key={`${ind.evidenceId}-${ind.id}`} className="py-2.5 text-xs">
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-semibold text-slate-900 dark:text-slate-100">{tr.title}</span>
                              <span className={`font-mono text-[11px] font-semibold ${statusTextClass(ind.severity)}`}>
                                {ind.filename}
                              </span>
                            </div>
                            <p className="text-slate-600 dark:text-slate-400 mt-1">{tr.detail}</p>
                          </div>
                        );
                      })}
                      {indicatorsForWhy.length === 0 && (
                        <p className="text-xs text-slate-500">No suspicious clues were triggered.</p>
                      )}
                    </div>
                    {(parsed.alternativeExplanations || []).length > 0 && (
                      <div className="pt-3 border-t border-slate-200 dark:border-slate-800">
                        <p className="text-xs font-semibold text-amber-700 dark:text-amber-400 mb-1.5">
                          Common Innocent Reasons These Clues Can Appear:
                        </p>
                        <ul className="space-y-1 text-xs text-slate-600 dark:text-slate-400 list-disc pl-4">
                          {(parsed.alternativeExplanations || []).map((a: string, i: number) => (
                            <li key={i}>{a}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </section>

                  {/* SECTION 5: VISUAL ANALYSIS */}
                  <section className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-5 space-y-5">
                    <div>
                      <h3 className="font-display text-sm font-bold text-slate-900 dark:text-slate-100">
                        5. Visual Analysis
                      </h3>
                      <p className="text-xs text-slate-500">
                        Interactive charts and generated forensic inspection visuals based on real computed evidence
                      </p>
                    </div>

                    <div className="grid sm:grid-cols-2 gap-5">
                      <div>
                        <p className="text-xs font-semibold text-slate-700 dark:text-slate-300 mb-2">
                          Clues Found by Severity
                        </p>
                        <div className="h-44">
                          <ResponsiveContainer width="100%" height="100%">
                            <BarChart data={severityChartData} margin={{ top: 6, right: 8, left: -18, bottom: 0 }}>
                              <CartesianGrid stroke={chart.gridStroke} strokeDasharray="3 3" vertical={false} />
                              <XAxis dataKey="name" stroke={chart.axisStroke} fontSize={11} />
                              <YAxis stroke={chart.axisStroke} fontSize={11} allowDecimals={false} />
                              <Tooltip contentStyle={chart.tooltipStyle} />
                              <Bar dataKey="count" name="Indicators" radius={[3, 3, 0, 0]}>
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

                      {modalityScoreChartData.length > 0 && (
                        <div>
                          <p className="text-xs font-semibold text-slate-700 dark:text-slate-300 mb-2">
                            Average Raw Score by File Type
                          </p>
                          <div className="h-44">
                            <ResponsiveContainer width="100%" height="100%">
                              <BarChart data={modalityScoreChartData} margin={{ top: 6, right: 8, left: -14, bottom: 0 }}>
                                <CartesianGrid stroke={chart.gridStroke} strokeDasharray="3 3" vertical={false} />
                                <XAxis dataKey="modality" stroke={chart.axisStroke} fontSize={11} />
                                <YAxis stroke={chart.axisStroke} fontSize={11} domain={[0, 100]} unit="%" />
                                <Tooltip contentStyle={chart.tooltipStyle} />
                                <Bar dataKey="score" name="Raw Score %" fill={chart.cyanLine} radius={[3, 3, 0, 0]} />
                              </BarChart>
                            </ResponsiveContainer>
                          </div>
                        </div>
                      )}
                    </div>

                    {videoTimeline.length > 0 && (
                      <div>
                        <p className="text-xs font-semibold text-slate-700 dark:text-slate-300 mb-2">
                          Video Suspicious Timestamp Timeline
                        </p>
                        <div className="h-44">
                          <ResponsiveContainer width="100%" height="100%">
                            <LineChart data={videoTimeline} margin={{ top: 6, right: 12, left: -14, bottom: 0 }}>
                              <CartesianGrid stroke={chart.gridStroke} strokeDasharray="3 3" />
                              <XAxis dataKey="timeSec" stroke={chart.axisStroke} fontSize={11} unit="s" />
                              <YAxis stroke={chart.axisStroke} fontSize={11} />
                              <Tooltip contentStyle={chart.tooltipStyle} />
                              <Legend wrapperStyle={{ fontSize: 11 }} />
                              <Line type="monotone" dataKey="temporalDelta" name="Frame Motion Jump" stroke={chart.amberBar} strokeWidth={2} />
                              {videoTimeline.some((v) => v.mlPct !== null) && (
                                <Line type="monotone" dataKey="mlPct" name="Raw ML Score %" stroke={chart.coralBar} strokeWidth={2} />
                              )}
                            </LineChart>
                          </ResponsiveContainer>
                        </div>
                      </div>
                    )}

                    {audioTimeline.length > 0 && (
                      <div>
                        <p className="text-xs font-semibold text-slate-700 dark:text-slate-300 mb-2">
                          Audio Segment Spectral Pattern Timeline
                        </p>
                        <div className="h-44">
                          <ResponsiveContainer width="100%" height="100%">
                            <BarChart data={audioTimeline} margin={{ top: 6, right: 12, left: -14, bottom: 0 }}>
                              <CartesianGrid stroke={chart.gridStroke} strokeDasharray="3 3" vertical={false} />
                              <XAxis dataKey="label" stroke={chart.axisStroke} fontSize={10} />
                              <YAxis stroke={chart.axisStroke} fontSize={11} domain={[0, 100]} unit="%" />
                              <Tooltip contentStyle={chart.tooltipStyle} />
                              <Bar dataKey="flatness" name="Spectral Flatness %" radius={[3, 3, 0, 0]}>
                                {audioTimeline.map((seg, i) => (
                                  <Cell key={i} fill={seg.flagged ? chart.coralBar : chart.tealBar} />
                                ))}
                              </Bar>
                            </BarChart>
                          </ResponsiveContainer>
                        </div>
                      </div>
                    )}

                    {(beforeAfterChartData.length > 0 || columnIssuesChartData.length > 0) && (
                      <div className="grid sm:grid-cols-2 gap-5">
                        {beforeAfterChartData.length > 0 && (
                          <div>
                            <p className="text-xs font-semibold text-slate-700 dark:text-slate-300 mb-2">
                              Dataset Quality Before vs After
                            </p>
                            <div className="h-44">
                              <ResponsiveContainer width="100%" height="100%">
                                <BarChart data={beforeAfterChartData} margin={{ top: 6, right: 8, left: -14, bottom: 0 }}>
                                  <CartesianGrid stroke={chart.gridStroke} strokeDasharray="3 3" vertical={false} />
                                  <XAxis dataKey="metric" stroke={chart.axisStroke} fontSize={10} />
                                  <YAxis stroke={chart.axisStroke} fontSize={10} />
                                  <Tooltip contentStyle={chart.tooltipStyle} />
                                  <Bar dataKey="Before" fill={chart.amberBar} radius={[3, 3, 0, 0]} />
                                  <Bar dataKey="After" fill={chart.tealBar} radius={[3, 3, 0, 0]} />
                                </BarChart>
                              </ResponsiveContainer>
                            </div>
                          </div>
                        )}
                        {columnIssuesChartData.length > 0 && (
                          <div>
                            <p className="text-xs font-semibold text-slate-700 dark:text-slate-300 mb-2">
                              Column-Level Anomalies
                            </p>
                            <div className="h-44">
                              <ResponsiveContainer width="100%" height="100%">
                                <BarChart data={columnIssuesChartData} margin={{ top: 6, right: 8, left: -14, bottom: 0 }}>
                                  <CartesianGrid stroke={chart.gridStroke} strokeDasharray="3 3" vertical={false} />
                                  <XAxis dataKey="name" stroke={chart.axisStroke} fontSize={10} />
                                  <YAxis stroke={chart.axisStroke} fontSize={10} allowDecimals={false} />
                                  <Tooltip contentStyle={chart.tooltipStyle} />
                                  <Bar dataKey="Missing" fill={chart.amberBar} radius={[3, 3, 0, 0]} />
                                  <Bar dataKey="Errors" fill={chart.coralBar} radius={[3, 3, 0, 0]} />
                                  <Bar dataKey="Outliers" fill={chart.primaryBar} radius={[3, 3, 0, 0]} />
                                </BarChart>
                              </ResponsiveContainer>
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    {visualPreviews.length > 0 && (
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2">
                        {visualPreviews.slice(0, 4).map((vp, idx) => (
                          <div key={idx} className="border border-slate-200 dark:border-slate-800 rounded overflow-hidden bg-slate-50 dark:bg-[#0B1120]">
                            <img src={vp.url} alt={vp.type} className="w-full h-24 object-cover" />
                            <div className="p-2 text-[10px]">
                              <p className="font-semibold text-slate-800 dark:text-slate-200 truncate">{vp.type}</p>
                              <p className="text-slate-500 truncate">{vp.filename}</p>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </section>

                  {/* SECTION 6: EVIDENCE COMPARISON & GAPS */}
                  <section className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-5 space-y-3">
                    <h3 className="font-display text-sm font-bold text-slate-900 dark:text-slate-100">
                      6. Evidence Comparison &amp; Coverage Gaps
                    </h3>
                    {Array.isArray(parsed.missingEvidence) && parsed.missingEvidence.length > 0 && (
                      <div className="p-3 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded text-xs text-amber-900 dark:text-amber-300 space-y-1">
                        <p className="font-semibold">Missing Evidence &amp; Verification Gaps</p>
                        {(parsed.missingEvidence as string[]).map((gap, idx) => (
                          <p key={idx}>• {gap}</p>
                        ))}
                      </div>
                    )}
                    {(bundle?.correlations || []).length === 0 ? (
                      <p className="text-xs text-slate-500">
                        Only one evidence file was uploaded or no cross-file comparison links were created.
                      </p>
                    ) : (
                      <div className="divide-y divide-slate-200 dark:divide-slate-800">
                        {(bundle?.correlations || []).map((c) => {
                          const src = bundle?.evidence.find((e) => e.id === c.source_evidence_id)?.original_filename || c.source_evidence_id;
                          const tgt = bundle?.evidence.find((e) => e.id === c.target_evidence_id)?.original_filename || c.target_evidence_id;
                          const tr = translateCorrelationForView(c, src, tgt, viewMode);
                          return (
                            <div key={c.id} className="py-2.5 text-xs">
                              <p className={`font-semibold ${statusTextClass(c.relationship_type)}`}>
                                {tr.label}: {src} vs {tgt}
                              </p>
                              <p className="text-slate-600 dark:text-slate-400 mt-0.5">{tr.summary}</p>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </section>

                  {/* SECTION 7: SUGGESTED NEXT STEPS */}
                  <section className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-5 space-y-3">
                    <h3 className="font-display text-sm font-bold text-slate-900 dark:text-slate-100">
                      7. Suggested Next Steps
                    </h3>
                    <ul className="space-y-1.5 text-xs text-slate-700 dark:text-slate-300 list-disc pl-4">
                      {(parsed.recommendedNextSteps || []).map((s: string, i: number) => (
                        <li key={i}>{s}</li>
                      ))}
                    </ul>
                  </section>

                  {/* SECTION 8: TECHNICAL DETAILS (ADVANCED REFERENCE) */}
                  <section className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-5 space-y-3">
                    <button
                      type="button"
                      onClick={() => setTechExpanded((v) => !v)}
                      className="w-full flex items-center justify-between text-left"
                    >
                      <div>
                        <h3 className="font-display text-sm font-bold text-slate-900 dark:text-slate-100">
                          8. Technical Details (Advanced Reference)
                        </h3>
                        <p className="text-xs text-slate-500">
                          SHA-256 cryptographic hashes, internal model IDs, raw scores, and forensic limitations
                        </p>
                      </div>
                      {showTechnical ? (
                        <ChevronUp className="w-4 h-4 text-slate-500" />
                      ) : (
                        <ChevronDown className="w-4 h-4 text-slate-500" />
                      )}
                    </button>

                    {showTechnical && (
                      <div className="pt-3 border-t border-slate-200 dark:border-slate-800 space-y-4 text-xs">
                        <div>
                          <p className="font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                            SHA-256 Evidence Digests
                          </p>
                          <div className="space-y-1 font-mono text-[11px] text-slate-600 dark:text-slate-400">
                            {(bundle?.evidence || []).map((ev) => (
                              <p key={ev.id} className="break-all">
                                [{ev.id}] {ev.original_filename}: {ev.sha256_hash}
                              </p>
                            ))}
                          </div>
                        </div>

                        {(bundle?.predictions || []).length > 0 && (
                          <div>
                            <p className="font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                              Raw Model Identifiers &amp; Caveats
                            </p>
                            <div className="space-y-1.5 font-mono text-[11px]">
                              {(bundle?.predictions || []).map((p) => (
                                <p key={p.id} className="text-slate-600 dark:text-slate-400">
                                  [{p.evidence_id}] {p.model_id}: label={p.prediction_label}, raw_score={p.raw_score} —{' '}
                                  <span className="font-sans">{p.uncertainty_note}</span>
                                </p>
                              ))}
                            </div>
                          </div>
                        )}

                        <div>
                          <p className="font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                            Methodological Limitations
                          </p>
                          <div className="space-y-1 text-[11px] text-slate-500">
                            {(bundle?.analyses || []).map((a) => (
                              <p key={a.id}>
                                <span className="font-mono">{a.evidence_id}:</span> {a.limitations}
                              </p>
                            ))}
                          </div>
                        </div>
                      </div>
                    )}
                  </section>
                </div>

                {/* Analyst Sign-Off & Audit Trail */}
                <div className="lg:col-span-4 space-y-5">
                  <form
                    onSubmit={handleSaveConclusion}
                    className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-5 space-y-3"
                  >
                    <h3 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                      Human Reviewer Sign-Off
                    </h3>
                    <textarea
                      rows={4}
                      value={conclusion}
                      onChange={(e) => setConclusion(e.target.value)}
                      className="w-full bg-slate-50 dark:bg-[#162032] border border-slate-300 dark:border-slate-700 rounded-md p-2.5 text-xs text-slate-900 dark:text-slate-100 focus:outline-none focus:border-blue-600 dark:focus:border-sky-400"
                    />
                    {savedMsg && (
                      <p className="text-xs text-teal-700 dark:text-teal-400 flex items-center gap-1">
                        <Check className="w-3.5 h-3.5" />
                        {savedMsg}
                      </p>
                    )}
                    <button
                      type="submit"
                      disabled={saving}
                      className="w-full py-2 text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white rounded-md transition-colors"
                    >
                      {saving ? 'Recording...' : 'Record Reviewer Conclusion'}
                    </button>
                  </form>

                  <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-5 space-y-2">
                    <h3 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                      Investigation Audit History
                    </h3>
                    <div className="divide-y divide-slate-200 dark:divide-slate-800 max-h-72 overflow-y-auto text-xs">
                      {(bundle?.auditLogs || []).map((log) => (
                        <div key={log.id} className="py-2">
                          <p className="font-medium text-slate-800 dark:text-slate-200">
                            {log.action.replace(/_/g, ' ')}
                          </p>
                          <p className="font-mono text-[11px] text-slate-500">
                            {log.actor} · {new Date(log.created_at).toLocaleString()}
                          </p>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </ConsoleShell>
  );
};
