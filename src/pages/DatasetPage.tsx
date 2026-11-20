import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  CheckCircle2,
  Database,
  Download,
  FileSpreadsheet,
  FolderPlus,
  Play,
  RefreshCw,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { ConsoleShell, statusTextClass } from '../components/ConsoleShell.tsx';
import { WorkflowStepper } from '../components/WorkflowStepper.tsx';
import { useChartTheme } from '../context/ThemeContext.tsx';
import { useViewMode } from '../context/ViewModeContext.tsx';
import { translateIndicatorForView } from '../utils/plainEnglish.ts';
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

export const DatasetPage: React.FC = () => {
  const { id, evidenceId } = useParams();
  const navigate = useNavigate();
  const caseId = id && id !== 'none' ? id : getActiveCaseId();
  const chart = useChartTheme();
  const { viewMode } = useViewMode();
  const [bundle, setBundle] = useState<WorkspaceBundle | null>(() =>
    caseId ? loadWorkspaceSnapshot(caseId) : null,
  );
  const [selectedId, setSelectedId] = useState('');
  const [running, setRunning] = useState(false);

  // Quick CSV/TSV submission state persisted in localStorage
  const initialDraft = getDrafts().textEditor;
  const [filename, setFilename] = useState(
    initialDraft.filename.endsWith('.csv') || initialDraft.filename.endsWith('.tsv')
      ? initialDraft.filename
      : 'records_dataset.csv',
  );
  const [format, setFormat] = useState<'csv' | 'tsv'>(
    initialDraft.format === 'tsv' ? 'tsv' : 'csv',
  );
  const [content, setContent] = useState(initialDraft.content);
  const [contextNote, setContextNote] = useState(initialDraft.contextNote);
  const [submitting, setSubmitting] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');

  const load = () => {
    if (!caseId) return;
    api.getWorkspace(caseId).then((res) => {
      setBundle(res);
      saveWorkspaceSnapshot(caseId, res);
      const datasets = res.evidence.filter((e) => e.modality === 'dataset');
      if (evidenceId && datasets.some((d) => d.id === evidenceId)) {
        setSelectedId(evidenceId);
      } else if (datasets.length > 0 && !selectedId) {
        setSelectedId(datasets[0].id);
      }
    }).catch(() => {});
  };

  useEffect(() => {
    load();
  }, [caseId, evidenceId]);

  useEffect(() => {
    updateDrafts((prev) => ({
      ...prev,
      textEditor: { ...prev.textEditor, filename, format, content, contextNote },
    }));
  }, [filename, format, content, contextNote]);

  const datasets = bundle?.evidence.filter((e) => e.modality === 'dataset') || [];
  const activeEv = datasets.find((d) => d.id === selectedId) || datasets[0];
  const analysis = bundle?.analyses.find((a) => a.evidence_id === activeEv?.id);
  const metrics = analysis ? JSON.parse(analysis.metrics_json || '{}') : {};
  const artifacts = analysis ? JSON.parse(analysis.artifacts_json || '{}') : {};
  const columns: DatasetColumnProfile[] = artifacts.columns || [];
  const fixesApplied: DatasetFixAction[] = artifacts.fixesApplied || [];
  const beforeAfter: BeforeAfterComparison[] = artifacts.beforeAfterComparisons || [];
  const validationChecks: ValidationCheck[] = artifacts.validationChecks || [];
  const beforeSample: Array<Record<string, string>> = artifacts.beforeSample || [];
  const afterSample: Array<Record<string, string>> = artifacts.afterSample || [];
  const recommendations: string[] = artifacts.recommendations || [];
  const indicators: ForensicIndicator[] = analysis ? JSON.parse(analysis.indicators_json || '[]') : [];

  const columnHealthChart = (
    columns.length > 20
      ? [...columns].sort(
          (a, b) =>
            b.missingCount +
            b.typeErrorCount +
            b.outlierCount -
            (a.missingCount + a.typeErrorCount + a.outlierCount),
        ).slice(0, 20)
      : columns
  ).map((c) => ({
    name: c.name.slice(0, 14),
    Missing: c.missingCount,
    TypeErrors: c.typeErrorCount,
    Outliers: c.outlierCount,
  }));

  const beforeAfterChart = beforeAfter
    .filter((b) => b.metric !== 'Row Count')
    .map((b) => ({
      metric: b.metric,
      Before: b.before,
      After: b.after,
    }));

  const handleIngestDataset = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!caseId || content.trim().length < 5) return;
    setSubmitting(true);
    setStatusMsg('');
    try {
      await api.ingestTextEvidence(caseId, { filename, format, content, contextNote });
      await api.runAnalysis(caseId);
      setContent('');
      setContextNote('');
      setStatusMsg('Dataset profiled, cleaned, and validated.');
      load();
    } catch (err) {
      setStatusMsg(err instanceof Error ? err.message : 'Dataset ingestion failed');
    } finally {
      setSubmitting(false);
    }
  };

  const handleReanalyze = async () => {
    if (!caseId) return;
    setRunning(true);
    try {
      await api.runAnalysis(caseId);
      load();
    } finally {
      setRunning(false);
    }
  };

  return (
    <ConsoleShell
      title="Dataset Quality & Cleaning Lab"
      subtitle={
        caseId
          ? `Investigation ${caseId} · Missing value audit, deduplication, anomaly detection, automated cleaning & validation`
          : 'Create or select an active investigation to analyze tabular CSV/TSV datasets'
      }
      activeInvestigationId={caseId}
      actions={
        caseId && datasets.length > 0 ? (
          <div className="flex items-center gap-2">
            {artifacts.cleanedCsvUrl && (
              <a
                href={artifacts.cleanedCsvUrl}
                download={`cleaned_${activeEv?.original_filename || 'dataset.csv'}`}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-white dark:bg-[#111827] border border-slate-300 dark:border-slate-700 hover:border-blue-600 dark:hover:border-sky-400 text-slate-800 dark:text-slate-100 rounded-md whitespace-nowrap"
              >
                <Download className="w-3.5 h-3.5" />
                Download Cleaned CSV
              </a>
            )}
            <button
              type="button"
              onClick={handleReanalyze}
              disabled={running}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-md whitespace-nowrap"
            >
              {running ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
              {running ? 'Profiling...' : 'Re-Run Cleaning'}
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
            Start a new investigation from the sidebar or dashboard to upload CSV/TSV datasets and generate automated cleaning
            and validation reports.
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
        <div className="space-y-6">
          <WorkflowStepper caseId={caseId} bundle={bundle} />
          {/* Dataset Switcher + Paste Form Split when needed */}
          {datasets.length > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap gap-2">
                {datasets.map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    onClick={() => setSelectedId(d.id)}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md border transition-colors whitespace-nowrap ${
                      activeEv?.id === d.id
                        ? 'bg-blue-600 border-blue-600 text-white font-medium'
                        : 'bg-white dark:bg-[#111827] border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-300'
                    }`}
                  >
                    <FileSpreadsheet className="w-3.5 h-3.5" />
                    {d.original_filename}
                  </button>
                ))}
              </div>
              <Link
                to={`/investigations/${caseId}/upload`}
                className="text-xs font-medium text-blue-600 dark:text-sky-400 hover:underline whitespace-nowrap"
              >
                + Upload CSV / TSV File
              </Link>
            </div>
          )}

          {activeEv && analysis ? (
            <div className="space-y-6">
              {/* Dataset Quality KPI Strip */}
              <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
                <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-4">
                  <p className="text-xs font-medium text-slate-500">Quality Score</p>
                  <p className="font-mono text-xl font-semibold text-teal-700 dark:text-teal-400 mt-1 tabular-nums">
                    {metrics.beforeQualityScore ?? '—'} → {metrics.afterQualityScore ?? '—'}
                  </p>
                  <p className="text-[11px] text-slate-500 mt-0.5">Out of 100.0</p>
                </div>
                <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-4">
                  <p className="text-xs font-medium text-slate-500">Rows × Columns</p>
                  <p className="font-mono text-xl font-semibold text-slate-900 dark:text-slate-100 mt-1 tabular-nums">
                    {metrics.rowCount ?? 0} → {metrics.afterRowCount ?? 0} × {metrics.columnCount ?? 0}
                  </p>
                  <p className="text-[11px] text-slate-500 mt-0.5">Raw vs cleaned rows</p>
                </div>
                <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-4">
                  <p className="text-xs font-medium text-slate-500">Missing Values</p>
                  <p className="font-mono text-xl font-semibold text-amber-600 dark:text-amber-400 mt-1 tabular-nums">
                    {metrics.totalMissingValues ?? 0} → {metrics.afterMissingValues ?? 0}
                  </p>
                  <p className="text-[11px] text-slate-500 mt-0.5">Cells imputed</p>
                </div>
                <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-4">
                  <p className="text-xs font-medium text-slate-500">Duplicates &amp; Errors</p>
                  <p className="font-mono text-xl font-semibold text-rose-600 dark:text-rose-400 mt-1 tabular-nums">
                    {(metrics.duplicateRowCount ?? 0) + (metrics.typeErrorCount ?? 0)} → {metrics.afterTypeErrorCount ?? 0}
                  </p>
                  <p className="text-[11px] text-slate-500 mt-0.5">
                    {metrics.duplicateRowCount ?? 0} dup · {metrics.typeErrorCount ?? 0} type err
                  </p>
                </div>
                <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-4">
                  <p className="text-xs font-medium text-slate-500">Statistical Outliers</p>
                  <p className="font-mono text-xl font-semibold text-blue-600 dark:text-sky-400 mt-1 tabular-nums">
                    {metrics.outlierCount ?? 0}
                  </p>
                  <p className="text-[11px] text-slate-500 mt-0.5">IQR / Z-score flagged</p>
                </div>
              </div>

              {/* Charts Row */}
              <div className="grid lg:grid-cols-2 gap-6">
                <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-5">
                  <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100 mb-1">
                    Column Issues Breakdown
                  </h2>
                  <p className="text-xs text-slate-500 mb-4">
                    Missing cells, schema/type errors, and statistical outliers per column
                    {columns.length > 20 ? ` (top 20 of ${columns.length} columns by issue count)` : ''}
                  </p>
                  <div className="h-60">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={columnHealthChart} margin={{ top: 8, right: 12, left: -16, bottom: 0 }}>
                        <CartesianGrid stroke={chart.gridStroke} strokeDasharray="3 3" vertical={false} />
                        <XAxis dataKey="name" stroke={chart.axisStroke} fontSize={11} />
                        <YAxis stroke={chart.axisStroke} fontSize={11} allowDecimals={false} />
                        <Tooltip contentStyle={chart.tooltipStyle} />
                        <Legend wrapperStyle={{ fontSize: 11 }} />
                        <Bar dataKey="Missing" fill={chart.amberBar} radius={[3, 3, 0, 0]} />
                        <Bar dataKey="TypeErrors" name="Type Errors" fill={chart.coralBar} radius={[3, 3, 0, 0]} />
                        <Bar dataKey="Outliers" fill={chart.primaryBar} radius={[3, 3, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>

                <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-5">
                  <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100 mb-1">
                    Before-and-After Cleaning Comparison
                  </h2>
                  <p className="text-xs text-slate-500 mb-4">
                    Deterministic comparison across quality score, missing cells, duplicates, and errors
                  </p>
                  <div className="h-60">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={beforeAfterChart} margin={{ top: 8, right: 12, left: -12, bottom: 0 }}>
                        <CartesianGrid stroke={chart.gridStroke} strokeDasharray="3 3" vertical={false} />
                        <XAxis dataKey="metric" stroke={chart.axisStroke} fontSize={11} />
                        <YAxis stroke={chart.axisStroke} fontSize={11} />
                        <Tooltip contentStyle={chart.tooltipStyle} />
                        <Legend wrapperStyle={{ fontSize: 11 }} />
                        <Bar dataKey="Before" fill={chart.amberBar} radius={[3, 3, 0, 0]} />
                        <Bar dataKey="After" fill={chart.tealBar} radius={[3, 3, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              </div>

              {/* Column Schema Profile Table */}
              <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
                <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Database className="w-4 h-4 text-blue-600 dark:text-sky-400" />
                    <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                      Column Schema &amp; Statistical Profile ({columns.length} columns)
                    </h2>
                  </div>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-slate-50 dark:bg-[#162032] text-slate-600 dark:text-slate-300 border-b border-slate-200 dark:border-slate-800">
                      <tr>
                        <th className="py-2.5 px-4 font-medium">Column</th>
                        <th className="py-2.5 px-4 font-medium">Inferred Type</th>
                        <th className="py-2.5 px-4 font-medium text-right">Missing</th>
                        <th className="py-2.5 px-4 font-medium text-right">Unique</th>
                        <th className="py-2.5 px-4 font-medium text-right">Type Errors</th>
                        <th className="py-2.5 px-4 font-medium text-right">Outliers</th>
                        <th className="py-2.5 px-4 font-medium text-right">Mean / Range</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200 dark:divide-slate-800 font-mono tabular-nums">
                      {columns.map((col) => (
                        <tr key={col.name} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                          <td className="py-2.5 px-4 font-sans font-medium text-slate-900 dark:text-slate-100">
                            {col.name}
                          </td>
                          <td className="py-2.5 px-4 uppercase text-cyan-700 dark:text-sky-400">
                            {col.inferredType}
                          </td>
                          <td className="py-2.5 px-4 text-right text-amber-700 dark:text-amber-400">
                            {col.missingCount} ({col.missingPct}%)
                          </td>
                          <td className="py-2.5 px-4 text-right text-slate-700 dark:text-slate-300">
                            {col.uniqueCount}
                          </td>
                          <td className="py-2.5 px-4 text-right text-rose-600 dark:text-rose-400">
                            {col.typeErrorCount}
                          </td>
                          <td className="py-2.5 px-4 text-right text-blue-600 dark:text-sky-400">
                            {col.outlierCount}
                          </td>
                          <td className="py-2.5 px-4 text-right text-slate-600 dark:text-slate-400">
                            {col.mean !== null ? `${col.mean} [${col.min}..${col.max}]` : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Automated Fixes + Validation Checks */}
              <div className="grid lg:grid-cols-2 gap-6">
                <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-5 space-y-3">
                  <div className="flex items-center gap-2">
                    <Sparkles className="w-4 h-4 text-blue-600 dark:text-sky-400" />
                    <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                      Automated Fixes Applied
                    </h2>
                  </div>
                  <div className="divide-y divide-slate-200 dark:divide-slate-800">
                    {fixesApplied.map((fx, i) => (
                      <div key={i} className="py-2.5 text-xs">
                        <div className="flex items-center justify-between">
                          <span className="font-medium text-slate-900 dark:text-slate-100">{fx.action}</span>
                          <span className="font-mono text-teal-700 dark:text-teal-400 font-semibold">
                            {fx.count} fixed
                          </span>
                        </div>
                        <p className="text-slate-600 dark:text-slate-400 mt-0.5">{fx.detail}</p>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-5 space-y-3">
                  <div className="flex items-center gap-2">
                    <ShieldCheck className="w-4 h-4 text-teal-600 dark:text-teal-400" />
                    <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                      Post-Fix Validation &amp; Recommendations
                    </h2>
                  </div>
                  <div className="divide-y divide-slate-200 dark:divide-slate-800">
                    {validationChecks.map((vc, i) => (
                      <div key={i} className="py-2 text-xs flex items-start justify-between gap-2">
                        <div>
                          <p className="font-medium text-slate-900 dark:text-slate-100">{vc.check}</p>
                          <p className="text-slate-600 dark:text-slate-400">{vc.detail}</p>
                        </div>
                        <span
                          className={`font-mono font-semibold shrink-0 flex items-center gap-1 ${
                            vc.passed ? 'text-teal-700 dark:text-teal-400' : 'text-rose-600 dark:text-rose-400'
                          }`}
                        >
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          {vc.passed ? 'PASS' : 'CHECK'}
                        </span>
                      </div>
                    ))}
                  </div>
                  {recommendations.length > 0 && (
                    <div className="pt-3 border-t border-slate-200 dark:border-slate-800">
                      <p className="text-xs font-semibold text-slate-800 dark:text-slate-200 mb-1.5">
                        Analyst Recommendations
                      </p>
                      <ul className="space-y-1 text-xs text-slate-600 dark:text-slate-400 list-disc pl-4">
                        {recommendations.map((rec, i) => (
                          <li key={i}>{rec}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              </div>

              {/* Before vs After Row Sample Preview */}
              {beforeSample.length > 0 && (
                <div className="grid lg:grid-cols-2 gap-6">
                  <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
                    <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 text-xs font-semibold text-amber-700 dark:text-amber-400">
                      Before Cleaning (First {beforeSample.length} Rows)
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-[11px] font-mono">
                        <thead className="bg-slate-50 dark:bg-[#162032] text-slate-500">
                          <tr>
                            {Object.keys(beforeSample[0]).map((k) => (
                              <th key={k} className="py-2 px-3">
                                {k}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                          {beforeSample.map((row, ri) => (
                            <tr key={ri}>
                              {Object.keys(beforeSample[0]).map((k) => (
                                <td key={k} className="py-1.5 px-3 text-slate-700 dark:text-slate-300">
                                  {row[k] === '' ? <span className="text-rose-500">[EMPTY]</span> : row[k]}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
                    <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 text-xs font-semibold text-teal-700 dark:text-teal-400">
                      After Automated Fixes (First {afterSample.length} Rows)
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-[11px] font-mono">
                        <thead className="bg-slate-50 dark:bg-[#162032] text-slate-500">
                          <tr>
                            {Object.keys(afterSample[0] || beforeSample[0]).map((k) => (
                              <th key={k} className="py-2 px-3">
                                {k}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                          {afterSample.map((row, ri) => (
                            <tr key={ri}>
                              {Object.keys(afterSample[0] || beforeSample[0]).map((k) => (
                                <td key={k} className="py-1.5 px-3 text-slate-800 dark:text-slate-200">
                                  {row[k]}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              )}

              {/* Indicators */}
              {indicators.length > 0 && (
                <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-5 space-y-2">
                  <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                    Dataset Diagnostic Indicators
                  </h2>
                  <div className="divide-y divide-slate-200 dark:divide-slate-800">
                    {indicators.map((ind) => {
                      const display = translateIndicatorForView(ind, viewMode);
                      return (
                        <div key={ind.id} className="py-2 text-xs">
                          <span className={`font-semibold ${statusTextClass(ind.severity)}`}>
                            [{ind.severity.toUpperCase()}]
                          </span>{' '}
                          <span className="font-medium text-slate-900 dark:text-slate-100">{display.title}</span>
                          <p className="text-slate-600 dark:text-slate-400 mt-0.5">{display.detail}</p>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          ) : null}

          {/* Direct Paste CSV/TSV Form */}
          <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-5 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                  Ingest &amp; Clean CSV / TSV Dataset
                </h2>
                <p className="text-xs text-slate-500">
                  Paste tabular data directly or use Upload Studio to drop `.csv` / `.tsv` files (drafts auto-saved to
                  Local Storage)
                </p>
              </div>
              <Link
                to={`/investigations/${caseId}/reports`}
                className="text-xs font-medium text-blue-600 dark:text-sky-400 hover:underline whitespace-nowrap"
              >
                View Full Report →
              </Link>
            </div>
            <form onSubmit={handleIngestDataset} className="space-y-3 text-xs">
              <div className="grid sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-slate-600 dark:text-slate-400 mb-1">Filename</label>
                  <input
                    type="text"
                    value={filename}
                    onChange={(e) => setFilename(e.target.value)}
                    className="w-full bg-slate-50 dark:bg-[#162032] border border-slate-300 dark:border-slate-700 rounded px-2.5 py-1.5 text-slate-900 dark:text-slate-100"
                  />
                </div>
                <div>
                  <label className="block text-slate-600 dark:text-slate-400 mb-1">Delimiter Format</label>
                  <select
                    value={format}
                    onChange={(e) => setFormat(e.target.value as 'csv' | 'tsv')}
                    className="w-full bg-slate-50 dark:bg-[#162032] border border-slate-300 dark:border-slate-700 rounded px-2.5 py-1.5 text-slate-900 dark:text-slate-100"
                  >
                    <option value="csv">CSV (Comma-separated)</option>
                    <option value="tsv">TSV (Tab-separated)</option>
                  </select>
                </div>
                <div>
                  <label className="block text-slate-600 dark:text-slate-400 mb-1">Source Context Note</label>
                  <input
                    type="text"
                    value={contextNote}
                    onChange={(e) => setContextNote(e.target.value)}
                    placeholder="e.g., Q4 customer transactions export"
                    className="w-full bg-slate-50 dark:bg-[#162032] border border-slate-300 dark:border-slate-700 rounded px-2.5 py-1.5 text-slate-900 dark:text-slate-100"
                  />
                </div>
              </div>
              <div>
                <label className="block text-slate-600 dark:text-slate-400 mb-1">CSV / TSV Rows</label>
                <textarea
                  rows={6}
                  required
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  placeholder="id,amount,region,status&#10;101,250.00,West,ok&#10;102,,East,pending"
                  className="w-full bg-slate-50 dark:bg-[#162032] border border-slate-300 dark:border-slate-700 rounded p-2.5 font-mono text-slate-900 dark:text-slate-100"
                />
              </div>
              {statusMsg && <p className="text-teal-700 dark:text-teal-400 font-medium">{statusMsg}</p>}
              <div className="flex justify-end">
                <button
                  type="submit"
                  disabled={submitting || content.trim().length < 5}
                  className="px-5 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-semibold rounded-md transition-colors"
                >
                  {submitting ? 'Profiling & Cleaning...' : 'Ingest, Clean & Generate Report'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </ConsoleShell>
  );
};
