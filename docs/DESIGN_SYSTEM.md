# TruthLens AI — Design System

## 1. Visual Identity & Color Tokens (60-30-10 Discipline)
- **60% Primary Canvas**: `#090C10` (`--bg-canvas`) — deep neutral obsidian background for high-focus forensic analysis without neon glare.
- **30% Structural Surfaces**:
  - `--bg-panel`: `#0F141B` (1px hairline border `#1E2633`)
  - `--bg-elevated`: `#151C26` (1px hairline border `#263142`)
  - `--text-primary`: `#F1F5F9`
  - `--text-secondary`: `#94A3B8`
  - `--text-muted`: `#64748B`
- **10% Accent & Semantic Tokens** (never hue-only; always paired with explicit text labels):
  - `--accent-primary`: `#2563EB` / `#38BDF8` (active focal tabs, CTAs, interactive graph focus)
  - `--status-nominal`: `#10B981` (corroborated / consistent / low anomaly)
  - `--status-caution`: `#F59E0B` (inconclusive / requires human verification)
  - `--status-critical`: `#EF4444` (high-concern forensic anomaly / contradiction)

## 2. Typography (2+1 System)
- **Display / Headings**: `Plus Jakarta Sans` (600–700, `text-wrap: balance`)
- **Body / UI Prose**: `DM Sans` (400–500, 14px–16px, line-height 1.5–1.6)
- **Technical Telemetry / Hashes / IDs**: `JetBrains Mono` with `font-variant-numeric: tabular-nums`

## 3. Anti-Slop & Layout Rules
- **Single-Elevation Depth**: Hairline `1px` borders, no nested bordered card sandwiches, no thick left accent stripes (`border-l-4`).
- **Zero-Pill Metadata**: Metadata (dates, MIME types, case IDs, SHA-256 snippets, confidence notes) uses unboxed typography separated by `·` or `/`.
- **Single-Line Controls**: Buttons, nav items, and segmented filter tabs stay `whitespace-nowrap shrink-0`.
- **No Decorative Pulsing Dots**: Status indicators appear only for real live background tasks or verified semantic labels.
