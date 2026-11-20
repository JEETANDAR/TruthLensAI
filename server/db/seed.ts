import fs from 'fs';
import path from 'path';
import { UPLOADS_DIR, ensureDirectories } from '../config.ts';
import { getDb } from './database.ts';
import { ensureTrainedModels } from '../ml/trainer.ts';

/**
 * Initializes directories, trained local ML checkpoints, default operator profile,
 * and cleans up any legacy demo/sample fixture rows without touching real user data.
 */
export async function initializeSystemDefaults(): Promise<void> {
  ensureDirectories();
  ensureTrainedModels();

  const db = getDb();
  const now = new Date().toISOString();

  // Remove any legacy demo/synthetic fixture investigations or files
  db.prepare(`DELETE FROM evidence WHERE is_demo_fixture = 1 OR id LIKE 'EVID-DEMO-%'`).run();
  db.prepare(`DELETE FROM investigations WHERE id IN ('INV-2026-041', 'INV-2026-038')`).run();

  if (fs.existsSync(UPLOADS_DIR)) {
    for (const f of fs.readdirSync(UPLOADS_DIR)) {
      if (f.startsWith('demo_')) {
        try {
          fs.unlinkSync(path.join(UPLOADS_DIR, f));
        } catch {
          // ignore cleanup lock errors
        }
      }
    }
  }

  const existingLead = db.prepare(`SELECT id, name FROM users WHERE id = 'USR-LEAD-01'`).get() as
    | { id: string; name: string }
    | undefined;

  if (!existingLead) {
    const anyUser = db.prepare(`SELECT COUNT(*) as c FROM users`).get() as { c: number };
    if (anyUser.c === 0) {
      db.prepare(
        `INSERT INTO users (id, name, email, role, avatar_url, preferences_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'USR-LEAD-01',
        'Forensic Analyst',
        'analyst@truthlens.local',
        'Data & Digital Forensics Analyst',
        '',
        JSON.stringify({ retainDays: 90, sendRawMediaToGemini: false, showConfidenceBounds: true }),
        now,
      );
    }
  } else if (existingLead.name === 'Dr. Elena Vance') {
    db.prepare(
      `UPDATE users SET name = ?, email = ?, role = ?, avatar_url = '' WHERE id = 'USR-LEAD-01'`,
    ).run('Forensic Analyst', 'analyst@truthlens.local', 'Data & Digital Forensics Analyst');
  }
}

export const seedDatabaseIfEmpty = initializeSystemDefaults;
