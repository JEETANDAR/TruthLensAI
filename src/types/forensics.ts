export type Modality = 'image' | 'video' | 'audio' | 'text' | 'dataset';

export interface DatasetColumnProfile {
  name: string;
  inferredType: 'numeric' | 'boolean' | 'date' | 'string';
  nonEmptyCount: number;
  missingCount: number;
  missingPct: number;
  uniqueCount: number;
  typeErrorCount: number;
  outlierCount: number;
  min: number | null;
  max: number | null;
  mean: number | null;
  median: number | null;
}

export interface DatasetFixAction {
  action: string;
  count: number;
  detail: string;
  evidenceId?: string;
  filename?: string;
}

export interface BeforeAfterComparison {
  metric: string;
  before: number;
  after: number;
  unit: string;
}

export interface ValidationCheck {
  check: string;
  passed: boolean;
  detail: string;
}

export interface Investigation {
  id: string;
  case_code: string;
  title: string;
  description: string;
  status: 'ingesting' | 'analyzing' | 'review_required' | 'closed';
  assessment_summary: string;
  confidence_level: 'pending' | 'low_anomaly' | 'inconclusive' | 'requires_review';
  investigator_notes: string;
  owner_id: string;
  created_at: string;
  updated_at: string;
  evidence_count?: number;
  report_count?: number;
}

export interface EvidenceItem {
  id: string;
  investigation_id: string;
  original_filename: string;
  storage_path: string;
  mime_type: string;
  modality: Modality;
  file_size: number;
  sha256_hash: string;
  context_note: string;
  metadata_json: string;
  status: string;
  is_demo_fixture: number;
  uploaded_at: string;
}

export interface DetectedFace {
  x: number;
  y: number;
  w: number;
  h: number;
  xPct: number;
  yPct: number;
  wPct: number;
  hPct: number;
  confidence: number;
  trackId?: string;
  mlScore?: number;
  mlLabel?: string;
}

export interface PipelineJobState {
  investigationId: string;
  status: 'running' | 'completed' | 'cancelled' | 'failed';
  currentStage: string;
  progressPct: number;
  startedAt: string;
  completedAt?: string;
  error?: string;
  cancelRequested: boolean;
}

export interface ForensicIndicator {
  id: string;
  category: string;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  detail: string;
  sourceLayer?: 'forensic_signal' | 'ml_model' | 'gemini_interpretation';
  evidenceRef?: string;
  evidenceRegion?: { xPct: number; yPct: number; wPct: number; hPct: number };
}

export interface ForensicAnalysisRow {
  id: string;
  evidence_id: string;
  investigation_id: string;
  modality: Modality;
  metrics_json: string;
  indicators_json: string;
  artifacts_json: string;
  limitations: string;
  analyzed_at: string;
}

export interface ModelPredictionRow {
  id: string;
  evidence_id: string;
  investigation_id: string;
  model_id: string;
  prediction_label: 'consistent_baseline' | 'inconclusive_review' | 'elevated_anomaly';
  raw_score: number;
  uncertainty_note: string;
  feature_contributions_json: string;
  created_at: string;
}

export interface AgentExecutionRow {
  id: string;
  investigation_id: string;
  agent_name: string;
  responsibility: string;
  status: 'running' | 'completed' | 'skipped' | 'failed';
  started_at: string;
  completed_at: string | null;
  input_summary_json: string;
  findings_json: string;
  error_message: string | null;
  related_evidence_ids_json: string;
  case_code?: string;
  investigation_title?: string;
}

export interface CorrelationRow {
  id: string;
  investigation_id: string;
  source_evidence_id: string;
  target_evidence_id: string;
  relationship_type: 'CONTRADICTS' | 'SUPPORTS' | 'TEMPORAL_ALIGN' | 'DURATION_COMPATIBLE' | 'WEAKENS';
  strength: number;
  summary: string;
  supporting_refs_json: string;
  alternative_explanations_json: string;
  created_at: string;
}

