import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowUpRight, Plus, Search, X } from 'lucide-react';
import { ConsoleShell, formatStatusLabel, statusTextClass } from '../components/ConsoleShell.tsx';
import { api } from '../services/api.ts';
import {
  getDrafts,
  loadInvestigationsCache,
  saveInvestigationsCache,
  setActiveCaseId,
  updateDrafts,
} from '../services/sessionStorage.ts';
import { Investigation } from '../types/forensics.ts';

export const HistoryPage: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const initialDrafts = getDrafts();
  const [q, setQ] = useState(searchParams.get('q') ?? initialDrafts.historySearch);
  const [status, setStatus] = useState(initialDrafts.historyStatus || 'all');
  const [items, setItems] = useState<Investigation[]>(() => loadInvestigationsCache());
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [creating, setCreating] = useState(false);
  const [createErr, setCreateErr] = useState('');

  const fetchList = (searchVal = q, statusVal = status) => {
    setLoading(true);
    api
      .listInvestigations(searchVal, statusVal)
      .then((res) => {
        setItems(res.investigations);
        if (!searchVal && statusVal === 'all') {
          saveInvestigationsCache(res.investigations);
        }
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchList(q, status);
  }, [status]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newTitle.trim().length < 3) {
      setCreateErr('Enter an investigation title (at least 3 characters).');
      return;
    }
    setCreating(true);
    setCreateErr('');
    try {
      const res = await api.createInvestigation({ title: newTitle.trim(), description: newDesc.trim() });
      setCreateOpen(false);
      setNewTitle('');
      setNewDesc('');
      setActiveCaseId(res.investigation.id);
      navigate(`/investigations/${res.investigation.id}`);
    } catch (err) {
      setCreateErr(err instanceof Error ? err.message : 'Failed to create investigation');
    } finally {
      setCreating(false);
    }
  };

  return (
    <ConsoleShell
      title="Investigation History"
      subtitle="Searchable case archive, evidence counts, assessment tiers, and report availability"
      actions={
        <button
          type="button"
          onClick={() => setCreateOpen(true)}
          className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white rounded-md whitespace-nowrap shrink-0"
        >
          <Plus className="w-3.5 h-3.5" />
          New Investigation
        </button>
      }
    >
      <div className="space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              fetchList(q, status);
            }}
            className="flex items-center gap-2"
          >
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-2.5" />
              <input
                type="search"
                value={q}
                onChange={(e) => {
                  const v = e.target.value;
                  setQ(v);
                  updateDrafts((d) => ({ ...d, historySearch: v }));
                }}
                placeholder="Filter by title or case code..."
                className="w-64 bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-md pl-8 pr-3 py-1.5 text-xs text-slate-900 dark:text-slate-100 focus:outline-none focus:border-blue-600 dark:focus:border-sky-400"
              />
            </div>
            <button
              type="submit"
              className="px-3 py-1.5 text-xs font-medium bg-white dark:bg-[#162032] border border-slate-200 dark:border-slate-700 rounded-md text-slate-800 dark:text-slate-100 hover:border-blue-600"
            >
              Filter
            </button>
          </form>

          <div className="inline-flex bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-md p-1 gap-1">
            {(
              [
                { id: 'all', label: 'All' },
                { id: 'ingesting', label: 'Ingesting' },
                { id: 'review_required', label: 'Review' },
                { id: 'closed', label: 'Closed' },
              ] as const
            ).map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => {
                  setStatus(t.id);
                  updateDrafts((d) => ({ ...d, historyStatus: t.id }));
                }}
                className={`px-3 py-1 text-xs rounded whitespace-nowrap transition-colors ${
                  status === t.id
                    ? 'bg-blue-600 text-white font-medium'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 dark:bg-[#162032] text-slate-600 dark:text-slate-300 border-b border-slate-200 dark:border-slate-800">
                <tr>
                  <th className="py-3 px-4 font-medium">Case Code &amp; Title</th>
                  <th className="py-3 px-4 font-medium">Status</th>
                  <th className="py-3 px-4 font-medium">Assessment</th>
                  <th className="py-3 px-4 font-medium text-right">Evidence</th>
                  <th className="py-3 px-4 font-medium text-right">Reports</th>
                  <th className="py-3 px-4 font-medium text-right">Open</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                {items.map((inv) => (
                  <tr key={inv.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors">
                    <td className="py-3 px-4">
                      <p className="font-medium text-slate-900 dark:text-slate-100">{inv.title}</p>
                      <p className="font-mono text-[11px] text-slate-500 mt-0.5 tabular-nums">
                        {inv.case_code} · {new Date(inv.created_at).toLocaleDateString()}
                      </p>
                    </td>
                    <td className={`py-3 px-4 font-medium ${statusTextClass(inv.status)}`}>
                      {formatStatusLabel(inv.status)}
                    </td>
                    <td className={`py-3 px-4 ${statusTextClass(inv.confidence_level)}`}>
                      {formatStatusLabel(inv.confidence_level)}
                    </td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-700 dark:text-slate-300">
                      {inv.evidence_count ?? 0}
                    </td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-700 dark:text-slate-300">
                      {inv.report_count ?? 0}
                    </td>
                    <td className="py-3 px-4 text-right">
                      <Link
                        to={`/investigations/${inv.id}`}
                        onClick={() => setActiveCaseId(inv.id)}
                        className="inline-flex items-center gap-1 text-blue-600 dark:text-sky-400 hover:underline font-medium"
                      >
                        Reopen
                        <ArrowUpRight className="w-3.5 h-3.5" />
                      </Link>
                    </td>
                  </tr>
                ))}
                {!loading && items.length === 0 && (
                  <tr>
                    <td colSpan={6} className="py-10 text-center text-slate-500 space-y-3">
                      <p>No saved investigations match the current filter.</p>
                      <button
                        type="button"
                        onClick={() => setCreateOpen(true)}
                        className="inline-block px-3.5 py-1.5 text-xs font-semibold bg-blue-600 text-white rounded-md"
                      >
                        + New Investigation
                      </button>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {createOpen && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-6 shadow-xl">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
                Create New Investigation
              </h2>
              <button
                type="button"
                onClick={() => setCreateOpen(false)}
                className="text-slate-400 hover:text-slate-900 dark:hover:text-white"
                aria-label="Close modal"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleCreate} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                  Investigation Title
                </label>
                <input
                  type="text"
                  required
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  placeholder="e.g., Press Clip Audio-Visual Authenticity Check"
                  className="w-full bg-slate-50 dark:bg-[#162032] border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:border-blue-600"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                  Scope &amp; Context Notes
                </label>
                <textarea
                  rows={3}
                  value={newDesc}
                  onChange={(e) => setNewDesc(e.target.value)}
                  placeholder="Summarize source context and files to inspect..."
                  className="w-full bg-slate-50 dark:bg-[#162032] border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:border-blue-600"
                />
              </div>
              {createErr && <p className="text-xs text-rose-600 dark:text-rose-400">{createErr}</p>}
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setCreateOpen(false)}
                  className="px-4 py-2 text-xs font-medium bg-slate-100 dark:bg-[#162032] border border-slate-200 dark:border-slate-700 rounded-md text-slate-700 dark:text-slate-300"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={creating}
                  className="px-4 py-2 text-xs font-semibold bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-md"
                >
                  {creating ? 'Creating...' : 'Create Investigation'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </ConsoleShell>
  );
};
