import React, { useEffect, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  Activity,
  AudioLines,
  Bell,
  ChevronDown,
  Clock,
  Cpu,
  FileSearch,
  FileSpreadsheet,
  FileText,
  Film,
  FolderClock,
  FolderTree,
  GitBranch,
  Image as ImageIcon,
  LayoutDashboard,
  Menu,
  MessageSquareCode,
  Moon,
  Plus,
  RotateCcw,
  Search,
  Settings,
  Shield,
  Stethoscope,
  Sun,
  Trash2,
  UploadCloud,
  X,
} from 'lucide-react';
import { useTheme } from '../context/ThemeContext.tsx';
import { useViewMode } from '../context/ViewModeContext.tsx';
import { api } from '../services/api.ts';
import {
  clearAllSavedSessionData,
  getActiveCaseId,
  getDrafts,
  loadInvestigationsCache,
  loadUserSettingsLocal,
  resetSessionDraftsOnly,
  saveInvestigationsCache,
  saveUserSettingsLocal,
  setActiveCaseId,
  updateDrafts,
} from '../services/sessionStorage.ts';
import { AuditLogRow, Investigation } from '../types/forensics.ts';

interface ConsoleShellProps {
  title: string;
  subtitle?: string;
  activeInvestigationId?: string;
  onInvestigationCreated?: (inv: Investigation) => void;
  actions?: React.ReactNode;
  children: React.ReactNode;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatStatusLabel(status: string): string {
  const map: Record<string, string> = {
    ingesting: 'Ingesting Data',
    analyzing: 'Analyzing Signals',
    review_required: 'Requires Review',
    closed: 'Closed',
    pending: 'Pending Analysis',
    low_anomaly: 'Baseline Consistent',
    inconclusive: 'Inconclusive',
    requires_review: 'Elevated Indicators',
    DURATION_COMPATIBLE: 'Duration Compatible',
    TEMPORAL_ALIGN: 'Temporal Align',
  };
  return map[status] || status;
}

export function statusTextClass(status: string): string {
  if (
    status === 'requires_review' ||
    status === 'review_required' ||
    status === 'elevated_anomaly' ||
    status === 'critical' ||
    status === 'CONTRADICTS' ||
    status === 'WEAKENS' ||
    status === 'failed'
  ) {
    return 'text-rose-600 dark:text-rose-400';
  }
  if (
    status === 'inconclusive' ||
    status === 'inconclusive_review' ||
    status === 'warning' ||
    status === 'analyzing'
  ) {
    return 'text-amber-600 dark:text-amber-400';
  }
  if (
    status === 'low_anomaly' ||
    status === 'consistent_baseline' ||
    status === 'completed' ||
    status === 'SUPPORTS' ||
    status === 'closed'
  ) {
    return 'text-teal-700 dark:text-teal-400';
  }
  if (status === 'DURATION_COMPATIBLE' || status === 'TEMPORAL_ALIGN' || status === 'skipped') {
    return 'text-cyan-700 dark:text-sky-400';
  }
  return 'text-slate-600 dark:text-slate-400';
}

export function epistemicLayerMeta(layer?: string): { label: string; toneClass: string } {
  if (layer === 'ml_model') {
    return { label: 'ML Prediction', toneClass: 'text-indigo-700 dark:text-indigo-400' };
  }
  if (layer === 'gemini_interpretation') {
    return { label: 'AI Interpretation', toneClass: 'text-cyan-700 dark:text-sky-400' };
  }
  if (layer === 'human_review') {
    return { label: 'Human Review', toneClass: 'text-teal-700 dark:text-teal-400' };
  }
  return { label: 'Observed Forensic Signal', toneClass: 'text-slate-700 dark:text-slate-300' };
}

export const ConsoleShell: React.FC<ConsoleShellProps> = ({
  title,
  subtitle,
  activeInvestigationId,
  onInvestigationCreated,
  actions,
  children,
}) => {
  const { theme, toggleTheme } = useTheme();
  const { viewMode, setViewMode } = useViewMode();
  const params = useParams();
  const navigate = useNavigate();
  const location = useLocation();

  const [investigations, setInvestigations] = useState<Investigation[]>(() => loadInvestigationsCache());
  const [auditLogs, setAuditLogs] = useState<AuditLogRow[]>([]);
  const localUser = loadUserSettingsLocal();
  const [userName, setUserName] = useState(localUser.name || 'Forensic Analyst');
  const [userRole, setUserRole] = useState(localUser.role || 'Data & Digital Forensics Analyst');

  const [mobileOpen, setMobileOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [notifOpen, setNotifOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [clearModalOpen, setClearModalOpen] = useState(false);
  const [clearing, setClearing] = useState(false);

  const initialDrafts = getDrafts();
  const [newTitle, setNewTitle] = useState(initialDrafts.newCaseTitle);
  const [newDesc, setNewDesc] = useState(initialDrafts.newCaseDesc);
  const [creating, setCreating] = useState(false);
  const [createErr, setCreateErr] = useState('');

  const paramId = params.id && params.id !== 'none' ? params.id : '';
  const resolvedCaseId = activeInvestigationId || paramId || getActiveCaseId() || investigations[0]?.id || '';
  const navCaseSegment = resolvedCaseId || 'none';

  useEffect(() => {
    if (resolvedCaseId) {
      setActiveCaseId(resolvedCaseId);
    }
  }, [resolvedCaseId]);

  useEffect(() => {
    updateDrafts((prev) => ({
      ...prev,
      newCaseTitle: newTitle,
      newCaseDesc: newDesc,
    }));
  }, [newTitle, newDesc]);

  useEffect(() => {
    api
      .listInvestigations()
      .then((res) => {
        setInvestigations(res.investigations);
        saveInvestigationsCache(res.investigations);
      })
      .catch(() => {});
    api
      .getSettings()
      .then((res) => {
        setAuditLogs(res.auditLogs || []);
        if (res.user) {
          setUserName(res.user.name || 'Forensic Analyst');
          setUserRole(res.user.role || 'Data & Digital Forensics Analyst');
          saveUserSettingsLocal({ name: res.user.name, role: res.user.role });
        }
      })
      .catch(() => {});
  }, [location.pathname]);

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchTerm.trim()) return;
    navigate(`/history?q=${encodeURIComponent(searchTerm.trim())}`);
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newTitle.trim().length < 3) {
      setCreateErr('Enter an investigation title (at least 3 characters).');
      return;
    }
    setCreating(true);
    setCreateErr('');
    try {
      const res = await api.createInvestigation({
        title: newTitle.trim(),
        description: newDesc.trim(),
      });
      setCreateOpen(false);
      setNewTitle('');
      setNewDesc('');
      setActiveCaseId(res.investigation.id);
      if (onInvestigationCreated) {
        onInvestigationCreated(res.investigation);
      } else {
        navigate(`/investigations/${res.investigation.id}`);
      }
    } catch (err) {
      setCreateErr(err instanceof Error ? err.message : 'Failed to create investigation');
    } finally {
      setCreating(false);
    }
  };

