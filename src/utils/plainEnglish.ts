import { ViewMode } from '../services/sessionStorage.ts';
import { CorrelationRow, ForensicIndicator } from '../types/forensics.ts';

export type VerdictDisplayLabel =
  | 'Likely Genuine'
  | 'Possibly AI-Generated or Manipulated'
  | 'Inconclusive — Needs Review';

export interface VerdictDisplayMeta {
  label: VerdictDisplayLabel;
  shortExplanation: string;
  toneTextClass: string;
  toneBgClass: string;
  toneBorderClass: string;
  reliabilityText: string;
}

export function resolveVerdictMeta(
  confidenceLevel?: string,
  verdictObj?: {
    label?: string;
    plainSummary?: string;
    reliabilityLevel?: string;
    aiRawScorePct?: number | null;
    genuineRawScorePct?: number | null;
    scoresCalibrated?: boolean;
  },
): VerdictDisplayMeta {
  const label = (
    verdictObj?.label === 'Likely Genuine' ||
    verdictObj?.label === 'Possibly AI-Generated or Manipulated' ||
    verdictObj?.label === 'Inconclusive — Needs Review'
      ? verdictObj.label
      : confidenceLevel === 'requires_review'
      ? 'Possibly AI-Generated or Manipulated'
      : confidenceLevel === 'low_anomaly'
      ? 'Likely Genuine'
      : 'Inconclusive — Needs Review'
  ) as VerdictDisplayLabel;

  const reliability = verdictObj?.reliabilityLevel || (confidenceLevel === 'requires_review' ? 'Moderate' : 'Limited');

  if (label === 'Possibly AI-Generated or Manipulated') {
    return {
      label,
      shortExplanation:
        verdictObj?.plainSummary ||
        'Our checks found unusual compression patterns, digital artifacts, or mismatches between files that deserve closer human review.',
      toneTextClass: 'text-rose-700 dark:text-rose-400',
      toneBgClass: 'bg-rose-50 dark:bg-rose-950/30',
      toneBorderClass: 'border-rose-200 dark:border-rose-800',
      reliabilityText: `${reliability} Reliability · Uncalibrated Raw Score`,
    };
  }
  if (label === 'Inconclusive — Needs Review') {
    return {
      label,
      shortExplanation:
        verdictObj?.plainSummary ||
        'Some files show moderate differences that could come from normal social-media saving or minor editing. A human check is recommended.',
      toneTextClass: 'text-amber-700 dark:text-amber-400',
      toneBgClass: 'bg-amber-50 dark:bg-amber-950/30',
      toneBorderClass: 'border-amber-200 dark:border-amber-800',
      reliabilityText: `${reliability} Reliability · Uncalibrated Raw Score`,
    };
  }
  return {
    label,
    shortExplanation:
      verdictObj?.plainSummary ||
      'No strong signs of AI generation or tampering were detected in these files, though automated checks cannot guarantee 100% authenticity.',
    toneTextClass: 'text-teal-700 dark:text-teal-400',
    toneBgClass: 'bg-teal-50 dark:bg-teal-950/30',
    toneBorderClass: 'border-teal-200 dark:border-teal-800',
    reliabilityText: `${reliability} Reliability · Uncalibrated Raw Score`,
  };
}

export function translateModelDisplay(modelId: string, viewMode: ViewMode): { name: string; role: string } {
  if (viewMode === 'advanced') {
    return { name: modelId, role: 'Model ID' };
  }
  if (modelId.includes('ViT')) {
    return { name: 'Visual AI Image Pattern Checker', role: 'Deepfake Image Neural Detector' };
  }
  if (modelId.includes('AASIST')) {
    return { name: 'Voice Spoofing Neural Checker', role: 'Synthetic Speech Detector' };
  }
  if (modelId.includes('RF')) {
    return { name: 'Image Texture & Compression Checker', role: 'Visual Artifact Classifier' };
  }
  if (modelId.includes('AudSpoof')) {
    return { name: 'Audio Frequency Pattern Checker', role: 'Sound Spectrum Classifier' };
  }
  if (modelId.includes('LR')) {
    return { name: 'Image Consistency Screener', role: 'Baseline Statistical Check' };
  }
  return { name: 'Automated Pattern Detector', role: 'Media Classifier' };
}

export function translatePredictionLabelSimple(label: string): string {
  if (label === 'elevated_anomaly') return 'Flagged Unusual Patterns';
  if (label === 'inconclusive_review') return 'Uncertain — Needs Review';
  return 'Looks Consistent with Normal Files';
}

