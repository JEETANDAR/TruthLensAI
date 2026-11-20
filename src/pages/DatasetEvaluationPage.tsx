import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Download,
  FileSpreadsheet,
  FileWarning,
  Folder,
  FolderOpen,
  FolderUp,
  Image as ImageIcon,
  Play,
  RefreshCw,
  Search,
  Square,
  Trash2,
} from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { ConsoleShell, formatBytes } from '../components/ConsoleShell.tsx';
import { useChartTheme } from '../context/ThemeContext.tsx';
import { api } from '../services/api.ts';
import {
  CsvFileDescriptor,
  CsvInspectionResult,
  DatasetEvalModelMetrics,
  DatasetEvalResultRow,
  DatasetEvalRunRow,
  DatasetMatchSummary,
  DatasetTreeNode,
  DatasetUploadRow,
  UnsupportedFileRecord,
} from '../types/forensics.ts';

function fmtPct(v: number | null): string {
  if (v === null || Number.isNaN(v)) return 'N/A';
  return `${(v * 100).toFixed(1)}%`;
}

function splitBadgeLabel(split: string): string {
  if (split === 'test') return 'Test Split';
  if (split === 'train') return 'Train Split';
  if (split === 'valid') return 'Validation Split';
  return 'Custom CSV';
}

function countFoldersInTree(node: DatasetTreeNode | null): number {
  if (!node || node.type !== 'folder') return 0;
  let total = 1;
  for (const child of node.children || []) {
    if (child.type === 'folder') total += countFoldersInTree(child);
  }
  return total;
}

async function readDroppedEntries(dataTransfer: DataTransfer): Promise<{
  rootName: string;
  entries: Array<{ file: File; relativePath: string }>;
}> {
  const items = Array.from(dataTransfer.items || []);
  const collected: Array<{ file: File; relativePath: string }> = [];

  async function traverseEntry(entry: FileSystemEntry, prefix: string): Promise<void> {
    if (entry.isFile) {
      const fileEntry = entry as FileSystemFileEntry;
      const file = await new Promise<File>((resolve, reject) => fileEntry.file(resolve, reject));
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      collected.push({ file, relativePath: rel });
    } else if (entry.isDirectory) {
      const dirEntry = entry as FileSystemDirectoryEntry;
      const reader = dirEntry.createReader();
      const readBatch = (): Promise<FileSystemEntry[]> =>
        new Promise((resolve, reject) => reader.readEntries(resolve, reject));
      let batch = await readBatch();
      const allChildren: FileSystemEntry[] = [];
      while (batch.length > 0) {
        allChildren.push(...batch);
        batch = await readBatch();
      }
      const nextPrefix = prefix ? `${prefix}/${entry.name}` : entry.name;
      for (const child of allChildren) {
        await traverseEntry(child, nextPrefix);
      }
    }
  }

  let rootName = 'uploaded_dataset';
  for (const item of items) {
    const entry = item.webkitGetAsEntry?.();
    if (entry) {
      if (entry.isDirectory && rootName === 'uploaded_dataset') {
        rootName = entry.name;
      }
      await traverseEntry(entry, '');
    } else {
      const file = item.getAsFile();
      if (file) {
        collected.push({ file, relativePath: file.name });
      }
    }
  }

  return { rootName, entries: collected };
}

interface TreeExplorerProps {
  node: DatasetTreeNode;
  selectedCsvPath: string;
  onSelectCsv: (csvPath: string) => void;
  depth?: number;
}

