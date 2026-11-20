import {
  AgentExecutionRow,
  AuditLogRow,
  CopilotMessage,
  CorrelationRow,
  CsvInspectionResult,
  DatasetEvalResultRow,
  DatasetEvalRunRow,
  DatasetMatchSummary,
  DatasetUploadRow,
  EvidenceItem,
  ForensicAnalysisRow,
  Investigation,
  ModelEvaluationRow,
  ModelPredictionRow,
  ModelRegistryRow,
  ModelValidationMetrics,
  PipelineJobState,
  ValidationDatasetSource,
  ValidationResultRow,
  ValidationRunRow,
  WorkspaceBundle,
} from '../types/forensics.ts';

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as { error?: string }).error || `Request failed (${res.status})`);
  }
  return data as T;
}

export interface DashboardPayload {
  metrics: {
    totalInvestigations: number;
    totalEvidence: number;
    suspiciousIndicators: number;
    reviewRequiredCount: number;
    avgDatasetQuality?: number | null;
  };
  indicatorSeverityBreakdown?: Array<{ severity: string; count: number }>;
  modalityDistribution: Array<{ modality: string; count: number }>;
  statusDistribution: Array<{ status: string; count: number }>;
  recentInvestigations: Investigation[];
  recentAgents: AgentExecutionRow[];
  recentAudit: AuditLogRow[];
  predictionTimeline: Array<{
    created_at: string;
    raw_score: number;
    prediction_label: string;
    model_id: string;
    original_filename: string;
    modality: string;
  }>;
  datasetQualityTimeline?: Array<{
    filename: string;
    beforeScore: number;
    afterScore: number;
    missingBefore: number;
    duplicatesBefore: number;
    analyzedAt: string;
  }>;
  systemHealth?: {
    geminiConfigured: boolean;
    ffmpegAvailable: boolean;
    ffprobeAvailable: boolean;
    pretrainedModels: {
      vitAvailable: boolean;
      aasistAvailable: boolean;
      faceDetectorAvailable?: boolean;
      vitPath: string;
      aasistPath: string;
      faceDetectorPath?: string;
    };
  };
}

