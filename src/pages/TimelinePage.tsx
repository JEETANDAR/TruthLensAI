import React, { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Clock, ExternalLink, FolderPlus } from 'lucide-react';
import { ConsoleShell, formatBytes, statusTextClass } from '../components/ConsoleShell.tsx';
import { WorkflowStepper } from '../components/WorkflowStepper.tsx';
import { api } from '../services/api.ts';
import { getActiveCaseId, loadWorkspaceSnapshot, saveWorkspaceSnapshot } from '../services/sessionStorage.ts';
import { WorkspaceBundle } from '../types/forensics.ts';

type EventFilter = 'all' | 'ingestion' | 'agents' | 'media_offsets' | 'correlations';

interface CaseTimelineEvent {
  id: string;
  group: Exclude<EventFilter, 'all'>;
  timestamp: string;
  offsetLabel?: string;
  title: string;
  detail: string;
  toneClass: string;
  linkTo?: string;
  linkLabel?: string;
}

export const TimelinePage: React.FC = () => {
  const { id } = useParams();
  const caseId = id && id !== 'none' ? id : getActiveCaseId();
  const [bundle, setBundle] = useState<WorkspaceBundle | null>(() =>
    caseId ? loadWorkspaceSnapshot(caseId) : null,
  );
  const [filter, setFilter] = useState<EventFilter>('all');
  const [loading, setLoading] = useState(Boolean(caseId && !loadWorkspaceSnapshot(caseId)));

  useEffect(() => {
    if (!caseId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    api
      .getWorkspace(caseId)
      .then((res) => {
        setBundle(res);
        saveWorkspaceSnapshot(caseId, res);
      })
      .finally(() => setLoading(false));
  }, [caseId]);

  const { chronologicalEvents, mediaOffsetEvents } = useMemo(() => {
    if (!bundle || !caseId) {
      return { chronologicalEvents: [] as CaseTimelineEvent[], mediaOffsetEvents: [] as Array<CaseTimelineEvent & { offsetSec: number }> };
    }

    const chron: CaseTimelineEvent[] = [];
    const offsets: Array<CaseTimelineEvent & { offsetSec: number }> = [];

    for (const ev of bundle.evidence) {
      chron.push({
        id: `ev-${ev.id}`,
        group: 'ingestion',
        timestamp: ev.uploaded_at,
        title: `Ingested ${ev.modality.toUpperCase()}: ${ev.original_filename}`,
        detail: `${formatBytes(ev.file_size)} · SHA-256 ${ev.sha256_hash.slice(0, 16)}…`,
        toneClass: 'text-blue-600 dark:text-sky-400',
        linkTo: `/investigations/${caseId}/evidence/${ev.id}`,
        linkLabel: 'Inspect Detail',
      });
    }

    for (const ag of bundle.agents) {
      const fJson = (() => {
        try {
          return JSON.parse(ag.findings_json || '{}') as { durationMs?: number };
        } catch {
          return {};
        }
      })();
      const dur =
        typeof fJson.durationMs === 'number'
          ? `${fJson.durationMs} ms`
          : ag.completed_at
          ? `${Math.max(1, new Date(ag.completed_at).getTime() - new Date(ag.started_at).getTime())} ms`
          : 'running';
      chron.push({
        id: `ag-${ag.id}`,
        group: 'agents',
        timestamp: ag.completed_at || ag.started_at,
        title: `${ag.agent_name} (${ag.status})`,
        detail: `${ag.responsibility} · Execution duration ${dur}${ag.error_message ? ` · Error: ${ag.error_message}` : ''}`,
        toneClass: statusTextClass(ag.status),
        linkTo: '/agents',
        linkLabel: 'Agent Ledger',
      });
    }

    for (const corr of bundle.correlations) {
      const src = bundle.evidence.find((e) => e.id === corr.source_evidence_id)?.original_filename || corr.source_evidence_id;
      const tgt = bundle.evidence.find((e) => e.id === corr.target_evidence_id)?.original_filename || corr.target_evidence_id;
      chron.push({
        id: `cor-${corr.id}`,
        group: 'correlations',
        timestamp: corr.created_at,
        title: `${corr.relationship_type}: ${src} → ${tgt}`,
        detail: corr.summary,
        toneClass: statusTextClass(corr.relationship_type),
        linkTo: `/investigations/${caseId}/correlate`,
        linkLabel: 'Open Graph',
      });
    }

    for (const anl of bundle.analyses) {
      const ev = bundle.evidence.find((e) => e.id === anl.evidence_id);
      const fname = ev?.original_filename || anl.evidence_id;
      const arts = JSON.parse(anl.artifacts_json || '{}');

      if (anl.modality === 'video' && Array.isArray(arts.sampledFrames)) {
        for (const fr of arts.sampledFrames as Array<{
          index: number;
          timestampSec: number;
          temporalDelta: number;
          elaMean: number;
          flagged?: boolean;
          flagReason?: string;
          mlScore?: number;
          faces?: Array<{ trackId?: string }>;
        }>) {
          const trackTags = (fr.faces || []).map((f) => f.trackId).filter(Boolean).join(', ');
          offsets.push({
            id: `vfr-${anl.evidence_id}-${fr.index}`,
            group: 'media_offsets',
            timestamp: anl.analyzed_at,
            offsetSec: fr.timestampSec,
            offsetLabel: `${fr.timestampSec.toFixed(2)}s`,
            title: `Video Frame #${fr.index} (${fname})${fr.flagged ? ' [FLAGGED]' : ''}`,
            detail: `ELA=${fr.elaMean}, Δ=${fr.temporalDelta}${
              typeof fr.mlScore === 'number' ? `, Raw ViT ${(fr.mlScore * 100).toFixed(1)}%` : ''
            }${trackTags ? `, Tracks: ${trackTags}` : ''}${fr.flagReason ? ` — ${fr.flagReason}` : ''}`,
            toneClass: fr.flagged ? 'text-rose-600 dark:text-rose-400' : 'text-slate-700 dark:text-slate-300',
            linkTo: `/investigations/${caseId}/video/${anl.evidence_id}`,
            linkLabel: 'Video Lab',
          });
        }
      }

      if ((anl.modality === 'audio' || anl.modality === 'video') && (Array.isArray(arts.segments) || Array.isArray(arts.embeddedAudio?.segments))) {
        const segs = (anl.modality === 'audio' ? arts.segments : arts.embeddedAudio?.segments) as Array<{
          id: string;
          startSec: number;
          endSec: number;
          rmsDb: number;
          spectralFlatness: number;
          flagged?: boolean;
          note: string;
        }>;
        for (const seg of segs) {
          offsets.push({
            id: `aseg-${anl.evidence_id}-${seg.id}`,
            group: 'media_offsets',
            timestamp: anl.analyzed_at,
            offsetSec: seg.startSec,
            offsetLabel: `${seg.startSec.toFixed(1)}s–${seg.endSec.toFixed(1)}s`,
            title: `Audio Window (${fname})${seg.flagged ? ' [ANOMALY]' : ''}`,
            detail: `${seg.rmsDb} dBFS · Spectral Flatness ${seg.spectralFlatness} · ${seg.note}`,
            toneClass: seg.flagged ? 'text-amber-600 dark:text-amber-400' : 'text-teal-700 dark:text-teal-400',
            linkTo: `/investigations/${caseId}/${anl.modality}/${anl.evidence_id}`,
            linkLabel: anl.modality === 'audio' ? 'Audio Lab' : 'Video Lab',
          });
        }
      }

      if (anl.modality === 'text' && Array.isArray(arts.cues)) {
        for (const cue of arts.cues as Array<{ index: number; startSec: number; endSec: number; text: string }>) {
          offsets.push({
            id: `cue-${anl.evidence_id}-${cue.index}`,
            group: 'media_offsets',
            timestamp: anl.analyzed_at,
            offsetSec: cue.startSec,
            offsetLabel: `${cue.startSec.toFixed(2)}s–${cue.endSec.toFixed(2)}s`,
            title: `Subtitle Cue #${cue.index} (${fname})`,
            detail: cue.text,
            toneClass: 'text-indigo-700 dark:text-indigo-400',
            linkTo: `/investigations/${caseId}/text/${anl.evidence_id}`,
            linkLabel: 'Text Lab',
          });
        }
      }
    }

    chron.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    offsets.sort((a, b) => a.offsetSec - b.offsetSec);
    return { chronologicalEvents: chron, mediaOffsetEvents: offsets };
  }, [bundle, caseId]);

  const filteredChron = chronologicalEvents.filter((e) => (filter === 'all' ? true : e.group === filter));

  return (
    <ConsoleShell
      title="Unified Investigation Timeline"
      subtitle={
        caseId
          ? `Investigation ${caseId} · Chronological custody chain, agent execution spans, and synchronized media timestamps`
          : 'Select an investigation to view its timeline'
      }
      activeInvestigationId={caseId}
      actions={
        caseId ? (
          <Link
            to={`/investigations/${caseId}`}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-white dark:bg-[#111827] border border-slate-300 dark:border-slate-700 hover:border-blue-600 text-slate-800 dark:text-slate-100 rounded-md whitespace-nowrap shrink-0"
          >
            Back to Workspace
          </Link>
        ) : null
      }
    >
      {!caseId ? (
        <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-10 text-center space-y-3">
          <FolderPlus className="w-8 h-8 text-blue-600 dark:text-sky-400 mx-auto" />
          <p className="text-sm font-medium text-slate-900 dark:text-slate-100">No Active Investigation Selected</p>
          <Link
            to="/dashboard"
            className="inline-block px-4 py-2 text-xs font-semibold bg-blue-600 text-white rounded-md"
          >
            Open Dashboard
          </Link>
        </div>
      ) : (
        <div className="space-y-6">
          <WorkflowStepper caseId={caseId} bundle={bundle} />

          {/* Filter Bar */}
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="inline-flex flex-wrap bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-md p-1 gap-1">
              {(
                [
                  { id: 'all', label: 'All Events' },
                  { id: 'media_offsets', label: 'Media Timestamps' },
                  { id: 'ingestion', label: 'Evidence Uploads' },
                  { id: 'agents', label: 'Agent Runs' },
                  { id: 'correlations', label: 'Correlations' },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setFilter(tab.id)}
                  className={`px-3 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
                    filter === tab.id
                      ? 'bg-blue-600 text-white'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
            <span className="font-mono text-xs text-slate-500 tabular-nums">
              {chronologicalEvents.length} audit events · {mediaOffsetEvents.length} media offset markers
            </span>
          </div>

          {loading && !bundle ? (
            <div className="h-56 bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg animate-pulse" />
          ) : (
            <div className="grid lg:grid-cols-12 gap-6">
              {/* Synchronized Media Time-Offset Track */}
              {(filter === 'all' || filter === 'media_offsets') && (
                <section
                  className={`${
                    filter === 'media_offsets' ? 'lg:col-span-12' : 'lg:col-span-6'
                  } bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-5 space-y-3`}
                >
                  <div className="flex items-center justify-between">
                    <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-1.5">
                      <Clock className="w-4 h-4 text-blue-600 dark:text-sky-400" />
                      Synchronized Media &amp; Subtitle Time Offsets
                    </h2>
                    <span className="font-mono text-[11px] text-slate-500 tabular-nums">
                      Sorted by media offset (s)
                    </span>
                  </div>
                  <div className="divide-y divide-slate-200 dark:divide-slate-800 max-h-[540px] overflow-y-auto">
                    {mediaOffsetEvents.map((ev) => (
                      <div key={ev.id} className="py-3 text-xs flex items-start justify-between gap-3">
                        <div className="flex items-start gap-3 min-w-0">
                          <span className="font-mono text-[11px] font-semibold text-slate-500 tabular-nums w-24 shrink-0">
                            {ev.offsetLabel}
                          </span>
                          <div className="min-w-0">
                            <p className={`font-medium ${ev.toneClass}`}>{ev.title}</p>
                            <p className="text-slate-600 dark:text-slate-400 mt-0.5 leading-relaxed">{ev.detail}</p>
                          </div>
                        </div>
                        {ev.linkTo && (
                          <Link
                            to={ev.linkTo}
                            className="text-blue-600 dark:text-sky-400 hover:underline font-medium inline-flex items-center gap-1 shrink-0"
                          >
                            {ev.linkLabel}
                            <ExternalLink className="w-3 h-3" />
                          </Link>
                        )}
                      </div>
                    ))}
                    {mediaOffsetEvents.length === 0 && (
                      <p className="py-6 text-xs text-slate-500 text-center">
                        No timestamped video frames, audio windows, or SRT cues analyzed yet.
                      </p>
                    )}
                  </div>
                </section>
              )}

              {/* Chronological Audit & Agent Log */}
              {filter !== 'media_offsets' && (
                <section
                  className={`${
                    filter === 'all' ? 'lg:col-span-6' : 'lg:col-span-12'
                  } bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-5 space-y-3`}
                >
                  <div className="flex items-center justify-between">
                    <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                      Chronological Case &amp; Pipeline Ledger
                    </h2>
                    <span className="font-mono text-[11px] text-slate-500 tabular-nums">
                      {filteredChron.length} event(s)
                    </span>
                  </div>
                  <div className="divide-y divide-slate-200 dark:divide-slate-800 max-h-[540px] overflow-y-auto">
                    {filteredChron.map((ev) => (
                      <div key={ev.id} className="py-3 text-xs flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-500 font-mono tabular-nums">
                            <span>{new Date(ev.timestamp).toLocaleString()}</span>
                            <span aria-hidden="true">·</span>
                            <span className="uppercase">{ev.group}</span>
                          </div>
                          <p className={`font-medium mt-0.5 ${ev.toneClass}`}>{ev.title}</p>
                          <p className="text-slate-600 dark:text-slate-400 mt-0.5 leading-relaxed">{ev.detail}</p>
                        </div>
                        {ev.linkTo && (
                          <Link
                            to={ev.linkTo}
                            className="text-blue-600 dark:text-sky-400 hover:underline font-medium shrink-0"
                          >
                            {ev.linkLabel}
                          </Link>
                        )}
                      </div>
                    ))}
                    {filteredChron.length === 0 && (
                      <p className="py-6 text-xs text-slate-500 text-center">No events recorded for this filter.</p>
                    )}
                  </div>
                </section>
              )}
            </div>
          )}
        </div>
      )}
    </ConsoleShell>
  );
};
