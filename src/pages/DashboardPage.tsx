import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowUpRight, FolderPlus, Plus } from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { ConsoleShell, formatStatusLabel, statusTextClass } from '../components/ConsoleShell.tsx';
import { useChartTheme } from '../context/ThemeContext.tsx';
import { useViewMode } from '../context/ViewModeContext.tsx';
import { api, DashboardPayload } from '../services/api.ts';
import {
  loadDashboardSnapshot,
  saveDashboardSnapshot,
  setActiveCaseId,
} from '../services/sessionStorage.ts';
import { translateModelDisplay } from '../utils/plainEnglish.ts';

export const DashboardPage: React.FC = () => {
  const navigate = useNavigate();
  const chart = useChartTheme();
  const { viewMode } = useViewMode();
  const [data, setData] = useState<DashboardPayload | null>(() => loadDashboardSnapshot());
  const [loading, setLoading] = useState(!loadDashboardSnapshot());
  const [error, setError] = useState('');

  const [quickTitle, setQuickTitle] = useState('');
  const [quickDesc, setQuickDesc] = useState('');
  const [creating, setCreating] = useState(false);

  const load = () => {
    setLoading(true);
    api
      .getDashboard()
      .then((res) => {
        setData(res);
        saveDashboardSnapshot(res);
        setError('');
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load dashboard'))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
  }, []);

  const handleQuickCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (quickTitle.trim().length < 3) return;
    setCreating(true);
    try {
      const res = await api.createInvestigation({
        title: quickTitle.trim(),
        description: quickDesc.trim(),
      });
      setActiveCaseId(res.investigation.id);
      navigate(`/investigations/${res.investigation.id}/upload`);
    } finally {
      setCreating(false);
    }
  };

  const mlTimelineData = (data?.predictionTimeline || []).map((p) => {
    const modelMeta = translateModelDisplay(p.model_id, viewMode);
    return {
      name: `${p.original_filename.slice(0, 12)} (${
        viewMode === 'simple' ? modelMeta.name.split(' ')[0] : p.model_id.replace('TL-', '').slice(0, 8)
      })`,
      score: Number((p.raw_score * 100).toFixed(1)),
      model: modelMeta.name,
      file: p.original_filename,
    };
  });

  const severityData = (data?.indicatorSeverityBreakdown || []).map((s) => {
    const raw = s.severity.toLowerCase();
    return {
      severity:
        raw === 'critical'
          ? viewMode === 'simple'
            ? 'High Priority'
            : 'Critical'
          : raw === 'warning'
          ? viewMode === 'simple'
            ? 'Needs Review'
            : 'Warning'
          : viewMode === 'simple'
          ? 'Normal / Info'
          : 'Info',
      rawSeverity: raw,
      count: s.count,
    };
  });

  const datasetChartData = (data?.datasetQualityTimeline || []).map((d) => ({
    name: d.filename.slice(0, 16),
    Before: d.beforeScore,
    After: d.afterScore,
  }));

  const hasInvestigations = (data?.metrics.totalInvestigations ?? 0) > 0;
  const sysHealth = data?.systemHealth;

  return (
    <ConsoleShell
      title="Investigation Dashboard"
      subtitle={
        viewMode === 'simple'
          ? 'Overview of your saved investigations, evidence checks, and file warnings'
          : 'Live SQLite metrics, dataset quality scores, uncalibrated ML signals, and multi-agent activity'
      }
      onInvestigationCreated={(inv) => navigate(`/investigations/${inv.id}`)}
    >
      {error && (
        <div className="mb-6 p-4 bg-white dark:bg-[#111827] border border-rose-300 dark:border-rose-500/50 rounded-lg text-xs text-rose-600 dark:text-rose-400 flex items-center justify-between">
          <span>{error}</span>
          <button type="button" onClick={load} className="underline font-medium">
            Retry
          </button>
        </div>
      )}

      {/* System Engine Readiness Notice if optional modules offline */}
      {sysHealth && (!sysHealth.geminiConfigured || !sysHealth.ffmpegAvailable) && (
        <div className="mb-5 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg px-4 py-2.5 text-xs text-amber-900 dark:text-amber-300 flex flex-wrap items-center justify-between gap-2">
          <div>
            {!sysHealth.geminiConfigured && (
              <span>
                <span className="font-semibold">AI Narrative Service Offline:</span>{' '}
                <code>GEMINI_API_KEY</code> is not set — automated media &amp; pattern detection works locally, while AI
                spoken-word comparison is disabled.
              </span>
            )}
            {!sysHealth.ffmpegAvailable && (
              <span className="ml-2">
                <span className="font-semibold">FFmpeg Unavailable:</span> Video/audio decoding disabled.
              </span>
            )}
          </div>
          <Link to="/settings" className="font-semibold underline whitespace-nowrap">
            System Health
          </Link>
        </div>
      )}

      {/* 4-Column KPI Strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-4">
          <p className="text-xs font-medium text-slate-500 dark:text-slate-400">Saved Investigations</p>
          <p className="font-mono text-2xl font-semibold text-slate-900 dark:text-slate-100 mt-1 tabular-nums">
            {loading && !data ? '—' : data?.metrics.totalInvestigations ?? 0}
          </p>
          <p className="text-[11px] text-slate-500 mt-1">Persisted in DB &amp; Local Storage</p>
        </div>
        <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-4">
          <p className="text-xs font-medium text-slate-500 dark:text-slate-400">Evidence Files</p>
          <p className="font-mono text-2xl font-semibold text-blue-600 dark:text-sky-400 mt-1 tabular-nums">
            {loading && !data ? '—' : data?.metrics.totalEvidence ?? 0}
          </p>
          <p className="text-[11px] text-slate-500 mt-1">Images, video, audio, text &amp; datasets</p>
        </div>
        <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-4">
          <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
            {data?.metrics.avgDatasetQuality !== null && data?.metrics.avgDatasetQuality !== undefined
              ? 'Avg Cleaned Dataset Quality'
              : 'Flagged Clues'}
          </p>
          <p className="font-mono text-2xl font-semibold text-teal-600 dark:text-teal-400 mt-1 tabular-nums">
            {data?.metrics.avgDatasetQuality !== null && data?.metrics.avgDatasetQuality !== undefined
              ? `${data.metrics.avgDatasetQuality}%`
              : loading && !data
              ? '—'
              : data?.metrics.suspiciousIndicators ?? 0}
          </p>
          <p className="text-[11px] text-slate-500 mt-1">
            {data?.metrics.avgDatasetQuality !== null && data?.metrics.avgDatasetQuality !== undefined
              ? `${data?.metrics.suspiciousIndicators ?? 0} warning/high flags`
              : 'Warning & high-priority flags'}
          </p>
        </div>
        <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-4">
          <p className="text-xs font-medium text-slate-500 dark:text-slate-400">Needing Human Review</p>
          <p className="font-mono text-2xl font-semibold text-rose-600 dark:text-rose-400 mt-1 tabular-nums">
            {loading && !data ? '—' : data?.metrics.reviewRequiredCount ?? 0}
          </p>
          <p className="text-[11px] text-slate-500 mt-1">Pending investigator sign-off</p>
        </div>
      </div>

      {/* Clean First-Run Quick Start Banner when 0 investigations exist */}
      {!loading && !hasInvestigations && (
        <div className="mb-6 bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-6 grid lg:grid-cols-12 gap-6 items-center">
          <div className="lg:col-span-6 space-y-2">
            <p className="text-xs font-mono text-blue-600 dark:text-sky-400">Ready for Analysis</p>
            <h2 className="font-display text-lg font-bold text-slate-900 dark:text-slate-100">
              Start Your First Investigation
            </h2>
            <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
              Create an investigation to check images, videos, audio clips, transcripts, or CSV datasets (.jpg, .png,
              .mp4, .wav, .srt, .csv). Every uploaded file, chart, and report saves automatically across refreshes.
            </p>
          </div>
          <form onSubmit={handleQuickCreate} className="lg:col-span-6 space-y-3 text-xs">
            <div className="grid sm:grid-cols-2 gap-3">
              <input
                type="text"
                required
                minLength={3}
                value={quickTitle}
                onChange={(e) => setQuickTitle(e.target.value)}
                placeholder="Investigation title (e.g., Video Claim Check)"
                className="w-full bg-slate-50 dark:bg-[#162032] border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-slate-900 dark:text-slate-100 focus:outline-none focus:border-blue-600"
              />
              <input
                type="text"
                value={quickDesc}
                onChange={(e) => setQuickDesc(e.target.value)}
                placeholder="Optional provenance or context note"
                className="w-full bg-slate-50 dark:bg-[#162032] border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-slate-900 dark:text-slate-100 focus:outline-none focus:border-blue-600"
              />
            </div>
            <button
              type="submit"
              disabled={creating || quickTitle.trim().length < 3}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-md"
            >
              <Plus className="w-3.5 h-3.5" />
              {creating ? 'Creating Investigation...' : 'Create Investigation & Upload Evidence'}
            </button>
          </form>
        </div>
      )}

      {/* Charts Row: 2x2 Grid with Real Persisted Data */}
      <div className="grid lg:grid-cols-12 gap-6 mb-6">
        <div className="lg:col-span-6 bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-5">
          <div className="mb-4">
            <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
              Evidence Types Analysed
            </h2>
            <p className="text-xs text-slate-500">Uploaded evidence files grouped by media type</p>
          </div>
          <div className="h-52">
            {loading && !data ? (
              <div className="h-full bg-slate-100 dark:bg-slate-800/50 rounded animate-pulse" />
            ) : (data?.modalityDistribution || []).length === 0 ? (
              <div className="h-full flex items-center justify-center text-xs text-slate-400">
                Upload evidence files to view breakdown
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data?.modalityDistribution || []} margin={{ top: 8, right: 12, left: -16, bottom: 0 }}>
                  <CartesianGrid stroke={chart.gridStroke} strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="modality" stroke={chart.axisStroke} fontSize={12} tickLine={false} />
                  <YAxis stroke={chart.axisStroke} fontSize={12} tickLine={false} allowDecimals={false} />
                  <Tooltip contentStyle={chart.tooltipStyle} />
                  <Bar dataKey="count" name="Files" fill={chart.primaryBar} radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        <div className="lg:col-span-6 bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-5">
          <div className="mb-4">
            <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
              Flagged Indicators by Severity
            </h2>
            <p className="text-xs text-slate-500">Real indicator counts computed across all active investigations</p>
          </div>
          <div className="h-52">
            {severityData.length === 0 ? (
              <div className="h-full flex items-center justify-center text-xs text-slate-400 text-center px-4">
                Run an investigation pipeline to plot detected indicator severities
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={severityData} margin={{ top: 8, right: 12, left: -16, bottom: 0 }}>
                  <CartesianGrid stroke={chart.gridStroke} strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="severity" stroke={chart.axisStroke} fontSize={12} tickLine={false} />
                  <YAxis stroke={chart.axisStroke} fontSize={12} tickLine={false} allowDecimals={false} />
                  <Tooltip contentStyle={chart.tooltipStyle} />
                  <Bar dataKey="count" name="Indicators" radius={[4, 4, 0, 0]}>
                    {severityData.map((entry) => (
                      <Cell
                        key={entry.rawSeverity}
                        fill={
                          entry.rawSeverity === 'critical'
                            ? chart.coralBar
                            : entry.rawSeverity === 'warning'
                            ? chart.amberBar
                            : chart.tealBar
                        }
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        <div className="lg:col-span-6 bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                Uncalibrated Raw Model Scores
              </h2>
              <p className="text-xs text-slate-500">
                Relative anomaly pattern scores (not factual probabilities)
              </p>
            </div>
            <Link to="/models" className="text-xs font-medium text-blue-600 dark:text-sky-400 hover:underline whitespace-nowrap">
              {viewMode === 'simple' ? 'About Detectors' : 'Model Benchmarks'}
            </Link>
          </div>
          <div className="h-52">
            {mlTimelineData.length === 0 ? (
              <div className="h-full flex items-center justify-center text-xs text-slate-400 text-center px-4">
                Analyze image, video, or audio files to plot raw detector scores
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={mlTimelineData} margin={{ top: 8, right: 12, left: -12, bottom: 0 }}>
                  <CartesianGrid stroke={chart.gridStroke} strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="name" stroke={chart.axisStroke} fontSize={10} tickLine={false} />
                  <YAxis stroke={chart.axisStroke} fontSize={11} tickLine={false} domain={[0, 100]} unit="%" />
                  <Tooltip
                    contentStyle={chart.tooltipStyle}
                    formatter={(value: unknown, _name: unknown, props: { payload?: { model?: string; file?: string } }) => [
                      `Raw ${value}% (${props?.payload?.model || ''})`,
                      props?.payload?.file || 'Uncalibrated Score',
                    ]}
                  />
                  <Bar dataKey="score" name="Raw Model Score %" fill={chart.cyanLine} radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        <div className="lg:col-span-6 bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-5">
          <div className="mb-4">
            <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
              Dataset Quality (Before vs After Cleaning)
            </h2>
            <p className="text-xs text-slate-500">Automated CSV/TSV quality improvement</p>
          </div>
          <div className="h-52">
            {datasetChartData.length === 0 ? (
              <div className="h-full flex items-center justify-center text-xs text-slate-400 text-center px-4">
                Analyze a CSV or TSV dataset to track before-and-after quality scores
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={datasetChartData} margin={{ top: 8, right: 12, left: -12, bottom: 0 }}>
                  <CartesianGrid stroke={chart.gridStroke} strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="name" stroke={chart.axisStroke} fontSize={11} tickLine={false} />
                  <YAxis stroke={chart.axisStroke} fontSize={11} domain={[0, 100]} />
                  <Tooltip contentStyle={chart.tooltipStyle} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar dataKey="Before" fill={chart.amberBar} radius={[3, 3, 0, 0]} />
                  <Bar dataKey="After" fill={chart.tealBar} radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>
      </div>

      {/* Investigations Table + Recent Agent Activity */}
      <div className="grid lg:grid-cols-12 gap-6">
        <div className="lg:col-span-7 bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
            <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
              Saved Investigations
            </h2>
            <Link to="/history" className="text-xs font-medium text-blue-600 dark:text-sky-400 hover:underline">
              View All Investigations
            </Link>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 dark:bg-[#162032] text-slate-600 dark:text-slate-300 border-b border-slate-200 dark:border-slate-800">
                <tr>
                  <th className="py-2.5 px-4 font-medium">Investigation</th>
                  <th className="py-2.5 px-4 font-medium">Status</th>
                  <th className="py-2.5 px-4 font-medium text-right">Files</th>
                  <th className="py-2.5 px-4 font-medium text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                {(data?.recentInvestigations || []).map((inv) => (
                  <tr key={inv.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors">
                    <td className="py-3 px-4">
                      <p className="font-medium text-slate-900 dark:text-slate-100">{inv.title}</p>
                      <p className="font-mono text-[11px] text-slate-500 mt-0.5">
                        {inv.case_code} · {new Date(inv.updated_at).toLocaleDateString()}
                      </p>
                    </td>
                    <td className={`py-3 px-4 font-medium ${statusTextClass(inv.status)}`}>
                      {formatStatusLabel(inv.status)}
                    </td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-700 dark:text-slate-300">
                      {inv.evidence_count ?? 0}
                    </td>
                    <td className="py-3 px-4 text-right">
                      <Link
                        to={`/investigations/${inv.id}`}
                        className="inline-flex items-center gap-1 text-blue-600 dark:text-sky-400 hover:underline font-medium"
                      >
                        Open
                        <ArrowUpRight className="w-3.5 h-3.5" />
                      </Link>
                    </td>
                  </tr>
                ))}
                {!loading && (data?.recentInvestigations || []).length === 0 && (
                  <tr>
                    <td colSpan={4} className="py-8 text-center text-slate-500">
                      <FolderPlus className="w-5 h-5 mx-auto mb-2 opacity-60" />
                      No investigations saved yet. Start your first investigation above.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="lg:col-span-5 bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
            <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
              Recent Pipeline Activity
            </h2>
            <Link to="/agents" className="text-xs font-medium text-blue-600 dark:text-sky-400 hover:underline">
              Execution Ledger
            </Link>
          </div>
          <div className="divide-y divide-slate-200 dark:divide-slate-800 max-h-[340px] overflow-y-auto">
            {(data?.recentAgents || []).map((ag) => (
              <div key={ag.id} className="px-5 py-3 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-slate-900 dark:text-slate-100">{ag.agent_name}</span>
                  <span className={`font-mono text-[11px] font-medium ${statusTextClass(ag.status)}`}>
                    {ag.status}
                  </span>
                </div>
                <p className="text-slate-600 dark:text-slate-400 mt-1 line-clamp-1">{ag.responsibility}</p>
                <p className="font-mono text-[11px] text-slate-500 mt-1">
                  {ag.investigation_id} · {new Date(ag.started_at).toLocaleTimeString()}
                </p>
              </div>
            ))}
            {!loading && (data?.recentAgents || []).length === 0 && (
              <p className="px-5 py-8 text-center text-xs text-slate-500">
                Agent activity will appear here once you analyze uploaded evidence or datasets.
              </p>
            )}
          </div>
        </div>
      </div>
    </ConsoleShell>
  );
};
