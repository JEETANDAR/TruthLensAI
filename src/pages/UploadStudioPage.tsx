import React, { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { CheckCircle2, FileWarning, FolderPlus, Play, UploadCloud, X } from 'lucide-react';
import { ConsoleShell, formatBytes } from '../components/ConsoleShell.tsx';
import { WorkflowStepper } from '../components/WorkflowStepper.tsx';
import { api } from '../services/api.ts';
import { getActiveCaseId, getDrafts, loadWorkspaceSnapshot, updateDrafts } from '../services/sessionStorage.ts';

const ALLOWED_EXTS = [
  '.csv',
  '.tsv',
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.mp4',
  '.mov',
  '.wav',
  '.mp3',
  '.flac',
  '.ogg',
  '.m4a',
  '.txt',
  '.json',
  '.srt',
];
const MAX_MB = 50;

interface QueuedFile {
  file: File;
  sha256Preview: string;
  valid: boolean;
  error?: string;
}

async function computeBrowserSha256(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export const UploadStudioPage: React.FC = () => {
  const { id } = useParams();
  const caseId = id && id !== 'none' ? id : getActiveCaseId();
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [queue, setQueue] = useState<QueuedFile[]>([]);
  const [contextNote, setContextNote] = useState(() => getDrafts().uploadContextNote);
  const [progress, setProgress] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [uploadedOk, setUploadedOk] = useState(false);

  useEffect(() => {
    updateDrafts((prev) => ({ ...prev, uploadContextNote: contextNote }));
  }, [contextNote]);

  const stageFiles = async (fileList: FileList | File[]) => {
    setUploadError('');
    setUploadedOk(false);
    const items = Array.from(fileList);
    const staged: QueuedFile[] = [];
    for (const file of items) {
      const ext = '.' + (file.name.split('.').pop() || '').toLowerCase();
      if (!ALLOWED_EXTS.includes(ext)) {
        staged.push({ file, sha256Preview: '—', valid: false, error: `Unsupported extension (${ext})` });
        continue;
      }
      if (file.size > MAX_MB * 1024 * 1024) {
        staged.push({ file, sha256Preview: '—', valid: false, error: `Exceeds ${MAX_MB} MB limit` });
        continue;
      }
      const hash = await computeBrowserSha256(file);
      staged.push({ file, sha256Preview: hash, valid: true });
    }
    setQueue((prev) => [...prev, ...staged]);
  };

  const handleUpload = async (andAnalyze = false) => {
    if (!caseId) return;
    const validFiles = queue.filter((q) => q.valid).map((q) => q.file);
    if (validFiles.length === 0) {
      setUploadError('Select at least one valid dataset or media file.');
      return;
    }
    setUploading(true);
    setUploadError('');
    setProgress(0);
    try {
      await api.uploadEvidenceWithProgress(caseId, validFiles, contextNote, setProgress);
      setUploadedOk(true);
      setQueue([]);
      setContextNote('');
      if (andAnalyze) {
        setAnalyzing(true);
        await api.runAnalysis(caseId);
        navigate(`/investigations/${caseId}/reports`);
      }
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
      setAnalyzing(false);
    }
  };

  const cachedBundle = caseId ? loadWorkspaceSnapshot(caseId) : null;

  return (
    <ConsoleShell
      title="Evidence & Dataset Upload Studio"
      subtitle={
        caseId
          ? `Investigation ${caseId} · Client SHA-256 pre-hashing, file validation, and immutable ingest`
          : 'Create or select an active investigation to upload evidence and datasets'
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
            Start a new investigation from the sidebar or dashboard before uploading evidence files.
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
          <WorkflowStepper caseId={caseId} bundle={cachedBundle} />
          <div className="max-w-4xl space-y-6">
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              if (e.dataTransfer.files.length) stageFiles(e.dataTransfer.files);
            }}
            className={`border-2 border-dashed rounded-lg p-10 text-center transition-colors duration-150 ${
              dragging
                ? 'border-blue-600 dark:border-sky-400 bg-blue-50 dark:bg-blue-950/30'
                : 'border-slate-300 dark:border-slate-700 bg-white dark:bg-[#111827] hover:border-blue-500 dark:hover:border-sky-400/60'
            }`}
          >
            <UploadCloud className="w-8 h-8 text-blue-600 dark:text-sky-400 mx-auto mb-3" />
            <p className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
              Drag and drop datasets or media files here
            </p>
            <p className="text-xs text-slate-600 dark:text-slate-400 mt-1.5">
              Supported: CSV, TSV, JPG, JPEG, PNG, WEBP, MP4, MOV, WAV, MP3, FLAC, OGG, M4A, TXT, JSON, SRT (max {MAX_MB} MB per file)
            </p>
            <input
              ref={inputRef}
              type="file"
              multiple
              accept={ALLOWED_EXTS.join(',')}
              onChange={(e) => e.target.files && stageFiles(e.target.files)}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className="mt-5 px-4 py-2 text-xs font-medium bg-slate-100 dark:bg-[#162032] border border-slate-300 dark:border-slate-700 hover:border-blue-600 dark:hover:border-sky-400 text-slate-900 dark:text-slate-100 rounded-md transition-colors"
            >
              Browse Local Files
            </button>
          </div>

          <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-5 space-y-3">
            <label htmlFor="ev-context" className="block text-xs font-medium text-slate-900 dark:text-slate-100">
              Contextual Source &amp; Chain-of-Custody Note (Auto-saved)
            </label>
            <textarea
              id="ev-context"
              rows={2}
              value={contextNote}
              onChange={(e) => setContextNote(e.target.value)}
              placeholder="Where was this dataset or media file obtained? What schema or provenance should be verified?"
              className="w-full bg-slate-50 dark:bg-[#162032] border border-slate-300 dark:border-slate-700 rounded-md p-2.5 text-xs text-slate-900 dark:text-slate-100 focus:outline-none focus:border-blue-600 dark:focus:border-sky-400"
            />
          </div>

          {queue.length > 0 && (
            <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
              <div className="px-5 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between text-xs">
                <span className="font-semibold text-slate-900 dark:text-slate-100">
                  Staged Files ({queue.length})
                </span>
                <button
                  type="button"
                  onClick={() => setQueue([])}
                  className="text-slate-500 hover:text-slate-900 dark:hover:text-white"
                >
                  Clear Queue
                </button>
              </div>
              <div className="divide-y divide-slate-200 dark:divide-slate-800">
                {queue.map((item, idx) => (
                  <div key={`${item.file.name}-${idx}`} className="px-5 py-3 flex items-center justify-between gap-4 text-xs">
                    <div className="min-w-0">
                      <p className="font-medium text-slate-900 dark:text-slate-100 truncate">{item.file.name}</p>
                      <p className="font-mono text-[11px] text-slate-500 mt-0.5 truncate">
                        {formatBytes(item.file.size)} · SHA-256: {item.sha256Preview.slice(0, 24)}…
                      </p>
                      {!item.valid && <p className="text-rose-600 dark:text-rose-400 mt-0.5">{item.error}</p>}
                    </div>
                    <button
                      type="button"
                      onClick={() => setQueue((q) => q.filter((_, i) => i !== idx))}
                      className="text-slate-400 hover:text-slate-900 dark:hover:text-white"
                      aria-label="Remove staged file"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {(uploading || analyzing) && (
            <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-4 space-y-2">
              <div className="flex justify-between text-xs">
                <span className="text-slate-700 dark:text-slate-300">
                  {analyzing ? 'Running full profiling, cleaning & forensic analysis pipeline...' : 'Uploading & verifying SHA-256 on server...'}
                </span>
                <span className="font-mono text-blue-600 dark:text-sky-400 tabular-nums">{progress}%</span>
              </div>
              <div className="h-1.5 bg-slate-200 dark:bg-slate-800 rounded overflow-hidden">
                <div className="h-full bg-blue-600 transition-all" style={{ width: `${progress}%` }} />
              </div>
            </div>
          )}

          {uploadError && (
            <div className="p-4 bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-700 rounded-lg flex items-center gap-2 text-xs text-rose-700 dark:text-rose-300">
              <FileWarning className="w-4 h-4 shrink-0" />
              <span>{uploadError}</span>
            </div>
          )}

          {uploadedOk && (
            <div className="p-4 bg-teal-50 dark:bg-teal-950/30 border border-teal-200 dark:border-teal-700 rounded-lg flex flex-wrap items-center justify-between gap-2 text-xs text-teal-800 dark:text-teal-300">
              <span className="flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4" />
                Files ingested cleanly with verified SHA-256 digests.
              </span>
              <button
                type="button"
                onClick={() => navigate(`/investigations/${caseId}`)}
                className="underline font-semibold"
              >
                Open Investigation Workspace
              </button>
            </div>
          )}

          <div className="flex flex-wrap justify-end gap-3">
            <button
              type="button"
              onClick={() => navigate(`/investigations/${caseId}`)}
              className="px-4 py-2 text-xs font-medium bg-white dark:bg-[#111827] border border-slate-300 dark:border-slate-700 rounded-md text-slate-700 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white whitespace-nowrap"
            >
              Back to Workspace
            </button>
            <button
              type="button"
              disabled={uploading || analyzing || queue.filter((q) => q.valid).length === 0}
              onClick={() => handleUpload(false)}
              className="px-4 py-2 text-xs font-medium bg-slate-900 hover:bg-slate-800 dark:bg-[#1E293B] dark:hover:bg-slate-700 disabled:opacity-50 text-white rounded-md whitespace-nowrap"
            >
              Upload Files Only
            </button>
            <button
              type="button"
              disabled={uploading || analyzing || queue.filter((q) => q.valid).length === 0}
              onClick={() => handleUpload(true)}
              className="inline-flex items-center gap-1.5 px-5 py-2 text-xs font-semibold bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-md whitespace-nowrap"
            >
              <Play className="w-3.5 h-3.5" />
              {analyzing ? 'Analyzing...' : 'Upload, Analyze & Generate Report'}
            </button>
          </div>
        </div>
        </>
      )}
    </ConsoleShell>
  );
};
