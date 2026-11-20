import { Component, ErrorInfo, ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { ThemeProvider } from './context/ThemeContext.tsx';
import { ViewModeProvider } from './context/ViewModeContext.tsx';
import { AgentsPage } from './pages/AgentsPage.tsx';
import { AudioForensicsPage } from './pages/AudioForensicsPage.tsx';
import { CopilotPage } from './pages/CopilotPage.tsx';
import { CrossModalPage } from './pages/CrossModalPage.tsx';
import { DashboardPage } from './pages/DashboardPage.tsx';
import { DatasetEvaluationPage } from './pages/DatasetEvaluationPage.tsx';
import { DatasetPage } from './pages/DatasetPage.tsx';
import { DiagnosticsPage } from './pages/DiagnosticsPage.tsx';
import { EvidenceDetailPage } from './pages/EvidenceDetailPage.tsx';
import { HistoryPage } from './pages/HistoryPage.tsx';
import { ImageForensicsPage } from './pages/ImageForensicsPage.tsx';
import { LandingPage } from './pages/LandingPage.tsx';
import { ModelsPage } from './pages/ModelsPage.tsx';
import { ReportsPage } from './pages/ReportsPage.tsx';
import { SettingsPage } from './pages/SettingsPage.tsx';
import { TextIntelligencePage } from './pages/TextIntelligencePage.tsx';
import { TimelinePage } from './pages/TimelinePage.tsx';
import { UploadStudioPage } from './pages/UploadStudioPage.tsx';
import { VideoForensicsPage } from './pages/VideoForensicsPage.tsx';
import { WorkspacePage } from './pages/WorkspacePage.tsx';

class RouteErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean; message: string }
> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false, message: '' };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, message: error?.message || 'Unexpected rendering error' };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo) {
    // Handled by fallback UI
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-slate-50 dark:bg-[#0B1120] flex items-center justify-center p-6">
          <div className="max-w-md w-full bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-6 text-center space-y-4">
            <h1 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
              Workspace Module Interrupted
            </h1>
            <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
              A view module failed to load ({this.state.message}). Reloading will fetch the latest bundle cleanly.
            </p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="px-4 py-2 text-xs font-semibold rounded-md bg-blue-600 hover:bg-blue-700 text-white transition-colors"
            >
              Reload Workspace
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  return (
    <ThemeProvider>
      <ViewModeProvider>
        <BrowserRouter>
          <RouteErrorBoundary>
            <Routes>
              <Route path="/" element={<LandingPage />} />
              <Route path="/dashboard" element={<DashboardPage />} />
              <Route path="/investigations" element={<HistoryPage />} />
              <Route path="/investigations/:id" element={<WorkspacePage />} />
              <Route path="/investigations/:id/upload" element={<UploadStudioPage />} />
              <Route path="/investigations/:id/timeline" element={<TimelinePage />} />
              <Route path="/investigations/:id/evidence/:evidenceId" element={<EvidenceDetailPage />} />
              <Route path="/investigations/:id/image/:evidenceId?" element={<ImageForensicsPage />} />
              <Route path="/investigations/:id/video/:evidenceId?" element={<VideoForensicsPage />} />
              <Route path="/investigations/:id/audio/:evidenceId?" element={<AudioForensicsPage />} />
              <Route path="/investigations/:id/text/:evidenceId?" element={<TextIntelligencePage />} />
              <Route path="/investigations/:id/dataset/:evidenceId?" element={<DatasetPage />} />
              <Route path="/investigations/:id/correlate" element={<CrossModalPage />} />
              <Route path="/investigations/:id/copilot" element={<CopilotPage />} />
              <Route path="/investigations/:id/reports" element={<ReportsPage />} />
              <Route path="/agents" element={<AgentsPage />} />
              <Route path="/models" element={<ModelsPage />} />
              <Route path="/dataset-evaluation" element={<DatasetEvaluationPage />} />
              <Route path="/diagnostics" element={<DiagnosticsPage />} />
              <Route path="/history" element={<HistoryPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </RouteErrorBoundary>
        </BrowserRouter>
      </ViewModeProvider>
    </ThemeProvider>
  );
}
