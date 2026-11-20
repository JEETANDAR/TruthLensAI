import { Investigation, WorkspaceBundle } from '../types/forensics.ts';
import type { DashboardPayload } from './api.ts';

const STORAGE_KEY = 'truthlens_session_v1';

export interface TextEditorDraft {
  filename: string;
  format: 'txt' | 'json' | 'srt' | 'csv' | 'tsv';
  content: string;
  contextNote: string;
}

export interface LocalUserSettings {
  name?: string;
  role?: string;
  retainDays?: number;
  sendRawMediaToGemini?: boolean;
  showConfidenceBounds?: boolean;
}

export interface SessionDrafts {
  newCaseTitle: string;
  newCaseDesc: string;
  uploadContextNote: string;
  textEditor: TextEditorDraft;
  workspaceNotesByCase: Record<string, string>;
  copilotDraftByCase: Record<string, string>;
  reportConclusionByReport: Record<string, string>;
  historySearch: string;
  historyStatus: string;
  selectedLabEvidenceByCase: Record<string, Record<string, string>>;
}

export type ViewMode = 'simple' | 'advanced';

export interface PersistedSessionState {
  version: number;
  updatedAt: string;
  activeCaseId: string;
  viewMode: ViewMode;
  investigationsCache: Investigation[];
  dashboardSnapshot: DashboardPayload | null;
  workspaceSnapshots: Record<string, WorkspaceBundle>;
  drafts: SessionDrafts;
  userSettings: LocalUserSettings;
}

const DEFAULT_DRAFTS: SessionDrafts = {
  newCaseTitle: '',
  newCaseDesc: '',
  uploadContextNote: '',
  textEditor: {
    filename: 'dataset_input.csv',
    format: 'csv',
    content: '',
    contextNote: '',
  },
  workspaceNotesByCase: {},
  copilotDraftByCase: {},
  reportConclusionByReport: {},
  historySearch: '',
  historyStatus: 'all',
  selectedLabEvidenceByCase: {},
};

const DEFAULT_STATE: PersistedSessionState = {
  version: 1,
  updatedAt: '',
  activeCaseId: '',
  viewMode: 'simple',
  investigationsCache: [],
  dashboardSnapshot: null,
  workspaceSnapshots: {},
  drafts: DEFAULT_DRAFTS,
  userSettings: {},
};

function readRawState(): PersistedSessionState {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return structuredClone(DEFAULT_STATE);
    const parsed = JSON.parse(raw) as Partial<PersistedSessionState>;
    return {
      version: 1,
      updatedAt: parsed.updatedAt || '',
      activeCaseId: typeof parsed.activeCaseId === 'string' ? parsed.activeCaseId : '',
      viewMode: parsed.viewMode === 'advanced' ? 'advanced' : 'simple',
      investigationsCache: Array.isArray(parsed.investigationsCache) ? parsed.investigationsCache : [],
      dashboardSnapshot: parsed.dashboardSnapshot ?? null,
      workspaceSnapshots: parsed.workspaceSnapshots && typeof parsed.workspaceSnapshots === 'object' ? parsed.workspaceSnapshots : {},
      drafts: {
        ...DEFAULT_DRAFTS,
        ...(parsed.drafts || {}),
        textEditor: {
          ...DEFAULT_DRAFTS.textEditor,
          ...(parsed.drafts?.textEditor || {}),
        },
      },
      userSettings: parsed.userSettings && typeof parsed.userSettings === 'object' ? parsed.userSettings : {},
    };
  } catch {
    return structuredClone(DEFAULT_STATE);
  }
}

function writeRawState(state: PersistedSessionState): void {
  try {
    state.updatedAt = new Date().toISOString();
    // Keep at most 4 most-recent workspace snapshots in localStorage to stay well below quota limits
    const keys = Object.keys(state.workspaceSnapshots);
    if (keys.length > 4) {
      for (const oldKey of keys.slice(0, keys.length - 4)) {
        delete state.workspaceSnapshots[oldKey];
      }
    }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Fallback: prune workspace snapshots if storage quota is tight
    try {
      state.workspaceSnapshots = {};
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // ignore unavailable storage
    }
  }
}

export function getActiveCaseId(): string {
  return readRawState().activeCaseId;
}

export function setActiveCaseId(caseId: string): void {
  const s = readRawState();
  s.activeCaseId = caseId;
  writeRawState(s);
}

export function loadViewMode(): ViewMode {
  return readRawState().viewMode;
}

export function saveViewMode(mode: ViewMode): void {
  const s = readRawState();
  s.viewMode = mode;
  writeRawState(s);
}

export function loadInvestigationsCache(): Investigation[] {
  return readRawState().investigationsCache;
}

export function saveInvestigationsCache(list: Investigation[]): void {
  const s = readRawState();
  s.investigationsCache = list.slice(0, 50);
  if (s.activeCaseId && list.length > 0 && !list.some((i) => i.id === s.activeCaseId)) {
    s.activeCaseId = list[0].id;
  } else if (!s.activeCaseId && list.length > 0) {
    s.activeCaseId = list[0].id;
  }
  writeRawState(s);
}

export function loadDashboardSnapshot(): DashboardPayload | null {
  return readRawState().dashboardSnapshot;
}

export function saveDashboardSnapshot(data: DashboardPayload): void {
  const s = readRawState();
  s.dashboardSnapshot = data;
  writeRawState(s);
}

export function loadWorkspaceSnapshot(caseId: string): WorkspaceBundle | null {
  if (!caseId) return null;
  return readRawState().workspaceSnapshots[caseId] || null;
}

export function saveWorkspaceSnapshot(caseId: string, bundle: WorkspaceBundle): void {
  if (!caseId) return;
  const s = readRawState();
  // Trim oversized raw text previews before saving snapshot to browser storage
  const compactAnalyses = bundle.analyses.map((a) => ({
    ...a,
    artifacts_json: a.artifacts_json.length > 45000 ? '{}' : a.artifacts_json,
  }));
  s.workspaceSnapshots[caseId] = {
    ...bundle,
    analyses: compactAnalyses,
  };
  s.activeCaseId = caseId;
  writeRawState(s);
}

export function getDrafts(): SessionDrafts {
  return readRawState().drafts;
}

export function updateDrafts(updater: (prev: SessionDrafts) => SessionDrafts): void {
  const s = readRawState();
  s.drafts = updater(s.drafts);
  writeRawState(s);
}

export function loadUserSettingsLocal(): LocalUserSettings {
  return readRawState().userSettings;
}

export function saveUserSettingsLocal(settings: LocalUserSettings): void {
  const s = readRawState();
  s.userSettings = { ...s.userSettings, ...settings };
  writeRawState(s);
}

export function resetSessionDraftsOnly(): void {
  const s = readRawState();
  s.activeCaseId = '';
  s.drafts = structuredClone(DEFAULT_DRAFTS);
  writeRawState(s);
}

export function clearAllSavedSessionData(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

export function exportSavedSessionJson(): string {
  return JSON.stringify(readRawState(), null, 2);
}
