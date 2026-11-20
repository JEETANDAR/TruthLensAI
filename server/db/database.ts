import Database from 'better-sqlite3';
import { DB_PATH, ensureDirectories } from '../config.ts';

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;
  ensureDirectories();
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initSchema(db);
  _db = db;
  return db;
}

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL DEFAULT 'Lead Forensic Investigator',
      avatar_url TEXT,
      preferences_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS investigations (
      id TEXT PRIMARY KEY,
      case_code TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'ingesting',
      assessment_summary TEXT NOT NULL DEFAULT '',
      confidence_level TEXT NOT NULL DEFAULT 'pending',
      investigator_notes TEXT NOT NULL DEFAULT '',
      owner_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (owner_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS evidence (
      id TEXT PRIMARY KEY,
      investigation_id TEXT NOT NULL,
      original_filename TEXT NOT NULL,
      storage_path TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      modality TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      sha256_hash TEXT NOT NULL,
      context_note TEXT NOT NULL DEFAULT '',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'ingested',
      is_demo_fixture INTEGER NOT NULL DEFAULT 0,
      uploaded_at TEXT NOT NULL,
      FOREIGN KEY (investigation_id) REFERENCES investigations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS forensic_analyses (
      id TEXT PRIMARY KEY,
      evidence_id TEXT NOT NULL,
      investigation_id TEXT NOT NULL,
      modality TEXT NOT NULL,
      metrics_json TEXT NOT NULL DEFAULT '{}',
      indicators_json TEXT NOT NULL DEFAULT '[]',
      artifacts_json TEXT NOT NULL DEFAULT '{}',
      limitations TEXT NOT NULL DEFAULT '',
      analyzed_at TEXT NOT NULL,
      FOREIGN KEY (evidence_id) REFERENCES evidence(id) ON DELETE CASCADE,
      FOREIGN KEY (investigation_id) REFERENCES investigations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS model_registry (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      version TEXT NOT NULL,
      modality TEXT NOT NULL,
      algorithm TEXT NOT NULL,
      source TEXT NOT NULL,
      checkpoint_path TEXT NOT NULL,
      license TEXT NOT NULL,
      input_spec TEXT NOT NULL,
      limitations TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS model_evaluations (
      id TEXT PRIMARY KEY,
      model_id TEXT NOT NULL,
      dataset_name TEXT NOT NULL,
      dataset_license TEXT NOT NULL,
      sample_count INTEGER NOT NULL,
      accuracy REAL NOT NULL,
      precision_score REAL NOT NULL,
      recall_score REAL NOT NULL,
      f1_score REAL NOT NULL,
      roc_auc REAL NOT NULL,
      fpr REAL NOT NULL,
      confusion_matrix_json TEXT NOT NULL,
      notes TEXT NOT NULL,
      evaluated_at TEXT NOT NULL,
      FOREIGN KEY (model_id) REFERENCES model_registry(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS model_predictions (
      id TEXT PRIMARY KEY,
      evidence_id TEXT NOT NULL,
      investigation_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      prediction_label TEXT NOT NULL,
      raw_score REAL NOT NULL,
      uncertainty_note TEXT NOT NULL,
      feature_contributions_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      FOREIGN KEY (evidence_id) REFERENCES evidence(id) ON DELETE CASCADE,
      FOREIGN KEY (investigation_id) REFERENCES investigations(id) ON DELETE CASCADE,
      FOREIGN KEY (model_id) REFERENCES model_registry(id)
    );

    CREATE TABLE IF NOT EXISTS agent_executions (
      id TEXT PRIMARY KEY,
      investigation_id TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      responsibility TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      input_summary_json TEXT NOT NULL DEFAULT '{}',
      findings_json TEXT NOT NULL DEFAULT '{}',
      error_message TEXT,
      related_evidence_ids_json TEXT NOT NULL DEFAULT '[]',
      FOREIGN KEY (investigation_id) REFERENCES investigations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS evidence_correlations (
      id TEXT PRIMARY KEY,
      investigation_id TEXT NOT NULL,
      source_evidence_id TEXT NOT NULL,
      target_evidence_id TEXT NOT NULL,
      relationship_type TEXT NOT NULL,
      strength REAL NOT NULL,
      summary TEXT NOT NULL,
      supporting_refs_json TEXT NOT NULL DEFAULT '[]',
      alternative_explanations_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      FOREIGN KEY (investigation_id) REFERENCES investigations(id) ON DELETE CASCADE,
      FOREIGN KEY (source_evidence_id) REFERENCES evidence(id) ON DELETE CASCADE,
      FOREIGN KEY (target_evidence_id) REFERENCES evidence(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS investigation_reports (
      id TEXT PRIMARY KEY,
      investigation_id TEXT NOT NULL,
      title TEXT NOT NULL,
      executive_summary TEXT NOT NULL,
      human_conclusion TEXT NOT NULL DEFAULT 'Pending investigator sign-off',
      report_json TEXT NOT NULL,
      pdf_path TEXT,
      generated_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (investigation_id) REFERENCES investigations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS copilot_conversations (
      id TEXT PRIMARY KEY,
      investigation_id TEXT NOT NULL,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (investigation_id) REFERENCES investigations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS copilot_messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      cited_evidence_ids_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      FOREIGN KEY (conversation_id) REFERENCES copilot_conversations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      investigation_id TEXT,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      details_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS validation_runs (
      id TEXT PRIMARY KEY,
      collection_id TEXT NOT NULL,
      collection_name TEXT NOT NULL,
      status TEXT NOT NULL,
      sample_count INTEGER NOT NULL,
      real_count INTEGER NOT NULL,
      fake_count INTEGER NOT NULL,
      threshold REAL NOT NULL,
      metrics_by_model_json TEXT NOT NULL DEFAULT '[]',
      sources_json TEXT NOT NULL DEFAULT '[]',
      notes TEXT NOT NULL DEFAULT '',
      started_at TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS validation_results (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      sample_id TEXT NOT NULL,
      modality TEXT NOT NULL,
      filename TEXT NOT NULL,
      source_dataset TEXT NOT NULL,
      ground_truth_label TEXT NOT NULL,
      model_id TEXT NOT NULL,
      predicted_label TEXT NOT NULL,
      raw_score REAL NOT NULL,
      is_calibrated INTEGER NOT NULL DEFAULT 0,
      correct INTEGER NOT NULL,
      flag_reasons_json TEXT NOT NULL DEFAULT '[]',
      forensic_metrics_json TEXT NOT NULL DEFAULT '{}',
      uncertainty_note TEXT NOT NULL DEFAULT '',
      evaluated_at TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES validation_runs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS dataset_uploads (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      storage_dir TEXT NOT NULL,
      total_files INTEGER NOT NULL DEFAULT 0,
      image_count INTEGER NOT NULL DEFAULT 0,
      csv_count INTEGER NOT NULL DEFAULT 0,
      unsupported_count INTEGER NOT NULL DEFAULT 0,
      total_bytes INTEGER NOT NULL DEFAULT 0,
      tree_json TEXT NOT NULL DEFAULT '{}',
      csv_files_json TEXT NOT NULL DEFAULT '[]',
      unsupported_files_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'ready',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS dataset_eval_runs (
      id TEXT PRIMARY KEY,
      dataset_id TEXT NOT NULL,
      dataset_name TEXT NOT NULL,
      csv_path TEXT NOT NULL,
      split_label TEXT NOT NULL DEFAULT 'unspecified',
      path_column TEXT NOT NULL,
      label_column TEXT NOT NULL,
      label_mapping_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'running',
      total_csv_rows INTEGER NOT NULL DEFAULT 0,
      matched_count INTEGER NOT NULL DEFAULT 0,
      unmatched_count INTEGER NOT NULL DEFAULT 0,
      duplicate_count INTEGER NOT NULL DEFAULT 0,
      processed_count INTEGER NOT NULL DEFAULT 0,
      failed_count INTEGER NOT NULL DEFAULT 0,
      inconclusive_count INTEGER NOT NULL DEFAULT 0,
      primary_model_id TEXT NOT NULL,
      metrics_by_model_json TEXT NOT NULL DEFAULT '[]',
      match_summary_json TEXT NOT NULL DEFAULT '{}',
      current_item TEXT NOT NULL DEFAULT '',
      error_message TEXT NOT NULL DEFAULT '',
      started_at TEXT NOT NULL,
      completed_at TEXT,
      FOREIGN KEY (dataset_id) REFERENCES dataset_uploads(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS dataset_eval_results (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      row_index INTEGER NOT NULL,
      csv_image_ref TEXT NOT NULL,
      resolved_rel_path TEXT,
      filename TEXT NOT NULL,
      ground_truth_label TEXT NOT NULL,
      model_id TEXT NOT NULL,
      predicted_label TEXT NOT NULL,
      raw_score REAL,
      status TEXT NOT NULL,
      correct INTEGER,
      error_detail TEXT NOT NULL DEFAULT '',
      uncertainty_note TEXT NOT NULL DEFAULT '',
      forensic_metrics_json TEXT NOT NULL DEFAULT '{}',
      evaluated_at TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES dataset_eval_runs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_evidence_inv ON evidence(investigation_id);
    CREATE INDEX IF NOT EXISTS idx_analyses_evid ON forensic_analyses(evidence_id);
    CREATE INDEX IF NOT EXISTS idx_preds_inv ON model_predictions(investigation_id);
    CREATE INDEX IF NOT EXISTS idx_agents_inv ON agent_executions(investigation_id);
    CREATE INDEX IF NOT EXISTS idx_corr_inv ON evidence_correlations(investigation_id);
    CREATE INDEX IF NOT EXISTS idx_audit_inv ON audit_logs(investigation_id);
    CREATE INDEX IF NOT EXISTS idx_val_res_run ON validation_results(run_id);
    CREATE INDEX IF NOT EXISTS idx_dseval_run_id ON dataset_eval_results(run_id);
    CREATE INDEX IF NOT EXISTS idx_dseval_dataset_id ON dataset_eval_runs(dataset_id);
  `);

  addColumnIfMissing(db, 'model_evaluations', 'eval_scope', `TEXT NOT NULL DEFAULT 'held_out_calibration'`);
  addColumnIfMissing(db, 'model_evaluations', 'benchmark_summary', `TEXT NOT NULL DEFAULT ''`);
}

function addColumnIfMissing(db: Database.Database, table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export function logAudit(
  investigationId: string | null,
  actor: string,
  action: string,
  targetType: string,
  targetId: string,
  details: Record<string, unknown> = {},
): void {
  const db = getDb();
  const id = `AUD-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  db.prepare(
    `INSERT INTO audit_logs (id, investigation_id, actor, action, target_type, target_id, details_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, investigationId, actor, action, targetType, targetId, JSON.stringify(details), new Date().toISOString());
}
