#!/usr/bin/env node
/**
 * Generate mock attendance data so the analytics dashboards have something
 * to render. Run with `--dry` to preview.
 *
 * Strategy:
 *   1. Pick a window ending today and walking back 28 days.
 *   2. For every Wednesday and Saturday in that window (the real session days
 *      per the rotation spreadsheet), generate one attendance row per
 *      student. Today is added as a bonus session so "presentes hoy" lights
 *      up regardless of weekday.
 *   3. Each student gets ~88% present, ~12% absent. Absences split ~70/30
 *      between "injustificada" and "justificada".
 *   4. Each student's project_id for the row uses whichever rotation row
 *      covers that date (so rotation alerts work correctly) - and falls back
 *      to the student's home project when there is no covering rotation.
 *
 * Idempotent-ish: re-running on the same date range will hit the
 * UNIQUE(student_id, date) constraint and skip existing rows.
 */

const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const DRY = process.argv.includes('--dry');
const DAYS_BACK = parseInt(process.argv.find(a => a.startsWith('--days='))?.slice('--days='.length)) || 28;
const PRESENT_RATE = 0.88;
const JUSTIFIED_SHARE = 0.30; // among absences

const DB_PATH = path.join(__dirname, '..', 'attendance.db');
const ADMIN_LEADER_ID = 2; // Lluvia Azofeifa, admin - owns the synthetic inserts

const todayIsoLocal = () => {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

const addDays = (iso, n) => {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + n);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return { iso: `${yy}-${mm}-${dd}`, weekday: dt.getDay() };
};

const pick = (p) => Math.random() < p;
const randomTime = () => {
  // Sessions run mid-morning. 08:00–10:30.
  const hour = 8 + Math.floor(Math.random() * 3);
  const minute = [0, 15, 30, 45][Math.floor(Math.random() * 4)];
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
};

(async () => {
  const db = new sqlite3.Database(DB_PATH);
  const all = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => e ? rej(e) : res(r)));
  const run = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { e ? rej(e) : res(this); }));

  await run('PRAGMA foreign_keys = ON');
  await run('PRAGMA busy_timeout = 5000');

  const students = await all('SELECT id, name, project_id FROM students');
  const rotations = await all('SELECT student_id, project_id, start_date, end_date FROM rotations');

  // Build a lookup: student_id -> [{ start, end, project_id }]
  const rotationsByStudent = new Map();
  for (const r of rotations) {
    if (!rotationsByStudent.has(r.student_id)) rotationsByStudent.set(r.student_id, []);
    rotationsByStudent.get(r.student_id).push(r);
  }

  const projectForStudentOnDate = (student, dateIso) => {
    const rs = rotationsByStudent.get(student.id) || [];
    const covering = rs.find(r => dateIso >= r.start_date && dateIso <= r.end_date);
    return covering ? covering.project_id : student.project_id;
  };

  // Build the session-date list: every Wed (3) and Sat (6) in the window,
  // plus today itself if it isn't already covered.
  const today = todayIsoLocal();
  const sessionDates = new Set();
  for (let i = DAYS_BACK; i >= 0; i--) {
    const { iso, weekday } = addDays(today, -i);
    if (weekday === 3 || weekday === 6) sessionDates.add(iso);
  }
  sessionDates.add(today);

  const dates = [...sessionDates].sort();
  console.log(`Window: ${dates[0]} → ${dates[dates.length - 1]} (${dates.length} session days)`);
  console.log(`Students: ${students.length}`);
  console.log(`Target: ${dates.length * students.length} attendance rows (before dedup)`);

  if (DRY) {
    console.log('\n--- DRY RUN, no DB writes performed ---');
    db.close();
    return;
  }

  let inserted = 0;
  let skipped = 0;
  let present = 0;
  let absentJust = 0;
  let absentUnjust = 0;

  await run('BEGIN IMMEDIATE TRANSACTION');
  try {
    for (const date of dates) {
      for (const student of students) {
        const isPresent = pick(PRESENT_RATE);
        const status = isPresent ? 'present' : 'absent';
        let justification = null;
        if (!isPresent) {
          justification = pick(JUSTIFIED_SHARE) ? 'justificada' : 'injustificada';
        }
        const projectId = projectForStudentOnDate(student, date);
        try {
          await run(
            `INSERT INTO attendance
              (student_id, project_id, leader_id, date, time, status, justification, observation, timestamp)
             VALUES (?, ?, ?, ?, ?, ?, ?, NULL, CURRENT_TIMESTAMP)`,
            [student.id, projectId, ADMIN_LEADER_ID, date, randomTime(), status, justification]
          );
          inserted++;
          if (isPresent) present++;
          else if (justification === 'justificada') absentJust++;
          else absentUnjust++;
        } catch (e) {
          if (e && e.code === 'SQLITE_CONSTRAINT') {
            skipped++; // row already exists for this (student, date)
          } else {
            throw e;
          }
        }
      }
    }
    await run('COMMIT');
  } catch (e) {
    await run('ROLLBACK').catch(() => {});
    console.error('Aborted:', e.message);
    db.close();
    process.exit(1);
  }

  console.log(`\nInserted: ${inserted}`);
  console.log(`  Presentes:           ${present}`);
  console.log(`  Ausencias just.:     ${absentJust}`);
  console.log(`  Ausencias injust.:   ${absentUnjust}`);
  console.log(`Skipped (already existed): ${skipped}`);
  console.log(`Effective attendance rate: ${(present / inserted * 100).toFixed(1)}%`);

  db.close();
})();