export interface ReportRow {
  id: string;
  investigation_id: string;
  title: string;
  executive_summary: string;
  human_conclusion: string;
  report_json: string;
  pdf_path: string | null;
  generated_by: string;
  created_at: string;
}

export interface AuditLogRow {
  id: string;
  investigation_id: string | null;
  actor: string;
  action: string;
  target_type: string;
  target_id: string;
  details_json: string;
  created_at: string;
}

export interface WorkspaceBundle {
  investigation: Investigation;
  evidence: EvidenceItem[];
  analyses: ForensicAnalysisRow[];
  predictions: ModelPredictionRow[];
  agents: AgentExecutionRow[];
  correlations: CorrelationRow[];
  reports: ReportRow[];
  auditLogs: AuditLogRow[];
}

export interface CopilotMessage {
  id: string;
  conversation_id?: string;
  role: 'user' | 'assistant';
  content: string;
  cited_evidence_ids_json: string;
  created_at: string;
}

export interface ModelRegistryRow {
  id: string;
  name: string;
  version: string;
  modality: string;
  algorithm: string;
  source: string;
  checkpoint_path: string;
  license: string;
  input_spec: string;
  limitations: string;
  created_at: string;
}

export interface ModelEvaluationRow {
  id: string;
  model_id: string;
  dataset_name: string;
  dataset_license: string;
  sample_count: number;
  accuracy: number;
  precision_score: number;
  recall_score: number;
  f1_score: number;
  roc_auc: number;
  fpr: number;
  confusion_matrix_json: string;
  notes: string;
  evaluated_at: string;
  eval_scope?: string;
  benchmark_summary?: string;
}

export interface ValidationDatasetSource {
  name: string;
  url: string;
  license: string;
  sampleCount: number;
  breakdown: { real: number; fake: number };
  limitations: string;
}

export interface ModelValidationMetrics {
  modelId: string;
  modalityScope: 'all' | 'image' | 'video' | 'audio';
  sampleCount: number;
  realCount: number;
  fakeCount: number;
  metricsSupported: boolean;
  unsupportedReason?: string;
  confusionMatrix: { tp: number; fp: number; tn: number; fn: number };
  accuracy: number | null;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  fpr: number | null;
  meanRawScoreReal: number | null;
  meanRawScoreFake: number | null;
  scoresCalibrated: false;
}

export interface ValidationRunRow {
  id: string;
  collection_id: string;
  collection_name: string;
  status: string;
  sample_count: number;
  real_count: number;
  fake_count: number;
  threshold: number;
  metrics_by_model_json: string;
  sources_json: string;
  notes: string;
  started_at: string;
  completed_at: string | null;
}

export interface ValidationResultRow {
  id: string;
  run_id: string;
  sample_id: string;
  modality: 'image' | 'video' | 'audio';
  filename: string;
  source_dataset: string;
  ground_truth_label: 'real' | 'fake';
  model_id: string;
  predicted_label: 'real' | 'fake';
  raw_score: number;
  is_calibrated: number;
  correct: number;
  flag_reasons_json: string;
  forensic_metrics_json: string;
  uncertainty_note: string;
  evaluated_at: string;
}

export interface DatasetTreeNode {
  name: string;
  path: string;
  type: 'folder' | 'file';
  size: number;
  extension?: string;
  modality?: 'image' | 'csv' | 'unsupported';
  imageCount: number;
  csvCount: number;
  unsupportedCount: number;
  children?: DatasetTreeNode[];
}

export interface CsvFileDescriptor {
  path: string;
  name: string;
  size: number;
  inferredSplit: 'train' | 'test' | 'valid' | 'custom';
}

export interface UnsupportedFileRecord {
  path: string;
  extension: string;
  size: number;
  reason: string;
}

export interface DatasetUploadRow {
  id: string;
  name: string;
  storage_dir: string;
  total_files: number;
  image_count: number;
  csv_count: number;
  unsupported_count: number;
  total_bytes: number;
  tree_json: string;
  csv_files_json: string;
  unsupported_files_json: string;
  status: string;
  created_at: string;
}