export function translateIndicatorForView(
  ind: ForensicIndicator,
  viewMode: ViewMode,
): { title: string; detail: string; categoryLabel: string } {
  if (viewMode === 'advanced') {
    return { title: ind.title, detail: ind.detail, categoryLabel: ind.category };
  }

  const lower = `${ind.title} ${ind.category} ${ind.detail}`.toLowerCase();

  if (lower.includes('double-jpeg') || lower.includes('recompression') || lower.includes('quantization')) {
    return {
      title: 'Image Was Saved or Re-encoded Multiple Times',
      detail:
        'This picture shows signs of being saved more than once. This often happens after editing, or simply when shared through social media or messaging apps.',
      categoryLabel: 'Saving & Re-encoding History',
    };
  }
  if (lower.includes('ela') || lower.includes('tile variance') || lower.includes('residual')) {
    return {
      title: ind.severity === 'info' ? 'Even Image Compression Across Photo' : 'Uneven Quality Area Detected in Image',
      detail:
        ind.severity === 'info'
          ? 'The image compression looks uniform across the picture with no obvious pasted regions.'
          : 'One part of this photo compresses differently from the rest, which can happen when an object or face is edited or pasted in.',
      categoryLabel: 'Visual Editing Check',
    };
  }
  if (lower.includes('ai software') || lower.includes('c2pa') || lower.includes('metadata') || lower.includes('exif')) {
    return {
      title: ind.severity === 'warning' || ind.severity === 'critical' ? 'Missing Camera Info or AI Generator Tag Found' : 'Camera Details Present',
      detail:
        ind.severity === 'info'
          ? 'Standard camera details (such as device make and model) are present in the file metadata.'
          : ind.detail.includes('AI') || ind.detail.includes('generator')
          ? 'Hidden file details mention AI generation software or editing tools.'
          : 'Normal camera details were missing or stripped from this file, which happens when apps remove photo info or when images are generated synthetically.',
      categoryLabel: 'File Details Check',
    };
  }
  if (lower.includes('noise') || lower.includes('block artifact')) {
    return {
      title: ind.severity === 'info' ? 'Natural Camera Grain Looks Consistent' : 'Unusual Pixel Smoothness or Grid Pattern',
      detail:
        ind.severity === 'info'
          ? 'Natural background camera texture looks steady across the image.'
          : 'The image texture looks unusually smooth or blocky in places compared to a typical unedited camera photo.',
      categoryLabel: 'Pixel Texture Check',
    };
  }
  if (lower.includes('temporal') || lower.includes('luma') || lower.includes('frame')) {
    return {
      title: ind.severity === 'info' ? 'Smooth Frame-to-Frame Motion' : 'Sudden Visual Jump Between Video Frames',
      detail:
        ind.severity === 'info'
          ? 'Checked video frames change smoothly without suspicious frame-level jumps.'
          : 'One or more moments in the video show an abrupt change in brightness or sharpness between frames, which can happen during splicing or face-swapping.',
      categoryLabel: 'Video Frame Check',
    };
  }
  if (lower.includes('clipping') || lower.includes('flatness') || lower.includes('spectral') || lower.includes('silence') || lower.includes('spoof') || lower.includes('aasist')) {
    return {
      title: ind.severity === 'info' ? 'Audio Sound Profile Looks Normal' : 'Unusual Sound Pattern Detected in Audio',
      detail:
        ind.severity === 'info'
          ? 'The audio frequencies and volume flow steadily without suspicious digital gaps.'
          : 'Part of the audio has flat or robotic frequency patterns or sudden pauses, which can happen with AI voice cloning or heavy noise filtering.',
      categoryLabel: 'Voice & Sound Check',
    };
  }
  if (lower.includes('subtitle') || lower.includes('srt') || lower.includes('gap') || lower.includes('transcript') || lower.includes('contradict')) {
    return {
      title: ind.severity === 'info' ? 'Text & Timing Look Consistent' : 'Timing or Wording Mismatch Found',
      detail:
        ind.severity === 'info'
          ? 'The text timestamps and statements appear internally consistent.'
          : 'Statements or timestamps in the text do not line up cleanly with the other uploaded files.',
      categoryLabel: 'Text & Timing Check',
    };
  }

  return {
    title: ind.title,
    detail: ind.detail,
    categoryLabel: ind.category,
  };
}

export function translateCorrelationForView(
  corr: CorrelationRow,
  sourceName: string,
  targetName: string,
  viewMode: ViewMode,
): { label: string; summary: string } {
  if (viewMode === 'advanced') {
    return { label: corr.relationship_type, summary: corr.summary };
  }
  if (corr.relationship_type === 'CONTRADICTS') {
    return {
      label: 'Conflict Found',
      summary: `${sourceName} and ${targetName} disagree in length, spoken words, or timestamps.`,
    };
  }
  if (corr.relationship_type === 'WEAKENS') {
    return {
      label: 'Minor Difference',
      summary: `${sourceName} and ${targetName} show different export quality or differing details — they may come from different edits or saves.`,
    };
  }
  if (corr.relationship_type === 'SUPPORTS') {
    return {
      label: 'Consistent',
      summary: `${sourceName} and ${targetName} match well in formatting, keywords, or technical baseline.`,
    };
  }
  return {
    label: 'Same Length Only (Unverified Content)',
    summary: `${sourceName} and ${targetName} have similar lengths, but length alone does not prove they belong together.`,
  };
}
