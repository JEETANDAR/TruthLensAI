import React, { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, CheckCircle2, ExternalLink, FileCheck2, ShieldAlert } from 'lucide-react';
import {
  ConsoleShell,
  epistemicLayerMeta,
  formatBytes,
  formatStatusLabel,
  statusTextClass,
} from '../components/ConsoleShell.tsx';
import { useViewMode } from '../context/ViewModeContext.tsx';
import { api } from '../services/api.ts';
import { getActiveCaseId } from '../services/sessionStorage.ts';
import {
  CorrelationRow,
  DetectedFace,
  EvidenceItem,
  ForensicAnalysisRow,
  ForensicIndicator,
  ModelPredictionRow,
} from '../types/forensics.ts';
import { translateIndicatorForView, translateModelDisplay } from '../utils/plainEnglish.ts';

interface EvidenceDetailPayload {
  evidence: EvidenceItem;
  investigation: { id: string; case_code: string; title: string; status: string };
  analysis: ForensicAnalysisRow | null;
  predictions: ModelPredictionRow[];
  correlations: CorrelationRow[];
}

export const EvidenceDetailPage: React.FC = () => {
  const { id, evidenceId } = useParams();
  const { viewMode } = useViewMode();
  const caseId = id && id !== 'none' ? id : getActiveCaseId();

  const [data, setData] = useState<EvidenceDetailPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [hashVerifyResult, setHashVerifyResult] = useState<{
    expectedHash: string;
    actualHash: string;
    verified: boolean;
  } | null>(null);

  useEffect(() => {
    if (!evidenceId) {
      setLoading(false);
      setError('No evidence ID specified.');
      return;
    }
    setLoading(true);
    setError(null);
    setHashVerifyResult(null);
    const routeInvId = id && id !== 'none' ? id : undefined;
    api
      .getEvidenceDetail(evidenceId, routeInvId)
      .then((res) => setData(res))
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load evidence item'))
      .finally(() => setLoading(false));
  }, [id, evidenceId]);

  const handleVerifyHash = async () => {
    if (!evidenceId) return;
    setVerifying(true);
    try {
      const routeInvId = id && id !== 'none' ? id : undefined;
      const res = await api.verifyEvidenceHash(evidenceId, routeInvId);
      setHashVerifyResult({
        expectedHash: res.expectedHash,
        actualHash: res.actualHash,
        verified: res.verified,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Hash verification failed');
    } finally {
      setVerifying(false);
    }
  };

  const ev = data?.evidence;
  const inv = data?.investigation;
  const resolvedCaseId = inv?.id || caseId || ev?.investigation_id || '';
  const analysis = data?.analysis || null;
  const predictions = data?.predictions || [];
  const correlations = data?.correlations || [];

  const metrics: Record<string, unknown> = analysis ? JSON.parse(analysis.metrics_json || '{}') : {};
  const artifacts: Record<string, unknown> = analysis ? JSON.parse(analysis.artifacts_json || '{}') : {};
  const indicators: ForensicIndicator[] = analysis ? JSON.parse(analysis.indicators_json || '[]') : [];
  const detectedFaces = (Array.isArray(artifacts.detectedFaces) ? artifacts.detectedFaces : []) as DetectedFace[];
  const geminiTranscript = artifacts.geminiTranscript as { transcript?: string; model?: string; error?: string } | undefined;

  return (
    <ConsoleShell
      title={ev ? `Evidence Detail · ${ev.original_filename}` : 'Evidence Item Detail'}
      subtitle={
        ev && inv
          ? `${inv.case_code} · ${ev.modality.toUpperCase()} · ${formatBytes(ev.file_size)}`
          : 'Cryptographic integrity, forensic signals, and uncalibrated detector scores'
      }
      activeInvestigationId={resolvedCaseId}
      actions={
        ev && resolvedCaseId ? (
          <div className="flex items-center gap-2">
            <Link
              to={`/investigations/${resolvedCaseId}`}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-white dark:bg-[#111827] border border-slate-300 dark:border-slate-700 hover:border-blue-600 text-slate-800 dark:text-slate-100 rounded-md whitespace-nowrap shrink-0"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              Workspace
            </Link>
            <Link
              to={`/investigations/${resolvedCaseId}/${ev.modality}/${ev.id}`}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white rounded-md whitespace-nowrap shrink-0"
            >
              Open {ev.modality.toUpperCase()} Lab
              <ExternalLink className="w-3.5 h-3.5" />
            </Link>
          </div>
        ) : null
      }
    >
      {loading ? (
        <div className="space-y-4">
          <div className="h-36 bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg animate-pulse" />
          <div className="h-64 bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg animate-pulse" />
        </div>
      ) : error || !ev ? (
        <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-10 text-center space-y-3">
          <p className="text-sm font-medium text-rose-700 dark:text-rose-400">
            {error || 'Evidence record not found.'}
          </p>
          <Link
            to={resolvedCaseId ? `/investigations/${resolvedCaseId}` : '/dashboard'}
            className="inline-block px-4 py-2 text-xs font-semibold bg-blue-600 text-white rounded-md"
          >
            Return to Investigation
          </Link>
        </div>
      ) : (
        <div className="space-y-6">
          {/* Chain-of-Custody & File Provenance */}
          <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-5 grid lg:grid-cols-12 gap-6">
            <div className="lg:col-span-7 space-y-3">
              <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                <span className="font-mono font-semibold text-blue-600 dark:text-sky-400">{ev.id}</span>
                <span aria-hidden="true">·</span>
                <span className="font-mono uppercase">{ev.modality}</span>
                <span aria-hidden="true">·</span>
                <span className="font-mono">{ev.mime_type}</span>
                <span aria-hidden="true">·</span>
                <span className="font-mono tabular-nums">{formatBytes(ev.file_size)}</span>
              </div>

              <h2 className="font-display text-lg font-semibold text-slate-900 dark:text-slate-100">
                {ev.original_filename}
              </h2>

              <dl className="grid sm:grid-cols-2 gap-3 text-xs pt-1">
                <div>
                  <dt className="text-slate-500">Ingested Timestamp</dt>
                  <dd className="font-mono text-slate-900 dark:text-slate-100 tabular-nums mt-0.5">
                    {new Date(ev.uploaded_at).toLocaleString()}
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-500">Processing State</dt>
                  <dd className={`font-medium mt-0.5 ${statusTextClass(ev.status)}`}>
                    {formatStatusLabel(ev.status)}
                  </dd>
                </div>
              </dl>

              {ev.context_note && (
                <p className="text-xs text-slate-600 dark:text-slate-300 pt-2 border-t border-slate-200 dark:border-slate-800">
                  <span className="font-semibold text-slate-800 dark:text-slate-200">Context Note:</span>{' '}
                  {ev.context_note}
                </p>
              )}

              <div className="pt-2 border-t border-slate-200 dark:border-slate-800 space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-medium text-slate-700 dark:text-slate-300">
                    Recorded SHA-256 Digest
                  </span>
                  <button
                    type="button"
                    onClick={handleVerifyHash}
                    disabled={verifying}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-slate-100 dark:bg-[#162032] border border-slate-200 dark:border-slate-700 hover:border-teal-600 text-slate-800 dark:text-slate-100 rounded-md whitespace-nowrap shrink-0"
                  >
                    <FileCheck2 className="w-3.5 h-3.5 text-teal-600 dark:text-teal-400" />
                    {verifying ? 'Verifying Disk Hash...' : 'Verify SHA-256 Integrity'}
                  </button>
                </div>
                <p className="font-mono text-[11px] text-slate-600 dark:text-slate-400 break-all">
                  {ev.sha256_hash}
                </p>
                {hashVerifyResult && (
                  <div
                    className={`p-2.5 rounded border text-xs flex items-start gap-2 ${
                      hashVerifyResult.verified
                        ? 'bg-teal-50 dark:bg-teal-950/30 border-teal-200 dark:border-teal-800 text-teal-800 dark:text-teal-300'
                        : 'bg-rose-50 dark:bg-rose-950/30 border-rose-200 dark:border-rose-800 text-rose-800 dark:text-rose-300'
                    }`}
                  >
                    {hashVerifyResult.verified ? (
                      <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
                    ) : (
                      <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
                    )}
                    <div className="space-y-0.5 break-all">
                      <p className="font-semibold">
                        {hashVerifyResult.verified
                          ? 'Chain-of-Custody Verified: Disk bytes match ingestion SHA-256.'
                          : 'Integrity Mismatch Detected: File bytes differ from ingestion digest!'}
                      </p>
                      <p className="font-mono text-[11px]">Computed: {hashVerifyResult.actualHash}</p>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Inline Preview Slot */}
            <div className="lg:col-span-5 bg-slate-50 dark:bg-[#0B1120] border border-slate-200 dark:border-slate-800 rounded-md p-3 flex flex-col items-center justify-center min-h-[220px]">
              {ev.modality === 'image' && (
                <div className="relative inline-block">
                  <img
                    src={`/api/evidence/${ev.id}/file`}
                    alt={ev.original_filename}
                    referrerPolicy="no-referrer"
                    className="max-h-56 w-auto object-contain rounded"
                  />
                  {detectedFaces.map((f, idx) => (
                    <div
                      key={idx}
                      style={{
                        left: `${f.xPct}%`,
                        top: `${f.yPct}%`,
                        width: `${f.wPct}%`,
                        height: `${f.hPct}%`,
                      }}
                      title={`Face ${idx + 1} (${(f.confidence * 100).toFixed(0)}%)`}
                      className="absolute border-2 border-cyan-500 bg-cyan-500/10 pointer-events-none"
                    />
                  ))}
                </div>
              )}
              {ev.modality === 'video' && (
                <video
                  src={`/api/evidence/${ev.id}/file`}
                  controls
                  className="w-full max-h-56 rounded bg-slate-900"
                />
              )}
              {ev.modality === 'audio' && (
                <div className="w-full space-y-2">
                  <p className="text-xs text-slate-500 text-center">Original Audio Stream</p>
                  <audio src={`/api/evidence/${ev.id}/file`} controls className="w-full" />
                </div>
              )}
              {(ev.modality === 'text' || ev.modality === 'dataset') && (
                <div className="w-full text-xs text-slate-600 dark:text-slate-300 font-mono max-h-52 overflow-y-auto whitespace-pre-wrap">
                  {typeof artifacts.rawPreview === 'string'
                    ? artifacts.rawPreview.slice(0, 900)
                    : `Structured ${ev.modality.toUpperCase()} evidence ready in dedicated inspection lab.`}
                </div>
              )}
            </div>
          </div>

          {/* Uncalibrated Predictions & Signal Metrics */}
          <div className="grid lg:grid-cols-12 gap-6">
            <div className="lg:col-span-6 bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-5 space-y-3">
              <div>
                <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                  Model Predictions (Uncalibrated Raw Scores)
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  Scores are normalized 0–100 anomaly indicators, not calibrated manipulation probabilities.
                </p>
              </div>
              {predictions.length === 0 ? (
                <p className="text-xs text-slate-500 py-4">
                  {analysis
                    ? 'No ML classifier applies directly to this file type (signal and structural checks used).'
                    : 'Run Full Analysis from the Workspace to evaluate this file.'}
                </p>
              ) : (
                <div className="divide-y divide-slate-200 dark:divide-slate-800">
                  {predictions.map((p) => {
                    const modelMeta = translateModelDisplay(p.model_id, viewMode);
                    const contribs = JSON.parse(p.feature_contributions_json || '[]') as Array<{
                      feature: string;
                      value: number;
                      impact: number;
                    }>;
                    return (
                      <div key={p.id} className="py-3 first:pt-0 last:pb-0 space-y-1.5 text-xs">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-mono font-semibold text-slate-900 dark:text-slate-100">
                            {modelMeta.name}
                          </span>
                          <span className={`font-mono font-semibold tabular-nums ${statusTextClass(p.prediction_label)}`}>
                            Raw {(p.raw_score * 100).toFixed(1)}% · {p.prediction_label.replace(/_/g, ' ')}
                          </span>
                        </div>
                        <p className="text-[11px] text-slate-600 dark:text-slate-400 leading-relaxed">
                          {p.uncertainty_note}
                        </p>
                        {contribs.length > 0 && (
                          <div className="grid grid-cols-2 gap-x-4 gap-y-1 pt-1 font-mono text-[11px] text-slate-500">
                            {contribs.slice(0, 6).map((c) => (
                              <div key={c.feature} className="flex justify-between gap-2">
                                <span className="truncate">{c.feature}</span>
                                <span className="tabular-nums text-slate-800 dark:text-slate-200">{c.value}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="lg:col-span-6 bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-5 space-y-3">
              <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                Measured Forensic Signals &amp; Metadata
              </h2>
              {Object.keys(metrics).length === 0 ? (
                <p className="text-xs text-slate-500 py-4">Analysis pending.</p>
              ) : (
                <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs max-h-72 overflow-y-auto">
                  {Object.entries(metrics).map(([k, v]) => (
                    <React.Fragment key={k}>
                      <dt className="text-slate-500 truncate">{k}</dt>
                      <dd className="font-mono text-right text-slate-900 dark:text-slate-100 tabular-nums truncate">
                        {typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v ?? '—')}
                      </dd>
                    </React.Fragment>
                  ))}
                </dl>
              )}
            </div>
          </div>

          {geminiTranscript?.transcript && (
            <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-5 space-y-2">
              <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                Speech Transcription ({geminiTranscript.model || 'ASR'})
              </h2>
              <p className="text-xs text-slate-700 dark:text-slate-300 leading-relaxed whitespace-pre-wrap">
                {geminiTranscript.transcript}
              </p>
            </div>
          )}

          {/* Indicators */}
          <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-5 space-y-3">
            <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
              Forensic Indicators ({indicators.length})
            </h2>
            <div className="divide-y divide-slate-200 dark:divide-slate-800">
              {indicators.map((ind) => {
                const layer = epistemicLayerMeta(ind.sourceLayer);
                const tr = translateIndicatorForView(ind, viewMode);
                return (
                  <div key={ind.id} className="py-2.5 text-xs flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                    <div>
                      <span className={`font-semibold ${statusTextClass(ind.severity)}`}>
                        [{ind.severity.toUpperCase()}]
                      </span>{' '}
                      <span className="font-medium text-slate-900 dark:text-slate-100">{tr.title}</span>{' '}
                      <span className="text-slate-400">·</span>{' '}
                      <span className={`font-mono text-[11px] ${layer.toneClass}`}>{layer.label}</span>
                      <p className="text-slate-600 dark:text-slate-400 mt-0.5">{tr.detail}</p>
                    </div>
                    <span className="font-mono text-[11px] text-slate-500 shrink-0">{ind.category}</span>
                  </div>
                );
              })}
              {indicators.length === 0 && (
                <p className="py-4 text-xs text-slate-500">No forensic indicators recorded yet.</p>
              )}
            </div>
            {analysis?.limitations && (
              <p className="text-xs text-slate-500 pt-2 border-t border-slate-200 dark:border-slate-800">
                Methodological Limitations: {analysis.limitations}
              </p>
            )}
          </div>

          {/* Linked Correlations */}
          <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-5 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                Cross-Modal Links Involving This File ({correlations.length})
              </h2>
              {resolvedCaseId && (
                <Link
                  to={`/investigations/${resolvedCaseId}/correlate`}
                  className="text-xs font-medium text-blue-600 dark:text-sky-400 hover:underline"
                >
                  Open Cross-Modal Graph
                </Link>
              )}
            </div>
            <div className="divide-y divide-slate-200 dark:divide-slate-800">
              {correlations.map((c) => {
                const otherId = c.source_evidence_id === ev.id ? c.target_evidence_id : c.source_evidence_id;
                return (
                  <div key={c.id} className="py-2.5 text-xs flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                    <div>
                      <span className={`font-mono font-semibold ${statusTextClass(c.relationship_type)}`}>
                        {c.relationship_type}
                      </span>{' '}
                      <span className="text-slate-700 dark:text-slate-300 ml-1">{c.summary}</span>
                    </div>
                    {resolvedCaseId && (
                      <Link
                        to={`/investigations/${resolvedCaseId}/evidence/${otherId}`}
                        className="font-mono text-[11px] text-blue-600 dark:text-sky-400 hover:underline shrink-0"
                      >
                        Compare {otherId}
                      </Link>
                    )}
                  </div>
                );
              })}
              {correlations.length === 0 && (
                <p className="py-3 text-xs text-slate-500">No cross-modal links involve this item yet.</p>
              )}
            </div>
          </div>
        </div>
      )}
    </ConsoleShell>
  );
};
