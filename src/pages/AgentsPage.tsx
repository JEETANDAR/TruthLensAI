import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ConsoleShell, statusTextClass } from '../components/ConsoleShell.tsx';
import { api } from '../services/api.ts';
import { AgentExecutionRow } from '../types/forensics.ts';

export const AgentsPage: React.FC = () => {
  const [executions, setExecutions] = useState<AgentExecutionRow[]>([]);
  const [filter, setFilter] = useState<'all' | 'completed' | 'skipped' | 'failed'>('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api
      .getAgents()
      .then((res) => setExecutions(res.executions))
      .finally(() => setLoading(false));
  }, []);

  const filtered = executions.filter((e) => (filter === 'all' ? true : e.status === filter));

  return (
    <ConsoleShell
      title="AI Agent Activity Monitor"
      subtitle="Dependency-aware 9-agent execution ledger persisted in SQLite"
    >
      <div className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="inline-flex bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-md p-1 gap-1">
            {(['all', 'completed', 'skipped', 'failed'] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setFilter(tab)}
                className={`px-3 py-1.5 text-xs font-medium rounded capitalize transition-colors whitespace-nowrap ${
                  filter === tab
                    ? 'bg-blue-600 text-white'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                {tab}
              </button>
            ))}
          </div>
          <span className="font-mono text-xs text-slate-500 tabular-nums">
            {filtered.length} execution record(s)
          </span>
        </div>

        <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 dark:bg-[#162032] text-slate-600 dark:text-slate-300 border-b border-slate-200 dark:border-slate-800">
                <tr>
                  <th className="py-3 px-4 font-medium">Agent</th>
                  <th className="py-3 px-4 font-medium">Case</th>
                  <th className="py-3 px-4 font-medium">Status</th>
                  <th className="py-3 px-4 font-medium">Timing</th>
                  <th className="py-3 px-4 font-medium text-right">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                {filtered.map((ag) => {
                  const isExp = expandedId === ag.id;
                  const findingsObj = (() => {
                    try {
                      return JSON.parse(ag.findings_json || '{}') as { durationMs?: number };
                    } catch {
                      return {};
                    }
                  })();
                  const durMs =
                    typeof findingsObj.durationMs === 'number'
                      ? findingsObj.durationMs
                      : ag.completed_at
                      ? Math.max(1, new Date(ag.completed_at).getTime() - new Date(ag.started_at).getTime())
                      : null;
                  const durLabel =
                    durMs === null ? '—' : durMs >= 1000 ? `${(durMs / 1000).toFixed(2)}s` : `${durMs} ms`;
                  return (
                    <React.Fragment key={ag.id}>
                      <tr className="hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors">
                        <td className="py-3 px-4">
                          <p className="font-medium text-slate-900 dark:text-slate-100">{ag.agent_name}</p>
                          <p className="text-slate-500 mt-0.5">{ag.responsibility}</p>
                        </td>
                        <td className="py-3 px-4 font-mono">
                          <Link
                            to={`/investigations/${ag.investigation_id}`}
                            className="text-blue-600 dark:text-sky-400 hover:underline"
                          >
                            {ag.case_code || ag.investigation_id}
                          </Link>
                        </td>
                        <td className={`py-3 px-4 font-mono font-semibold ${statusTextClass(ag.status)}`}>
                          {ag.status}
                        </td>
                        <td className="py-3 px-4 font-mono text-slate-500 tabular-nums whitespace-nowrap">
                          {new Date(ag.started_at).toLocaleTimeString()} · {durLabel}
                        </td>
                        <td className="py-3 px-4 text-right">
                          <button
                            type="button"
                            onClick={() => setExpandedId(isExp ? null : ag.id)}
                            className="text-blue-600 dark:text-sky-400 hover:underline font-medium"
                          >
                            {isExp ? 'Hide' : 'Inspect'}
                          </button>
                        </td>
                      </tr>
                      {isExp && (
                        <tr className="bg-slate-50 dark:bg-[#0B1120]">
                          <td colSpan={5} className="p-4 font-mono text-[11px] text-slate-700 dark:text-slate-300 space-y-2">
                            {ag.error_message && (
                              <p className="text-rose-600 dark:text-rose-400">Error: {ag.error_message}</p>
                            )}
                            <p className="text-slate-500">Related Evidence: {ag.related_evidence_ids_json}</p>
                            <div>
                              <p className="text-slate-500 mb-1">Input Summary:</p>
                              <pre className="whitespace-pre-wrap overflow-x-auto text-slate-600 dark:text-slate-400">
                                {JSON.stringify(JSON.parse(ag.input_summary_json || '{}'), null, 2)}
                              </pre>
                            </div>
                            <div>
                              <p className="text-slate-500 mb-1">Findings / Outcome:</p>
                              <pre className="whitespace-pre-wrap overflow-x-auto text-slate-800 dark:text-slate-200">
                                {JSON.stringify(JSON.parse(ag.findings_json || '{}'), null, 2)}
                              </pre>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
                {!loading && filtered.length === 0 && (
                  <tr>
                    <td colSpan={5} className="py-8 text-center text-slate-500">
                      No agent executions match the current filter.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </ConsoleShell>
  );
};
