import React, { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Grid, RotateCcw, ZoomIn, ZoomOut } from 'lucide-react';
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
import { DetectedFace, ForensicIndicator, WorkspaceBundle } from '../types/forensics.ts';
import { translateIndicatorForView, translateModelDisplay } from '../utils/plainEnglish.ts';

export const ImageForensicsPage: React.FC = () => {
  const { id, evidenceId } = useParams();
  const { viewMode: complexityMode } = useViewMode();
  const caseId = id && id !== 'none' ? id : getActiveCaseId();
  const [bundle, setBundle] = useState<WorkspaceBundle | null>(() =>
    caseId ? loadWorkspaceSnapshot(caseId) : null,
  );
  const [selectedId, setSelectedId] = useState<string>('');
  const [viewMode, setViewMode] = useState<'original' | 'ela' | 'noise' | 'split'>('original');
  const [splitPct, setSplitPct] = useState(50);
  const [showRegions, setShowRegions] = useState(true);
  const [showFaces, setShowFaces] = useState(true);
  const [tileMode, setTileMode] = useState<'ela' | 'noise'>('ela');
  const [selectedTileIdx, setSelectedTileIdx] = useState<number | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [dragOrigin, setDragOrigin] = useState({ x: 0, y: 0 });

  useEffect(() => {
    if (!caseId) return;
    api.getWorkspace(caseId).then((res) => {
      setBundle(res);
      saveWorkspaceSnapshot(caseId, res);
      const imgs = res.evidence.filter((e) => e.modality === 'image');
      const savedSel = getDrafts().selectedLabEvidenceByCase[caseId]?.image;
      if (evidenceId && imgs.some((i) => i.id === evidenceId)) {
        setSelectedId(evidenceId);
      } else if (savedSel && imgs.some((i) => i.id === savedSel)) {
        setSelectedId(savedSel);
      } else if (imgs.length > 0) {
        setSelectedId(imgs[0].id);
      }
    }).catch(() => {});
  }, [caseId, evidenceId]);

  const images = bundle?.evidence.filter((e) => e.modality === 'image') || [];
  const activeEv = images.find((i) => i.id === selectedId) || images[0];
  const analysis = bundle?.analyses.find((a) => a.evidence_id === activeEv?.id);
  const predictions = bundle?.predictions.filter((p) => p.evidence_id === activeEv?.id) || [];

  const metrics = analysis ? JSON.parse(analysis.metrics_json || '{}') : {};
  const artifacts = analysis ? JSON.parse(analysis.artifacts_json || '{}') : {};
  const indicators: ForensicIndicator[] = analysis ? JSON.parse(analysis.indicators_json || '[]') : [];
  const exif = artifacts.exif || {};
  const elaTiles: number[] = artifacts.tileMeans || [];
  const noiseTiles: number[] = artifacts.noiseTileMeans || [];
  const activeTiles = tileMode === 'ela' ? elaTiles : noiseTiles;
  const maxTileVal = Math.max(1, ...activeTiles);

  const originalUrl = activeEv ? `/api/evidence/${activeEv.id}/file` : '';
  const elaUrl = artifacts.elaUrl || '';
  const noiseUrl = artifacts.noiseUrl || '';
  const detectedFaces: DetectedFace[] = Array.isArray(artifacts.detectedFaces) ? artifacts.detectedFaces : [];
  const localizedRegions = indicators.filter((ind) => ind.evidenceRegion && ind.category !== 'Face Region Analysis');

  return (
    <ConsoleShell
      title="Image Forensics Lab"
      subtitle={
        caseId
          ? `Investigation ${caseId} · Dual-quality ELA, 8x8 spatial tile residuals, Laplacian noise, EXIF, and ViT/RF classifiers`
          : 'No active investigation selected'
      }
      activeInvestigationId={caseId}
    >
      {!caseId ? (
        <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-10 text-center space-y-3">
          <p className="text-sm text-slate-700 dark:text-slate-300">
            Start or select an investigation from the Dashboard before opening the Image Forensics Lab.
          </p>
          <Link
            to="/dashboard"
            className="inline-block px-4 py-2 text-xs font-semibold bg-blue-600 text-white rounded-md"
          >
            Go to Dashboard
          </Link>
        </div>
      ) : images.length === 0 ? (
        <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-10 text-center space-y-3">
          <p className="text-sm text-slate-700 dark:text-slate-300">No image evidence found in this investigation.</p>
          <Link
            to={`/investigations/${caseId}/upload`}
            className="inline-block px-4 py-2 text-xs font-semibold bg-blue-600 text-white rounded-md"
          >
            Upload Image Evidence
          </Link>
        </div>
      ) : (
        <div className="space-y-6">
          <WorkflowStepper caseId={caseId} bundle={bundle} />
          {/* Evidence Switcher & Mode Controls */}
          <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-4 flex flex-wrap items-center justify-between gap-4">
            <div className="flex flex-wrap items-center gap-2">
              {images.map((img) => (
                <button
                  key={img.id}
                  type="button"
                  onClick={() => {
                    setSelectedId(img.id);
                    updateDrafts((d) => ({
                      ...d,
                      selectedLabEvidenceByCase: {
                        ...d.selectedLabEvidenceByCase,
                        [caseId]: { ...(d.selectedLabEvidenceByCase[caseId] || {}), image: img.id },
                      },
                    }));
                    setZoom(1);
                    setPan({ x: 0, y: 0 });
                    setSelectedTileIdx(null);
                  }}
                  className={`px-3 py-1.5 text-xs rounded-md border transition-colors whitespace-nowrap ${
                    activeEv?.id === img.id
                      ? 'bg-blue-600 border-blue-600 text-white font-medium'
                      : 'bg-slate-50 dark:bg-[#162032] border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
                  }`}
                >
                  {img.original_filename}
                </button>
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <div className="inline-flex bg-slate-100 dark:bg-[#162032] border border-slate-200 dark:border-slate-700 rounded-md p-0.5">
                {(
                  [
                    { id: 'original', label: 'Original' },
                    { id: 'ela', label: 'ELA Residual' },
                    { id: 'noise', label: 'Noise Floor' },
                    { id: 'split', label: 'Split Compare' },
                  ] as const
                ).map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => setViewMode(m.id)}
                    className={`px-2.5 py-1 text-xs rounded transition-colors whitespace-nowrap ${
                      viewMode === m.id
                        ? 'bg-blue-600 text-white font-medium'
                        : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                    }`}
                  >
                    {m.label}
                  </button>
                ))}
              </div>

              <div className="flex items-center gap-1 bg-slate-100 dark:bg-[#162032] border border-slate-200 dark:border-slate-700 rounded-md px-2 py-1">
                <button
                  type="button"
                  onClick={() => setZoom((z) => Math.max(0.75, Number((z - 0.25).toFixed(2))))}
                  aria-label="Zoom out"
                  className="text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white p-0.5"
                >
                  <ZoomOut className="w-3.5 h-3.5" />
                </button>
                <span className="font-mono text-xs text-slate-900 dark:text-slate-100 w-11 text-center tabular-nums">
                  {Math.round(zoom * 100)}%
                </span>
                <button
                  type="button"
                  onClick={() => setZoom((z) => Math.min(3.5, Number((z + 0.25).toFixed(2))))}
                  aria-label="Zoom in"
                  className="text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white p-0.5"
                >
                  <ZoomIn className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setZoom(1);
                    setPan({ x: 0, y: 0 });
                  }}
                  aria-label="Reset zoom"
                  className="text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white p-0.5 ml-1"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          </div>

          {/* Interactive Viewport + Metadata Split */}
          <div className="grid lg:grid-cols-12 gap-6">
            <div className="lg:col-span-8 space-y-6">
              <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-4 flex flex-col">
                <div className="flex flex-wrap items-center justify-between gap-2 mb-3 text-xs text-slate-600 dark:text-slate-400">
                  <span>
                    Drag canvas to pan · {metrics.width || '—'}×{metrics.height || '—'} px ·{' '}
                    {String(metrics.format || '').toUpperCase()} · {detectedFaces.length} face(s) detected
                  </span>
                  <div className="flex items-center gap-3">
                    {detectedFaces.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setShowFaces((s) => !s)}
                        className="text-cyan-700 dark:text-sky-400 hover:underline font-medium"
                      >
                        {showFaces ? 'Hide Face Boxes' : 'Show Face Boxes'}
                      </button>
                    )}
                    {localizedRegions.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setShowRegions((s) => !s)}
                        className="text-amber-600 dark:text-amber-400 hover:underline font-medium"
                      >
                        {showRegions ? 'Hide ELA Tile Box' : 'Show ELA Tile Box'}
                      </button>
                    )}
                    {activeEv && (
                      <Link
                        to={`/investigations/${caseId}/evidence/${activeEv.id}`}
                        className="text-blue-600 dark:text-sky-400 hover:underline font-medium"
                      >
                        Inspect Detail
                      </Link>
                    )}
                  </div>
                </div>

                <div
                  className="relative flex-1 min-h-[400px] bg-slate-100 dark:bg-[#0B1120] border border-slate-200 dark:border-slate-800 rounded overflow-hidden select-none cursor-grab active:cursor-grabbing flex items-center justify-center"
                  onMouseDown={(e) => {
                    setDragging(true);
                    setDragOrigin({ x: e.clientX - pan.x, y: e.clientY - pan.y });
                  }}
                  onMouseMove={(e) => {
                    if (!dragging) return;
                    setPan({ x: e.clientX - dragOrigin.x, y: e.clientY - dragOrigin.y });
                  }}
                  onMouseUp={() => setDragging(false)}
                  onMouseLeave={() => setDragging(false)}
                >
                  <div
                    className="relative transition-transform duration-75"
                    style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
                  >
                    {viewMode === 'split' && elaUrl ? (
                      <div className="relative">
                        <img
                          src={originalUrl}
                          alt={activeEv?.original_filename}
                          draggable={false}
                          referrerPolicy="no-referrer"
                          className="max-h-[400px] w-auto object-contain block"
                        />
                        <div
                          className="absolute inset-0 overflow-hidden"
                          style={{ clipPath: `inset(0 ${100 - splitPct}% 0 0)` }}
                        >
                          <img
                            src={elaUrl}
                            alt="ELA residual map"
                            draggable={false}
                            referrerPolicy="no-referrer"
                            className="w-full h-full object-contain block"
                          />
                        </div>
                        <div
                          className="absolute top-0 bottom-0 w-0.5 bg-cyan-500 dark:bg-sky-400"
                          style={{ left: `${splitPct}%` }}
                        />
                      </div>
                    ) : (
                      <img
                        src={
                          viewMode === 'ela' && elaUrl
                            ? elaUrl
                            : viewMode === 'noise' && noiseUrl
                            ? noiseUrl
                            : originalUrl
                        }
                        alt={`${activeEv?.original_filename} (${viewMode})`}
                        draggable={false}
                        referrerPolicy="no-referrer"
                        className="max-h-[400px] w-auto object-contain block"
                      />
                    )}

                    {showFaces &&
                      detectedFaces.map((face, idx) => (
                        <div
                          key={`face-${idx}`}
                          style={{
                            left: `${face.xPct}%`,
                            top: `${face.yPct}%`,
                            width: `${face.wPct}%`,
                            height: `${face.hPct}%`,
                          }}
                          className="absolute border-2 border-cyan-400 bg-cyan-500/10 pointer-events-none"
                        >
                          <span className="absolute -top-5 left-0 bg-slate-900/90 text-white font-mono text-[10px] px-1.5 py-0.5 rounded-xs whitespace-nowrap tabular-nums">
                            Face {idx + 1} · {(face.confidence * 100).toFixed(0)}%
                            {typeof face.mlScore === 'number' ? ` · ViT ${(face.mlScore * 100).toFixed(0)}%` : ''}
                          </span>
                        </div>
                      ))}

                    {showRegions &&
                      localizedRegions.map((ind) =>
                        ind.evidenceRegion ? (
                          <div
                            key={ind.id}
                            style={{
                              left: `${ind.evidenceRegion.xPct}%`,
                              top: `${ind.evidenceRegion.yPct}%`,
                              width: `${ind.evidenceRegion.wPct}%`,
                              height: `${ind.evidenceRegion.hPct}%`,
                            }}
                            title={ind.title}
                            className="absolute border-2 border-rose-500 bg-rose-500/15 pointer-events-none"
                          />
                        ) : null,
                      )}
                  </div>
                </div>

                {viewMode === 'split' && (
                  <div className="mt-3 flex items-center gap-3 text-xs text-slate-600 dark:text-slate-400">
                    <span>ELA Overlay</span>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      value={splitPct}
                      onChange={(e) => setSplitPct(Number(e.target.value))}
                      className="flex-1 accent-blue-600"
                    />
                    <span>Original</span>
                  </div>
                )}
              </div>

              {/* 8x8 Spatial Tile Heatmap Inspector */}
              {activeTiles.length === 64 && (
                <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-5 space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <Grid className="w-4 h-4 text-cyan-700 dark:text-sky-400" />
                      <div>
                        <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                          8×8 Spatial Tile Residual Matrix
                        </h2>
                        <p className="text-xs text-slate-500">
                          Click any grid tile to inspect regional compression or noise divergence
                        </p>
                      </div>
                    </div>
                    <div className="inline-flex bg-slate-100 dark:bg-[#162032] border border-slate-200 dark:border-slate-700 rounded-md p-0.5">
                      <button
                        type="button"
                        onClick={() => setTileMode('ela')}
                        className={`px-2.5 py-1 text-xs rounded ${
                          tileMode === 'ela'
                            ? 'bg-blue-600 text-white font-medium'
                            : 'text-slate-600 dark:text-slate-400'
                        }`}
                      >
                        ELA Tile Mean
                      </button>
                      <button
                        type="button"
                        onClick={() => setTileMode('noise')}
                        className={`px-2.5 py-1 text-xs rounded ${
                          tileMode === 'noise'
                            ? 'bg-blue-600 text-white font-medium'
                            : 'text-slate-600 dark:text-slate-400'
                        }`}
                      >
                        Noise Tile Std
                      </button>
                    </div>
                  </div>

                  <div className="grid grid-cols-8 gap-1">
                    {activeTiles.map((val, idx) => {
                      const intensity = Math.min(1, val / maxTileVal);
                      const isSelected = selectedTileIdx === idx;
                      const row = Math.floor(idx / 8);
                      const col = idx % 8;
                      return (
                        <button
                          key={idx}
                          type="button"
                          onClick={() => setSelectedTileIdx(idx)}
                          title={`Tile (${row},${col}): ${val}`}
                          className={`h-8 rounded-xs font-mono text-[10px] tabular-nums transition-colors border ${
                            isSelected
                              ? 'border-slate-900 dark:border-white ring-1 ring-blue-600'
                              : 'border-slate-200/70 dark:border-slate-800'
                          }`}
                          style={{
                            backgroundColor:
                              intensity > 0.72
                                ? `rgba(225, 29, 72, ${0.22 + intensity * 0.55})`
                                : intensity > 0.42
                                ? `rgba(8, 145, 178, ${0.15 + intensity * 0.45})`
                                : `rgba(37, 99, 235, ${0.06 + intensity * 0.28})`,
                          }}
                        >
                          <span className="text-slate-900 dark:text-slate-100">{val}</span>
                        </button>
                      );
                    })}
                  </div>
                  {selectedTileIdx !== null && (
                    <p className="text-xs font-mono text-slate-600 dark:text-slate-300">
                      Tile ({Math.floor(selectedTileIdx / 8)}, {selectedTileIdx % 8}) · ELA Mean:{' '}
                      {elaTiles[selectedTileIdx] ?? '—'} · Noise Floor: {noiseTiles[selectedTileIdx] ?? '—'}
                    </p>
                  )}
                </div>
              )}
            </div>

            {/* Right Sidebar: Metrics, ML Predictions, EXIF */}
            <div className="lg:col-span-4 space-y-5">
              <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-4 space-y-3">
                <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                  Observed Forensic Signal Metrics
                </h2>
                <dl className="grid grid-cols-2 gap-y-2 gap-x-3 text-xs">
                  <dt className="text-slate-500">ELA Mean (Q=90)</dt>
                  <dd className="font-mono text-right text-slate-900 dark:text-slate-100 tabular-nums">
                    {metrics.elaMean ?? '—'}
                  </dd>
                  <dt className="text-slate-500">ELA Mean (Q=75)</dt>
                  <dd className="font-mono text-right text-slate-900 dark:text-slate-100 tabular-nums">
                    {metrics.elaQ75Mean ?? '—'}
                  </dd>
                  <dt className="text-slate-500">ELA 95th Pct</dt>
                  <dd className="font-mono text-right text-slate-900 dark:text-slate-100 tabular-nums">
                    {metrics.elaP95 ?? '—'}
                  </dd>
                  <dt className="text-slate-500">ELA Spatial Variance</dt>
                  <dd className="font-mono text-right text-slate-900 dark:text-slate-100 tabular-nums">
                    {metrics.elaSpatialVariance ?? '—'}
                  </dd>
                  <dt className="text-slate-500">Noise Floor Std</dt>
                  <dd className="font-mono text-right text-slate-900 dark:text-slate-100 tabular-nums">
                    {metrics.noiseFloorStd ?? '—'}
                  </dd>
                  <dt className="text-slate-500">Noise Spatial Variance</dt>
                  <dd className="font-mono text-right text-slate-900 dark:text-slate-100 tabular-nums">
                    {metrics.noiseSpatialVariance ?? '—'}
                  </dd>
                  <dt className="text-slate-500">8×8 Block Ratio</dt>
                  <dd className="font-mono text-right text-slate-900 dark:text-slate-100 tabular-nums">
                    {metrics.blockArtifactRatio ?? '—'}
                  </dd>
                  <dt className="text-slate-500">Double-JPEG Signal</dt>
                  <dd className="font-mono text-right text-slate-700 dark:text-slate-300">
                    {metrics.doubleJpegSuspected === true
                      ? 'Detected'
                      : metrics.doubleJpegSuspected === false
                      ? 'Not flagged'
                      : '—'}
                  </dd>
                  <dt className="text-slate-500">JPEG DQT Tables</dt>
                  <dd className="font-mono text-right text-slate-900 dark:text-slate-100 tabular-nums">
                    {metrics.jpegQuantTablesCount ?? '—'}
                  </dd>
                  <dt className="text-slate-500">AI Metadata Markers</dt>
                  <dd className="font-mono text-right text-slate-700 dark:text-slate-300">
                    {metrics.aiMetadataDetected ? 'Flagged' : 'None detected'}
                  </dd>
                  <dt className="text-slate-500">C2PA / Content Credentials</dt>
                  <dd className="font-mono text-right text-slate-700 dark:text-slate-300">
                    {metrics.c2paPresent ? 'Present' : 'Not embedded'}
                  </dd>
                </dl>
                {typeof metrics.doubleJpegReason === 'string' && metrics.doubleJpegReason && (
                  <p className="text-[11px] text-slate-600 dark:text-slate-400 pt-1">
                    {metrics.doubleJpegReason}
                  </p>
                )}
                {((typeof metrics.aiMetadataMarkers === 'string' &&
                  metrics.aiMetadataMarkers.trim() !== '' &&
                  metrics.aiMetadataMarkers !== 'None') ||
                  (Array.isArray(metrics.aiMetadataMarkers) && metrics.aiMetadataMarkers.length > 0)) && (
                  <p className="text-[11px] font-mono text-amber-700 dark:text-amber-400">
                    Metadata Markers:{' '}
                    {Array.isArray(metrics.aiMetadataMarkers)
                      ? metrics.aiMetadataMarkers.join(', ')
                      : String(metrics.aiMetadataMarkers)}
                  </p>
                )}
                {activeEv && (
                  <p className="pt-2 border-t border-slate-200 dark:border-slate-800 font-mono text-[11px] text-slate-500 break-all">
                    SHA-256: {activeEv.sha256_hash}
                  </p>
                )}
              </div>

              <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-4 space-y-3">
                <div>
                  <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                    Raw Model Scores (Uncalibrated)
                  </h2>
                  <p className="text-[11px] text-slate-500">
                    Raw classifier scores reflect relative anomaly signals, not factual probabilities.
                  </p>
                </div>
                {predictions.map((pred) => {
                  const contribs = JSON.parse(pred.feature_contributions_json || '[]') as Array<{
                    feature: string;
                    value: number;
                    impact: number;
                  }>;
                  const modelMeta = translateModelDisplay(pred.model_id, complexityMode);
                  return (
                    <div
                      key={pred.id}
                      className="pt-2.5 first:pt-0 border-t first:border-t-0 border-slate-200 dark:border-slate-800 space-y-1.5"
                    >
                      <div className="flex items-center justify-between text-xs gap-2">
                        <span className="font-mono font-medium text-slate-800 dark:text-slate-200 truncate">
                          {modelMeta.name}
                        </span>
                        <span className={`font-mono font-semibold shrink-0 ${statusTextClass(pred.prediction_label)}`}>
                          Raw {(pred.raw_score * 100).toFixed(1)}%
                        </span>
                      </div>
                      <p className="text-[11px] text-slate-600 dark:text-slate-400 leading-relaxed">
                        {pred.uncertainty_note}
                      </p>
                      {complexityMode === 'advanced' && (
                        <div className="space-y-1 pt-1">
                          {contribs.slice(0, 3).map((c) => (
                            <div key={c.feature} className="flex items-center justify-between text-[11px] font-mono text-slate-500">
                              <span>{c.feature}</span>
                              <span>{c.value}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
                {predictions.length === 0 && (
                  <p className="text-xs text-slate-500">Run Forensic Analysis from Workspace to score this image.</p>
                )}
              </div>

              <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-4 space-y-2">
                <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                  EXIF &amp; Provenance Tags
                </h2>
                <div className="text-xs space-y-1 max-h-48 overflow-y-auto">
                  {Object.entries(exif).map(([k, v]) => (
                    <div key={k} className="flex justify-between gap-3">
                      <span className="text-slate-500">{k}</span>
                      <span className="font-mono text-slate-800 dark:text-slate-200 text-right truncate">
                        {String(v ?? '—')}
                      </span>
                    </div>
                  ))}
                  {Object.keys(exif).length === 0 && (
                    <p className="text-xs text-slate-500">No EXIF tags extracted or analysis pending.</p>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Observed Indicators & Limitations */}
          <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-5 space-y-3">
            <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
              Observed Indicators &amp; Methodological Limits
            </h2>
            <div className="divide-y divide-slate-200 dark:divide-slate-800">
              {indicators.map((ind) => {
                const layer = epistemicLayerMeta(ind.sourceLayer);
                const tr = translateIndicatorForView(ind, complexityMode);
                return (
                  <div key={ind.id} className="py-2.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={`font-semibold ${statusTextClass(ind.severity)}`}>
                          [{ind.severity.toUpperCase()}]
                        </span>
                        <span className="font-medium text-slate-900 dark:text-slate-100">{tr.title}</span>
                        {complexityMode === 'advanced' && (
                          <>
                            <span className="text-slate-400">·</span>
                            <span className={`font-mono text-[11px] ${layer.toneClass}`}>{layer.label}</span>
                          </>
                        )}
                      </div>
                      <p className="text-slate-600 dark:text-slate-400 mt-0.5">{tr.detail}</p>
                    </div>
                    <span className="font-mono text-[11px] text-slate-500 shrink-0">
                      {complexityMode === 'simple' ? tr.categoryLabel : ind.evidenceRef || ind.category}
                    </span>
                  </div>
                );
              })}
            </div>
            {complexityMode === 'advanced' && analysis?.limitations && (
              <p className="text-xs text-slate-500 pt-2 border-t border-slate-200 dark:border-slate-800">
                Limitation Note: {analysis.limitations}
              </p>
            )}
          </div>
        </div>
      )}
    </ConsoleShell>
  );
};
