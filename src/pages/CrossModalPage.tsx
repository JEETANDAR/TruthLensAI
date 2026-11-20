import React, { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ConsoleShell, statusTextClass } from '../components/ConsoleShell.tsx';
import { WorkflowStepper } from '../components/WorkflowStepper.tsx';
import { useTheme } from '../context/ThemeContext.tsx';
import { useViewMode } from '../context/ViewModeContext.tsx';
import { api } from '../services/api.ts';
import { getActiveCaseId, loadWorkspaceSnapshot, saveWorkspaceSnapshot } from '../services/sessionStorage.ts';
import { CorrelationRow, WorkspaceBundle } from '../types/forensics.ts';
import { translateCorrelationForView } from '../utils/plainEnglish.ts';

type FilterTab = 'ALL' | 'CONTRADICTS' | 'WEAKENS' | 'SUPPORTS' | 'DURATION_COMPATIBLE';

export const CrossModalPage: React.FC = () => {
  const { id } = useParams();
  const caseId = id && id !== 'none' ? id : getActiveCaseId();
  const { theme } = useTheme();
  const { viewMode } = useViewMode();
  const isDark = theme === 'dark';
  const [bundle, setBundle] = useState<WorkspaceBundle | null>(() =>
    caseId ? loadWorkspaceSnapshot(caseId) : null,
  );
  const [filter, setFilter] = useState<FilterTab>('ALL');
  const [selectedCorr, setSelectedCorr] = useState<CorrelationRow | null>(null);

  useEffect(() => {
    if (!caseId) return;
    api.getWorkspace(caseId).then((res) => {
      setBundle(res);
      saveWorkspaceSnapshot(caseId, res);
      if (res.correlations.length > 0) setSelectedCorr(res.correlations[0]);
    }).catch(() => {});
  }, [caseId]);

  const evidence = bundle?.evidence || [];
  const correlations = (bundle?.correlations || []).filter((c) =>
    filter === 'ALL' ? true : c.relationship_type === filter,
  );

  // Deterministic circular SVG layout for evidence nodes
  const cx = 340;
  const cy = 195;
  const rx = 220;
  const ry = 130;
  const nodePositions = new Map<string, { x: number; y: number }>();
  evidence.forEach((ev, idx) => {
    const angle = (idx / Math.max(1, evidence.length)) * Math.PI * 2 - Math.PI / 2;
    nodePositions.set(ev.id, {
      x: cx + rx * Math.cos(angle),
      y: cy + ry * Math.sin(angle),
    });
  });

  const modalityColor = (m: string) => {
    if (m === 'image') return isDark ? '#38BDF8' : '#2563EB';
    if (m === 'video') return isDark ? '#A78BFA' : '#4F46E5';
    if (m === 'audio') return isDark ? '#2DD4BF' : '#0D9488';
    return isDark ? '#FBBF24' : '#D97706';
  };

  const edgeColor = (rel: string) => {
    if (rel === 'CONTRADICTS' || rel === 'WEAKENS') return isDark ? '#FB7185' : '#E11D48';
    if (rel === 'SUPPORTS') return isDark ? '#2DD4BF' : '#0D9488';
    return isDark ? '#38BDF8' : '#0891B2';
  };

  const selectedAlts: string[] = selectedCorr
    ? JSON.parse(selectedCorr.alternative_explanations_json || '[]')
    : [];
  const selectedRefs: string[] = selectedCorr
    ? JSON.parse(selectedCorr.supporting_refs_json || '[]')
    : [];

  const latestReportJson = bundle?.reports?.[0] ? JSON.parse(bundle.reports[0].report_json || '{}') : {};
  const missingEvidence: string[] = Array.isArray(latestReportJson.missingEvidence)
    ? latestReportJson.missingEvidence
    : [];
  const conflictingCount = (bundle?.correlations || []).filter(
    (c) => c.relationship_type === 'CONTRADICTS' || c.relationship_type === 'WEAKENS',
  ).length;

  return (
    <ConsoleShell
      title="Cross-Modal Comparison Graph"
      subtitle={
        caseId
          ? `Investigation ${caseId} · Directional file comparisons, conflicts, and benign explanations`
          : 'No active investigation selected'
      }
      activeInvestigationId={caseId}
      actions={
        caseId ? (
          <Link
            to={`/investigations/${caseId}/timeline`}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-white dark:bg-[#111827] border border-slate-300 dark:border-slate-700 hover:border-blue-600 text-slate-800 dark:text-slate-100 rounded-md whitespace-nowrap shrink-0"
          >
            View Unified Timeline
          </Link>
        ) : null
      }
    >
      {!caseId ? (
        <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-10 text-center space-y-3">
          <p className="text-sm text-slate-700 dark:text-slate-300">
            Start or select an investigation from the Dashboard to compare uploaded files.
          </p>
          <Link
            to="/dashboard"
            className="inline-block px-4 py-2 text-xs font-semibold bg-blue-600 text-white rounded-md"
          >
            Go to Dashboard
          </Link>
        </div>
      ) : (
      <div className="space-y-6">
        <WorkflowStepper caseId={caseId} bundle={bundle} />
        {/* Epistemic Correlation Notice */}
        <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg px-4 py-3 text-xs text-slate-600 dark:text-slate-400">
          <span className="font-semibold text-slate-900 dark:text-slate-100">Correlation Standard:</span>{' '}
          Matching file or cue durations are classified strictly as{' '}
          <span className="font-mono text-cyan-700 dark:text-sky-400">DURATION_COMPATIBLE</span> (low-strength
          boundary check) and are never treated as proof of semantic or acoustic alignment without speech-to-text verification.
        </div>

        {(missingEvidence.length > 0 || conflictingCount > 0) && (
          <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg px-4 py-3 text-xs text-amber-900 dark:text-amber-300 space-y-1.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-semibold">Missing Evidence &amp; Conflicting Signals</span>
              <span className="font-mono tabular-nums">
                {missingEvidence.length} coverage gap(s) · {conflictingCount} contradicting/weakening link(s)
              </span>
            </div>
            {missingEvidence.map((gap, i) => (
              <p key={i}>• {gap}</p>
            ))}
          </div>
        )}

        {/* Filter Bar */}
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="inline-flex flex-wrap bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-md p-1 gap-1">
            {(
              [
                { id: 'ALL', label: 'All Relations' },
                { id: 'CONTRADICTS', label: 'Contradicts' },
                { id: 'WEAKENS', label: 'Weakens' },
                { id: 'SUPPORTS', label: 'Supports' },
                { id: 'DURATION_COMPATIBLE', label: 'Duration Compatible' },
              ] as const
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setFilter(tab.id)}
                className={`px-3 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap ${
                  filter === tab.id
                    ? 'bg-blue-600 text-white'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <span className="font-mono text-xs text-slate-500">
            {evidence.length} evidence nodes · {correlations.length} relationship edges
          </span>
        </div>

        {/* Graph + Inspector Split */}
        <div className="grid lg:grid-cols-12 gap-6">
          <div className="lg:col-span-7 bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-4">
            <svg
              viewBox="0 0 680 390"
              className="w-full h-[380px] bg-slate-50 dark:bg-[#0B1120] rounded border border-slate-200 dark:border-slate-800"
            >
              <defs>
                <marker id="arrow-red" viewBox="0 0 10 10" refX="26" refY="5" markerWidth="6" markerHeight="6" orient="auto">
                  <path d="M 0 0 L 10 5 L 0 10 z" fill={isDark ? '#FB7185' : '#E11D48'} />
                </marker>
                <marker id="arrow-green" viewBox="0 0 10 10" refX="26" refY="5" markerWidth="6" markerHeight="6" orient="auto">
                  <path d="M 0 0 L 10 5 L 0 10 z" fill={isDark ? '#2DD4BF' : '#0D9488'} />
                </marker>
                <marker id="arrow-blue" viewBox="0 0 10 10" refX="26" refY="5" markerWidth="6" markerHeight="6" orient="auto">
                  <path d="M 0 0 L 10 5 L 0 10 z" fill={isDark ? '#38BDF8' : '#0891B2'} />
                </marker>
              </defs>

              {correlations.map((c) => {
                const p1 = nodePositions.get(c.source_evidence_id);
                const p2 = nodePositions.get(c.target_evidence_id);
                if (!p1 || !p2) return null;
                const active = selectedCorr?.id === c.id;
                const stroke = edgeColor(c.relationship_type);
                const marker =
                  c.relationship_type === 'CONTRADICTS' || c.relationship_type === 'WEAKENS'
                    ? 'url(#arrow-red)'
                    : c.relationship_type === 'SUPPORTS'
                    ? 'url(#arrow-green)'
                    : 'url(#arrow-blue)';
                const mx = (p1.x + p2.x) / 2;
                const my = (p1.y + p2.y) / 2;

                return (
                  <g key={c.id} onClick={() => setSelectedCorr(c)} className="cursor-pointer">
                    <line
                      x1={p1.x}
                      y1={p1.y}
                      x2={p2.x}
                      y2={p2.y}
                      stroke={stroke}
                      strokeWidth={active ? 3 : 1.75}
                      strokeOpacity={active ? 1 : 0.72}
                      strokeDasharray={c.relationship_type === 'DURATION_COMPATIBLE' ? '5 4' : undefined}
                      markerEnd={marker}
                    />
                    <rect
                      x={mx - 58}
                      y={my - 10}
                      width={116}
                      height={18}
                      rx={4}
                      fill={isDark ? '#111827' : '#FFFFFF'}
                      stroke={stroke}
                      strokeWidth={0.9}
                    />
                    <text
                      x={mx}
                      y={my + 3}
                      textAnchor="middle"
                      fill={isDark ? '#F1F5F9' : '#0F172A'}
                      fontSize="8.5"
                      fontFamily="JetBrains Mono"
                    >
                      {c.relationship_type}
                    </text>
                  </g>
                );
              })}

              {evidence.map((ev) => {
                const pos = nodePositions.get(ev.id);
                if (!pos) return null;
                const color = modalityColor(ev.modality);
                const isConnected =
                  selectedCorr &&
                  (selectedCorr.source_evidence_id === ev.id || selectedCorr.target_evidence_id === ev.id);
                return (
                  <g key={ev.id}>
                    <circle
                      cx={pos.x}
                      cy={pos.y}
                      r={22}
                      fill={isDark ? '#162032' : '#FFFFFF'}
                      stroke={color}
                      strokeWidth={isConnected ? 3.2 : 2}
                    />
                    <text
                      x={pos.x}
                      y={pos.y + 3}
                      textAnchor="middle"
                      fill={isDark ? '#F1F5F9' : '#0F172A'}
                      fontSize="9"
                      fontFamily="JetBrains Mono"
                    >
                      {ev.modality.toUpperCase()}
                    </text>
                    <text
                      x={pos.x}
                      y={pos.y + 36}
                      textAnchor="middle"
                      fill={isDark ? '#CBD5E1' : '#334155'}
                      fontSize="10"
                      fontFamily="DM Sans"
                    >
                      {ev.original_filename.slice(0, 22)}
                    </text>
                  </g>
                );
              })}
            </svg>
            <p className="text-[11px] text-slate-500 mt-2">
              Click any relationship edge in the graph to inspect supporting evidence IDs and alternative explanations.
            </p>
          </div>

          {/* Edge Inspector */}
          <div className="lg:col-span-5 bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-5 space-y-4">
            {selectedCorr ? (
              (() => {
                const srcName =
                  evidence.find((e) => e.id === selectedCorr.source_evidence_id)?.original_filename ||
                  selectedCorr.source_evidence_id;
                const tgtName =
                  evidence.find((e) => e.id === selectedCorr.target_evidence_id)?.original_filename ||
                  selectedCorr.target_evidence_id;
                const tr = translateCorrelationForView(selectedCorr, srcName, tgtName, viewMode);
                return (
                  <>
                    <div className="flex items-center justify-between">
                      <span className={`font-mono text-xs font-semibold ${statusTextClass(selectedCorr.relationship_type)}`}>
                        {tr.label}
                      </span>
                      <span className="font-mono text-xs text-slate-500 tabular-nums">
                        Strength {(selectedCorr.strength * 100).toFixed(0)}%
                      </span>
                    </div>
                    <p className="text-sm text-slate-900 dark:text-slate-100 leading-relaxed">{tr.summary}</p>
                    <div className="pt-3 border-t border-slate-200 dark:border-slate-800">
                      <p className="text-xs font-semibold text-slate-700 dark:text-slate-300 mb-2">
                        Referenced Evidence Files
                      </p>
                      <div className="flex flex-wrap gap-3">
                        {selectedRefs.map((refId) => {
                          const ev = evidence.find((e) => e.id === refId);
                          return (
                            <Link
                              key={refId}
                              to={ev ? `/investigations/${caseId}/${ev.modality}/${ev.id}` : `/investigations/${caseId}`}
                              className="font-mono text-xs text-blue-600 dark:text-sky-400 hover:underline"
                            >
                              {viewMode === 'simple' && ev ? ev.original_filename : `${refId}${ev ? ` (${ev.original_filename})` : ''}`}
                            </Link>
                          );
                        })}
                      </div>
                    </div>
                    <div className="pt-3 border-t border-slate-200 dark:border-slate-800">
                      <p className="text-xs font-semibold text-amber-700 dark:text-amber-400 mb-2">
                        Alternative Innocent Explanations
                      </p>
                      <ul className="space-y-1.5 text-xs text-slate-600 dark:text-slate-300 list-disc pl-4">
                        {selectedAlts.map((alt, idx) => (
                          <li key={idx}>{alt}</li>
                        ))}
                        {selectedAlts.length === 0 && (
                          <li>No automated alternative note attached; check the Investigation Report for overall caveats.</li>
                        )}
                      </ul>
                    </div>
                  </>
                );
              })()
            ) : (
              <p className="text-xs text-slate-500">No comparison link selected or analysis not yet executed.</p>
            )}
          </div>
        </div>

        {/* Correlation Timeline List */}
        <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-5">
          <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100 mb-3">
            Comparison Ledger
          </h2>
          <div className="divide-y divide-slate-200 dark:divide-slate-800">
            {correlations.map((c) => {
              const srcName = evidence.find((e) => e.id === c.source_evidence_id)?.original_filename || c.source_evidence_id;
              const tgtName = evidence.find((e) => e.id === c.target_evidence_id)?.original_filename || c.target_evidence_id;
              const tr = translateCorrelationForView(c, srcName, tgtName, viewMode);
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setSelectedCorr(c)}
                  className={`w-full text-left py-3 px-2 rounded transition-colors flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs ${
                    selectedCorr?.id === c.id
                      ? 'bg-slate-100 dark:bg-slate-800/60'
                      : 'hover:bg-slate-50 dark:hover:bg-slate-800/40'
                  }`}
                >
                  <div>
                    <span className={`font-mono font-semibold ${statusTextClass(c.relationship_type)}`}>
                      {tr.label}
                    </span>
                    <span className="text-slate-800 dark:text-slate-200 ml-2">{tr.summary}</span>
                  </div>
                  <span className="font-mono text-slate-500 shrink-0">
                    {viewMode === 'simple'
                      ? `${srcName} → ${tgtName}`
                      : `${c.source_evidence_id} → ${c.target_evidence_id}`}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
      )}
    </ConsoleShell>
  );
};
