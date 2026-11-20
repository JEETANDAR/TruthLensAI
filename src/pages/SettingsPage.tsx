import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, Download, RotateCcw, Trash2 } from 'lucide-react';
import { ConsoleShell, formatBytes } from '../components/ConsoleShell.tsx';
import { useTheme } from '../context/ThemeContext.tsx';
import { api } from '../services/api.ts';
import {
  clearAllSavedSessionData,
  exportSavedSessionJson,
  loadUserSettingsLocal,
  resetSessionDraftsOnly,
  saveUserSettingsLocal,
} from '../services/sessionStorage.ts';

export const SettingsPage: React.FC = () => {
  const navigate = useNavigate();
  const { theme, setTheme } = useTheme();
  const cachedSettings = loadUserSettingsLocal();
  const [name, setName] = useState(cachedSettings.name || '');
  const [role, setRole] = useState(cachedSettings.role || '');
  const [email, setEmail] = useState('');
  const [retainDays, setRetainDays] = useState(cachedSettings.retainDays ?? 90);
  const [sendRawMedia, setSendRawMedia] = useState(cachedSettings.sendRawMediaToGemini ?? false);
  const [showBounds, setShowBounds] = useState(cachedSettings.showConfidenceBounds ?? true);
  const [system, setSystem] = useState<{
    geminiConfigured: boolean;
    geminiModel: string;
    runtime: string;
    ffmpegAvailable: boolean;
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
  } | null>(null);
  const [saved, setSaved] = useState(false);
  const [storageNotice, setStorageNotice] = useState('');
  const [clearingDb, setClearingDb] = useState(false);

  useEffect(() => {
    api.getSettings().then((res) => {
      if (res.user) {
        setName(res.user.name);
        setRole(res.user.role);
        setEmail(res.user.email);
        const prefs = JSON.parse(res.user.preferences_json || '{}');
        const nextRetain = typeof prefs.retainDays === 'number' ? prefs.retainDays : 90;
        const nextRaw = typeof prefs.sendRawMediaToGemini === 'boolean' ? prefs.sendRawMediaToGemini : false;
        const nextBounds = typeof prefs.showConfidenceBounds === 'boolean' ? prefs.showConfidenceBounds : true;
        setRetainDays(nextRetain);
        setSendRawMedia(nextRaw);
        setShowBounds(nextBounds);
        saveUserSettingsLocal({
          name: res.user.name,
          role: res.user.role,
          retainDays: nextRetain,
          sendRawMediaToGemini: nextRaw,
          showConfidenceBounds: nextBounds,
        });
      }
      setSystem(res.system);
    });
  }, []);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaved(false);
    await api.updateSettings({
      name,
      role,
      preferences: {
        retainDays,
        sendRawMediaToGemini: sendRawMedia,
        showConfidenceBounds: showBounds,
      },
    });
    saveUserSettingsLocal({
      name,
      role,
      retainDays,
      sendRawMediaToGemini: sendRawMedia,
      showConfidenceBounds: showBounds,
    });
    setSaved(true);
  };

  const handleExportSession = () => {
    const json = exportSavedSessionJson();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `truthlens-investigation-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setStorageNotice('Exported Local Storage investigation backup JSON.');
  };

  const handleStartNewSession = () => {
    resetSessionDraftsOnly();
    setStorageNotice('Local drafts and active investigation pointer reset. Ready for a new investigation.');
    navigate('/dashboard');
  };

  const handleClearLocalOnly = () => {
    clearAllSavedSessionData();
    setStorageNotice('Cleared all saved browser Local Storage data.');
  };

  const handleClearEverything = async () => {
    setClearingDb(true);
    try {
      clearAllSavedSessionData();
      await api.clearAllSessions();
      setStorageNotice('Cleared all browser Local Storage and server investigation records.');
      navigate('/dashboard');
    } finally {
      setClearingDb(false);
    }
  };

  return (
    <ConsoleShell
      title="Console Settings & System Health"
      subtitle="Investigator profile, theme preference, privacy controls, and ONNX/FFmpeg engine health"
    >
      <div className="grid lg:grid-cols-12 gap-6">
        <form
          onSubmit={handleSave}
          className="lg:col-span-7 bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-6 space-y-5"
        >
          <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
            Investigator Profile &amp; Privacy
          </h2>
          <div className="grid sm:grid-cols-2 gap-4 text-xs">
            <div>
              <label className="block text-slate-600 dark:text-slate-400 mb-1">Full Name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full bg-slate-50 dark:bg-[#162032] border border-slate-300 dark:border-slate-700 rounded px-3 py-2 text-slate-900 dark:text-slate-100"
              />
            </div>
            <div>
              <label className="block text-slate-600 dark:text-slate-400 mb-1">Role</label>
              <input
                type="text"
                value={role}
                onChange={(e) => setRole(e.target.value)}
                className="w-full bg-slate-50 dark:bg-[#162032] border border-slate-300 dark:border-slate-700 rounded px-3 py-2 text-slate-900 dark:text-slate-100"
              />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-slate-600 dark:text-slate-400 mb-1">Account Email</label>
              <input
                type="email"
                value={email}
                disabled
                className="w-full bg-slate-100 dark:bg-[#0B1120] border border-slate-200 dark:border-slate-800 rounded px-3 py-2 text-slate-500"
              />
            </div>
          </div>

          <div className="pt-4 border-t border-slate-200 dark:border-slate-800 space-y-3 text-xs">
            <h3 className="font-semibold text-slate-900 dark:text-slate-100">Appearance &amp; AI Guardrails</h3>
            <div className="flex items-center justify-between">
              <span className="text-slate-700 dark:text-slate-300">Console Colour Theme</span>
              <div className="inline-flex bg-slate-100 dark:bg-[#162032] border border-slate-200 dark:border-slate-700 rounded-md p-0.5">
                <button
                  type="button"
                  onClick={() => setTheme('light')}
                  className={`px-3 py-1 rounded text-xs ${
                    theme === 'light'
                      ? 'bg-blue-600 text-white font-medium'
                      : 'text-slate-600 dark:text-slate-400'
                  }`}
                >
                  Light
                </button>
                <button
                  type="button"
                  onClick={() => setTheme('dark')}
                  className={`px-3 py-1 rounded text-xs ${
                    theme === 'dark'
                      ? 'bg-blue-600 text-white font-medium'
                      : 'text-slate-600 dark:text-slate-400'
                  }`}
                >
                  Dark
                </button>
              </div>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-slate-700 dark:text-slate-300">Evidence retention window (days)</span>
              <input
                type="number"
                min={7}
                max={365}
                value={retainDays}
                onChange={(e) => setRetainDays(Number(e.target.value))}
                className="w-24 bg-slate-50 dark:bg-[#162032] border border-slate-300 dark:border-slate-700 rounded px-2.5 py-1 text-right font-mono text-slate-900 dark:text-slate-100"
              />
            </div>
            <label className="flex items-center justify-between cursor-pointer">
              <span className="text-slate-700 dark:text-slate-300">
                Allow sending raw media bytes to Gemini (off by default)
              </span>
              <input
                type="checkbox"
                checked={sendRawMedia}
                onChange={(e) => setSendRawMedia(e.target.checked)}
                className="accent-blue-600"
              />
            </label>
            <label className="flex items-center justify-between cursor-pointer">
              <span className="text-slate-700 dark:text-slate-300">
                Always display ML uncertainty &amp; model disagreement
              </span>
              <input
                type="checkbox"
                checked={showBounds}
                onChange={(e) => setShowBounds(e.target.checked)}
                className="accent-blue-600"
              />
            </label>
          </div>

          <div className="flex items-center justify-between pt-2">
            {saved ? (
              <span className="text-xs text-teal-700 dark:text-teal-400 flex items-center gap-1">
                <Check className="w-3.5 h-3.5" />
                Settings saved
              </span>
            ) : (
              <span />
            )}
            <button
              type="submit"
              className="px-4 py-2 text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white rounded-md transition-colors"
            >
              Save Preferences
            </button>
          </div>
        </form>

        <div className="lg:col-span-5 bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-6 space-y-4 h-fit">
          <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
            Backend, Pretrained ONNX &amp; Environment Health
          </h2>
          <dl className="space-y-3 text-xs">
            <div className="flex justify-between">
              <dt className="text-slate-500">Gemini Server Integration</dt>
              <dd
                className={`font-mono ${
                  system?.geminiConfigured ? 'text-teal-700 dark:text-teal-400' : 'text-amber-700 dark:text-amber-400'
                }`}
              >
                {system?.geminiConfigured ? 'Configured (server env)' : 'Local Fallback Active'}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-500">Active Gemini Model</dt>
              <dd className="font-mono text-slate-900 dark:text-slate-100">{system?.geminiModel || '—'}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-500">ViT Deepfake ONNX</dt>
              <dd
                className={`font-mono ${
                  system?.pretrainedModels?.vitAvailable
                    ? 'text-teal-700 dark:text-teal-400'
                    : 'text-amber-700 dark:text-amber-400'
                }`}
              >
                {system?.pretrainedModels?.vitAvailable ? 'Loaded locally' : 'On-demand download'}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-500">AASIST Anti-Spoofing ONNX</dt>
              <dd
                className={`font-mono ${
                  system?.pretrainedModels?.aasistAvailable
                    ? 'text-teal-700 dark:text-teal-400'
                    : 'text-amber-700 dark:text-amber-400'
                }`}
              >
                {system?.pretrainedModels?.aasistAvailable ? 'Loaded locally' : 'On-demand download'}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-500">UltraFace Face Detector ONNX</dt>
              <dd
                className={`font-mono ${
                  system?.pretrainedModels?.faceDetectorAvailable
                    ? 'text-teal-700 dark:text-teal-400'
                    : 'text-amber-700 dark:text-amber-400'
                }`}
              >
                {system?.pretrainedModels?.faceDetectorAvailable ? 'Loaded locally' : 'Missing'}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-500">FFmpeg / FFprobe Engine</dt>
              <dd className="font-mono text-teal-700 dark:text-teal-400">
                {system?.ffmpegAvailable ? 'Available' : 'Unavailable'}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-500">Server Runtime</dt>
              <dd className="font-mono text-slate-700 dark:text-slate-300">{system?.runtime || '—'}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-500">Evidence Storage Used</dt>
              <dd className="font-mono text-slate-900 dark:text-slate-100 tabular-nums">
                {system ? formatBytes(system.storageUsedBytes) : '—'}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-500">Max Upload Cap</dt>
              <dd className="font-mono text-slate-700 dark:text-slate-300 tabular-nums">
                {system ? formatBytes(system.maxUploadBytes) : '—'}
              </dd>
            </div>
          </dl>
          <p className="text-[11px] text-slate-500 pt-3 border-t border-slate-200 dark:border-slate-800">
            API credentials are managed strictly on the server environment and are never exposed to browser clients.
          </p>
        </div>

        {/* Local Storage & Investigation Lifecycle */}
        <div className="lg:col-span-12 bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-6 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div>
              <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                Browser Local Storage &amp; Investigation Lifecycle
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Investigations, drafts, dataset analyses, reports, and UI preferences persist automatically across browser refreshes.
              </p>
            </div>
            {storageNotice && (
              <span className="text-xs font-medium text-teal-700 dark:text-teal-400">{storageNotice}</span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={handleExportSession}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium bg-slate-50 dark:bg-[#162032] border border-slate-200 dark:border-slate-700 hover:border-blue-600 rounded-md text-slate-800 dark:text-slate-100 transition-colors"
            >
              <Download className="w-3.5 h-3.5" />
              Export Saved Investigation JSON
            </button>
            <button
              type="button"
              onClick={handleStartNewSession}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium bg-blue-600 hover:bg-blue-700 text-white rounded-md transition-colors"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Start New Investigation
            </button>
            <button
              type="button"
              onClick={handleClearLocalOnly}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium bg-slate-50 dark:bg-[#162032] border border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-950/30 rounded-md transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Clear Browser Local Storage
            </button>
            <button
              type="button"
              disabled={clearingDb}
              onClick={handleClearEverything}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold bg-rose-600 hover:bg-rose-700 disabled:opacity-50 text-white rounded-md transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />
              {clearingDb ? 'Clearing...' : 'Clear All Saved Data (Browser + Database)'}
            </button>
          </div>
        </div>
      </div>
    </ConsoleShell>
  );
};
