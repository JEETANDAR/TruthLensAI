import React, { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Send } from 'lucide-react';
import { ConsoleShell } from '../components/ConsoleShell.tsx';
import { WorkflowStepper } from '../components/WorkflowStepper.tsx';
import { api } from '../services/api.ts';
import {
  getActiveCaseId,
  getDrafts,
  loadWorkspaceSnapshot,
  saveWorkspaceSnapshot,
  updateDrafts,
} from '../services/sessionStorage.ts';
import { CopilotMessage, EvidenceItem, WorkspaceBundle } from '../types/forensics.ts';

const SUGGESTED_QUESTIONS = [
  'Why was this evidence flagged?',
  'Explain the ViT, AASIST, and classical ML predictions and their uncertainty.',
  'Which frames, audio segments, or dataset rows require review?',
  'Are there inconsistencies between the video/audio and transcript or dataset?',
  'What could explain this anomaly without manipulation?',
  'What should I investigate next?',
  'Summarize this investigation in plain English.',
];

export const CopilotPage: React.FC = () => {
  const { id } = useParams();
  const caseId = id && id !== 'none' ? id : getActiveCaseId();
  const [messages, setMessages] = useState<CopilotMessage[]>([]);
  const [bundle, setBundle] = useState<WorkspaceBundle | null>(() =>
    caseId ? loadWorkspaceSnapshot(caseId) : null,
  );
  const [evidence, setEvidence] = useState<EvidenceItem[]>(() =>
    caseId ? loadWorkspaceSnapshot(caseId)?.evidence || [] : [],
  );
  const [geminiConfigured, setGeminiConfigured] = useState(false);
  const [question, setQuestion] = useState(() =>
    caseId ? getDrafts().copilotDraftByCase[caseId] || '' : '',
  );
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!caseId) return;
    setQuestion(getDrafts().copilotDraftByCase[caseId] || '');
    api.getCopilot(caseId).then((res) => {
      setMessages(res.messages);
      setGeminiConfigured(res.geminiConfigured);
    }).catch(() => {});
    api.getWorkspace(caseId).then((res) => {
      setBundle(res);
      setEvidence(res.evidence);
      saveWorkspaceSnapshot(caseId, res);
    }).catch(() => {});
  }, [caseId]);

  const handleQuestionChange = (val: string) => {
    setQuestion(val);
    if (caseId) {
      updateDrafts((d) => ({
        ...d,
        copilotDraftByCase: { ...d.copilotDraftByCase, [caseId]: val },
      }));
    }
  };

  const sendQuestion = async (qText: string) => {
    if (!caseId || !qText.trim() || sending) return;
    setSending(true);
    setError('');
    try {
      const res = await api.askCopilot(caseId, qText.trim());
      setMessages((prev) => [...prev, res.userMessage, res.assistantMessage]);
      handleQuestionChange('');
      if (res.error) setError(res.error);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Copilot failed');
    } finally {
      setSending(false);
    }
  };

  return (
    <ConsoleShell
      title="AI Investigation Copilot"
      subtitle={
        caseId
          ? `Investigation ${caseId} · Evidence-grounded Q&A with mandatory [EVID] citations`
          : 'No active investigation selected'
      }
      activeInvestigationId={caseId}
    >
      {!caseId ? (
        <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-10 text-center space-y-3">
          <p className="text-sm text-slate-700 dark:text-slate-300">
            Start or select an investigation from the Dashboard to ask grounded questions about your evidence.
          </p>
          <Link
            to="/dashboard"
            className="inline-block px-4 py-2 text-xs font-semibold bg-blue-600 text-white rounded-md"
          >
            Go to Dashboard
          </Link>
        </div>
      ) : (
      <div className="space-y-4">
        <WorkflowStepper caseId={caseId} bundle={bundle} />
        {!geminiConfigured && (
          <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg px-4 py-3 text-xs text-amber-800 dark:text-amber-300">
            <span className="font-semibold">Gemini AI Service Unavailable:</span>{' '}
            <code>GEMINI_API_KEY</code> is not configured in the server runtime environment. Copilot is operating in
            deterministic local database retrieval mode (AI reasoning and multimodal transcription are offline).
          </div>
        )}
      <div className="grid lg:grid-cols-12 gap-6">
        <div className="lg:col-span-8 bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg flex flex-col h-[640px]">
          <div className="px-5 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between text-xs">
            <span className="font-semibold text-slate-900 dark:text-slate-100">Grounded Investigation Thread</span>
            <span className="font-mono text-slate-500">
              {geminiConfigured ? 'Gemini Connected' : 'Local SQLite Retrieval (AI Offline)'}
            </span>
          </div>

          <div className="flex-1 overflow-y-auto p-5 space-y-4">
            {messages.length === 0 && (
              <div className="text-xs text-slate-600 dark:text-slate-400 py-8 text-center max-w-md mx-auto space-y-2">
                <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
                  Ask the TruthLens Forensic Copilot
                </p>
                <p>
                  Every answer retrieves stored forensic measurements, ONNX/RF ML outputs, and cross-modal correlations
                  from SQLite before generating a structured response separated by epistemic layer.
                </p>
              </div>
            )}

            {messages.map((msg) => {
              const cited: string[] = JSON.parse(msg.cited_evidence_ids_json || '[]');
              return (
                <div
                  key={msg.id}
                  className={`p-4 rounded-lg border text-xs leading-relaxed ${
                    msg.role === 'user'
                      ? 'bg-blue-50 dark:bg-[#162032] border-blue-200 dark:border-slate-700 ml-8 sm:ml-12 text-slate-900 dark:text-slate-100'
                      : 'bg-slate-50 dark:bg-[#0B1120] border-slate-200 dark:border-slate-800 mr-4 sm:mr-8 text-slate-800 dark:text-slate-200'
                  }`}
                >
                  <p className="font-mono text-[11px] text-slate-500 mb-1.5">
                    {msg.role === 'user' ? 'Investigator' : 'TruthLens Copilot'} ·{' '}
                    {new Date(msg.created_at).toLocaleTimeString()}
                  </p>
                  <div className="whitespace-pre-wrap">{msg.content}</div>
                  {cited.length > 0 && (
                    <div className="mt-3 pt-2 border-t border-slate-200 dark:border-slate-800 flex flex-wrap gap-3">
                      <span className="text-slate-500">Cited Evidence:</span>
                      {cited.map((cid) => {
                        const ev = evidence.find((e) => e.id === cid);
                        return (
                          <Link
                            key={cid}
                            to={ev ? `/investigations/${caseId}/${ev.modality}/${ev.id}` : `/investigations/${caseId}`}
                            className="font-mono text-blue-600 dark:text-sky-400 hover:underline font-medium"
                          >
                            [{cid}]
                          </Link>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {error && (
            <div className="px-5 py-2 text-[11px] text-amber-700 dark:text-amber-400 border-t border-slate-200 dark:border-slate-800">
              {error}
            </div>
          )}

          <form
            onSubmit={(e) => {
              e.preventDefault();
              sendQuestion(question);
            }}
            className="p-4 border-t border-slate-200 dark:border-slate-800 flex gap-2"
          >
            <input
              type="text"
              value={question}
              onChange={(e) => handleQuestionChange(e.target.value)}
              placeholder="Ask about flagged frames, ELA scores, dataset quality, or alternative causes..."
              className="flex-1 bg-slate-50 dark:bg-[#162032] border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-xs text-slate-900 dark:text-slate-100 focus:outline-none focus:border-blue-600 dark:focus:border-sky-400"
            />
            <button
              type="submit"
              disabled={sending || question.trim().length < 2}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-md whitespace-nowrap"
            >
              <Send className="w-3.5 h-3.5" />
              {sending ? 'Retrieving...' : 'Ask'}
            </button>
          </form>
        </div>

        {/* Suggested Prompts & Grounded Evidence Scope */}
        <div className="lg:col-span-4 space-y-5">
          <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-5 space-y-3">
            <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
              Suggested Questions
            </h2>
            <div className="space-y-2">
              {SUGGESTED_QUESTIONS.map((q) => (
                <button
                  key={q}
                  type="button"
                  disabled={sending}
                  onClick={() => sendQuestion(q)}
                  className="w-full text-left px-3 py-2 text-xs bg-slate-50 dark:bg-[#162032] hover:border-blue-600 dark:hover:border-sky-400 border border-slate-200 dark:border-slate-700 rounded-md text-slate-700 dark:text-slate-200 transition-colors"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>

          <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-5 space-y-2">
            <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
              Retrievable Case Evidence
            </h2>
            <div className="divide-y divide-slate-200 dark:divide-slate-800 text-xs">
              {evidence.map((ev) => (
                <div key={ev.id} className="py-2 flex items-center justify-between gap-2">
                  <Link
                    to={`/investigations/${caseId}/${ev.modality}/${ev.id}`}
                    className="truncate text-slate-700 dark:text-slate-300 hover:text-blue-600 dark:hover:text-sky-400"
                  >
                    {ev.original_filename}
                  </Link>
                  <span className="font-mono text-[11px] text-slate-500 shrink-0">{ev.id}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
      </div>
      )}
    </ConsoleShell>
  );
};