  const handleStartNewSession = () => {
    resetSessionDraftsOnly();
    setNewTitle('');
    setNewDesc('');
    setCreateOpen(true);
  };

  const handleClearSavedData = async (alsoClearServer: boolean) => {
    setClearing(true);
    try {
      clearAllSavedSessionData();
      if (alsoClearServer) {
        await api.clearAllSessions();
        setInvestigations([]);
        setAuditLogs([]);
      }
      setClearModalOpen(false);
      navigate('/dashboard');
      window.location.reload();
    } catch {
      setClearing(false);
    }
  };

  const userInitials = userName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() || '')
    .join('') || 'FA';

  const navGroups = [
    {
      heading: 'Investigation Operations',
      items: [
        { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
        { to: `/investigations/${navCaseSegment}`, label: 'Workspace', icon: FileSearch },
        { to: `/investigations/${navCaseSegment}/timeline`, label: 'Timeline', icon: Clock },
        { to: '/history', label: 'Investigation History', icon: FolderClock },
      ],
    },
    {
      heading: 'Data & Media Labs',
      items: [
        { to: `/investigations/${navCaseSegment}/upload`, label: 'Upload Studio', icon: UploadCloud },
        { to: `/investigations/${navCaseSegment}/dataset`, label: 'Dataset Quality Lab', icon: FileSpreadsheet },
        { to: `/investigations/${navCaseSegment}/image`, label: 'Image Forensics', icon: ImageIcon },
        { to: `/investigations/${navCaseSegment}/video`, label: 'Video Forensics', icon: Film },
        { to: `/investigations/${navCaseSegment}/audio`, label: 'Audio Forensics', icon: AudioLines },
        { to: `/investigations/${navCaseSegment}/text`, label: 'Text Intelligence', icon: FileText },
      ],
    },
    {
      heading: 'Synthesis & Oversight',
      items: [
        { to: `/investigations/${navCaseSegment}/correlate`, label: 'Cross-Modal Graph', icon: GitBranch },
        { to: `/investigations/${navCaseSegment}/copilot`, label: 'Forensic Copilot', icon: MessageSquareCode },
        { to: '/agents', label: 'Agent Activity', icon: Activity },
        { to: `/investigations/${navCaseSegment}/reports`, label: 'Reports & Export', icon: Shield },
        { to: '/models', label: 'Model Evaluation', icon: Cpu },
        { to: '/dataset-evaluation', label: 'Dataset Evaluation', icon: FolderTree },
        { to: '/diagnostics', label: 'Model Diagnostics', icon: Stethoscope },
        { to: '/settings', label: 'Settings', icon: Settings },
      ],
    },
  ];

  const SidebarContent = (
    <div className="flex flex-col h-full bg-white dark:bg-[#111827] border-r border-slate-200 dark:border-slate-800 transition-colors duration-150">
      <div className="h-14 px-5 flex items-center justify-between border-b border-slate-200 dark:border-slate-800 shrink-0">
        <Link
          to="/"
          className="font-display text-base font-bold tracking-tight text-slate-900 dark:text-slate-100 whitespace-nowrap"
        >
          TruthLens AI
        </Link>
        <button
          type="button"
          onClick={() => setMobileOpen(false)}
          className="lg:hidden p-1.5 text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white"
          aria-label="Close navigation"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Investigation Switcher */}
      <div className="p-3.5 border-b border-slate-200 dark:border-slate-800">
        <label
          htmlFor="case-switcher"
          className="block text-[11px] font-medium text-slate-500 dark:text-slate-400 mb-1.5"
        >
          Active Investigation
        </label>
        <div className="relative">
          <select
            id="case-switcher"
            value={resolvedCaseId}
            onChange={(e) => {
              if (!e.target.value) return;
              setActiveCaseId(e.target.value);
              navigate(`/investigations/${e.target.value}`);
            }}
            className="w-full appearance-none bg-slate-50 dark:bg-[#162032] border border-slate-300 dark:border-slate-700 rounded-md pl-2.5 pr-7 py-1.5 text-xs text-slate-900 dark:text-slate-100 focus:outline-none focus:border-blue-600 dark:focus:border-sky-400 truncate"
          >
            {investigations.length === 0 ? (
              <option value="">No saved investigations yet</option>
            ) : (
              investigations.map((inv) => (
                <option key={inv.id} value={inv.id}>
                  {inv.case_code} · {inv.title}
                </option>
              ))
            )}
          </select>
          <ChevronDown className="w-3.5 h-3.5 text-slate-500 pointer-events-none absolute right-2 top-2" />
        </div>
        <button
          type="button"
          onClick={handleStartNewSession}
          className="mt-2.5 w-full flex items-center justify-center gap-1.5 py-2 px-3 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-md transition-colors duration-150 whitespace-nowrap"
        >
          <Plus className="w-3.5 h-3.5" />
          Start New Investigation
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-5" aria-label="Primary Console Navigation">
        {navGroups.map((group) => (
          <div key={group.heading}>
            <p className="px-2.5 mb-1.5 text-[11px] font-semibold text-slate-500 dark:text-slate-400">
              {group.heading}
            </p>
            <ul className="space-y-0.5">
              {group.items.map((item) => {
                const Icon = item.icon;
                return (
                  <li key={item.to}>
                    <NavLink
                      to={item.to}
                      end={item.to === `/investigations/${navCaseSegment}` || item.to === '/dashboard'}
                      onClick={() => setMobileOpen(false)}
                      className={({ isActive }) =>
                        `flex items-center gap-2.5 px-2.5 py-2 text-[13px] rounded-md transition-colors duration-150 whitespace-nowrap ${
                          isActive
                            ? 'bg-slate-900 text-white dark:bg-[#1E293B] dark:text-white font-medium'
                            : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100 dark:text-slate-400 dark:hover:text-slate-100 dark:hover:bg-slate-800/60'
                        }`
                      }
                    >
                      <Icon className="w-4 h-4 shrink-0" />
                      <span className="truncate">{item.label}</span>
                    </NavLink>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      {/* Investigation Storage Controls */}
      <div className="p-3 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between gap-2 text-[11px]">
        <button
          type="button"
          onClick={handleStartNewSession}
          className="inline-flex items-center gap-1 text-slate-600 dark:text-slate-400 hover:text-blue-600 dark:hover:text-sky-400 font-medium whitespace-nowrap"
        >
          <RotateCcw className="w-3 h-3" />
          New Investigation
        </button>
        <button
          type="button"
          onClick={() => setClearModalOpen(true)}
          className="inline-flex items-center gap-1 text-slate-500 hover:text-rose-600 dark:hover:text-rose-400 font-medium whitespace-nowrap"
        >
          <Trash2 className="w-3 h-3" />
          Clear Data
        </button>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-[#0B1120] text-slate-900 dark:text-slate-100 flex transition-colors duration-150">
      <aside className="hidden lg:block w-[252px] shrink-0 sticky top-0 h-screen">{SidebarContent}</aside>

      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div className="w-[260px] h-full">{SidebarContent}</div>
          <div className="flex-1 bg-slate-900/50 backdrop-blur-xs" onClick={() => setMobileOpen(false)} />
        </div>
      )}

      <div className="flex-1 min-w-0 flex flex-col">
        <header className="h-14 px-4 lg:px-6 bg-white/95 dark:bg-[#0B1120]/95 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-4 sticky top-0 z-30 backdrop-blur-sm transition-colors duration-150">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileOpen(true)}
              className="lg:hidden p-2 rounded-md border border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
              aria-label="Open navigation"
            >
              <Menu className="w-4 h-4" />
            </button>
            <div className="min-w-0">
              <h1 className="font-display text-sm lg:text-base font-semibold text-slate-900 dark:text-slate-100 truncate">
                {title}
              </h1>
              {subtitle && (
                <p className="text-xs text-slate-500 dark:text-slate-400 truncate">{subtitle}</p>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <div
              role="group"
              aria-label="Complexity view mode"
              className="hidden sm:inline-flex bg-slate-100 dark:bg-[#162032] border border-slate-200 dark:border-slate-700 rounded-md p-0.5 text-[11px]"
            >
              <button
                type="button"
                onClick={() => setViewMode('simple')}
                className={`px-2 py-1 rounded transition-colors whitespace-nowrap ${
                  viewMode === 'simple'
                    ? 'bg-blue-600 text-white font-semibold'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                Simple View
              </button>
              <button
                type="button"
                onClick={() => setViewMode('advanced')}
                className={`px-2 py-1 rounded transition-colors whitespace-nowrap ${
                  viewMode === 'advanced'
                    ? 'bg-blue-600 text-white font-semibold'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                Advanced Technical
              </button>
            </div>

            <form onSubmit={handleSearchSubmit} className="hidden xl:flex items-center relative">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 pointer-events-none" />
              <input
                type="search"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="Search investigations or IDs..."
                aria-label="Search investigations"
                className="w-48 bg-slate-50 dark:bg-[#111827] border border-slate-200 dark:border-slate-800 focus:border-blue-600 dark:focus:border-sky-400 rounded-md pl-8 pr-3 py-1.5 text-xs text-slate-900 dark:text-slate-100 placeholder-slate-400 focus:outline-none"
              />
            </form>

            {actions}

            <button
              type="button"
              onClick={toggleTheme}
              aria-label={theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
              title={theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
              className="p-2 rounded-md bg-slate-50 dark:bg-[#111827] border border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700 text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white transition-colors duration-150 shrink-0"
            >
              {theme === 'light' ? <Moon className="w-4 h-4" /> : <Sun className="w-4 h-4" />}
            </button>

            <div className="relative">
              <button
                type="button"
                onClick={() => {
                  setNotifOpen((v) => !v);
                  setProfileOpen(false);
                }}
                aria-label="Audit notifications"
                className="p-2 rounded-md bg-slate-50 dark:bg-[#111827] border border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700 text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white transition-colors duration-150"
              >
                <Bell className="w-4 h-4" />
              </button>
              {notifOpen && (
                <div className="absolute right-0 mt-2 w-80 bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg shadow-lg z-40 p-3">
                  <div className="flex items-center justify-between pb-2 mb-2 border-b border-slate-200 dark:border-slate-800">
                    <span className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                      Recent Audit Events
                    </span>
                    <button
                      type="button"
                      onClick={() => setNotifOpen(false)}
                      className="text-xs text-slate-500 hover:text-slate-900 dark:hover:text-white"
                    >
                      Close
                    </button>
                  </div>
                  <div className="max-h-64 overflow-y-auto divide-y divide-slate-200 dark:divide-slate-800">
                    {auditLogs.slice(0, 6).map((log) => (
                      <div key={log.id} className="py-2 text-xs">
                        <p className="font-medium text-slate-900 dark:text-slate-100">
                          {log.action.replace(/_/g, ' ')}
                        </p>
                        <p className="text-slate-500 dark:text-slate-400 font-mono text-[11px] mt-0.5">
                          {log.target_id} · {new Date(log.created_at).toLocaleTimeString()}
                        </p>
                      </div>
                    ))}
                    {auditLogs.length === 0 && (
                      <p className="py-3 text-xs text-slate-500">No recent audit logs.</p>
                    )}
                  </div>
                </div>
              )}
            </div>

            <div className="relative">
              <button
                type="button"
                onClick={() => {
                  setProfileOpen((v) => !v);
                  setNotifOpen(false);
                }}
                aria-label="Analyst profile menu"
                className="w-7 h-7 rounded-md bg-slate-900 dark:bg-blue-600 text-white text-[11px] font-mono font-semibold flex items-center justify-center border border-slate-700 dark:border-blue-500"
              >
                {userInitials}
              </button>
              {profileOpen && (
                <div className="absolute right-0 mt-2 w-56 bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg shadow-lg z-40 p-2">
                  <div className="px-2.5 py-2 border-b border-slate-200 dark:border-slate-800 mb-1">
                    <p className="text-xs font-semibold text-slate-900 dark:text-slate-100">{userName}</p>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400">{userRole}</p>
                  </div>
                  <Link
                    to="/settings"
                    onClick={() => setProfileOpen(false)}
                    className="block px-2.5 py-1.5 text-xs text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800 rounded"
                  >
                    Console Settings
                  </Link>
                  <Link
                    to="/models"
                    onClick={() => setProfileOpen(false)}
                    className="block px-2.5 py-1.5 text-xs text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800 rounded"
                  >
                    Model Evaluation Centre
                  </Link>
                </div>
              )}
            </div>
          </div>
        </header>

        <main className="flex-1 p-4 lg:p-6 max-w-[1440px] w-full mx-auto">{children}</main>
      </div>

      {/* Create New Investigation Modal */}
      {createOpen && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-6 shadow-xl">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
                Start New Investigation
              </h2>
              <button
                type="button"
                onClick={() => setCreateOpen(false)}
                className="text-slate-400 hover:text-slate-900 dark:hover:text-white"
                aria-label="Close modal"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleCreate} className="space-y-4">
              <div>
                <label
                  htmlFor="inv-title"
                  className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5"
                >
                  Investigation Title
                </label>
                <input
                  id="inv-title"
                  type="text"
                  required
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  placeholder="e.g., Media Verification & Claim Audit"
                  className="w-full bg-slate-50 dark:bg-[#162032] border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:border-blue-600 dark:focus:border-sky-400"
                />
              </div>
              <div>
                <label
                  htmlFor="inv-desc"
                  className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5"
                >
                  Scope &amp; Provenance Notes
                </label>
                <textarea
                  id="inv-desc"
                  rows={3}
                  value={newDesc}
                  onChange={(e) => setNewDesc(e.target.value)}
                  placeholder="Describe uploaded evidence files, datasets, and verification objectives..."
                  className="w-full bg-slate-50 dark:bg-[#162032] border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:border-blue-600 dark:focus:border-sky-400"
                />
              </div>
              {createErr && <p className="text-xs text-rose-600 dark:text-rose-400">{createErr}</p>}
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setCreateOpen(false)}
                  className="px-4 py-2 text-xs font-medium text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white bg-slate-100 dark:bg-[#162032] border border-slate-200 dark:border-slate-700 rounded-md whitespace-nowrap"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={creating}
                  className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded-md whitespace-nowrap"
                >
                  {creating ? 'Creating...' : 'Create Investigation'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Clear Saved Data Modal */}
      {clearModalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-6 shadow-xl space-y-4">
            <h2 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
              Clear Saved Investigation Data?
            </h2>
            <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
              Choose whether to clear only browser Local Storage caches and drafts, or permanently wipe all saved
              investigations, uploaded evidence files, and generated reports from both Local Storage and the database.
            </p>
            <div className="flex flex-wrap justify-end gap-2 pt-2">
              <button
                type="button"
                disabled={clearing}
                onClick={() => setClearModalOpen(false)}
                className="px-3 py-1.5 text-xs font-medium bg-slate-100 dark:bg-[#162032] border border-slate-200 dark:border-slate-700 rounded-md text-slate-700 dark:text-slate-300"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={clearing}
                onClick={() => handleClearSavedData(false)}
                className="px-3 py-1.5 text-xs font-medium bg-amber-600 hover:bg-amber-700 text-white rounded-md"
              >
                Clear Local Storage Only
              </button>
              <button
                type="button"
                disabled={clearing}
                onClick={() => handleClearSavedData(true)}
                className="px-3.5 py-1.5 text-xs font-semibold bg-rose-600 hover:bg-rose-700 text-white rounded-md"
              >
                {clearing ? 'Clearing...' : 'Clear All Investigations & Data'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
