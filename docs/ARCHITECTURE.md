# TruthLens AI — Application Architecture

```mermaid
flowchart TB
  subgraph Client["React + Vite + Tailwind Frontend (SPA)"]
    UI["15 Forensic Views & Interactive Viewers"]
    RQ["TanStack Query / Fetch State"]
  end

  subgraph Server["Express Modular Monolith (Port 3000)"]
    API["REST API Routes (/api/*)"]
    ORCH["Dependency-Aware Multi-Agent Orchestrator"]
    subgraph Forensics["Local Forensic Signal Engine"]
      IMG["Image Pipeline (Sharp + EXIF)"]
      VID["Video Pipeline (FFprobe + FFmpeg + Sharp)"]
      AUD["Audio Pipeline (FFmpeg PCM + FFT DSP)"]
      TXT["Text Pipeline (Parser + SRT/JSON)"]
    end
    ML["Trained ML Inference (RF & Logistic Regression)"]
    AI["Gemini AI Service (@google/genai / gemini-4-hydrogen)"]
    PDF["PDFKit Forensic Report Builder"]
  end

  subgraph Persistence["Local Storage & Database"]
    DB[("SQLite (truthlens.db)")]
    ORIG["storage/uploads/ (Immutable Evidence)"]
    ART["storage/artifacts/ (ELA PNGs, Keyframes, Reports)"]
    MOD["models/ (Trained Weights & Eval Metrics)"]
  end

  Client <--> API
  API --> ORCH
  ORCH --> Forensics
  Forensics --> ML
  ORCH --> AI
  API --> PDF
  Server <--> DB
  Forensics --> ORIG
  Forensics --> ART
  ML <--> MOD
```

## Module Boundaries
- `server/db/`: Schema DDL, migrations, seed dataset generator, typed query helpers.
- `server/forensics/`: Image, Video, Audio, and Text pure signal extraction modules.
- `server/ml/`: Training pipeline, feature scaler, Random Forest & Logistic Regression inference, held-out evaluator.
- `server/agents/`: 9 specialized agents + dependency-aware DAG orchestrator.
- `server/ai/`: Server-only `@google/genai` client (`gemini-4-hydrogen`), structured JSON schemas, evidence retrieval for Copilot.
- `server/reports/`: PDFKit binary report builder.
- `server/routes/`: Modular Express routers for investigations, evidence, analysis, agents, copilot, models, reports, settings.
- `src/`: React Router SPA with custom design tokens, interactive forensic viewers, and Recharts visualizations.
