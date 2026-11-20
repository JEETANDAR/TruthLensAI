import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight,
  AudioLines,
  FileSpreadsheet,
  FileText,
  Film,
  GitBranch,
  Image as ImageIcon,
  Moon,
  ShieldCheck,
  Sun,
} from 'lucide-react';
import { useTheme } from '../context/ThemeContext.tsx';
import { getActiveCaseId } from '../services/sessionStorage.ts';

const WORKFLOW_STAGES = [
  {
    step: '01',
    name: 'Ingest',
    summary: 'Compute immutable SHA-256 digests, validate MIME headers, and persist investigation data safely.',
  },
  {
    step: '02',
    name: 'Profile & Analyze',
    summary: 'Audit CSV/TSV quality, missing values, duplicates, ELA residuals, video deltas, and 24-band FFT spectra.',
  },
  {
    step: '03',
    name: 'Clean & Correlate',
    summary: 'Apply deterministic dataset repairs, deduplicate records, and cross-check timestamps and claims.',
  },
  {
    step: '04',
    name: 'Validate',
    summary: 'Verify post-fix completeness, review uncertainty margins, and evaluate benign alternative hypotheses.',
  },
  {
    step: '05',
    name: 'Report',
    summary: 'Inspect interactive before/after charts, record analyst sign-off, and export PDF & cleaned CSV files.',
  },
];

