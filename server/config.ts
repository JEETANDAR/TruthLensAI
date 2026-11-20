import fs from 'fs';
import path from 'path';

export const ROOT_DIR = process.cwd();
export const STORAGE_DIR = path.join(ROOT_DIR, 'storage');
export const UPLOADS_DIR = path.join(STORAGE_DIR, 'uploads');
export const ARTIFACTS_DIR = path.join(STORAGE_DIR, 'artifacts');
export const REPORTS_DIR = path.join(STORAGE_DIR, 'reports');
export const DATASETS_UPLOAD_DIR = path.join(STORAGE_DIR, 'datasets');
export const MODELS_DIR = path.join(ROOT_DIR, 'models');
export const PRETRAINED_MODELS_DIR = path.join(MODELS_DIR, 'pretrained');
export const DATASETS_DIR = path.join(ROOT_DIR, 'datasets');
export const DB_PATH = path.join(STORAGE_DIR, 'truthlens.db');

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MB
export const SUBPROCESS_TIMEOUT_MS = 25_000;

export const ALLOWED_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.mp4',
  '.mov',
  '.wav',
  '.mp3',
  '.flac',
  '.ogg',
  '.m4a',
  '.txt',
  '.json',
  '.srt',
  '.csv',
  '.tsv',
]);

export const EXTENSION_TO_MODALITY: Record<string, 'image' | 'video' | 'audio' | 'text' | 'dataset'> = {
  '.jpg': 'image',
  '.jpeg': 'image',
  '.png': 'image',
  '.webp': 'image',
  '.mp4': 'video',
  '.mov': 'video',
  '.wav': 'audio',
  '.mp3': 'audio',
  '.flac': 'audio',
  '.ogg': 'audio',
  '.m4a': 'audio',
  '.txt': 'text',
  '.json': 'text',
  '.srt': 'text',
  '.csv': 'dataset',
  '.tsv': 'dataset',
};

export function ensureDirectories(): void {
  for (const dir of [STORAGE_DIR, UPLOADS_DIR, ARTIFACTS_DIR, REPORTS_DIR, DATASETS_UPLOAD_DIR, MODELS_DIR, PRETRAINED_MODELS_DIR, DATASETS_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function resolveSafeStoragePath(relativeOrAbs: string, baseDir = STORAGE_DIR): string {
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(resolvedBase, relativeOrAbs);
  if (!resolvedTarget.startsWith(resolvedBase + path.sep) && resolvedTarget !== resolvedBase) {
    throw new Error('Path traversal attempt blocked');
  }
  return resolvedTarget;
}
