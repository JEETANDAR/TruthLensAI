import React, { useEffect, useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Download, Play, Upload } from 'lucide-react';
import { ConsoleShell } from '../components/ConsoleShell.tsx';
import { useChartTheme } from '../context/ThemeContext.tsx';
import { api } from '../services/api.ts';
import {
  ModelEvaluationRow,
  ModelRegistryRow,
  ModelValidationMetrics,
  ValidationDatasetSource,
  ValidationResultRow,
  ValidationRunRow,
} from '../types/forensics.ts';

interface StagedSample {
  file: File;
  label: 'real' | 'fake';
}

function fmtPct(v: number | null): string {
  if (v === null || Number.isNaN(v)) return 'N/A';
  return `${(v * 100).toFixed(1)}%`;
}

export const ModelsPage: React.FC = () => {
  const chart = useChartTheme();
  const [models, setModels] = useState<ModelRegistryRow[]>([]);
  const [evals, setEvals] = useState<ModelEvaluationRow[]>([]);
  const [benchmarkInfo, setBenchmarkInfo] = useState<{
    collectionId: string;
    name: string;
    description: string;
    totalSamples: number;
    sources: ValidationDatasetSource[];
  } | null>(null);
  const [devBenchmarkInfo, setDevBenchmarkInfo] = useState<{
    collectionId: string;
    name: string;
    description: string;
    totalSamples: number;
    sources: ValidationDatasetSource[];
  } | null>(null);
  const [audioBenchmarkInfo, setAudioBenchmarkInfo] = useState<{
    collectionId: string;
    name: string;
    description: string;
    totalSamples: number;
    sources: ValidationDatasetSource[];
  } | null>(null);
  const [selectedCollection, setSelectedCollection] = useState<'held_out' | 'dev' | 'audio'>('held_out');
  const [runs, setRuns] = useState<ValidationRunRow[]>([]);
  const [activeRun, setActiveRun] = useState<ValidationRunRow | null>(null);
  const [results, setResults] = useState<ValidationResultRow[]>([]);

  const [loading, setLoading] = useState(true);
  const [runningValidation, setRunningValidation] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [threshold, setThreshold] = useState<number>(0.5);
  const [selectedModelId, setSelectedModelId] = useState<string>('TL-ViT-DFvReal-ONNX');
  const [modalityFilter, setModalityFilter] = useState<'all' | 'image' | 'video' | 'audio'>('all');
  const [outcomeFilter, setOutcomeFilter] = useState<'all' | 'correct' | 'errors'>('all');

  // Custom labelled upload state
  const [showCustomForm, setShowCustomForm] = useState(false);
  const [stagedSamples, setStagedSamples] = useState<StagedSample[]>([]);
  const [customSourceNote, setCustomSourceNote] = useState('Investigator-verified labelled test batch');
  const [customLicenseNote, setCustomLicenseNote] = useState('Internal evaluation media');
  const [runningCustom, setRunningCustom] = useState(false);

  const loadAll = async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const [mRes, vRes] = await Promise.all([api.getModels(), api.getValidationState()]);
      setModels(mRes.models);
      setEvals(mRes.evaluations);
      setBenchmarkInfo(vRes.benchmark);
      setDevBenchmarkInfo(vRes.devBenchmark);
      setAudioBenchmarkInfo(vRes.audioBenchmark);
      setRuns(vRes.runs);
      if (vRes.runs.length > 0) {
        setActiveRun(vRes.runs[0]);
        setResults(vRes.latestResults);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to load model evaluation data');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadAll();
  }, []);

  const targetBenchmark =
    selectedCollection === 'dev'
      ? devBenchmarkInfo
      : selectedCollection === 'audio'
      ? audioBenchmarkInfo
      : benchmarkInfo;

  const handleRunBenchmark = async () => {
    setRunningValidation(true);
    setErrorMsg(null);
    try {
      const res = await api.runBenchmarkValidation(threshold, true, selectedCollection);
      setActiveRun(res.run);
      setRuns((prev) => [res.run, ...prev.filter((r) => r.id !== res.run.id)]);

      if (res.run.status === 'running') {
        let current = res;
        while (current.run.status === 'running') {
          await new Promise((r) => setTimeout(r, 2000));
          const poll = await api.getValidationRun(res.run.id);
          setActiveRun(poll.run);
          setResults(poll.results);
          setRuns((prev) => prev.map((r) => (r.id === poll.run.id ? poll.run : r)));
          current = { ...current, run: poll.run, results: poll.results };
        }
      } else {
        setResults(res.results);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Benchmark validation failed');
    } finally {
      setRunningValidation(false);
    }
  };

  const handleSelectRun = async (runId: string) => {
    setErrorMsg(null);
    try {
      const res = await api.getValidationRun(runId);
      setActiveRun(res.run);
      setResults(res.results);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Could not load validation run');
    }
  };

  const handleStageFiles = (files: FileList | null) => {
    if (!files) return;
    const next: StagedSample[] = Array.from(files).map((f) => ({
      file: f,
      label: 'real',
    }));
    setStagedSamples((prev) => [...prev, ...next]);
  };

  const handleRunCustom = async (e: React.FormEvent) => {
    e.preventDefault();
    if (stagedSamples.length === 0) return;
    setRunningCustom(true);
    setErrorMsg(null);
    try {
      const res = await api.runCustomValidation(
        stagedSamples.map((s) => s.file),
        stagedSamples.map((s) => s.label),
        threshold,
        customSourceNote,
        customLicenseNote,
      );
      setActiveRun(res.run);
      setResults(res.results);
      setRuns((prev) => [res.run, ...prev.filter((r) => r.id !== res.run.id)]);
      setStagedSamples([]);
      setShowCustomForm(false);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Custom validation failed');
    } finally {
      setRunningCustom(false);
    }
  };

  const metricsByModel: ModelValidationMetrics[] = useMemo(() => {
    if (!activeRun) return [];
    try {
      return JSON.parse(activeRun.metrics_by_model_json || '[]') as ModelValidationMetrics[];
    } catch {
      return [];
    }
  }, [activeRun]);

  const activeSources: ValidationDatasetSource[] = useMemo(() => {
    if (activeRun) {
      try {
        const parsed = JSON.parse(activeRun.sources_json || '[]') as ValidationDatasetSource[];
        if (parsed.length > 0) return parsed;
      } catch {
        // fallback below
      }
    }
    return benchmarkInfo?.sources || [];
  }, [activeRun, benchmarkInfo]);

  const availableModelIds = useMemo(() => {
    const ids = Array.from(new Set(metricsByModel.map((m) => m.modelId)));
    return ids.length > 0 ? ids : ['TL-ViT-DFvReal-ONNX', 'TL-ImgForensics-RF-v2', 'TL-ImgForensics-LR-v2'];
  }, [metricsByModel]);

  useEffect(() => {
    if (availableModelIds.length > 0 && !availableModelIds.includes(selectedModelId)) {
      setSelectedModelId(availableModelIds[0]);
    }
  }, [availableModelIds, selectedModelId]);

  const selectedMetric = useMemo(() => {
    return (
      metricsByModel.find((m) => m.modelId === selectedModelId && m.modalityScope === modalityFilter) ||
      metricsByModel.find((m) => m.modelId === selectedModelId && m.modalityScope === 'all') ||
      null
    );
  }, [metricsByModel, selectedModelId, modalityFilter]);

  const modelComparisonChartData = useMemo(() => {
    return metricsByModel
      .filter((m) => m.modalityScope === 'all')
      .map((m) => ({
        model: m.modelId.replace('TL-', ''),
        accuracy: m.accuracy !== null ? Number((m.accuracy * 100).toFixed(1)) : 0,
        precision: m.precision !== null ? Number((m.precision * 100).toFixed(1)) : 0,
        recall: m.recall !== null ? Number((m.recall * 100).toFixed(1)) : 0,
        f1: m.f1 !== null ? Number((m.f1 * 100).toFixed(1)) : 0,
        fpr: m.fpr !== null ? Number((m.fpr * 100).toFixed(1)) : 0,
      }));
  }, [metricsByModel]);

  const filteredFileResults = useMemo(() => {
    return results.filter((r) => {
      if (r.model_id !== selectedModelId) return false;
      if (modalityFilter !== 'all' && r.modality !== modalityFilter) return false;
      if (outcomeFilter === 'correct' && !r.correct) return false;
      if (outcomeFilter === 'errors' && r.correct) return false;
      return true;
    });
  }, [results, selectedModelId, modalityFilter, outcomeFilter]);

  const perFileChartData = useMemo(() => {
    return filteredFileResults.map((r) => ({
      name: r.filename.replace(/\.(jpg|jpeg|png|mp4|wav|mp3)$/i, ''),
      rawScorePct: Number((r.raw_score * 100).toFixed(1)),
      groundTruth: r.ground_truth_label,
      predicted: r.predicted_label,
      correct: Boolean(r.correct),
    }));
  }, [filteredFileResults]);

  const publishedBenchmarks = [
    { benchmark: 'ViT-v2 Face DF (Model Card)', value: 92.12 },
    { benchmark: 'AASIST ASVspoof19-LA (EER)', value: 0.83 },
    { benchmark: 'AASIST ASVspoof21-LA (EER)', value: 12.35 },
    { benchmark: 'AASIST ASVspoof21-DF (EER)', value: 17.04 },
    { benchmark: 'AASIST In-The-Wild (EER)', value: 43.01 },
  ];

  return (
    <ConsoleShell
      title="Model Evaluation Dashboard"
      subtitle="Known-labelled real vs fake validation using actual pretrained ONNX models and forensic pipelines"
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300 bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-md px-2.5 py-1.5">
            <label htmlFor="val-collection" className="whitespace-nowrap">
              Split
            </label>
            <select
              id="val-collection"
              value={selectedCollection}
              onChange={(e) => setSelectedCollection(e.target.value as 'held_out' | 'dev' | 'audio')}
              className="bg-transparent font-mono text-xs text-slate-900 dark:text-slate-100 focus:outline-none"
            >
              <option value="held_out">Held-Out Image/Video ({benchmarkInfo?.totalSamples ?? 16})</option>
              <option value="dev">Dev Split Image/Video ({devBenchmarkInfo?.totalSamples ?? 12})</option>
              <option value="audio">Audio Deepfake CC-BY-4.0 ({audioBenchmarkInfo?.totalSamples ?? 12})</option>
            </select>
          </div>
          <div className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300 bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-md px-2.5 py-1.5">
            <label htmlFor="val-threshold" className="whitespace-nowrap">
              Decision Cutoff
            </label>
            <select
              id="val-threshold"
              value={threshold}
              onChange={(e) => setThreshold(Number(e.target.value))}
              className="bg-transparent font-mono text-xs text-slate-900 dark:text-slate-100 focus:outline-none"
            >
              <option value={0.4}>40 / 100 (Sensitive)</option>
              <option value={0.5}>50 / 100 (Standard)</option>
              <option value={0.65}>65 / 100 (Strict)</option>
            </select>
          </div>
          <button
            type="button"
            onClick={() => setShowCustomForm((v) => !v)}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#111827] text-slate-800 dark:text-slate-100 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
          >
            <Upload className="w-3.5 h-3.5" />
            Test Custom Labelled Media
          </button>
          <button
            type="button"
            disabled={runningValidation || !targetBenchmark}
            onClick={handleRunBenchmark}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-md bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white transition-colors whitespace-nowrap shrink-0"
          >
            <Play className="w-3.5 h-3.5" />
            {runningValidation
              ? 'Running Models...'
              : `Run ${selectedCollection === 'dev' ? 'Dev' : selectedCollection === 'audio' ? 'Audio' : 'Held-Out'} (${targetBenchmark?.totalSamples ?? 12} Samples)`}
          </button>
        </div>
      }
    >
      <div className="space-y-6">
        {errorMsg && (
          <div className="bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-800 rounded-lg px-4 py-3 text-xs text-rose-800 dark:text-rose-200">
            {errorMsg}
          </div>
        )}

        {/* Custom Labelled Upload Panel */}
        {showCustomForm && (
          <form
            onSubmit={handleRunCustom}
            className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-5 space-y-4"
          >
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div>
                <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                  Validate Custom Labelled Image &amp; Video Samples
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  Ground-truth labels are stored separately from inference and never passed to forensic or ML modules.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowCustomForm(false)}
                className="text-xs text-slate-500 hover:text-slate-900 dark:hover:text-slate-200 whitespace-nowrap shrink-0"
              >
                Close
              </button>
            </div>

            <div className="grid sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-slate-500 mb-1">Dataset Source Documentation</label>
                <input
                  type="text"
                  value={customSourceNote}
                  onChange={(e) => setCustomSourceNote(e.target.value)}
                  className="w-full px-3 py-2 text-xs rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#0B1120] text-slate-900 dark:text-slate-100"
                  required
                />
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-1">Dataset Licence / Usage Terms</label>
                <input
                  type="text"
                  value={customLicenseNote}
                  onChange={(e) => setCustomLicenseNote(e.target.value)}
                  className="w-full px-3 py-2 text-xs rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#0B1120] text-slate-900 dark:text-slate-100"
                  required
                />
              </div>
            </div>

            <div>
              <label className="block text-xs text-slate-500 mb-1.5">
                Select Image (.jpg, .png, .webp) or Video (.mp4, .mov, .webm) Files
              </label>
              <input
                type="file"
                multiple
                accept="image/*,video/*"
                onChange={(e) => handleStageFiles(e.target.files)}
                className="block w-full text-xs text-slate-600 dark:text-slate-300 file:mr-3 file:py-1.5 file:px-3 file:rounded-md file:border-0 file:text-xs file:font-medium file:bg-slate-100 dark:file:bg-slate-800 file:text-slate-800 dark:file:text-slate-100 hover:file:bg-slate-200"
              />
            </div>

            {stagedSamples.length > 0 && (
              <div className="border border-slate-200 dark:border-slate-800 rounded-md overflow-hidden">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-50 dark:bg-[#162032] text-slate-500">
                    <tr>
                      <th className="py-2 px-3 font-medium">Filename</th>
                      <th className="py-2 px-3 font-medium">Verified Ground-Truth Label</th>
                      <th className="py-2 px-3 font-medium text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                    {stagedSamples.map((s, idx) => (
                      <tr key={`${s.file.name}-${idx}`}>
                        <td className="py-2 px-3 font-mono text-slate-800 dark:text-slate-200">{s.file.name}</td>
                        <td className="py-2 px-3">
                          <select
                            value={s.label}
                            onChange={(e) => {
                              const val = e.target.value as 'real' | 'fake';
                              setStagedSamples((prev) =>
                                prev.map((item, i) => (i === idx ? { ...item, label: val } : item)),
                              );
                            }}
                            className="px-2 py-1 text-xs rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#0B1120] text-slate-900 dark:text-slate-100"
                          >
                            <option value="real">Real (Genuine)</option>
                            <option value="fake">Fake (Manipulated / AI)</option>
                          </select>
                        </td>
                        <td className="py-2 px-3 text-right">
                          <button
                            type="button"
                            onClick={() => setStagedSamples((prev) => prev.filter((_, i) => i !== idx))}
                            className="text-rose-600 dark:text-rose-400 hover:underline"
                          >
                            Remove
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="flex items-center justify-between pt-2">
              <span className="text-xs text-slate-500 font-mono tabular-nums">
                Staged: {stagedSamples.length} file(s) · Real: {stagedSamples.filter((s) => s.label === 'real').length} ·
                Fake: {stagedSamples.filter((s) => s.label === 'fake').length}
              </span>
              <button
                type="submit"
                disabled={stagedSamples.length === 0 || runningCustom}
                className="px-4 py-2 text-xs font-semibold rounded-md bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white whitespace-nowrap shrink-0"
              >
                {runningCustom ? 'Evaluating Batch...' : 'Run Isolated Validation'}
              </button>
            </div>
          </form>
        )}

        {/* Active Validation Results Section */}
        <section className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-5 space-y-5">
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 pb-4 border-b border-slate-200 dark:border-slate-800">
            <div>
              <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                <span className="font-mono text-amber-700 dark:text-amber-400 font-medium">
                  Uncalibrated Raw Model Scores (0–100)
                </span>
                <span>·</span>
                <span>Ground Truth Isolated During Inference</span>
                {activeRun && (
                  <>
                    <span>·</span>
                    <span className="font-mono tabular-nums">
                      n={activeRun.sample_count} ({activeRun.real_count} Real / {activeRun.fake_count} Fake)
                    </span>
                    <span>·</span>
                    <span className="font-mono tabular-nums">Cutoff {(activeRun.threshold * 100).toFixed(0)}/100</span>
                  </>
                )}
              </div>
              <h2 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100 mt-1">
                {activeRun ? activeRun.collection_name : 'Real vs Fake Detection Validation'}
              </h2>
            </div>

            {activeRun && (
              <div className="flex flex-wrap items-center gap-2">
                {runs.length > 1 && (
                  <select
                    value={activeRun.id}
                    onChange={(e) => void handleSelectRun(e.target.value)}
                    className="px-2.5 py-1.5 text-xs rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#0B1120] text-slate-900 dark:text-slate-100 font-mono"
                  >
                    {runs.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.collection_name} ({new Date(r.started_at).toLocaleTimeString()})
                      </option>
                    ))}
                  </select>
                )}
                <a
                  href={`/api/validation/runs/${encodeURIComponent(activeRun.id)}/export?format=csv`}
                  download
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-slate-300 dark:border-slate-700 text-slate-800 dark:text-slate-100 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
                >
                  <Download className="w-3.5 h-3.5" />
                  Download CSV
                </a>
                <a
                  href={`/api/validation/runs/${encodeURIComponent(activeRun.id)}/export?format=json`}
                  download
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-slate-300 dark:border-slate-700 text-slate-800 dark:text-slate-100 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
                >
                  <Download className="w-3.5 h-3.5" />
                  Download JSON
                </a>
              </div>
            )}
          </div>

          {loading ? (
            <div className="h-48 bg-slate-100 dark:bg-slate-800/50 rounded animate-pulse" />
          ) : !activeRun ? (
            <div className="py-10 text-center space-y-3">
              <p className="text-sm font-medium text-slate-800 dark:text-slate-200">
                No validation run executed yet.
              </p>
              <p className="text-xs text-slate-500 max-w-xl mx-auto">
                Click &ldquo;Run Validation&rdquo; above to evaluate the actual pretrained ONNX and forensic pipelines
                against the verified {benchmarkInfo?.totalSamples ?? 16}-file real &amp; fake test collection, or upload
                your own labelled media.
              </p>
            </div>
          ) : activeRun.status === 'running' ? (
            <div className="py-10 text-center space-y-2">
              <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
                Running Pretrained Models &amp; Forensic Pipelines...
              </p>
              <p className="font-mono text-xs text-blue-600 dark:text-sky-400">{activeRun.notes}</p>
            </div>
          ) : (
            <>
              {/* Model Selector & Modality Filter */}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 dark:bg-[#162032] rounded-lg">
                  {availableModelIds.map((mid) => (
                    <button
                      key={mid}
                      type="button"
                      onClick={() => setSelectedModelId(mid)}
                      className={`px-3 py-1.5 text-xs font-mono rounded-md transition-colors whitespace-nowrap shrink-0 ${
                        selectedModelId === mid
                          ? 'bg-white dark:bg-[#0B1120] text-blue-600 dark:text-sky-400 font-semibold shadow-sm'
                          : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                      }`}
                    >
                      {mid}
                    </button>
                  ))}
                </div>

                <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-[#162032] rounded-lg">
                  {(['all', 'image', 'video', 'audio'] as const).map((mod) => (
                    <button
                      key={mod}
                      type="button"
                      onClick={() => setModalityFilter(mod)}
                      className={`px-3 py-1.5 text-xs font-medium rounded-md capitalize transition-colors whitespace-nowrap shrink-0 ${
                        modalityFilter === mod
                          ? 'bg-white dark:bg-[#0B1120] text-slate-900 dark:text-slate-100 shadow-sm'
                          : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                      }`}
                    >
                      {mod}
                    </button>
                  ))}
                </div>
              </div>

              {/* Audio Out-of-Domain / Inconclusive Disclosure */}
              {(activeRun.collection_id === 'TL-AUD-VAL-V1' || modalityFilter === 'audio') && (
                <div className="p-3 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-md text-xs text-amber-800 dark:text-amber-300 leading-relaxed">
                  <span className="font-semibold">Out-of-Domain Audio Benchmark Disclosure:</span>{' '}
                  <span className="font-mono">TL-AASIST-ONNX</span> (trained on 16kHz lossless ASVspoof2019-LA lab audio) exhibits severe domain shift on YouTube ambient speech transcoded from FLAC (100% false-positive rate on genuine YouTube speech at 0.50 cutoff), and <span className="font-mono">TL-AudSpoof-LR-v1</span> outputs ~0 on real-world speech waveforms. Treat live ambient audio predictions from these models as <span className="font-semibold">inconclusive</span>, not trustworthy deepfake or authenticity proof.
                </div>
              )}

              {/* Metrics KPI Strip */}
              {selectedMetric && !selectedMetric.metricsSupported && (
                <div className="p-3 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-md text-xs text-amber-800 dark:text-amber-300">
                  Aggregate classification rates omitted: {selectedMetric.unsupportedReason}
                </div>
              )}

              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
                {[
                  { label: 'Accuracy', value: selectedMetric?.metricsSupported ? fmtPct(selectedMetric.accuracy) : 'N/A' },
                  { label: 'Precision (Fake)', value: selectedMetric?.metricsSupported ? fmtPct(selectedMetric.precision) : 'N/A' },
                  { label: 'Recall (Fake)', value: selectedMetric?.metricsSupported ? fmtPct(selectedMetric.recall) : 'N/A' },
                  { label: 'F1 Score', value: selectedMetric?.metricsSupported ? fmtPct(selectedMetric.f1) : 'N/A' },
                  { label: 'False-Positive Rate', value: selectedMetric?.metricsSupported ? fmtPct(selectedMetric.fpr) : 'N/A' },
                  {
                    label: 'Mean Raw (Real / Fake)',
                    value:
                      selectedMetric &&
                      selectedMetric.meanRawScoreReal !== null &&
                      selectedMetric.meanRawScoreFake !== null
                        ? `${(selectedMetric.meanRawScoreReal * 100).toFixed(1)} / ${(selectedMetric.meanRawScoreFake * 100).toFixed(1)}`
                        : 'N/A',
                  },
                ].map((kpi) => (
                  <div
                    key={kpi.label}
                    className="p-3 bg-slate-50 dark:bg-[#162032] border border-slate-200 dark:border-slate-800 rounded-md"
                  >
                    <div className="text-[11px] text-slate-500">{kpi.label}</div>
                    <div className="font-mono tabular-nums text-lg font-semibold text-slate-900 dark:text-slate-100 mt-0.5">
                      {kpi.value}
                    </div>
                  </div>
                ))}
              </div>

              {/* Confusion Matrix + Comparison Chart + Per-Sample Scores */}
              <div className="grid lg:grid-cols-12 gap-6">
                {/* 2x2 Confusion Matrix */}
                <div className="lg:col-span-4 space-y-2">
                  <h3 className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                    Confusion Matrix ({selectedModelId})
                  </h3>
                  <p className="text-[11px] text-slate-500">
                    Positive class = Fake (Manipulated). Based on uncalibrated raw score ≥{' '}
                    {(activeRun.threshold * 100).toFixed(0)}/100.
                  </p>
                  {selectedMetric ? (
                    <div className="border border-slate-200 dark:border-slate-800 rounded-md overflow-hidden text-xs">
                      <table className="w-full text-center">
                        <thead className="bg-slate-50 dark:bg-[#162032] text-[11px] text-slate-500">
                          <tr>
                            <th className="py-2 px-2 text-left">Actual \ Predicted</th>
                            <th className="py-2 px-2">Pred: Fake</th>
                            <th className="py-2 px-2">Pred: Real</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-200 dark:divide-slate-800 font-mono tabular-nums">
                          <tr>
                            <td className="py-3 px-2 text-left font-sans font-medium text-slate-700 dark:text-slate-300">
                              Actual: Fake
                            </td>
                            <td className="py-3 px-2 bg-emerald-50/70 dark:bg-emerald-950/30 text-emerald-800 dark:text-emerald-300 font-semibold">
                              TP: {selectedMetric.confusionMatrix.tp}
                            </td>
                            <td className="py-3 px-2 bg-rose-50/70 dark:bg-rose-950/30 text-rose-800 dark:text-rose-300 font-semibold">
                              FN: {selectedMetric.confusionMatrix.fn}
                            </td>
                          </tr>
                          <tr>
                            <td className="py-3 px-2 text-left font-sans font-medium text-slate-700 dark:text-slate-300">
                              Actual: Real
                            </td>
                            <td className="py-3 px-2 bg-amber-50/70 dark:bg-amber-950/30 text-amber-800 dark:text-amber-300 font-semibold">
                              FP: {selectedMetric.confusionMatrix.fp}
                            </td>
                            <td className="py-3 px-2 bg-emerald-50/70 dark:bg-emerald-950/30 text-emerald-800 dark:text-emerald-300 font-semibold">
                              TN: {selectedMetric.confusionMatrix.tn}
                            </td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div className="text-xs text-slate-500">No matrix available for selected filter.</div>
                  )}
                </div>

                {/* Model Comparison Chart */}
                <div className="lg:col-span-4 space-y-2">
                  <h3 className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                    Measured Model Metrics Comparison (%)
                  </h3>
                  <p className="text-[11px] text-slate-500">
                    All models evaluated on the same n={activeRun.sample_count} verified collection.
                  </p>
                  <div className="h-48">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={modelComparisonChartData} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                        <CartesianGrid stroke={chart.gridStroke} strokeDasharray="3 3" vertical={false} />
                        <XAxis dataKey="model" stroke={chart.axisStroke} fontSize={10} />
                        <YAxis stroke={chart.axisStroke} fontSize={10} domain={[0, 100]} unit="%" />
                        <Tooltip contentStyle={chart.tooltipStyle} />
                        <Bar dataKey="accuracy" name="Accuracy %" fill="#2563eb" radius={[2, 2, 0, 0]} />
                        <Bar dataKey="f1" name="F1 %" fill="#0d9488" radius={[2, 2, 0, 0]} />
                        <Bar dataKey="fpr" name="FPR %" fill="#e11d48" radius={[2, 2, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>

                {/* Per-Sample Raw Score Separation Chart */}
                <div className="lg:col-span-4 space-y-2">
                  <h3 className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                    Uncalibrated Raw Score by File (0–100)
                  </h3>
                  <p className="text-[11px] text-slate-500">
                    Rose = verified Fake · Teal = verified Real · Dashed = cutoff ({(activeRun.threshold * 100).toFixed(0)}).
                  </p>
                  <div className="h-48">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={perFileChartData} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                        <CartesianGrid stroke={chart.gridStroke} strokeDasharray="3 3" vertical={false} />
                        <XAxis dataKey="name" stroke={chart.axisStroke} fontSize={9} interval={0} angle={-25} textAnchor="end" height={42} />
                        <YAxis stroke={chart.axisStroke} fontSize={10} domain={[0, 100]} />
                        <Tooltip contentStyle={chart.tooltipStyle} />
                        <ReferenceLine y={activeRun.threshold * 100} stroke="#d97706" strokeDasharray="4 4" />
                        <Bar dataKey="rawScorePct" name="Raw Score (Uncalibrated)">
                          {perFileChartData.map((entry, idx) => (
                            <Cell key={`cell-${idx}`} fill={entry.groundTruth === 'fake' ? '#e11d48' : '#0d9488'} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              </div>

              {/* Individual File Results & Flag Explanations */}
              <div className="space-y-3 pt-2">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <div>
                    <h3 className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                      Individual File Results &amp; Flag Explanations
                    </h3>
                    <p className="text-[11px] text-slate-500">
                      Showing {filteredFileResults.length} sample(s) for {selectedModelId}. Scores are uncalibrated raw
                      model outputs.
                    </p>
                  </div>
                  <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-[#162032] rounded-lg">
                    {(
                      [
                        { id: 'all', label: 'All Results' },
                        { id: 'correct', label: 'Correct Only' },
                        { id: 'errors', label: 'FP / FN Errors' },
                      ] as const
                    ).map((f) => (
                      <button
                        key={f.id}
                        type="button"
                        onClick={() => setOutcomeFilter(f.id)}
                        className={`px-2.5 py-1 text-xs rounded-md transition-colors whitespace-nowrap shrink-0 ${
                          outcomeFilter === f.id
                            ? 'bg-white dark:bg-[#0B1120] text-slate-900 dark:text-slate-100 font-medium shadow-sm'
                            : 'text-slate-600 dark:text-slate-400'
                        }`}
                      >
                        {f.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="border border-slate-200 dark:border-slate-800 rounded-md overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-slate-50 dark:bg-[#162032] text-slate-500 border-b border-slate-200 dark:border-slate-800">
                      <tr>
                        <th className="py-2.5 px-3 font-medium">File</th>
                        <th className="py-2.5 px-3 font-medium">Ground Truth</th>
                        <th className="py-2.5 px-3 font-medium text-right">Raw Score (Uncalibrated)</th>
                        <th className="py-2.5 px-3 font-medium">Predicted</th>
                        <th className="py-2.5 px-3 font-medium">Outcome</th>
                        <th className="py-2.5 px-3 font-medium">Why It Was Flagged / Cleared</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                      {filteredFileResults.map((r) => {
                        const reasons = JSON.parse(r.flag_reasons_json || '[]') as string[];
                        const outcome =
                          r.ground_truth_label === 'fake' && r.predicted_label === 'fake'
                            ? 'TP (Caught Fake)'
                            : r.ground_truth_label === 'real' && r.predicted_label === 'real'
                            ? 'TN (Verified Real)'
                            : r.ground_truth_label === 'real' && r.predicted_label === 'fake'
                            ? 'FP (False Flag)'
                            : 'FN (Missed Fake)';

                        return (
                          <tr key={r.id} className="align-top hover:bg-slate-50/60 dark:hover:bg-slate-800/30">
                            <td className="py-3 px-3 whitespace-nowrap">
                              <div className="font-mono font-medium text-slate-900 dark:text-slate-100">{r.filename}</div>
                              <div className="text-[11px] text-slate-500">
                                {r.modality.toUpperCase()} · {r.sample_id}
                              </div>
                            </td>
                            <td className="py-3 px-3 whitespace-nowrap font-mono uppercase">
                              <span
                                className={
                                  r.ground_truth_label === 'fake'
                                    ? 'text-rose-700 dark:text-rose-400 font-semibold'
                                    : 'text-teal-700 dark:text-teal-400 font-semibold'
                                }
                              >
                                {r.ground_truth_label}
                              </span>
                            </td>
                            <td className="py-3 px-3 text-right whitespace-nowrap font-mono tabular-nums text-slate-900 dark:text-slate-100">
                              {(r.raw_score * 100).toFixed(1)} / 100
                              <div className="text-[10px] text-amber-700 dark:text-amber-400">uncalibrated</div>
                            </td>
                            <td className="py-3 px-3 whitespace-nowrap font-mono uppercase text-slate-800 dark:text-slate-200">
                              {r.predicted_label}
                            </td>
                            <td className="py-3 px-3 whitespace-nowrap font-mono text-[11px]">
                              <span
                                className={
                                  r.correct
                                    ? 'text-emerald-700 dark:text-emerald-400 font-semibold'
                                    : 'text-rose-700 dark:text-rose-400 font-semibold'
                                }
                              >
                                {outcome}
                              </span>
                            </td>
                            <td className="py-3 px-3 text-slate-700 dark:text-slate-300 space-y-1 min-w-[320px]">
                              {reasons.map((line, i) => (
                                <p key={i} className="leading-relaxed">
                                  {line}
                                </p>
                              ))}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </section>

        {/* Dataset Sources, Licences, Sample Counts & Limitations */}
        <section className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-5 space-y-3">
          <div>
            <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
              Validation Dataset Sources, Licences &amp; Limitations
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Ground-truth labels are maintained in an isolated manifest and never mixed with training data or model inference inputs.
            </p>
          </div>
          <div className="grid md:grid-cols-2 gap-4">
            {activeSources.map((src) => (
              <div
                key={src.name}
                className="p-4 bg-slate-50 dark:bg-[#162032] border border-slate-200 dark:border-slate-800 rounded-md space-y-2 text-xs"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-slate-900 dark:text-slate-100">{src.name}</span>
                  <span className="font-mono tabular-nums text-slate-600 dark:text-slate-300 shrink-0">
                    n={src.sampleCount} ({src.breakdown.real} real · {src.breakdown.fake} fake)
                  </span>
                </div>
                <div className="text-[11px] text-slate-600 dark:text-slate-400">
                  Licence: {src.license}
                </div>
                <div className="text-[11px] text-amber-700 dark:text-amber-400 leading-relaxed">
                  Limitations: {src.limitations}
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Upstream Published Model Registry */}
        <section className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-5 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div>
              <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                Registered Models &amp; Upstream Published Benchmarks
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Reference upstream metrics published by model authors alongside TruthLens uncalibrated heuristic baselines.
              </p>
            </div>
          </div>

          <div className="h-44">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={publishedBenchmarks} margin={{ top: 8, right: 16, left: -10, bottom: 0 }}>
                <CartesianGrid stroke={chart.gridStroke} strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="benchmark" stroke={chart.axisStroke} fontSize={11} />
                <YAxis stroke={chart.axisStroke} fontSize={11} domain={[0, 100]} unit="%" />
                <Tooltip contentStyle={chart.tooltipStyle} />
                <Bar dataKey="value" name="Published Metric (%)" fill={chart.primaryBar} radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div className="space-y-3">
            {models.map((m) => {
              const ev = evals.find((e) => e.model_id === m.id);
              const isPublished = ev?.eval_scope === 'published_benchmark';
              return (
                <div
                  key={m.id}
                  className="p-4 border border-slate-200 dark:border-slate-800 rounded-md grid lg:grid-cols-12 gap-4 text-xs"
                >
                  <div className="lg:col-span-7 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2 text-slate-500">
                      <span className="font-mono font-semibold text-blue-600 dark:text-sky-400">{m.id}</span>
                      <span>·</span>
                      <span>v{m.version}</span>
                      <span>·</span>
                      <span className="uppercase font-mono">{m.modality}</span>
                      <span>·</span>
                      <span>{m.license}</span>
                    </div>
                    <div className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">{m.name}</div>
                    <p className="text-slate-600 dark:text-slate-400">{m.algorithm}</p>
                    <p className="text-amber-700 dark:text-amber-400">Limitation: {m.limitations}</p>
                  </div>
                  {ev && (
                    <div className="lg:col-span-5 lg:border-l border-slate-200 dark:border-slate-800 lg:pl-4 space-y-1.5">
                      <div className="font-semibold text-slate-900 dark:text-slate-100">{ev.dataset_name}</div>
                      <div className="text-[11px] text-slate-500">
                        {isPublished
                          ? `Published Upstream Benchmark · ${ev.dataset_license}`
                          : 'Uncalibrated Heuristic Baseline'}
                      </div>
                      <p className="text-slate-600 dark:text-slate-300 leading-relaxed">
                        {ev.benchmark_summary || ev.notes}
                      </p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </ConsoleShell>
  );
};