export const LandingPage: React.FC = () => {
  const { theme, toggleTheme } = useTheme();
  const [activeModality, setActiveModality] = useState<'dataset' | 'image' | 'video' | 'audio' | 'text'>('dataset');
  const activeSessionId = getActiveCaseId();

  const modalitySpecs = {
    dataset: {
      title: 'Structured Dataset Quality, Anomaly Detection & Automated Cleaning',
      signals: 'CSV / TSV Profiling · Missing Value & Duplicate Audit · Schema Type Checks · IQR / Z-Score Outliers',
      models: 'Deterministic Automated Cleaning Pipeline + Post-Fix Validation Suite + Quality Scoring (0–100)',
      epistemic: 'Quantifies before-and-after metrics transparently and preserves statistical outliers for analyst confirmation.',
    },
    image: {
      title: 'Image Compression, Noise & Deepfake Forensics',
      signals: 'Dual-Quality ELA (Q=90 & Q=75) · 8x8 Spatial Tile Matrix · Laplacian Noise Std · Double-JPEG & EXIF Audit',
      models: 'TL-ViT-Deepfake-v2-ONNX (ViT) · TL-ImgForensics-RF-v1 (25-Tree RF) · TL-ImgForensics-LR-v1',
      epistemic: 'Localizes compression hotspots only when 8x8 tile variance exceeds threshold; never fabricates bounding masks.',
    },
    video: {
      title: 'Video Keyframe, Luma Drift & A/V Sync Inspection',
      signals: 'FFprobe Stream Audit · Up to 12 Deterministic Keyframes · 16-Bin Luma Histogram Delta · A/V Desync Probe',
      models: 'Per-Frame Signal Extraction + Frame-Level ViT & RF Residual Scoring',
      epistemic: 'Explicitly reports exact sampled frame ratio (N of M total frames) so coverage limits remain transparent.',
    },
    audio: {
      title: 'Acoustic Spectrum & Voice Anti-Spoofing Analysis',
      signals: '16kHz PCM Decoding · 512-pt FFT 24-Band Spectrogram (0–8 kHz) · Clipping, Silence & Jump Detection',
      models: 'TL-AASIST-ONNX (Graph Attention Anti-Spoofing) + TL-AudSpoof-LR-v1 DSP Classifier',
      epistemic: 'Discloses ASVspoof vs In-The-Wild generalization gaps and VoIP codec caveats alongside every score.',
    },
    text: {
      title: 'Transcript, Subtitle & Claim Intelligence',
      signals: 'SRT/JSON/TXT Cue Parsing · Timeline Gap & Overlap Checks · Deterministic Numeric & Polarity Conflict Audit',
      models: 'Gemini Evidence-Grounded Synthesis (gemini-4-hydrogen) with Strict [EVID-*] Citations',
      epistemic: 'Treats matching durations as DURATION_COMPATIBLE (weak compatibility), never as proof of semantic alignment.',
    },
  };

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-[#0B1120] text-slate-900 dark:text-slate-100 transition-colors duration-150">
      <header className="border-b border-slate-200 dark:border-slate-800 bg-white/95 dark:bg-[#0B1120]/95 sticky top-0 z-30 backdrop-blur-sm">
        <div className="max-w-[1280px] mx-auto px-6 h-16 flex items-center justify-between gap-8">
          <Link
            to="/"
            className="font-display text-lg font-bold tracking-tight text-slate-900 dark:text-slate-100 whitespace-nowrap shrink-0"
          >
            TruthLens AI
          </Link>

          <nav className="hidden md:flex items-center gap-7 text-sm font-medium text-slate-600 dark:text-slate-400">
            <a href="#capabilities" className="hover:text-slate-900 dark:hover:text-slate-100 transition-colors whitespace-nowrap shrink-0">
              Capabilities
            </a>
            <a href="#workflow" className="hover:text-slate-900 dark:hover:text-slate-100 transition-colors whitespace-nowrap shrink-0">
              Workflow
            </a>
            <a href="#architecture" className="hover:text-slate-900 dark:hover:text-slate-100 transition-colors whitespace-nowrap shrink-0">
              Architecture
            </a>
            <a href="#traceability" className="hover:text-slate-900 dark:hover:text-slate-100 transition-colors whitespace-nowrap shrink-0">
              Traceability
            </a>
          </nav>

          <div className="flex items-center gap-2.5 shrink-0">
            <button
              type="button"
              onClick={toggleTheme}
              aria-label={theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
              className="p-2 rounded-md border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#111827] text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white transition-colors duration-150 shrink-0"
            >
              {theme === 'light' ? <Moon className="w-4 h-4" /> : <Sun className="w-4 h-4" />}
            </button>
            <Link
              to="/dashboard"
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-md transition-colors duration-150 whitespace-nowrap shrink-0"
            >
              Open Console
              <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          </div>
        </div>
      </header>

      {/* Hero Split */}
      <section className="border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120]">
        <div className="max-w-[1280px] mx-auto px-6 py-16 lg:py-20 grid lg:grid-cols-12 gap-10 items-stretch">
          <div className="lg:col-span-6 flex flex-col justify-center">
            <p className="text-xs font-mono text-cyan-700 dark:text-sky-400 mb-4">
              Data Quality &amp; Multimodal Forensics Platform
            </p>
            <h1 className="font-display text-4xl lg:text-5xl font-bold text-slate-900 dark:text-slate-100 leading-[1.12] text-balance mb-5">
              See Beyond the Surface. Verify What You See.
            </h1>
            <p className="text-base text-slate-600 dark:text-slate-400 leading-relaxed max-w-xl mb-8">
              TruthLens AI unifies multimodal media forensics, neural deepfake detection, tabular dataset quality
              auditing, and persistent investigation analytics into a transparent, report-ready intelligence platform.
            </p>

            <div className="flex flex-wrap items-center gap-4">
              <Link
                to="/dashboard"
                className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-md transition-colors duration-150 whitespace-nowrap"
              >
                {activeSessionId ? 'Resume Active Investigation' : 'Start Investigation'}
                <ArrowRight className="w-4 h-4" />
              </Link>
              <Link
                to="/history"
                className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-medium text-slate-800 dark:text-slate-100 bg-slate-50 dark:bg-[#111827] border border-slate-300 dark:border-slate-700 hover:border-blue-600 dark:hover:border-sky-400 rounded-md transition-colors duration-150 whitespace-nowrap"
              >
                View Saved Investigations
              </Link>
            </div>
          </div>

          <div className="lg:col-span-6 flex">
            <div className="w-full rounded-lg overflow-hidden border border-slate-200 dark:border-slate-800 bg-slate-900 flex flex-col">
              <div className="relative flex-1 min-h-[280px] bg-slate-900">
                <img
                  src="/src/assets/images/hero_forensic_console_1795063110629.jpg"
                  alt="TruthLens AI optical data intelligence and spectral signal analysis instrument"
                  referrerPolicy="no-referrer"
                  className="w-full h-full object-cover"
                />
              </div>
              <div className="px-4 py-3 bg-white dark:bg-[#111827] border-t border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600 dark:text-slate-400">
                <span className="font-medium text-slate-900 dark:text-slate-200">Zero Fabricated Metrics</span>
                <span className="font-mono text-slate-500">ONNX &amp; Classical ML · Dataset Auditing · Persistent Investigations</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Product Overview Strip */}
      <section className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#111827]/40">
        <div className="max-w-[1280px] mx-auto px-6 py-10 grid sm:grid-cols-2 lg:grid-cols-4 gap-8">
          <div>
            <p className="font-mono text-xs text-slate-500 mb-1">01 · Persistent Workspace</p>
            <p className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">Auto-Saved Local &amp; DB State</p>
            <p className="text-xs text-slate-600 dark:text-slate-400 mt-1 leading-relaxed">
              Every investigation, evidence file, draft note, analysis output, and report restores seamlessly after refresh.
            </p>
          </div>
          <div>
            <p className="font-mono text-xs text-slate-500 mb-1">02 · Automated Data Repair</p>
            <p className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">Before &amp; After Quality Reports</p>
            <p className="text-xs text-slate-600 dark:text-slate-400 mt-1 leading-relaxed">
              Detects missing cells, duplicates, schema errors, and statistical anomalies with verified cleaned CSV export.
            </p>
          </div>
          <div>
            <p className="font-mono text-xs text-slate-500 mb-1">03 · Neural &amp; Signal Forensics</p>
            <p className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">ViT, AASIST &amp; RF Detectors</p>
            <p className="text-xs text-slate-600 dark:text-slate-400 mt-1 leading-relaxed">
              Runs local ONNX neural detectors and classical classifiers with uncalibrated score disclosures.
            </p>
          </div>
          <div>
            <p className="font-mono text-xs text-slate-500 mb-1">04 · Executive Reporting</p>
            <p className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">Plain-English &amp; Visual PDF</p>
            <p className="text-xs text-slate-600 dark:text-slate-400 mt-1 leading-relaxed">
              Every chart, score bar, validation pass, and recommendation traces directly back to real computed evidence.
            </p>
          </div>
        </div>
      </section>

      {/* Interactive Multimodal Investigation Capabilities */}
      <section id="capabilities" className="border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120]">
        <div className="max-w-[1280px] mx-auto px-6 py-16">
          <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4 mb-8">
            <div>
              <h2 className="font-display text-2xl lg:text-3xl font-bold text-slate-900 dark:text-slate-100">
                Data &amp; Media Intelligence Capabilities
              </h2>
              <p className="text-sm text-slate-600 dark:text-slate-400 mt-1.5 max-w-2xl">
                Inspect how TruthLens profiles tabular datasets and analyzes images, video, audio, and text documents.
              </p>
            </div>
            <div className="inline-flex flex-wrap items-center p-1 bg-slate-100 dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-md gap-1">
              {(
                [
                  { id: 'dataset', label: 'Datasets', icon: FileSpreadsheet },
                  { id: 'image', label: 'Images', icon: ImageIcon },
                  { id: 'video', label: 'Video', icon: Film },
                  { id: 'audio', label: 'Audio', icon: AudioLines },
                  { id: 'text', label: 'Text', icon: FileText },
                ] as const
              ).map((tab) => {
                const Icon = tab.icon;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setActiveModality(tab.id)}
                    className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded transition-colors duration-150 whitespace-nowrap shrink-0 ${
                      activeModality === tab.id
                        ? 'bg-blue-600 text-white'
                        : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    {tab.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="bg-slate-50 dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-lg p-6 lg:p-8 grid lg:grid-cols-3 gap-8">
            <div className="lg:col-span-2 space-y-4">
              <h3 className="font-display text-xl font-semibold text-slate-900 dark:text-slate-100">
                {modalitySpecs[activeModality].title}
              </h3>
              <div className="space-y-3 text-sm">
                <div>
                  <p className="text-xs font-medium text-slate-500 mb-1">Extracted Signals &amp; Checks</p>
                  <p className="font-mono text-xs text-slate-900 dark:text-slate-100">
                    {modalitySpecs[activeModality].signals}
                  </p>
                </div>
                <div>
                  <p className="text-xs font-medium text-slate-500 mb-1">Processing &amp; Scoring Engine</p>
                  <p className="text-slate-700 dark:text-slate-300">{modalitySpecs[activeModality].models}</p>
                </div>
              </div>
            </div>
            <div className="border-t lg:border-t-0 lg:border-l border-slate-200 dark:border-slate-800 pt-4 lg:pt-0 lg:pl-8 flex flex-col justify-between">
              <div>
                <p className="text-xs font-semibold text-cyan-700 dark:text-sky-400 mb-1.5">Methodological Guardrail</p>
                <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
                  {modalitySpecs[activeModality].epistemic}
                </p>
              </div>
              <Link
                to={
                  activeSessionId
                    ? `/investigations/${activeSessionId}/${activeModality}`
                    : '/dashboard'
                }
                className="mt-5 inline-flex items-center gap-1.5 text-xs font-semibold text-blue-600 dark:text-sky-400 hover:underline whitespace-nowrap"
              >
                {activeSessionId ? 'Open Investigation Lab' : 'Start Investigation in Console'}
                <ArrowRight className="w-3.5 h-3.5" />
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* Workflow */}
      <section id="workflow" className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#0B1120]">
        <div className="max-w-[1280px] mx-auto px-6 py-16">
          <h2 className="font-display text-2xl lg:text-3xl font-bold text-slate-900 dark:text-slate-100 mb-2">
            End-to-End Intelligence Workflow
          </h2>
          <p className="text-sm text-slate-600 dark:text-slate-400 mb-10 max-w-2xl">
            Every uploaded dataset and media artifact progresses deterministically from ingestion to validated reports.
          </p>
          <div className="grid md:grid-cols-5 gap-px bg-slate-200 dark:bg-slate-800 border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
            {WORKFLOW_STAGES.map((stage) => (
              <div key={stage.step} className="bg-white dark:bg-[#111827] p-5 flex flex-col justify-between">
                <div>
                  <span className="font-mono text-xs font-semibold text-blue-600 dark:text-sky-400">{stage.step}</span>
                  <h3 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100 mt-1 mb-2">
                    {stage.name}
                  </h3>
                  <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">{stage.summary}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Architecture */}
      <section id="architecture" className="border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827]/30">
        <div className="max-w-[1280px] mx-auto px-6 py-16 grid lg:grid-cols-2 gap-10">
          <div className="space-y-4">
            <div className="flex items-center gap-2 text-xs font-mono text-cyan-700 dark:text-sky-400">
              <GitBranch className="w-4 h-4" />
              <span>Multi-Agent Correlation &amp; Grounded Copilot</span>
            </div>
            <h2 className="font-display text-2xl font-bold text-slate-900 dark:text-slate-100">
              Correlate Claims, Data Quality &amp; Physical Signals
            </h2>
            <p className="text-sm text-slate-600 dark:text-slate-400 leading-relaxed">
              TruthLens AI coordinates specialized agents across datasets, text, audio, video, and images—separating
              container compatibility from semantic alignment and keeping every observation traceable.
            </p>
          </div>
          <div className="space-y-4">
            <div className="flex items-center gap-2 text-xs font-mono text-teal-700 dark:text-teal-400">
              <ShieldCheck className="w-4 h-4" />
              <span>Strict Evidence Traceability</span>
            </div>
            <h2 className="font-display text-2xl font-bold text-slate-900 dark:text-slate-100">
              Zero Fabricated Findings or Uncited Claims
            </h2>
            <p className="text-sm text-slate-600 dark:text-slate-400 leading-relaxed">
              Every chart, quality score, validation check, and Copilot answer reads strictly from persisted SQLite
              records and browser Local Storage state.
            </p>
          </div>
        </div>
      </section>

      {/* Evidence Traceability Table */}
      <section id="traceability" className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#0B1120]">
        <div className="max-w-[1280px] mx-auto px-6 py-16">
          <h2 className="font-display text-2xl font-bold text-slate-900 dark:text-slate-100 mb-6">
            Epistemic Layering &amp; Technical Capabilities
          </h2>
          <div className="overflow-x-auto border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-[#111827]">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 dark:bg-[#162032] text-slate-600 dark:text-slate-300 border-b border-slate-200 dark:border-slate-800">
                <tr>
                  <th className="py-3 px-4 font-semibold">Layer</th>
                  <th className="py-3 px-4 font-semibold">Execution Engine</th>
                  <th className="py-3 px-4 font-semibold">Recorded Output</th>
                  <th className="py-3 px-4 font-semibold">Standard</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                <tr>
                  <td className="py-3 px-4 font-medium text-slate-900 dark:text-slate-100">Dataset Cleaning &amp; Signals</td>
                  <td className="py-3 px-4 font-mono text-slate-600 dark:text-slate-400">CSV/TSV Profiler · Sharp · FFmpeg · FFT</td>
                  <td className="py-3 px-4 text-slate-600 dark:text-slate-400">Cleaned CSV, Before/After metrics, ELA &amp; spectral maps</td>
                  <td className="py-3 px-4 font-medium text-teal-700 dark:text-teal-400">Deterministic &amp; Reproducible</td>
                </tr>
                <tr>
                  <td className="py-3 px-4 font-medium text-slate-900 dark:text-slate-100">Trained &amp; Pretrained ML</td>
                  <td className="py-3 px-4 font-mono text-slate-600 dark:text-slate-400">TL-ViT-Deepfake-v2 · TL-AASIST · RF · LR</td>
                  <td className="py-3 px-4 text-slate-600 dark:text-slate-400">Raw score, feature weights, uncertainty notes</td>
                  <td className="py-3 px-4 font-medium text-amber-700 dark:text-amber-400">Probabilistic Signal Only</td>
                </tr>
                <tr>
                  <td className="py-3 px-4 font-medium text-slate-900 dark:text-slate-100">AI Investigation Synthesis</td>
                  <td className="py-3 px-4 font-mono text-slate-600 dark:text-slate-400">Gemini 4 Hydrogen + 9-Agent DAG</td>
                  <td className="py-3 px-4 text-slate-600 dark:text-slate-400">Correlations, benign alternatives, cited answers</td>
                  <td className="py-3 px-4 font-medium text-cyan-700 dark:text-sky-400">Requires [EVID] Citations</td>
                </tr>
                <tr>
                  <td className="py-3 px-4 font-medium text-slate-900 dark:text-slate-100">Analyst Sign-Off</td>
                  <td className="py-3 px-4 font-mono text-slate-600 dark:text-slate-400">Report Validation &amp; PDFKit Export</td>
                  <td className="py-3 px-4 text-slate-600 dark:text-slate-400">Signed determination, recommendations, audit log</td>
                  <td className="py-3 px-4 font-medium text-slate-900 dark:text-slate-100">Final Authority</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <footer className="max-w-[1280px] mx-auto px-6 py-8 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-slate-500">
        <span>TruthLens AI · Data &amp; Multimodal Intelligence Platform</span>
        <div className="flex items-center gap-6">
          <Link to="/dashboard" className="hover:text-slate-900 dark:hover:text-slate-100">Dashboard</Link>
          <Link to="/models" className="hover:text-slate-900 dark:hover:text-slate-100">Model Evaluation</Link>
          <Link to="/agents" className="hover:text-slate-900 dark:hover:text-slate-100">Agent Activity</Link>
          <Link to="/settings" className="hover:text-slate-900 dark:hover:text-slate-100">Settings</Link>
        </div>
      </footer>
    </div>
  );
};
