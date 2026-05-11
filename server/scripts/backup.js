/**
 * Database Backup Script
 *
 * Schedule via cron for nightly backups; keeps the last 30 by default.
 *
 * IMPORTANT: A plain `fs.copyFileSync` of a live WAL database can produce a
 * torn snapshot — concurrent writes mid-copy mean the resulting file is
 * missing pages or has unflushed WAL entries. We therefore shell out to the
 * `sqlite3` CLI's `.backup` command (which uses SQLite's online backup API
 * and is the canonical safe way to hot-copy a WAL DB).
 *
 * If the `sqlite3` CLI is not available we fall back to:
 *   1. PRAGMA wal_checkpoint(TRUNCATE) — flushes WAL into the main DB file
 *   2. fs.copyFileSync of the main DB
 * which is correct as long as no writes happen between (1) and (2). The
 * Node-side `sqlite3` module's `.backup()` isn't used here because it isn't
 * exposed on the npm package's API.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'attendance.db');
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, '..', 'backups');
const KEEP = Number(process.env.BACKUP_KEEP) || 30;

function which(cmd) {
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], {
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
    return out.split(/\r?\n/)[0] || null;
  } catch {
    return null;
  }
}

function safeBackup(src, dest) {
  // Path 1 — the sqlite3 CLI is available. This is the canonical safe path.
  const sqlite3Bin = which('sqlite3');
  if (sqlite3Bin) {
    execFileSync(sqlite3Bin, [src, `.backup '${dest.replace(/'/g, "'\\''")}'`], {
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    return 'sqlite3-cli';
  }

  // Path 2 — fallback for hosts without the CLI installed. Force a WAL
  // checkpoint via the node binding before copying so the main DB file is
  // up-to-date. Brief race window: writes between checkpoint and copy could
  // be lost, but the resulting file is still internally consistent.
  const sqlite3 = require('sqlite3');
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(src, sqlite3.OPEN_READWRITE, (err) => {
      if (err) return reject(err);
      db.run('PRAGMA wal_checkpoint(TRUNCATE)', (e1) => {
        db.close((e2) => {
          const err = e1 || e2;
          if (err) return reject(err);
          try {
            fs.copyFileSync(src, dest);
            resolve('checkpoint+copy');
          } catch (e) { reject(e); }
        });
      });
    });
  });
}

async function backup() {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

  if (!fs.existsSync(DB_PATH)) {
    console.error('Database not found at:', DB_PATH);
    process.exit(1);
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupName = `attendance_backup_${timestamp}.db`;
  const backupPath = path.join(BACKUP_DIR, backupName);

  try {
    const method = await safeBackup(DB_PATH, backupPath);
    const size = fs.statSync(backupPath).size;
    console.log(`Backup created (${method}, ${size} bytes): ${backupPath}`);
    cleanOldBackups(KEEP);
  } catch (error) {
    console.error('Backup failed:', error.message);
    // Don't leave a partial file behind.
    if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
    process.exit(1);
  }
}

function cleanOldBackups(keepCount) {
  const files = fs
    .readdirSync(BACKUP_DIR)
    .filter((f) => f.startsWith('attendance_backup_') && f.endsWith('.db'))
    .map((f) => ({
      name: f,
      path: path.join(BACKUP_DIR, f),
      time: fs.statSync(path.join(BACKUP_DIR, f)).mtime.getTime(),
    }))
    .sort((a, b) => b.time - a.time);

  if (files.length > keepCount) {
    files.slice(keepCount).forEach((file) => {
      fs.unlinkSync(file.path);
      console.log('Deleted old backup:', file.name);
    });
  }
}

backup();
