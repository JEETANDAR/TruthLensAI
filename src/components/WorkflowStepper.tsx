import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { CheckCircle2, ChevronRight } from 'lucide-react';
import { WorkspaceBundle } from '../types/forensics.ts';

interface WorkflowStepperProps {
  caseId: string;
  bundle?: WorkspaceBundle | null;
}

export const WorkflowStepper: React.FC<WorkflowStepperProps> = ({ caseId, bundle }) => {
  const location = useLocation();
  if (!caseId || caseId === 'none') return null;

  const inv = bundle?.investigation;
  const hasEvidence = (bundle?.evidence.length || 0) > 0;
  const hasAnalyses = (bundle?.analyses.length || 0) > 0;
  const hasCorrelations = (bundle?.correlations.length || 0) > 0;
  const hasReports = (bundle?.reports.length || 0) > 0;
  const isReviewed =
    inv?.status === 'closed' ||
    (hasReports && Boolean(bundle?.reports[0]?.human_conclusion && !bundle.reports[0].human_conclusion.startsWith('Pending')));

  const path = location.pathname;
  const activeKey = path.includes('/upload')
    ? 'ingest'
    : path.includes('/correlate')
    ? 'correlate'
    : path.includes('/reports')
    ? 'report'
    : path.includes('/copilot')
    ? 'review'
    : 'analyze';

  const steps = [
    {
      key: 'ingest',
      num: '1',
      label: 'INGEST',
      sub: hasEvidence ? `${bundle?.evidence.length} file(s)` : 'Upload files',
      to: `/investigations/${caseId}/upload`,
      done: hasEvidence,
    },
    {
      key: 'analyze',
      num: '2',
      label: 'ANALYZE',
      sub: hasAnalyses ? 'Signals ready' : 'Run engines',
      to: `/investigations/${caseId}`,
      done: hasAnalyses,
    },
    {
      key: 'correlate',
      num: '3',
      label: 'CORRELATE',
      sub: hasCorrelations ? `${bundle?.correlations.length} link(s)` : 'Compare files',
      to: `/investigations/${caseId}/correlate`,
      done: hasCorrelations || (hasAnalyses && (bundle?.evidence.length || 0) <= 1),
    },
    {
      key: 'review',
      num: '4',
      label: 'REVIEW',
      sub: isReviewed ? 'Signed off' : 'Inspect & Q&A',
      to: `/investigations/${caseId}/copilot`,
      done: isReviewed || hasAnalyses,
    },
    {
      key: 'report',
      num: '5',
      label: 'REPORT',
      sub: hasReports ? 'PDF Ready' : 'Export report',
      to: `/investigations/${caseId}/reports`,
      done: hasReports,
    },
  ];

  return (
    <nav
      aria-label="Investigation workflow progress"
      className="mb-5 bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-2.5"
    >
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        {steps.map((st, idx) => {
          const isActive = activeKey === st.key;
          return (
            <Link
              key={st.key}
              to={st.to}
              className={`group px-3 py-2 rounded-md border text-xs flex items-center justify-between gap-2 transition-colors ${
                isActive
                  ? 'bg-blue-600 border-blue-600 text-white'
                  : st.done
                  ? 'bg-slate-50 dark:bg-[#162032] border-teal-200 dark:border-teal-800/70 text-slate-900 dark:text-slate-100 hover:border-blue-500'
                  : 'bg-white dark:bg-[#111827] border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400 hover:border-blue-500'
              }`}
            >
              <div className="min-w-0">
                <p className={`font-mono text-[11px] font-bold tracking-wide truncate ${isActive ? 'text-white' : ''}`}>
                  {st.num}. {st.label}
                </p>
                <p
                  className={`text-[10px] truncate mt-0.5 ${
                    isActive ? 'text-blue-100' : 'text-slate-500 dark:text-slate-400'
                  }`}
                >
                  {st.sub}
                </p>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {st.done && !isActive && <CheckCircle2 className="w-3.5 h-3.5 text-teal-600 dark:text-teal-400" />}
                {idx < steps.length - 1 && (
                  <ChevronRight
                    className={`w-3.5 h-3.5 hidden lg:block ${
                      isActive ? 'text-blue-100' : 'text-slate-300 dark:text-slate-600'
                    }`}
                  />
                )}
              </div>
            </Link>
          );
        })}
      </div>
    </nav>
  );
};