export const api = {
  getDashboard: () => apiJson<DashboardPayload>('/api/dashboard'),

  listInvestigations: (q = '', status = 'all') =>
    apiJson<{ investigations: Investigation[] }>(
      `/api/investigations?q=${encodeURIComponent(q)}&status=${encodeURIComponent(status)}`,
    ),

  createInvestigation: (payload: { title: string; description: string; investigatorNotes?: string }) =>
    apiJson<{ investigation: Investigation }>('/api/investigations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),

  getWorkspace: (id: string) => apiJson<WorkspaceBundle>(`/api/investigations/${encodeURIComponent(id)}`),

  updateInvestigation: (
    id: string,
    payload: { status?: string; investigator_notes?: string; confidence_level?: string },
  ) =>
    apiJson<{ investigation: Investigation }>(`/api/investigations/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),

  uploadEvidenceWithProgress: (
    investigationId: string,
    files: File[],
    contextNote: string,
    onProgress: (pct: number) => void,
  ): Promise<{ evidence: unknown[] }> =>
    new Promise((resolve, reject) => {
      const form = new FormData();
      files.forEach((f) => form.append('files', f));
      form.append('contextNote', contextNote);

      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api/investigations/${encodeURIComponent(investigationId)}/evidence`);
      xhr.upload.onprogress = (evt) => {
        if (evt.lengthComputable) {
          onProgress(Math.round((evt.loaded / evt.total) * 100));
        }
      };
      xhr.onload = () => {
        try {
          const json = JSON.parse(xhr.responseText || '{}');
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve(json);
          } else {
            reject(new Error(json.error || `Upload failed (${xhr.status})`));
          }
        } catch {
          reject(new Error('Invalid server response during upload'));
        }
      };
      xhr.onerror = () => reject(new Error('Network error during evidence upload'));
      xhr.send(form);
    }),

  ingestTextEvidence: (
    investigationId: string,
    payload: { filename: string; format: 'txt' | 'json' | 'srt' | 'csv' | 'tsv'; content: string; contextNote: string },
  ) =>
    apiJson<{ evidence: unknown }>(`/api/investigations/${encodeURIComponent(investigationId)}/text-evidence`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),

  deleteEvidence: (evidenceId: string, investigationId?: string) =>
    apiJson<{ deleted: boolean }>(
      `/api/evidence/${encodeURIComponent(evidenceId)}${
        investigationId ? `?investigationId=${encodeURIComponent(investigationId)}` : ''
      }`,
      { method: 'DELETE' },
    ),

  verifyEvidenceHash: (evidenceId: string, investigationId?: string) =>
    apiJson<{ evidenceId: string; expectedHash: string; actualHash: string; verified: boolean }>(
      `/api/evidence/${encodeURIComponent(evidenceId)}/verify${
        investigationId ? `?investigationId=${encodeURIComponent(investigationId)}` : ''
      }`,
    ),

  getEvidenceDetail: (evidenceId: string, investigationId?: string) =>
    apiJson<{
      evidence: EvidenceItem;
      investigation: { id: string; case_code: string; title: string; status: string };
      analysis: ForensicAnalysisRow | null;
      predictions: ModelPredictionRow[];
      correlations: CorrelationRow[];
    }>(
      `/api/evidence/${encodeURIComponent(evidenceId)}${
        investigationId ? `?investigationId=${encodeURIComponent(investigationId)}` : ''
      }`,
    ),

  runAnalysis: (investigationId: string) =>
    apiJson<{
      status: string;
      agentsExecuted: number;
      correlationsCreated: number;
      geminiUsed: boolean;
      geminiError?: string;
      rawMediaSent?: boolean;
      failedAgents?: Array<{ agent: string; error: string }>;
    }>(`/api/investigations/${encodeURIComponent(investigationId)}/analyze`, { method: 'POST' }),

  runAnalysisAsync: (investigationId: string) =>
    apiJson<{ status: string; job: PipelineJobState }>(
      `/api/investigations/${encodeURIComponent(investigationId)}/analyze?async=true`,
      { method: 'POST' },
    ),

  getAnalysisStatus: (investigationId: string) =>
    apiJson<{ investigationStatus: string; job: PipelineJobState | null }>(
      `/api/investigations/${encodeURIComponent(investigationId)}/analyze/status`,
    ),

  cancelAnalysis: (investigationId: string) =>
    apiJson<{ cancelled: boolean; job: PipelineJobState | null }>(
      `/api/investigations/${encodeURIComponent(investigationId)}/analyze/cancel`,
      { method: 'POST' },
    ),

  getCopilot: (investigationId: string) =>
    apiJson<{ conversation: { id: string }; messages: CopilotMessage[]; geminiConfigured: boolean }>(
      `/api/investigations/${encodeURIComponent(investigationId)}/copilot`,
    ),

  askCopilot: (investigationId: string, question: string) =>
    apiJson<{
      userMessage: CopilotMessage;
      assistantMessage: CopilotMessage;
      geminiUsed: boolean;
      error?: string;
    }>(`/api/investigations/${encodeURIComponent(investigationId)}/copilot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question }),
    }),

  updateReportConclusion: (reportId: string, humanConclusion: string) =>
    apiJson<{ report: unknown }>(`/api/reports/${encodeURIComponent(reportId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ humanConclusion }),
    }),

  getAgents: () => apiJson<{ executions: AgentExecutionRow[] }>('/api/agents'),

  getModels: () => apiJson<{ models: ModelRegistryRow[]; evaluations: ModelEvaluationRow[] }>('/api/models'),

  getValidationState: () =>
    apiJson<{
      benchmark: {
        collectionId: string;
        name: string;
        description: string;
        totalSamples: number;
        sources: ValidationDatasetSource[];
        items: Array<{
          id: string;
          modality: 'image' | 'video' | 'audio';
          filename: string;
          groundTruthLabel: 'real' | 'fake';
          sourceDataset: string;
          sourceLicense: string;
          fileSizeBytes: number;
        }>;
      } | null;
      devBenchmark: {
        collectionId: string;
        name: string;
        description: string;
        totalSamples: number;
        sources: ValidationDatasetSource[];
        items: Array<{
          id: string;
          modality: 'image' | 'video' | 'audio';
          filename: string;
          groundTruthLabel: 'real' | 'fake';
          sourceDataset: string;
          sourceLicense: string;
          fileSizeBytes: number;
        }>;
      } | null;
      audioBenchmark: {
        collectionId: string;
        name: string;
        description: string;
        totalSamples: number;
        sources: ValidationDatasetSource[];
        items: Array<{
          id: string;
          modality: 'image' | 'video' | 'audio';
          filename: string;
          groundTruthLabel: 'real' | 'fake';
          sourceDataset: string;
          sourceLicense: string;
          fileSizeBytes: number;
        }>;
      } | null;
      baselineRunId?: string;
      runs: ValidationRunRow[];
      latestResults: ValidationResultRow[];
    }>('/api/validation'),

  runBenchmarkValidation: (
    threshold = 0.5,
    runAsync = true,
    collection: 'held_out' | 'dev' | 'audio' = 'held_out',
  ) =>
    apiJson<{
      run: ValidationRunRow;
      results: ValidationResultRow[];
      metricsByModel: ModelValidationMetrics[];
    }>('/api/validation/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threshold, async: runAsync, collection }),
    }),

  runCustomValidation: async (
    files: File[],
    labels: Array<'real' | 'fake'>,
    threshold: number,
    sourceNote: string,
    licenseNote: string,
  ) => {
    const form = new FormData();
    files.forEach((f) => form.append('files', f));
    form.append('labels', JSON.stringify(labels));
    form.append('threshold', String(threshold));
    form.append('sourceNote', sourceNote);
    form.append('licenseNote', licenseNote);
    return apiJson<{
      run: ValidationRunRow;
      results: ValidationResultRow[];
      metricsByModel: ModelValidationMetrics[];
    }>('/api/validation/custom', {
      method: 'POST',
      body: form,
    });
  },

  getValidationRun: (runId: string) =>
    apiJson<{ run: ValidationRunRow; results: ValidationResultRow[] }>(
      `/api/validation/runs/${encodeURIComponent(runId)}`,
    ),

  getSettings: () =>
    apiJson<{
      user: {
        id: string;
        name: string;
        email: string;
        role: string;
        avatar_url: string;
        preferences_json: string;
      };
      system: {
        geminiConfigured: boolean;
        geminiModel: string;
        runtime: string;
        ffmpegAvailable: boolean;
        ffprobeAvailable?: boolean;
        storageUsedBytes: number;
        maxUploadBytes: number;
        pretrainedModels?: {
          vitAvailable: boolean;
          aasistAvailable: boolean;
          faceDetectorAvailable?: boolean;
          vitPath: string;
          aasistPath: string;
          faceDetectorPath?: string;
        };
      };
      auditLogs: AuditLogRow[];
    }>('/api/settings'),

  updateSettings: (payload: {
    name?: string;
    role?: string;
    preferences?: { retainDays: number; sendRawMediaToGemini: boolean; showConfidenceBounds: boolean };
  }) =>
    apiJson<{ user: unknown }>('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),

  clearAllSessions: () =>
    apiJson<{ cleared: boolean }>('/api/system/clear-sessions', {
      method: 'POST',
    }),

  listDatasetUploads: () =>
    apiJson<{ datasets: DatasetUploadRow[]; runs: DatasetEvalRunRow[] }>('/api/dataset-eval/datasets'),

  initDatasetUpload: (name: string) =>
    apiJson<{ dataset: DatasetUploadRow }>('/api/dataset-eval/datasets/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }),

  uploadDatasetBatch: async (
    datasetId: string,
    entries: Array<{ file: File; relativePath: string }>,
  ): Promise<{ datasetId: string; acceptedCount: number; skippedUnsupportedCount: number }> => {
    const form = new FormData();
    form.append('relativePaths', JSON.stringify(entries.map((e) => e.relativePath)));
    entries.forEach((e) => form.append('files', e.file, e.file.name));
    return apiJson<{ datasetId: string; acceptedCount: number; skippedUnsupportedCount: number }>(
      `/api/dataset-eval/datasets/${encodeURIComponent(datasetId)}/files`,
      { method: 'POST', body: form },
    );
  },

  finalizeDatasetUpload: (datasetId: string) =>
    apiJson<{ dataset: DatasetUploadRow }>(
      `/api/dataset-eval/datasets/${encodeURIComponent(datasetId)}/finalize`,
      { method: 'POST' },
    ),

  deleteDatasetUpload: (datasetId: string) =>
    apiJson<{ deleted: boolean; id: string }>(`/api/dataset-eval/datasets/${encodeURIComponent(datasetId)}`, {
      method: 'DELETE',
    }),

  inspectDatasetCsv: (datasetId: string, csvPath: string) =>
    apiJson<CsvInspectionResult>(
      `/api/dataset-eval/datasets/${encodeURIComponent(datasetId)}/csv?path=${encodeURIComponent(csvPath)}`,
    ),

  matchDatasetCsv: (
    datasetId: string,
    payload: {
      csvPath: string;
      pathColumn: string;
      labelColumn: string;
      labelMap?: Record<string, 'real' | 'fake' | 'unmapped'>;
    },
  ) =>
    apiJson<DatasetMatchSummary>(`/api/dataset-eval/datasets/${encodeURIComponent(datasetId)}/match`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),

  startDatasetEvaluation: (payload: {
    datasetId: string;
    csvPath: string;
    pathColumn: string;
    labelColumn: string;
    labelMap?: Record<string, 'real' | 'fake' | 'unmapped'>;
  }) =>
    apiJson<{ run: DatasetEvalRunRow }>('/api/dataset-eval/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),

  getDatasetEvalRun: (runId: string) =>
    apiJson<{ run: DatasetEvalRunRow; results: DatasetEvalResultRow[] }>(
      `/api/dataset-eval/runs/${encodeURIComponent(runId)}`,
    ),

  cancelDatasetEvaluation: (runId: string) =>
    apiJson<{ cancelled: boolean; run: DatasetEvalRunRow }>(
      `/api/dataset-eval/runs/${encodeURIComponent(runId)}/cancel`,
      { method: 'POST' },
    ),
};