const TreeExplorerNode: React.FC<TreeExplorerProps> = ({
  node,
  selectedCsvPath,
  onSelectCsv,
  depth = 0,
}) => {
  const [expanded, setExpanded] = useState(depth < 2);

  if (node.type === 'file') {
    const isCsv = node.modality === 'csv';
    const isImg = node.modality === 'image';
    const isSelected = isCsv && node.path === selectedCsvPath;

    return (
      <div
        className={`flex items-center justify-between gap-2 py-1.5 px-2 rounded text-xs ${
          isSelected
            ? 'bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-sky-300 font-medium'
            : 'hover:bg-slate-50 dark:hover:bg-slate-800/50 text-slate-700 dark:text-slate-300'
        }`}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
      >
        <div className="flex items-center gap-2 min-w-0">
          {isCsv ? (
            <FileSpreadsheet className="w-3.5 h-3.5 text-teal-600 dark:text-teal-400 shrink-0" />
          ) : isImg ? (
            <ImageIcon className="w-3.5 h-3.5 text-blue-600 dark:text-sky-400 shrink-0" />
          ) : (
            <FileWarning className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 shrink-0" />
          )}
          {isCsv ? (
            <button
              type="button"
              onClick={() => onSelectCsv(node.path)}
              className="font-mono truncate text-left hover:underline"
            >
              {node.name}
            </button>
          ) : (
            <span className="font-mono truncate">{node.name}</span>
          )}
        </div>
        <div className="flex items-center gap-3 shrink-0 font-mono text-[11px] text-slate-500 tabular-nums">
          <span>{formatBytes(node.size)}</span>
          {isCsv && (
            <button
              type="button"
              onClick={() => onSelectCsv(node.path)}
              className={`px-2 py-0.5 rounded border text-[11px] font-sans ${
                isSelected
                  ? 'border-blue-600 bg-blue-600 text-white'
                  : 'border-slate-300 dark:border-slate-700 hover:border-blue-600 text-slate-700 dark:text-slate-300'
              }`}
            >
              {isSelected ? 'Selected' : 'Inspect CSV'}
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between gap-2 py-1.5 px-2 rounded hover:bg-slate-50 dark:hover:bg-slate-800/50 text-xs text-slate-900 dark:text-slate-100"
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
      >
        <div className="flex items-center gap-1.5 min-w-0">
          {expanded ? (
            <ChevronDown className="w-3.5 h-3.5 text-slate-500 shrink-0" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-slate-500 shrink-0" />
          )}
          {expanded ? (
            <FolderOpen className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 shrink-0" />
          ) : (
            <Folder className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 shrink-0" />
          )}
          <span className="font-mono font-medium truncate">{node.name}/</span>
        </div>
        <div className="flex items-center gap-2 shrink-0 text-[11px] text-slate-500 font-mono tabular-nums">
          <span>{node.imageCount} img</span>
          {node.csvCount > 0 && (
            <>
              <span>·</span>
              <span className="text-teal-700 dark:text-teal-400">{node.csvCount} csv</span>
            </>
          )}
          {node.unsupportedCount > 0 && (
            <>
              <span>·</span>
              <span className="text-amber-700 dark:text-amber-400">{node.unsupportedCount} other</span>
            </>
          )}
          <span>·</span>
          <span>{formatBytes(node.size)}</span>
        </div>
      </button>
      {expanded && node.children && node.children.length > 0 && (
        <div>
          {node.children.map((child) => (
            <TreeExplorerNode
              key={child.path || child.name}
              node={child}
              selectedCsvPath={selectedCsvPath}
              onSelectCsv={onSelectCsv}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export const DatasetEvaluationPage: React.FC = () => {
  const chart = useChartTheme();
  const folderInputRef = useRef<HTMLInputElement | null>(null);

  const [datasets, setDatasets] = useState<DatasetUploadRow[]>([]);
  const [runs, setRuns] = useState<DatasetEvalRunRow[]>([]);
  const [activeDatasetId, setActiveDatasetId] = useState<string>('');
  const [loadingInit, setLoadingInit] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Upload state
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState({ done: 0, total: 0, folderName: '' });
  const [dragOver, setDragOver] = useState(false);

  // CSV inspection & column mapping state
  const [selectedCsvPath, setSelectedCsvPath] = useState<string>('');
  const [csvInspection, setCsvInspection] = useState<CsvInspectionResult | null>(null);
  const [loadingCsv, setLoadingCsv] = useState(false);
  const [pathColumn, setPathColumn] = useState<string>('');
  const [labelColumn, setLabelColumn] = useState<string>('');
  const [labelMap, setLabelMap] = useState<Record<string, 'real' | 'fake' | 'unmapped'>>({});

  // Matching state
  const [matching, setMatching] = useState(false);
  const [matchSummary, setMatchSummary] = useState<DatasetMatchSummary | null>(null);
  const [matchDiagFilter, setMatchDiagFilter] = useState<'all' | 'issues' | 'matched'>('issues');

  // Evaluation Run & Dashboard state
  const [activeRun, setActiveRun] = useState<DatasetEvalRunRow | null>(null);
  const [runResults, setRunResults] = useState<DatasetEvalResultRow[]>([]);
  const [startingRun, setStartingRun] = useState(false);
  const [cancellingRun, setCancellingRun] = useState(false);
  const [selectedModelId, setSelectedModelId] = useState<string>('TL-ViT-DFvReal-ONNX');
  const [resultFilter, setResultFilter] = useState<'all' | 'incorrect' | 'inconclusive' | 'issues'>('all');
  const [resultSearch, setResultSearch] = useState<string>('');

  const loadDatasetsAndRuns = async (preferredDatasetId?: string) => {
    setLoadingInit(true);
    try {
      const res = await api.listDatasetUploads();
      setDatasets(res.datasets);
      setRuns(res.runs);
      const targetDsId =
        preferredDatasetId && res.datasets.some((d) => d.id === preferredDatasetId)
          ? preferredDatasetId
          : activeDatasetId && res.datasets.some((d) => d.id === activeDatasetId)
          ? activeDatasetId
          : res.datasets[0]?.id || '';
      if (targetDsId) setActiveDatasetId(targetDsId);
      if (!activeRun && res.runs.length > 0) {
        const latest = await api.getDatasetEvalRun(res.runs[0].id);
        setActiveRun(latest.run);
        setRunResults(latest.results);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to load datasets');
    } finally {
      setLoadingInit(false);
    }
  };

  useEffect(() => {
    void loadDatasetsAndRuns();
  }, []);

  // Poll active evaluation run while running
  useEffect(() => {
    if (!activeRun || activeRun.status !== 'running') return;
    let cancelled = false;
    const timer = setInterval(async () => {
      try {
        const poll = await api.getDatasetEvalRun(activeRun.id);
        if (cancelled) return;
        setActiveRun(poll.run);
        setRunResults(poll.results);
        setRuns((prev) => prev.map((r) => (r.id === poll.run.id ? poll.run : r)));
        if (poll.run.status !== 'running') {
          clearInterval(timer);
        }
      } catch {
        // ignore transient poll error
      }
    }, 900);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [activeRun?.id, activeRun?.status]);

  const activeDataset = useMemo(
    () => datasets.find((d) => d.id === activeDatasetId) || null,
    [datasets, activeDatasetId],
  );

  const parsedTree = useMemo<DatasetTreeNode | null>(() => {
    if (!activeDataset) return null;
    try {
      const t = JSON.parse(activeDataset.tree_json || '{}') as DatasetTreeNode;
      return t && t.name ? t : null;
    } catch {
      return null;
    }
  }, [activeDataset]);

  const csvFiles = useMemo<CsvFileDescriptor[]>(() => {
    if (!activeDataset) return [];
    try {
      return JSON.parse(activeDataset.csv_files_json || '[]') as CsvFileDescriptor[];
    } catch {
      return [];
    }
  }, [activeDataset]);

  const unsupportedFiles = useMemo<UnsupportedFileRecord[]>(() => {
    if (!activeDataset) return [];
    try {
      return JSON.parse(activeDataset.unsupported_files_json || '[]') as UnsupportedFileRecord[];
    } catch {
      return [];
    }
  }, [activeDataset]);

  const folderCount = useMemo(() => countFoldersInTree(parsedTree), [parsedTree]);

  // Auto-select first test.csv or first CSV when switching dataset
  useEffect(() => {
    if (csvFiles.length === 0) {
      setSelectedCsvPath('');
      setCsvInspection(null);
      setMatchSummary(null);
      return;
    }
    const preferred =
      csvFiles.find((c) => c.inferredSplit === 'test') ||
      csvFiles.find((c) => c.inferredSplit === 'valid') ||
      csvFiles[0];
    setSelectedCsvPath(preferred.path);
  }, [activeDatasetId, csvFiles.length]);

  // Inspect CSV whenever selectedCsvPath changes
  useEffect(() => {
    if (!activeDatasetId || !selectedCsvPath) return;
    let ignore = false;
    setLoadingCsv(true);
    setErrorMsg(null);
    setMatchSummary(null);

    api
      .inspectDatasetCsv(activeDatasetId, selectedCsvPath)
      .then((res) => {
        if (ignore) return;
        setCsvInspection(res);
        setPathColumn(res.detectedPathColumn);
        setLabelColumn(res.detectedLabelColumn);
        const initMap: Record<string, 'real' | 'fake' | 'unmapped'> = {};
        for (const item of res.labelDistribution) {
          initMap[item.rawValue.trim().toLowerCase()] = item.suggestedMapping;
        }
        setLabelMap(initMap);
      })
      .catch((err) => {
        if (!ignore) setErrorMsg(err instanceof Error ? err.message : 'Failed to read CSV');
      })
      .finally(() => {
        if (!ignore) setLoadingCsv(false);
      });
    return () => {
      ignore = true;
    };
  }, [activeDatasetId, selectedCsvPath]);

  // Run matching automatically once CSV columns & labelMap are loaded
  useEffect(() => {
    if (!activeDatasetId || !selectedCsvPath || !pathColumn || !labelColumn) return;
    let ignore = false;
    setMatching(true);
    api
      .matchDatasetCsv(activeDatasetId, {
        csvPath: selectedCsvPath,
        pathColumn,
        labelColumn,
        labelMap,
      })
      .then((res) => {
        if (!ignore) setMatchSummary(res);
      })
      .catch((err) => {
        if (!ignore) setErrorMsg(err instanceof Error ? err.message : 'Matching failed');
      })
      .finally(() => {
        if (!ignore) setMatching(false);
      });
    return () => {
      ignore = true;
    };
  }, [activeDatasetId, selectedCsvPath, pathColumn, labelColumn, labelMap]);

  const handleLabelColumnChange = (nextCol: string) => {
    setLabelColumn(nextCol);
    const hints = csvInspection?.allColumnLabelHints?.[nextCol] || [];
    const nextMap: Record<string, 'real' | 'fake' | 'unmapped'> = {};
    for (const h of hints) {
      nextMap[h.rawValue.trim().toLowerCase()] = h.suggestedMapping;
    }
    setLabelMap(nextMap);
  };

  const uploadEntries = async (rootName: string, entries: Array<{ file: File; relativePath: string }>) => {
    if (entries.length === 0) {
      setErrorMsg('No files found in the selected folder.');
      return;
    }
    setUploading(true);
    setErrorMsg(null);
    setUploadProgress({ done: 0, total: entries.length, folderName: rootName });
    try {
      const initRes = await api.initDatasetUpload(rootName);
      const datasetId = initRes.dataset.id;

      const BATCH_SIZE = 40;
      for (let i = 0; i < entries.length; i += BATCH_SIZE) {
        const batch = entries.slice(i, i + BATCH_SIZE);
        await api.uploadDatasetBatch(datasetId, batch);
        setUploadProgress({
          done: Math.min(entries.length, i + batch.length),
          total: entries.length,
          folderName: rootName,
        });
      }

      await api.finalizeDatasetUpload(datasetId);
      await loadDatasetsAndRuns(datasetId);
      setActiveDatasetId(datasetId);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Folder upload failed');
    } finally {
      setUploading(false);
    }
  };

  const handleFolderInput = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const arr = Array.from(files);
    const firstRel = (arr[0] as File & { webkitRelativePath?: string }).webkitRelativePath || arr[0].name;
    const rootName = firstRel.includes('/') ? firstRel.split('/')[0] : 'uploaded_dataset';
    const entries = arr.map((file) => {
      const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
      return { file, relativePath: rel };
    });
    await uploadEntries(rootName, entries);
    if (folderInputRef.current) folderInputRef.current.value = '';
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (uploading) return;
    try {
      const { rootName, entries } = await readDroppedEntries(e.dataTransfer);
      await uploadEntries(rootName, entries);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to read dropped folder');
    }
  };

  const handleDeleteDataset = async (datasetId: string) => {
    try {
      await api.deleteDatasetUpload(datasetId);
      if (activeRun?.dataset_id === datasetId) {
        setActiveRun(null);
        setRunResults([]);
      }
      await loadDatasetsAndRuns();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to delete dataset');
    }
  };

  const handleRunEvaluation = async () => {
    if (!activeDatasetId || !selectedCsvPath || !pathColumn || !labelColumn) return;
    setStartingRun(true);
    setErrorMsg(null);
    try {
      const res = await api.startDatasetEvaluation({
        datasetId: activeDatasetId,
        csvPath: selectedCsvPath,
        pathColumn,
        labelColumn,
        labelMap,
      });
      setActiveRun(res.run);
      setRunResults([]);
      setRuns((prev) => [res.run, ...prev.filter((r) => r.id !== res.run.id)]);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Unable to start evaluation');
    } finally {
      setStartingRun(false);
    }
  };

  const handleCancelEvaluation = async () => {
    if (!activeRun) return;
    setCancellingRun(true);
    try {
      const res = await api.cancelDatasetEvaluation(activeRun.id);
      if (res.run) setActiveRun(res.run);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Cancel failed');
    } finally {
      setCancellingRun(false);
    }
  };

  const handleSelectRun = async (runId: string) => {
    setErrorMsg(null);
    try {
      const res = await api.getDatasetEvalRun(runId);
      setActiveRun(res.run);
      setRunResults(res.results);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to load evaluation run');
    }
  };

  const metricsByModel = useMemo<DatasetEvalModelMetrics[]>(() => {
    if (!activeRun) return [];
    try {
      return JSON.parse(activeRun.metrics_by_model_json || '[]') as DatasetEvalModelMetrics[];
    } catch {
      return [];
    }
  }, [activeRun]);

  useEffect(() => {
    if (metricsByModel.length > 0 && !metricsByModel.some((m) => m.modelId === selectedModelId)) {
      setSelectedModelId(metricsByModel[0].modelId);
    }
  }, [metricsByModel, selectedModelId]);

  const activeMetric = useMemo<DatasetEvalModelMetrics | null>(() => {
    return metricsByModel.find((m) => m.modelId === selectedModelId) || metricsByModel[0] || null;
  }, [metricsByModel, selectedModelId]);

  const filteredResults = useMemo(() => {
    const q = resultSearch.trim().toLowerCase();
    return runResults.filter((r) => {
      // Show model-specific rows for evaluated/inconclusive/failed, plus unmatched run-level rows
      if (r.status === 'evaluated' || r.status === 'inconclusive' || r.status === 'failed') {
        if (r.model_id !== selectedModelId && metricsByModel.some((m) => m.modelId === selectedModelId)) {
          return false;
        }
      }
      if (resultFilter === 'incorrect' && !(r.correct === 0 || r.status === 'failed')) return false;
      if (resultFilter === 'inconclusive' && r.status !== 'inconclusive') return false;
      if (resultFilter === 'issues' && r.status === 'evaluated' && r.correct === 1) return false;
      if (q) {
        return (
          r.filename.toLowerCase().includes(q) ||
          r.csv_image_ref.toLowerCase().includes(q) ||
          (r.resolved_rel_path || '').toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [runResults, selectedModelId, metricsByModel, resultFilter, resultSearch]);

  const predictionDistData = useMemo(() => {
    if (!activeMetric) return [];
    return [
      {
        category: 'Real (Genuine)',
        Actual: activeMetric.actualRealCount,
        Predicted: activeMetric.predictedRealCount,
      },
      {
        category: 'Fake (Manipulated)',
        Actual: activeMetric.actualFakeCount,
        Predicted: activeMetric.predictedFakeCount,
      },
      {
        category: 'Inconclusive',
        Actual: 0,
        Predicted: activeMetric.inconclusiveCount,
      },
      {
        category: 'Failed',
        Actual: 0,
        Predicted: activeMetric.failedCount,
      },
    ];
  }, [activeMetric]);

  const modelComparisonData = useMemo(() => {
    return metricsByModel.map((m) => ({
      model: m.modelId.replace('TL-', ''),
      Accuracy: m.accuracy !== null ? Number((m.accuracy * 100).toFixed(1)) : 0,
      Precision: m.precision !== null ? Number((m.precision * 100).toFixed(1)) : 0,
      FakeRecall: m.fakeRecall !== null ? Number((m.fakeRecall * 100).toFixed(1)) : 0,
      F1: m.f1Score !== null ? Number((m.f1Score * 100).toFixed(1)) : 0,
    }));
  }, [metricsByModel]);

  const visibleDiagnostics = useMemo(() => {
    if (!matchSummary) return [];
    if (matchDiagFilter === 'issues') return matchSummary.diagnostics.filter((d) => d.status !== 'matched');
    if (matchDiagFilter === 'matched') return matchSummary.diagnostics.filter((d) => d.status === 'matched');
    return matchSummary.diagnostics;
  }, [matchSummary, matchDiagFilter]);

  const currentLabelValues = useMemo(() => {
    if (!csvInspection) return [];
    return csvInspection.allColumnLabelHints?.[labelColumn] || [];
  }, [csvInspection, labelColumn]);

  const progressPct = useMemo(() => {
    if (!activeRun || activeRun.matched_count === 0) return 0;
    return Math.min(
      100,
      Math.round(((activeRun.processed_count + activeRun.failed_count) / activeRun.matched_count) * 100),
    );
  }, [activeRun]);

  return (
    <ConsoleShell
      title="Dataset Folder Upload & Evaluation"
      subtitle="Upload nested dataset directories, map CSV splits, match image files, and evaluate TruthLens forensic models without label leakage"
      actions={
        <div className="flex items-center gap-2">
          {datasets.length > 0 && (
            <select
              aria-label="Select uploaded dataset"
              value={activeDatasetId}
              onChange={(e) => setActiveDatasetId(e.target.value)}
              className="max-w-[220px] px-2.5 py-1.5 text-xs rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#111827] text-slate-900 dark:text-slate-100 font-mono truncate"
            >
              {datasets.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} ({d.image_count} img · {d.csv_count} csv)
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            onClick={() => folderInputRef.current?.click()}
            disabled={uploading}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-md bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white transition-colors whitespace-nowrap shrink-0"
          >
            <FolderUp className="w-3.5 h-3.5" />
            {uploading ? 'Uploading Folder...' : 'Upload Dataset Folder'}
          </button>
        </div>
      }
    >
      {/* Hidden folder input supporting nested directory upload */}
      <input
        ref={folderInputRef}
        type="file"
        multiple
        // @ts-expect-error non-standard folder selection attribute supported in modern browsers
        webkitdirectory=""
        directory=""
        onChange={(e) => void handleFolderInput(e.target.files)}
        className="hidden"
      />

      <div className="space-y-6">
        {errorMsg && (
          <div className="bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-800 rounded-lg px-4 py-3 text-xs text-rose-800 dark:text-rose-200 flex items-center justify-between gap-3">
            <span>{errorMsg}</span>
            <button type="button" onClick={() => setErrorMsg(null)} className="underline shrink-0">
              Dismiss
            </button>
          </div>
        )}

        {/* Section 1: Dataset Folder Upload & Expandable File Explorer */}
        <section className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-5 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div>
              <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                01. Dataset Folder Upload &amp; Structure Explorer
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Upload a dataset directory (e.g. <span className="font-mono">real_vs_fake/</span> with nested{' '}
                <span className="font-mono">train/</span>, <span className="font-mono">test/</span>,{' '}
                <span className="font-mono">valid/</span> folders and CSV manifests). Supports JPG, JPEG, PNG, and CSV.
              </p>
            </div>
            {activeDataset && (
              <button
                type="button"
                onClick={() => void handleDeleteDataset(activeDataset.id)}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/30 rounded-md transition-colors whitespace-nowrap shrink-0"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Remove Dataset
              </button>
            )}
          </div>

          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => void handleDrop(e)}
            className={`border-2 border-dashed rounded-lg p-6 text-center transition-colors ${
              dragOver
                ? 'border-blue-600 bg-blue-50/50 dark:bg-blue-950/20'
                : 'border-slate-300 dark:border-slate-700 bg-slate-50/60 dark:bg-[#0B1120]/50'
            }`}
          >
            {uploading ? (
              <div className="max-w-md mx-auto space-y-2">
                <p className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                  Uploading &amp; Preserving Folder Structure: {uploadProgress.folderName}
                </p>
                <div className="w-full h-2 bg-slate-200 dark:bg-slate-800 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-blue-600 transition-all duration-150"
                    style={{
                      width: `${
                        uploadProgress.total > 0 ? Math.round((uploadProgress.done / uploadProgress.total) * 100) : 0
                      }%`,
                    }}
                  />
                </div>
                <p className="font-mono tabular-nums text-[11px] text-slate-500">
                  {uploadProgress.done} / {uploadProgress.total} files transferred
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                <FolderUp className="w-7 h-7 text-blue-600 dark:text-sky-400 mx-auto" />
                <p className="text-xs font-medium text-slate-800 dark:text-slate-200">
                  Drag and drop a dataset folder here, or browse from disk
                </p>
                <p className="text-[11px] text-slate-500">
                  Relative paths are preserved identically on disk. Existing investigations and files remain untouched.
                </p>
                <div className="pt-1">
                  <button
                    type="button"
                    onClick={() => folderInputRef.current?.click()}
                    className="px-4 py-2 text-xs font-semibold rounded-md bg-slate-900 dark:bg-blue-600 hover:bg-slate-800 dark:hover:bg-blue-700 text-white transition-colors"
                  >
                    Select Dataset Folder
                  </button>
                </div>
              </div>
            )}
          </div>

          {loadingInit ? (
            <div className="h-32 bg-slate-100 dark:bg-slate-800/40 rounded animate-pulse" />
          ) : activeDataset && parsedTree ? (
            <div className="space-y-4">
              {/* Dataset Stats Strip */}
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                {[
                  { label: 'Folders', value: String(folderCount) },
                  { label: 'Valid Images (JPG/PNG)', value: String(activeDataset.image_count) },
                  { label: 'CSV Manifests', value: String(activeDataset.csv_count) },
                  { label: 'Unsupported / Skipped', value: String(activeDataset.unsupported_count) },
                  { label: 'Dataset Size', value: formatBytes(activeDataset.total_bytes) },
                ].map((stat) => (
                  <div
                    key={stat.label}
                    className="p-3 bg-slate-50 dark:bg-[#162032] border border-slate-200 dark:border-slate-800 rounded-md"
                  >
                    <div className="text-[11px] text-slate-500">{stat.label}</div>
                    <div className="font-mono tabular-nums text-base font-semibold text-slate-900 dark:text-slate-100 mt-0.5">
                      {stat.value}
                    </div>
                  </div>
                ))}
              </div>

              {/* Expandable File Explorer */}
              <div className="border border-slate-200 dark:border-slate-800 rounded-md overflow-hidden">
                <div className="px-3.5 py-2.5 bg-slate-50 dark:bg-[#162032] border-b border-slate-200 dark:border-slate-800 flex items-center justify-between text-xs">
                  <span className="font-semibold text-slate-900 dark:text-slate-100">
                    Uploaded Folder Explorer ({activeDataset.name})
                  </span>
                  <span className="text-[11px] text-slate-500">Click any CSV file to inspect &amp; map columns</span>
                </div>
                <div className="max-h-72 overflow-y-auto p-2 bg-white dark:bg-[#0B1120]">
                  <TreeExplorerNode
                    node={parsedTree}
                    selectedCsvPath={selectedCsvPath}
                    onSelectCsv={(p) => setSelectedCsvPath(p)}
                  />
                </div>
              </div>

              {unsupportedFiles.length > 0 && (
                <div className="p-3 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-md text-xs text-amber-800 dark:text-amber-300 space-y-1">
                  <p className="font-semibold">
                    {unsupportedFiles.length} unsupported file(s) detected during folder upload (excluded from image
                    inference):
                  </p>
                  <div className="max-h-24 overflow-y-auto font-mono text-[11px] space-y-0.5">
                    {unsupportedFiles.slice(0, 20).map((u, idx) => (
                      <div key={idx}>
                        {u.path} ({u.extension}) — {u.reason}
                      </div>
                    ))}
                    {unsupportedFiles.length > 20 && <div>...and {unsupportedFiles.length - 20} more</div>}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <p className="text-xs text-slate-500 text-center py-2">
              No dataset folders uploaded yet. Upload a folder above to explore its structure and evaluate CSV splits.
            </p>
          )}
        </section>

        {/* Section 2: CSV Selection & Column Mapping */}
        {activeDataset && csvFiles.length > 0 && (
          <section className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-5 space-y-5">
            <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 pb-3 border-b border-slate-200 dark:border-slate-800">
              <div>
                <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                  02. CSV Selection, Preview &amp; Column Mapping
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  Select a specific split CSV (<span className="font-mono">test.csv</span>,{' '}
                  <span className="font-mono">train.csv</span>, <span className="font-mono">valid.csv</span>) and verify
                  column mappings. Splits are kept strictly separate.
                </p>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {csvFiles.map((csv) => (
                  <button
                    key={csv.path}
                    type="button"
                    onClick={() => setSelectedCsvPath(csv.path)}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md border transition-colors whitespace-nowrap ${
                      selectedCsvPath === csv.path
                        ? 'bg-blue-600 border-blue-600 text-white font-semibold'
                        : 'bg-slate-50 dark:bg-[#162032] border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:border-blue-600'
                    }`}
                  >
                    <FileSpreadsheet className="w-3.5 h-3.5" />
                    <span className="font-mono">{csv.path}</span>
                    <span className="opacity-75 text-[11px]">· {splitBadgeLabel(csv.inferredSplit)}</span>
                  </button>
                ))}
              </div>
            </div>

            {loadingCsv ? (
              <div className="h-36 bg-slate-100 dark:bg-slate-800/40 rounded animate-pulse" />
            ) : csvInspection ? (
              <div className="space-y-5">
                {/* Metadata & Split Summary */}
                <div className="flex flex-wrap items-center gap-3 text-xs text-slate-600 dark:text-slate-400">
                  <span className="font-mono font-semibold text-slate-900 dark:text-slate-100">
                    {csvInspection.csvPath}
                  </span>
                  <span>·</span>
                  <span>{splitBadgeLabel(csvInspection.inferredSplit)}</span>
                  <span>·</span>
                  <span className="font-mono tabular-nums">{csvInspection.rowCount} rows</span>
                  <span>·</span>
                  <span className="font-mono tabular-nums">{csvInspection.columns.length} columns</span>
                </div>

                {/* Column Mapping Controls */}
                <div className="grid md:grid-cols-2 gap-4">
                  <div className="p-4 bg-slate-50 dark:bg-[#162032] border border-slate-200 dark:border-slate-800 rounded-md space-y-2">
                    <label
                      htmlFor="map-path-col"
                      className="block text-xs font-semibold text-slate-900 dark:text-slate-100"
                    >
                      Image Filename / Path Column
                    </label>
                    <select
                      id="map-path-col"
                      value={pathColumn}
                      onChange={(e) => setPathColumn(e.target.value)}
                      className="w-full px-3 py-2 text-xs font-mono rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#0B1120] text-slate-900 dark:text-slate-100"
                    >
                      {csvInspection.columns.map((col) => (
                        <option key={col} value={col}>
                          {col} {col === csvInspection.detectedPathColumn ? '(auto-detected)' : ''}
                        </option>
                      ))}
                    </select>
                    <p className="text-[11px] text-slate-500">
                      Column containing relative paths or filenames inside the uploaded folder.
                    </p>
                  </div>

                  <div className="p-4 bg-slate-50 dark:bg-[#162032] border border-slate-200 dark:border-slate-800 rounded-md space-y-2">
                    <label
                      htmlFor="map-label-col"
                      className="block text-xs font-semibold text-slate-900 dark:text-slate-100"
                    >
                      Ground-Truth Label Column (Real / Fake)
                    </label>
                    <select
                      id="map-label-col"
                      value={labelColumn}
                      onChange={(e) => handleLabelColumnChange(e.target.value)}
                      className="w-full px-3 py-2 text-xs font-mono rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#0B1120] text-slate-900 dark:text-slate-100"
                    >
                      {csvInspection.columns.map((col) => (
                        <option key={col} value={col}>
                          {col} {col === csvInspection.detectedLabelColumn ? '(auto-detected)' : ''}
                        </option>
                      ))}
                    </select>
                    <p className="text-[11px] text-slate-500">
                      Strictly isolated from inference; used only after model predictions complete.
                    </p>
                  </div>
                </div>

                {/* Label Value Mapping */}
                {currentLabelValues.length > 0 && (
                  <div className="p-4 bg-slate-50 dark:bg-[#162032] border border-slate-200 dark:border-slate-800 rounded-md space-y-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                        Available Labels in &ldquo;{labelColumn}&rdquo; ({currentLabelValues.length} distinct)
                      </span>
                      <span className="text-[11px] text-slate-500">
                        Verify how CSV label tokens map to Real vs Fake
                      </span>
                    </div>
                    <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
                      {currentLabelValues.map((item) => {
                        const key = item.rawValue.trim().toLowerCase();
                        const currentVal = labelMap[key] ?? item.suggestedMapping;
                        return (
                          <div
                            key={item.rawValue}
                            className="flex items-center justify-between gap-2 px-3 py-2 bg-white dark:bg-[#0B1120] border border-slate-200 dark:border-slate-800 rounded text-xs"
                          >
                            <div className="min-w-0">
                              <span className="font-mono font-semibold text-slate-900 dark:text-slate-100 truncate">
                                {item.rawValue || '(empty)'}
                              </span>
                              <span className="text-[11px] text-slate-500 ml-1.5 font-mono tabular-nums">
                                ({item.count})
                              </span>
                            </div>
                            <select
                              aria-label={`Map label ${item.rawValue}`}
                              value={currentVal}
                              onChange={(e) =>
                                setLabelMap((prev) => ({
                                  ...prev,
                                  [key]: e.target.value as 'real' | 'fake' | 'unmapped',
                                }))
                              }
                              className="px-2 py-1 text-xs rounded border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-[#162032] text-slate-900 dark:text-slate-100"
                            >
                              <option value="real">Real (Genuine)</option>
                              <option value="fake">Fake (Manipulated)</option>
                              <option value="unmapped">Unmapped (Exclude)</option>
                            </select>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* CSV Preview Table */}
                <div className="border border-slate-200 dark:border-slate-800 rounded-md overflow-hidden">
                  <div className="px-3.5 py-2 bg-slate-50 dark:bg-[#162032] border-b border-slate-200 dark:border-slate-800 text-xs font-semibold text-slate-900 dark:text-slate-100">
                    CSV Preview (First {csvInspection.previewRows.length} of {csvInspection.rowCount} rows)
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-[11px] font-mono">
                      <thead className="bg-slate-50/70 dark:bg-[#162032]/70 text-slate-500 border-b border-slate-200 dark:border-slate-800">
                        <tr>
                          <th className="py-2 px-3">#</th>
                          {csvInspection.columns.map((col) => (
                            <th
                              key={col}
                              className={`py-2 px-3 whitespace-nowrap ${
                                col === pathColumn
                                  ? 'text-blue-700 dark:text-sky-400'
                                  : col === labelColumn
                                  ? 'text-teal-700 dark:text-teal-400'
                                  : ''
                              }`}
                            >
                              {col}
                              {col === pathColumn ? ' [PATH]' : col === labelColumn ? ' [LABEL]' : ''}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                        {csvInspection.previewRows.slice(0, 10).map((row, idx) => (
                          <tr key={idx} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                            <td className="py-1.5 px-3 text-slate-400 tabular-nums">{idx + 1}</td>
                            {csvInspection.columns.map((col) => (
                              <td
                                key={col}
                                className="py-1.5 px-3 text-slate-800 dark:text-slate-200 max-w-[260px] truncate"
                              >
                                {row[col] || <span className="text-rose-500">(empty)</span>}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            ) : null}
          </section>
        )}

        {/* Section 3: Image Matching Diagnostics & Run Trigger */}
        {activeDataset && csvInspection && (
          <section className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-5 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                  03. Image Matching &amp; Integrity Verification
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  Resolves CSV records against uploaded nested folders. Missing files, duplicates, invalid paths, and
                  unsupported formats are explicitly reported and never silently skipped.
                </p>
              </div>
              <button
                type="button"
                disabled={
                  matching ||
                  startingRun ||
                  !matchSummary ||
                  matchSummary.matchedCount === 0 ||
                  activeRun?.status === 'running'
                }
                onClick={() => void handleRunEvaluation()}
                className="inline-flex items-center gap-1.5 px-5 py-2.5 text-xs font-semibold rounded-md bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white transition-colors whitespace-nowrap shrink-0"
              >
                <Play className="w-3.5 h-3.5" />
                {startingRun
                  ? 'Starting Pipeline...'
                  : activeRun?.status === 'running'
                  ? 'Evaluation Running...'
                  : `Run Evaluation (${matchSummary?.matchedCount ?? 0} Matched Images)`}
              </button>
            </div>

            {matching ? (
              <div className="h-24 bg-slate-100 dark:bg-slate-800/40 rounded animate-pulse" />
            ) : matchSummary ? (
              <div className="space-y-4">
                <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2.5">
                  {[
                    { label: 'CSV Rows', value: matchSummary.totalCsvRows, tone: 'text-slate-900 dark:text-slate-100' },
                    { label: 'Matched Valid', value: matchSummary.matchedCount, tone: 'text-teal-700 dark:text-teal-400' },
                    {
                      label: 'Real / Fake GT',
                      value: `${matchSummary.groundTruthBreakdown.real} / ${matchSummary.groundTruthBreakdown.fake}`,
                      tone: 'text-blue-700 dark:text-sky-400',
                    },
                    {
                      label: 'Missing Files',
                      value: matchSummary.missingCount,
                      tone: matchSummary.missingCount > 0 ? 'text-rose-600 dark:text-rose-400' : 'text-slate-500',
                    },
                    {
                      label: 'Duplicates',
                      value: matchSummary.duplicateCount,
                      tone: matchSummary.duplicateCount > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-slate-500',
                    },
                    {
                      label: 'Invalid Paths',
                      value: matchSummary.invalidPathCount,
                      tone: matchSummary.invalidPathCount > 0 ? 'text-rose-600 dark:text-rose-400' : 'text-slate-500',
                    },
                    {
                      label: 'Unsupported',
                      value: matchSummary.unsupportedFormatCount,
                      tone:
                        matchSummary.unsupportedFormatCount > 0
                          ? 'text-amber-600 dark:text-amber-400'
                          : 'text-slate-500',
                    },
                    {
                      label: 'Ambiguous / Unmapped',
                      value: matchSummary.ambiguousCount + matchSummary.unmappedLabelCount,
                      tone:
                        matchSummary.ambiguousCount + matchSummary.unmappedLabelCount > 0
                          ? 'text-amber-600 dark:text-amber-400'
                          : 'text-slate-500',
                    },
                  ].map((item) => (
                    <div
                      key={item.label}
                      className="p-2.5 bg-slate-50 dark:bg-[#162032] border border-slate-200 dark:border-slate-800 rounded-md"
                    >
                      <div className="text-[11px] text-slate-500 truncate">{item.label}</div>
                      <div className={`font-mono tabular-nums text-sm font-semibold mt-0.5 ${item.tone}`}>
                        {item.value}
                      </div>
                    </div>
                  ))}
                </div>

                {matchSummary.unreferencedImagesCount > 0 && (
                  <p className="text-[11px] text-slate-500">
                    Note: <span className="font-mono tabular-nums">{matchSummary.unreferencedImagesCount}</span> image(s)
                    in other folders (e.g. separate train/valid splits) are not referenced by{' '}
                    <span className="font-mono">{matchSummary.csvPath}</span> and are excluded from this evaluation.
                  </p>
                )}

                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-[#162032] rounded-lg w-fit">
                    {(
                      [
                        { id: 'issues', label: `Unmatched / Issues (${matchSummary.unmatchedTotal})` },
                        { id: 'matched', label: `Matched (${matchSummary.matchedCount})` },
                        { id: 'all', label: 'All Inspected' },
                      ] as const
                    ).map((tab) => (
                      <button
                        key={tab.id}
                        type="button"
                        onClick={() => setMatchDiagFilter(tab.id)}
                        className={`px-2.5 py-1 text-xs rounded-md transition-colors whitespace-nowrap ${
                          matchDiagFilter === tab.id
                            ? 'bg-white dark:bg-[#0B1120] text-slate-900 dark:text-slate-100 font-medium shadow-sm'
                            : 'text-slate-600 dark:text-slate-400'
                        }`}
                      >
                        {tab.label}
                      </button>
                    ))}
                  </div>
                </div>

                {visibleDiagnostics.length > 0 ? (
                  <div className="border border-slate-200 dark:border-slate-800 rounded-md overflow-x-auto max-h-64">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-slate-50 dark:bg-[#162032] text-slate-500 border-b border-slate-200 dark:border-slate-800 sticky top-0">
                        <tr>
                          <th className="py-2 px-3 font-medium">CSV Row</th>
                          <th className="py-2 px-3 font-medium">CSV Reference</th>
                          <th className="py-2 px-3 font-medium">Resolved File</th>
                          <th className="py-2 px-3 font-medium">GT Label</th>
                          <th className="py-2 px-3 font-medium">Status</th>
                          <th className="py-2 px-3 font-medium">Diagnostic Detail</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200 dark:divide-slate-800 font-mono text-[11px]">
                        {visibleDiagnostics.slice(0, 150).map((d) => (
                          <tr key={`${d.rowIndex}-${d.csvImageRef}`} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                            <td className="py-1.5 px-3 text-slate-500 tabular-nums">{d.rowIndex}</td>
                            <td className="py-1.5 px-3 text-slate-800 dark:text-slate-200 max-w-[220px] truncate">
                              {d.csvImageRef}
                            </td>
                            <td className="py-1.5 px-3 text-slate-600 dark:text-slate-400 max-w-[240px] truncate">
                              {d.resolvedRelPath || '—'}
                            </td>
                            <td className="py-1.5 px-3 uppercase">{d.mappedLabel}</td>
                            <td className="py-1.5 px-3 uppercase font-semibold">
                              <span
                                className={
                                  d.status === 'matched'
                                    ? 'text-teal-700 dark:text-teal-400'
                                    : d.status === 'duplicate' || d.status === 'unsupported_format' || d.status === 'ambiguous'
                                    ? 'text-amber-600 dark:text-amber-400'
                                    : 'text-rose-600 dark:text-rose-400'
                                }
                              >
                                {d.status}
                              </span>
                            </td>
                            <td className="py-1.5 px-3 font-sans text-slate-600 dark:text-slate-300">{d.detail}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="text-xs text-teal-700 dark:text-teal-400">
                    All {matchSummary.matchedCount} CSV rows matched cleanly with zero missing, duplicate, or invalid
                    records.
                  </p>
                )}
              </div>
            ) : null}
          </section>
        )}

        {/* Section 4: Live Progress & Accuracy Dashboard */}
        {activeRun && (
          <section className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-5 space-y-6">
            <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 pb-4 border-b border-slate-200 dark:border-slate-800">
              <div>
                <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                  <span className="font-mono text-amber-700 dark:text-amber-400 font-medium">
                    Uncalibrated Raw Model Scores (0–100)
                  </span>
                  <span>·</span>
                  <span>Ground Truth Isolated During Inference</span>
                  <span>·</span>
                  <span className="font-mono">{splitBadgeLabel(activeRun.split_label)}</span>
                  <span>·</span>
                  <span className="font-mono uppercase">{activeRun.status}</span>
                </div>
                <h2 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100 mt-1">
                  04. Evaluation Accuracy Dashboard — {activeRun.dataset_name} ({activeRun.csv_path})
                </h2>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {activeRun.status === 'running' ? (
                  <button
                    type="button"
                    disabled={cancellingRun}
                    onClick={() => void handleCancelEvaluation()}
                    className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold rounded-md bg-rose-600 hover:bg-rose-700 disabled:opacity-50 text-white whitespace-nowrap shrink-0"
                  >
                    <Square className="w-3.5 h-3.5" />
                    {cancellingRun ? 'Cancelling...' : 'Cancel Evaluation'}
                  </button>
                ) : (
                  <>
                    <a
                      href={`/api/dataset-eval/runs/${encodeURIComponent(activeRun.id)}/export?format=csv&scope=incorrect`}
                      download
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-rose-300 dark:border-rose-800 text-rose-700 dark:text-rose-300 hover:bg-rose-50 dark:hover:bg-rose-950/30 whitespace-nowrap shrink-0"
                    >
                      <Download className="w-3.5 h-3.5" />
                      Download Incorrect (CSV)
                    </a>
                    <a
                      href={`/api/dataset-eval/runs/${encodeURIComponent(activeRun.id)}/export?format=csv&scope=all`}
                      download
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-slate-300 dark:border-slate-700 text-slate-800 dark:text-slate-100 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
                    >
                      <Download className="w-3.5 h-3.5" />
                      Full Report (CSV)
                    </a>
                    <a
                      href={`/api/dataset-eval/runs/${encodeURIComponent(activeRun.id)}/export?format=json&scope=all`}
                      download
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-slate-300 dark:border-slate-700 text-slate-800 dark:text-slate-100 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
                    >
                      <Download className="w-3.5 h-3.5" />
                      Full Report (JSON)
                    </a>
                  </>
                )}
              </div>
            </div>

            {/* Live Progress Bar when Running */}
            {activeRun.status === 'running' && (
              <div className="p-4 bg-slate-50 dark:bg-[#162032] border border-slate-200 dark:border-slate-800 rounded-md space-y-2.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="inline-flex items-center gap-2 font-medium text-slate-900 dark:text-slate-100">
                    <RefreshCw className="w-3.5 h-3.5 animate-spin text-blue-600 dark:text-sky-400" />
                    Running local TruthLens image forensics &amp; ONNX inference...
                  </span>
                  <span className="font-mono tabular-nums text-slate-700 dark:text-slate-300">
                    {activeRun.processed_count + activeRun.failed_count} / {activeRun.matched_count} ({progressPct}%)
                  </span>
                </div>
                <div className="w-full h-2 bg-slate-200 dark:bg-slate-800 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-blue-600 transition-all duration-200"
                    style={{ width: `${progressPct}%` }}
                  />
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono text-slate-500">
                  <span className="truncate">Current: {activeRun.current_item || 'Preparing...'}</span>
                  <span className="tabular-nums">
                    Processed: {activeRun.processed_count} · Inconclusive: {activeRun.inconclusive_count} · Failed:{' '}
                    {activeRun.failed_count}
                  </span>
                </div>
              </div>
            )}

            {/* Processing Counts Strip */}
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
              {[
                { label: 'Matched Images', value: activeRun.matched_count },
                { label: 'Processed', value: activeRun.processed_count },
                { label: 'Failed Processing', value: activeRun.failed_count },
                { label: 'Inconclusive [40–65)', value: activeRun.inconclusive_count },
                { label: 'Unmatched CSV Rows', value: activeRun.unmatched_count },
              ].map((stat) => (
                <div
                  key={stat.label}
                  className="p-3 bg-slate-50 dark:bg-[#162032] border border-slate-200 dark:border-slate-800 rounded-md"
                >
                  <div className="text-[11px] text-slate-500">{stat.label}</div>
                  <div className="font-mono tabular-nums text-lg font-semibold text-slate-900 dark:text-slate-100 mt-0.5">
                    {stat.value}
                  </div>
                </div>
              ))}
            </div>

            {metricsByModel.length > 0 && activeMetric && (
              <>
                {/* Model Selector */}
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 dark:bg-[#162032] rounded-lg w-fit">
                    {metricsByModel.map((m) => (
                      <button
                        key={m.modelId}
                        type="button"
                        onClick={() => setSelectedModelId(m.modelId)}
                        className={`px-3 py-1.5 text-xs font-mono rounded-md transition-colors whitespace-nowrap ${
                          selectedModelId === m.modelId
                            ? 'bg-white dark:bg-[#0B1120] text-blue-600 dark:text-sky-400 font-semibold shadow-sm'
                            : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                        }`}
                      >
                        {m.modelId}
                      </button>
                    ))}
                  </div>
                  <span className="text-[11px] text-slate-500 font-mono">
                    Raw Score Band: &lt;40 Real · 40–64.9 Inconclusive · ≥65 Fake
                  </span>
                </div>

                {activeMetric.note && (
                  <div className="p-3 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-md text-xs text-amber-800 dark:text-amber-300 flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                    <span>{activeMetric.note}</span>
                  </div>
                )}

                {/* Core Metrics KPI Grid */}
                <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
                  {[
                    {
                      label: 'Overall Accuracy',
                      value: fmtPct(activeMetric.accuracy),
                      sub:
                        activeMetric.inconclusiveCount > 0
                          ? `Decisive (${activeMetric.decisiveCount}/${activeMetric.decisiveCount + activeMetric.inconclusiveCount}) · ${fmtPct(activeMetric.overallAccuracyInclInconclusive)} incl. inc.`
                          : `${activeMetric.confusionMatrix.tp + activeMetric.confusionMatrix.tn} / ${activeMetric.decisiveCount}`,
                    },
                    {
                      label: 'Precision (Fake)',
                      value: fmtPct(activeMetric.precision),
                      sub: `TP ${activeMetric.confusionMatrix.tp} / ${activeMetric.confusionMatrix.tp + activeMetric.confusionMatrix.fp}`,
                    },
                    {
                      label: 'Fake Recall (TPR)',
                      value: fmtPct(activeMetric.fakeRecall),
                      sub:
                        activeMetric.confusionMatrix.inconclusiveFake > 0
                          ? `${fmtPct(activeMetric.fakeRecallOverall)} incl. inc.`
                          : `TP ${activeMetric.confusionMatrix.tp} / ${activeMetric.confusionMatrix.tp + activeMetric.confusionMatrix.fn}`,
                    },
                    {
                      label: 'Genuine Recall (TNR)',
                      value: fmtPct(activeMetric.genuineRecall),
                      sub:
                        activeMetric.confusionMatrix.inconclusiveReal > 0
                          ? `${fmtPct(activeMetric.genuineRecallOverall)} incl. inc.`
                          : `TN ${activeMetric.confusionMatrix.tn} / ${activeMetric.confusionMatrix.tn + activeMetric.confusionMatrix.fp}`,
                    },
                    {
                      label: 'F1-Score',
                      value: fmtPct(activeMetric.f1Score),
                      sub: 'Harmonic mean',
                    },
                    {
                      label: 'False Positive Rate',
                      value: fmtPct(activeMetric.fpr),
                      sub: `FP ${activeMetric.confusionMatrix.fp} / ${activeMetric.confusionMatrix.fp + activeMetric.confusionMatrix.tn}`,
                    },
                    {
                      label: 'False Negative Rate',
                      value: fmtPct(activeMetric.fnr),
                      sub: `FN ${activeMetric.confusionMatrix.fn} / ${activeMetric.confusionMatrix.tp + activeMetric.confusionMatrix.fn}`,
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
                      <div className="text-[10px] font-mono text-slate-500 mt-0.5 truncate">{kpi.sub}</div>
                    </div>
                  ))}
                </div>

                {/* Confusion Matrix + Prediction Distribution + Model Comparison */}
                <div className="grid lg:grid-cols-12 gap-6">
                  {/* Confusion Matrix */}
                  <div className="lg:col-span-5 space-y-2">
                    <h3 className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                      Confusion Matrix ({activeMetric.modelId})
                    </h3>
                    <p className="text-[11px] text-slate-500">
                      Positive = Fake · Negative = Real · Inconclusive = raw score in [40, 65).
                    </p>
                    <div className="border border-slate-200 dark:border-slate-800 rounded-md overflow-hidden text-xs">
                      <table className="w-full text-center">
                        <thead className="bg-slate-50 dark:bg-[#162032] text-[11px] text-slate-500">
                          <tr>
                            <th className="py-2 px-2 text-left">Actual \ Pred</th>
                            <th className="py-2 px-2">Pred: Fake</th>
                            <th className="py-2 px-2">Pred: Real</th>
                            <th className="py-2 px-2">Inconclusive</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-200 dark:divide-slate-800 font-mono tabular-nums">
                          <tr>
                            <td className="py-3 px-2 text-left font-sans font-medium text-slate-700 dark:text-slate-300">
                              Actual: Fake
                            </td>
                            <td className="py-3 px-2 bg-emerald-50/70 dark:bg-emerald-950/30 text-emerald-800 dark:text-emerald-300 font-semibold">
                              TP: {activeMetric.confusionMatrix.tp}
                            </td>
                            <td className="py-3 px-2 bg-rose-50/70 dark:bg-rose-950/30 text-rose-800 dark:text-rose-300 font-semibold">
                              FN: {activeMetric.confusionMatrix.fn}
                            </td>
                            <td className="py-3 px-2 bg-amber-50/60 dark:bg-amber-950/20 text-amber-800 dark:text-amber-300">
                              {activeMetric.confusionMatrix.inconclusiveFake}
                            </td>
                          </tr>
                          <tr>
                            <td className="py-3 px-2 text-left font-sans font-medium text-slate-700 dark:text-slate-300">
                              Actual: Real
                            </td>
                            <td className="py-3 px-2 bg-amber-50/70 dark:bg-amber-950/30 text-amber-800 dark:text-amber-300 font-semibold">
                              FP: {activeMetric.confusionMatrix.fp}
                            </td>
                            <td className="py-3 px-2 bg-emerald-50/70 dark:bg-emerald-950/30 text-emerald-800 dark:text-emerald-300 font-semibold">
                              TN: {activeMetric.confusionMatrix.tn}
                            </td>
                            <td className="py-3 px-2 bg-amber-50/60 dark:bg-amber-950/20 text-amber-800 dark:text-amber-300">
                              {activeMetric.confusionMatrix.inconclusiveReal}
                            </td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                    <div className="text-[11px] font-mono text-slate-500 flex flex-wrap gap-3">
                      <span>
                        Mean Raw (Real):{' '}
                        {activeMetric.meanRawScoreReal !== null
                          ? `${(activeMetric.meanRawScoreReal * 100).toFixed(1)} / 100`
                          : 'N/A'}
                      </span>
                      <span>·</span>
                      <span>
                        Mean Raw (Fake):{' '}
                        {activeMetric.meanRawScoreFake !== null
                          ? `${(activeMetric.meanRawScoreFake * 100).toFixed(1)} / 100`
                          : 'N/A'}
                      </span>
                    </div>
                  </div>

                  {/* Real vs Fake Prediction Distribution */}
                  <div className="lg:col-span-3 space-y-2">
                    <h3 className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                      Real vs Fake Distribution
                    </h3>
                    <p className="text-[11px] text-slate-500">Ground truth vs predicted counts.</p>
                    <div className="h-48">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={predictionDistData} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                          <CartesianGrid stroke={chart.gridStroke} strokeDasharray="3 3" vertical={false} />
                          <XAxis dataKey="category" stroke={chart.axisStroke} fontSize={10} />
                          <YAxis stroke={chart.axisStroke} fontSize={10} allowDecimals={false} />
                          <Tooltip contentStyle={chart.tooltipStyle} />
                          <Legend wrapperStyle={{ fontSize: 10 }} />
                          <Bar dataKey="Actual" fill="#0d9488" radius={[2, 2, 0, 0]} />
                          <Bar dataKey="Predicted" fill="#2563eb" radius={[2, 2, 0, 0]} />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </div>

                  {/* Model-Wise Performance Comparison */}
                  <div className="lg:col-span-4 space-y-2">
                    <h3 className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                      Model-Wise Performance (%)
                    </h3>
                    <p className="text-[11px] text-slate-500">All local image detectors on the same split.</p>
                    <div className="h-48">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={modelComparisonData} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                          <CartesianGrid stroke={chart.gridStroke} strokeDasharray="3 3" vertical={false} />
                          <XAxis dataKey="model" stroke={chart.axisStroke} fontSize={9} />
                          <YAxis stroke={chart.axisStroke} fontSize={10} domain={[0, 100]} unit="%" />
                          <Tooltip contentStyle={chart.tooltipStyle} />
                          <Legend wrapperStyle={{ fontSize: 10 }} />
                          <Bar dataKey="Accuracy" fill="#2563eb" radius={[2, 2, 0, 0]} />
                          <Bar dataKey="F1" fill="#0d9488" radius={[2, 2, 0, 0]} />
                          <Bar dataKey="FakeRecall" name="Fake Recall" fill="#d97706" radius={[2, 2, 0, 0]} />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                </div>

                {/* Model-Wise Summary Table */}
                <div className="border border-slate-200 dark:border-slate-800 rounded-md overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-slate-50 dark:bg-[#162032] text-slate-500 border-b border-slate-200 dark:border-slate-800">
                      <tr>
                        <th className="py-2.5 px-3 font-medium">Model</th>
                        <th className="py-2.5 px-3 font-medium text-right">Decisive / Total</th>
                        <th className="py-2.5 px-3 font-medium text-right">Accuracy</th>
                        <th className="py-2.5 px-3 font-medium text-right">Precision</th>
                        <th className="py-2.5 px-3 font-medium text-right">Fake Recall</th>
                        <th className="py-2.5 px-3 font-medium text-right">Genuine Recall</th>
                        <th className="py-2.5 px-3 font-medium text-right">F1</th>
                        <th className="py-2.5 px-3 font-medium text-right">FPR</th>
                        <th className="py-2.5 px-3 font-medium text-right">FNR</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200 dark:divide-slate-800 font-mono tabular-nums">
                      {metricsByModel.map((m) => (
                        <tr
                          key={m.modelId}
                          onClick={() => setSelectedModelId(m.modelId)}
                          className={`cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/40 ${
                            selectedModelId === m.modelId ? 'bg-blue-50/50 dark:bg-blue-950/20' : ''
                          }`}
                        >
                          <td className="py-2.5 px-3 font-semibold text-slate-900 dark:text-slate-100">{m.modelId}</td>
                          <td className="py-2.5 px-3 text-right">
                            {m.decisiveCount} / {m.totalEvaluated}
                          </td>
                          <td className="py-2.5 px-3 text-right font-semibold">{fmtPct(m.accuracy)}</td>
                          <td className="py-2.5 px-3 text-right">{fmtPct(m.precision)}</td>
                          <td className="py-2.5 px-3 text-right">{fmtPct(m.fakeRecall)}</td>
                          <td className="py-2.5 px-3 text-right">{fmtPct(m.genuineRecall)}</td>
                          <td className="py-2.5 px-3 text-right">{fmtPct(m.f1Score)}</td>
                          <td className="py-2.5 px-3 text-right text-amber-700 dark:text-amber-400">{fmtPct(m.fpr)}</td>
                          <td className="py-2.5 px-3 text-right text-rose-600 dark:text-rose-400">{fmtPct(m.fnr)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}

            {/* Per-Image Prediction Table */}
            <div className="space-y-3 pt-2">
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
                <div>
                  <h3 className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                    Per-Image Predictions &amp; Error Audit ({filteredResults.length} rows)
                  </h3>
                  <p className="text-[11px] text-slate-500">
                    Raw scores are uncalibrated model outputs (0.0–100.0), not probabilities. Scores in [40.0, 65.0) are
                    marked Inconclusive.
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <div className="relative">
                    <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-2 pointer-events-none" />
                    <input
                      type="search"
                      value={resultSearch}
                      onChange={(e) => setResultSearch(e.target.value)}
                      placeholder="Filter filename or path..."
                      className="pl-8 pr-3 py-1.5 text-xs rounded-md border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-[#0B1120] text-slate-900 dark:text-slate-100"
                    />
                  </div>
                  <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-[#162032] rounded-lg">
                    {(
                      [
                        { id: 'all', label: 'All' },
                        { id: 'incorrect', label: 'Incorrect (FP/FN/Failed)' },
                        { id: 'inconclusive', label: 'Inconclusive' },
                        { id: 'issues', label: 'All Issues & Unmatched' },
                      ] as const
                    ).map((tab) => (
                      <button
                        key={tab.id}
                        type="button"
                        onClick={() => setResultFilter(tab.id)}
                        className={`px-2.5 py-1 text-xs rounded-md transition-colors whitespace-nowrap ${
                          resultFilter === tab.id
                            ? 'bg-white dark:bg-[#0B1120] text-slate-900 dark:text-slate-100 font-medium shadow-sm'
                            : 'text-slate-600 dark:text-slate-400'
                        }`}
                      >
                        {tab.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="border border-slate-200 dark:border-slate-800 rounded-md overflow-x-auto max-h-[460px]">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-50 dark:bg-[#162032] text-slate-500 border-b border-slate-200 dark:border-slate-800 sticky top-0">
                    <tr>
                      <th className="py-2.5 px-3 font-medium">Row</th>
                      <th className="py-2.5 px-3 font-medium">Filename &amp; Path</th>
                      <th className="py-2.5 px-3 font-medium">Actual Label</th>
                      <th className="py-2.5 px-3 font-medium">Predicted Label</th>
                      <th className="py-2.5 px-3 font-medium text-right">Raw Score (Uncalibrated)</th>
                      <th className="py-2.5 px-3 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                    {filteredResults.slice(0, 300).map((r) => {
                      const statusLabel =
                        r.status === 'evaluated'
                          ? r.correct === 1
                            ? r.ground_truth_label === 'fake'
                              ? 'Correct (TP)'
                              : 'Correct (TN)'
                            : r.ground_truth_label === 'real'
                            ? 'Incorrect (FP)'
                            : 'Incorrect (FN)'
                          : r.status === 'inconclusive'
                          ? 'Inconclusive'
                          : r.status === 'failed'
                          ? 'Failed Processing'
                          : `Unmatched (${r.status})`;

                      const statusClass =
                        r.correct === 1
                          ? 'text-emerald-700 dark:text-emerald-400'
                          : r.status === 'inconclusive'
                          ? 'text-amber-700 dark:text-amber-400'
                          : 'text-rose-700 dark:text-rose-400';

                      return (
                        <tr key={r.id} className="hover:bg-slate-50/70 dark:hover:bg-slate-800/30 align-top">
                          <td className="py-2.5 px-3 font-mono text-[11px] text-slate-500 tabular-nums">
                            {r.row_index}
                          </td>
                          <td className="py-2.5 px-3">
                            <div className="font-mono font-medium text-slate-900 dark:text-slate-100">{r.filename}</div>
                            <div className="font-mono text-[11px] text-slate-500 truncate max-w-[320px]">
                              {r.resolved_rel_path || r.csv_image_ref}
                            </div>
                            {r.error_detail && (
                              <div className="text-[11px] text-rose-600 dark:text-rose-400 mt-0.5">{r.error_detail}</div>
                            )}
                          </td>
                          <td className="py-2.5 px-3 font-mono uppercase whitespace-nowrap">
                            <span
                              className={
                                r.ground_truth_label === 'fake'
                                  ? 'text-rose-700 dark:text-rose-400 font-semibold'
                                  : r.ground_truth_label === 'real'
                                  ? 'text-teal-700 dark:text-teal-400 font-semibold'
                                  : 'text-slate-500'
                              }
                            >
                              {r.ground_truth_label}
                            </span>
                          </td>
                          <td className="py-2.5 px-3 font-mono uppercase whitespace-nowrap text-slate-800 dark:text-slate-200">
                            {r.predicted_label}
                          </td>
                          <td className="py-2.5 px-3 text-right font-mono tabular-nums whitespace-nowrap">
                            {r.raw_score !== null ? (
                              <>
                                <span className="text-slate-900 dark:text-slate-100">
                                  {(r.raw_score * 100).toFixed(1)} / 100
                                </span>
                                <div className="text-[10px] text-amber-700 dark:text-amber-400">uncalibrated</div>
                              </>
                            ) : (
                              <span className="text-slate-400">—</span>
                            )}
                          </td>
                          <td className={`py-2.5 px-3 font-mono text-[11px] font-semibold whitespace-nowrap ${statusClass}`}>
                            {statusLabel}
                          </td>
                        </tr>
                      );
                    })}
                    {filteredResults.length === 0 && (
                      <tr>
                        <td colSpan={6} className="py-6 text-center text-xs text-slate-500">
                          No matching records for the active filter.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              {filteredResults.length > 300 && (
                <p className="text-[11px] text-slate-500">
                  Showing first 300 rows in table; export CSV/JSON above to inspect all {filteredResults.length} records.
                </p>
              )}
            </div>
          </section>
        )}

        {/* Section 5: Persisted Evaluation History */}
        {runs.length > 0 && (
          <section className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-5 space-y-3">
            <div>
              <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                Persisted Evaluation History
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                All dataset evaluations and computed metrics are persisted in SQLite. Select any run to inspect or export.
              </p>
            </div>
            <div className="border border-slate-200 dark:border-slate-800 rounded-md overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50 dark:bg-[#162032] text-slate-500 border-b border-slate-200 dark:border-slate-800">
                  <tr>
                    <th className="py-2 px-3 font-medium">Run ID</th>
                    <th className="py-2 px-3 font-medium">Dataset &amp; CSV</th>
                    <th className="py-2 px-3 font-medium">Split</th>
                    <th className="py-2 px-3 font-medium text-right">Processed / Matched</th>
                    <th className="py-2 px-3 font-medium text-right">Primary Accuracy</th>
                    <th className="py-2 px-3 font-medium">Status</th>
                    <th className="py-2 px-3 font-medium text-right">Started</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                  {runs.map((r) => {
                    let primaryAcc = '—';
                    try {
                      const ms = JSON.parse(r.metrics_by_model_json || '[]') as DatasetEvalModelMetrics[];
                      const p = ms.find((m) => m.modelId === r.primary_model_id) || ms[0];
                      if (p) primaryAcc = fmtPct(p.accuracy);
                    } catch {
                      // ignore
                    }
                    return (
                      <tr
                        key={r.id}
                        onClick={() => void handleSelectRun(r.id)}
                        className={`cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/40 ${
                          activeRun?.id === r.id ? 'bg-blue-50/60 dark:bg-blue-950/20' : ''
                        }`}
                      >
                        <td className="py-2 px-3 font-mono text-[11px] text-blue-700 dark:text-sky-400">{r.id}</td>
                        <td className="py-2 px-3">
                          <span className="font-medium text-slate-900 dark:text-slate-100">{r.dataset_name}</span>
                          <span className="text-slate-500 font-mono ml-1.5 text-[11px]">{r.csv_path}</span>
                        </td>
                        <td className="py-2 px-3 text-slate-600 dark:text-slate-400">{splitBadgeLabel(r.split_label)}</td>
                        <td className="py-2 px-3 text-right font-mono tabular-nums">
                          {r.processed_count} / {r.matched_count}
                        </td>
                        <td className="py-2 px-3 text-right font-mono tabular-nums font-semibold">{primaryAcc}</td>
                        <td className="py-2 px-3 font-mono uppercase text-[11px]">{r.status}</td>
                        <td className="py-2 px-3 text-right font-mono tabular-nums text-[11px] text-slate-500">
                          {new Date(r.started_at).toLocaleString()}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>
    </ConsoleShell>
  );
};
