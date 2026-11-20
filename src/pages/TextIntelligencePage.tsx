import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { FolderPlus } from 'lucide-react';
import { ConsoleShell, epistemicLayerMeta, statusTextClass } from '../components/ConsoleShell.tsx';
import { WorkflowStepper } from '../components/WorkflowStepper.tsx';
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
import { translateIndicatorForView } from '../utils/plainEnglish.ts';

export const TextIntelligencePage: React.FC = () => {
  const { id, evidenceId } = useParams();
  const navigate = useNavigate();
  const { viewMode } = useViewMode();
  const caseId = id && id !== 'none' ? id : getActiveCaseId();
  const [bundle, setBundle] = useState<WorkspaceBundle | null>(() =>
    caseId ? loadWorkspaceSnapshot(caseId) : null,
  );
  const [selectedId, setSelectedId] = useState('');

  const initialDraft = getDrafts().textEditor;
  const [filename, setFilename] = useState(initialDraft.filename || 'transcript.srt');
  const [format, setFormat] = useState<'txt' | 'json' | 'srt' | 'csv' | 'tsv'>(initialDraft.format || 'srt');
  const [content, setContent] = useState(initialDraft.content || '');
  const [contextNote, setContextNote] = useState(initialDraft.contextNote || '');
  const [submitting, setSubmitting] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');

  const load = () => {
    if (!caseId) return;
    api
      .getWorkspace(caseId)
      .then((res) => {
        setBundle(res);
        saveWorkspaceSnapshot(caseId, res);
        const texts = res.evidence.filter((e) => e.modality === 'text');
        if (evidenceId && texts.some((t) => t.id === evidenceId)) {
          setSelectedId(evidenceId);
        } else if (texts.length > 0 && !selectedId) {
          setSelectedId(texts[0].id);
        }
      })
      .catch(() => {});
  };

  useEffect(() => {
    load();
  }, [caseId, evidenceId]);

  useEffect(() => {
    updateDrafts((prev) => ({
      ...prev,
      textEditor: { filename, format, content, contextNote },
    }));
  }, [filename, format, content, contextNote]);

  const texts = bundle?.evidence.filter((e) => e.modality === 'text') || [];
  const activeEv = texts.find((t) => t.id === selectedId) || texts[0];
  const analysis = bundle?.analyses.find((a) => a.evidence_id === activeEv?.id);
  const artifacts = analysis ? JSON.parse(analysis.artifacts_json || '{}') : {};
  const indicators: ForensicIndicator[] = analysis ? JSON.parse(analysis.indicators_json || '[]') : [];
  const cues: Array<{ index: number; startSec: number; endSec: number; text: string }> = artifacts.cues || [];
  const extractedClaims: string[] = artifacts.extractedClaims || [];

  const handleIngestText = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!caseId || content.trim().length < 5) return;
    setSubmitting(true);
    setStatusMsg('');
    try {
      await api.ingestTextEvidence(caseId, { filename, format, content, contextNote });
      await api.runAnalysis(caseId);
      setContent('');
      setContextNote('');
      if (format === 'csv' || format === 'tsv') {
        navigate(`/investigations/${caseId}/dataset`);
        return;
      }
      setStatusMsg('Document analyzed and compared against investigation evidence.');
      load();
    } catch (err) {
      setStatusMsg(err instanceof Error ? err.message : 'Ingestion failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ConsoleShell
      title="Text & Transcript Intelligence"
      subtitle={
        caseId
          ? `Investigation ${caseId} · Subtitle timing audit, claim extraction, and contradiction detection`
          : 'Select or create an investigation to analyze transcripts or structured text'
      }
      activeInvestigationId={caseId}
    >
      {!caseId ? (
        <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-10 text-center space-y-3">
          <FolderPlus className="w-8 h-8 text-blue-600 dark:text-sky-400 mx-auto" />
          <p className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
            No Active Investigation Selected
          </p>
          <p className="text-xs text-slate-500 max-w-md mx-auto">
            Create a new investigation from the Dashboard or Sidebar to ingest transcripts, JSON, SRT, or CSV files.
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
          <div className="grid lg:grid-cols-12 gap-6">
          <div className="lg:col-span-7 space-y-6">
            {texts.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {texts.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setSelectedId(t.id)}
                    className={`px-3 py-1.5 text-xs rounded-md border transition-colors whitespace-nowrap ${
                      activeEv?.id === t.id
                        ? 'bg-blue-600 border-blue-600 text-white font-medium'
                        : 'bg-white dark:bg-[#111827] border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300'
                    }`}
                  >
                    {t.original_filename}
                  </button>
                ))}
              </div>
            )}

            {activeEv ? (
              <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-5 space-y-5">
                <div>
                  <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                    Parsed Content &amp; Cue Spans
                  </h2>
                  <p className="text-xs text-slate-500 mt-0.5">{activeEv.context_note || 'No context note provided'}</p>
                </div>

                {cues.length > 0 ? (
                  <div className="divide-y divide-slate-200 dark:divide-slate-800 border border-slate-200 dark:border-slate-800 rounded-md bg-slate-50 dark:bg-[#0B1120]">
                    {cues.map((c) => (
                      <div key={c.index} className="p-3 text-xs flex gap-4">
                        <span className="font-mono text-cyan-700 dark:text-sky-400 shrink-0 tabular-nums">
                          {c.startSec.toFixed(1)}s → {c.endSec.toFixed(1)}s
                        </span>
                        <span className="text-slate-800 dark:text-slate-200">{c.text}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <pre className="p-3 bg-slate-50 dark:bg-[#0B1120] border border-slate-200 dark:border-slate-800 rounded text-xs font-mono text-slate-700 dark:text-slate-300 whitespace-pre-wrap max-h-64 overflow-y-auto">
                    {artifacts.rawPreview || 'Run Full Analysis from Workspace to parse text metrics.'}
                  </pre>
                )}

                {extractedClaims.length > 0 && (
                  <div>
                    <h3 className="text-xs font-semibold text-slate-600 dark:text-slate-400 mb-2">
                      Extracted Assertion Candidates ({extractedClaims.length})
                    </h3>
                    <ul className="space-y-1.5 text-xs text-slate-700 dark:text-slate-300 list-disc pl-4">
                      {extractedClaims.map((cl, i) => (
                        <li key={i}>{cl}</li>
                      ))}
                    </ul>
                  </div>
                )}

                <div className="pt-3 border-t border-slate-200 dark:border-slate-800 space-y-2">
                  <h3 className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                    Consistency &amp; Contradiction Findings
                  </h3>
                  <div className="divide-y divide-slate-200 dark:divide-slate-800">
                    {indicators.map((ind) => {
                      const layer = epistemicLayerMeta(ind.sourceLayer);
                      const tr = translateIndicatorForView(ind, viewMode);
                      return (
                        <div key={ind.id} className="text-xs py-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className={`font-semibold ${statusTextClass(ind.severity)}`}>
                              [{ind.severity.toUpperCase()}]
                            </span>
                            <span className="text-slate-900 dark:text-slate-100 font-medium">{tr.title}</span>
                            {viewMode === 'advanced' && (
                              <>
                                <span className="text-slate-400">·</span>
                                <span className={`font-mono text-[11px] ${layer.toneClass}`}>{layer.label}</span>
                              </>
                            )}
                          </div>
                          <p className="text-slate-600 dark:text-slate-400 mt-0.5">{tr.detail}</p>
                        </div>
                      );
                    })}
                  </div>
                  {viewMode === 'advanced' && analysis?.limitations && (
                    <p className="text-xs text-slate-500 pt-2">{analysis.limitations}</p>
                  )}
                </div>
              </div>
            ) : (
              <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-8 text-center text-xs text-slate-500">
                No transcript, caption, JSON, or subtitle file uploaded to this investigation yet. Submit one on the right.
              </div>
            )}
          </div>

          <div className="lg:col-span-5 bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-5 h-fit space-y-4">
            <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
              Submit Transcript / Document / Dataset (Auto-saved)
            </h2>
            <form onSubmit={handleIngestText} className="space-y-3 text-xs">
              <div className="grid grid-cols-2 gap-3">
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
                  <label className="block text-slate-600 dark:text-slate-400 mb-1">Format</label>
                  <select
                    value={format}
                    onChange={(e) => setFormat(e.target.value as 'txt' | 'json' | 'srt' | 'csv' | 'tsv')}
                    className="w-full bg-slate-50 dark:bg-[#162032] border border-slate-300 dark:border-slate-700 rounded px-2.5 py-1.5 text-slate-900 dark:text-slate-100"
                  >
                    <option value="srt">SRT Subtitles</option>
                    <option value="txt">Plain Text / Transcript</option>
                    <option value="json">Structured JSON</option>
                    <option value="csv">CSV Dataset</option>
                    <option value="tsv">TSV Dataset</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-slate-600 dark:text-slate-400 mb-1">Content</label>
                <textarea
                  rows={7}
                  required
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  placeholder="Paste transcript, SRT cues, JSON payload, or CSV rows..."
                  className="w-full bg-slate-50 dark:bg-[#162032] border border-slate-300 dark:border-slate-700 rounded p-2.5 font-mono text-slate-900 dark:text-slate-100"
                />
              </div>
              <div>
                <label className="block text-slate-600 dark:text-slate-400 mb-1">Context Note</label>
                <input
                  type="text"
                  value={contextNote}
                  onChange={(e) => setContextNote(e.target.value)}
                  placeholder="e.g., Source origin or verification scope"
                  className="w-full bg-slate-50 dark:bg-[#162032] border border-slate-300 dark:border-slate-700 rounded px-2.5 py-1.5 text-slate-900 dark:text-slate-100"
                />
              </div>
              {statusMsg && <p className="text-cyan-700 dark:text-sky-400 font-medium">{statusMsg}</p>}
              <button
                type="submit"
                disabled={submitting}
                className="w-full py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-semibold rounded-md transition-colors"
              >
                {submitting ? 'Analyzing & Correlating...' : 'Ingest & Run Analysis'}
              </button>
            </form>
          </div>
        </div>
        </>
      )}
    </ConsoleShell>
  );
};