export interface CsvInspectionResult {
  csvPath: string;
  inferredSplit: 'train' | 'test' | 'valid' | 'custom';
  columns: string[];
  rowCount: number;
  previewRows: Array<Record<string, string>>;
  detectedPathColumn: string;
  detectedLabelColumn: string;
  labelDistribution: Array<{ rawValue: string; count: number; suggestedMapping: 'real' | 'fake' | 'unmapped' }>;
  allColumnLabelHints: Record<
    string,
    Array<{ rawValue: string; count: number; suggestedMapping: 'real' | 'fake' | 'unmapped' }>
  >;
}

export type MatchRowStatus =
  | 'matched'
  | 'missing'
  | 'duplicate'
  | 'invalid_path'
  | 'unsupported_format'
  | 'ambiguous'
  | 'unmapped_label';

export interface MatchDiagnosticRecord {
  rowIndex: number;
  csvImageRef: string;
  resolvedRelPath: string | null;
  filename: string;
  rawCsvLabel: string;
  mappedLabel: 'real' | 'fake' | 'unmapped';
  status: MatchRowStatus;
  detail: string;
}

export interface DatasetMatchSummary {
  csvPath: string;
  inferredSplit: 'train' | 'test' | 'valid' | 'custom';
  pathColumn: string;
  labelColumn: string;
  totalCsvRows: number;
  matchedCount: number;
  missingCount: number;
  duplicateCount: number;
  invalidPathCount: number;
  unsupportedFormatCount: number;
  ambiguousCount: number;
  unmappedLabelCount: number;
  unmatchedTotal: number;
  unreferencedImagesCount: number;
  groundTruthBreakdown: { real: number; fake: number };
  diagnostics: MatchDiagnosticRecord[];
}

export interface DatasetEvalConfusionMatrix {
  tp: number;
  fp: number;
  tn: number;
  fn: number;
  inconclusiveFake: number;
  inconclusiveReal: number;
  failedFake: number;
  failedReal: number;
}

export interface DatasetEvalModelMetrics {
  modelId: string;
  totalEvaluated: number;
  decisiveCount: number;
  inconclusiveCount: number;
  failedCount: number;
  actualRealCount: number;
  actualFakeCount: number;
  predictedRealCount: number;
  predictedFakeCount: number;
  confusionMatrix: DatasetEvalConfusionMatrix;
  accuracy: number | null;
  overallAccuracyInclInconclusive: number | null;
  precision: number | null;
  fakeRecall: number | null;
  fakeRecallOverall: number | null;
  genuineRecall: number | null;
  genuineRecallOverall: number | null;
  f1Score: number | null;
  fpr: number | null;
  fnr: number | null;
  coverage: number | null;
  meanRawScoreReal: number | null;
  meanRawScoreFake: number | null;
  scoresCalibrated: false;
  note?: string;
}

export interface DatasetEvalRunRow {
  id: string;
  dataset_id: string;
  dataset_name: string;
  csv_path: string;
  split_label: string;
  path_column: string;
  label_column: string;
  label_mapping_json: string;
  status: string;
  total_csv_rows: number;
  matched_count: number;
  unmatched_count: number;
  duplicate_count: number;
  processed_count: number;
  failed_count: number;
  inconclusive_count: number;
  primary_model_id: string;
  metrics_by_model_json: string;
  match_summary_json: string;
  current_item: string;
  error_message: string;
  started_at: string;
  completed_at: string | null;
}

export interface DatasetEvalResultRow {
  id: string;
  run_id: string;
  row_index: number;
  csv_image_ref: string;
  resolved_rel_path: string | null;
  filename: string;
  ground_truth_label: string;
  model_id: string;
  predicted_label: string;
  raw_score: number | null;
  status: string;
  correct: number | null;
  error_detail: string;
  uncertainty_note: string;
  forensic_metrics_json: string;
  evaluated_at: string;
}

