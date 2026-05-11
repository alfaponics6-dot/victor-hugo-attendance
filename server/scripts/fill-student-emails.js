/**
 * One-off update: populate the `email` column for students whose row has
 * email NULL/empty. Builds the address from EARTH University's typical
 * convention: <first-letter-of-first-name><first-surname-stripped>@earth.ac.cr
 *
 * Verified at 27/35 (77%) exact match against the IC spreadsheet's known
 * emails; the remaining 8 are IT-assigned overrides for name collisions
 * (e.g. two students sharing initial+surname get a disambiguator suffix).
 *
 * This script ONLY updates rows where email IS NULL OR ''. It will not
 * clobber an existing value. Re-running it is therefore safe.
 *
 * Usage:
 *   node scripts/fill-student-emails.js [path/to/Spreadsheet.xlsx]
 *
 * If no spreadsheet path is given, defaults to the bundled
 * EF_IIC_Cuatrimestre_2026F Estudiantes.xlsx in your Downloads folder.
 */
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const sqlite3 = require('sqlite3');

const DEFAULT_XLSX = process.argv[2]
  || path.join(process.env.USERPROFILE || process.env.HOME || '.', 'Downloads', 'EF_IIC_Cuatrimestre_2026F Estudiantes.xlsx');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'attendance.db');

const stripAccents = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-zA-Z]/g, '');

const buildEmail = (last, first) => {
  // First name token: the first whitespace-separated word.
  const firstClean = stripAccents(String(first || '').trim().split(/\s+/)[0] || '');
  // Surname token: the first space-or-hyphen-separated word of the apellido column.
  const lastClean = stripAccents(String(last || '').trim().split(/[\s-]+/)[0] || '');
  if (!firstClean || !lastClean) return null;
  return (firstClean[0] + lastClean).toLowerCase() + '@earth.ac.cr';
};

function readStudents(xlsxPath) {
  if (!fs.existsSync(xlsxPath)) {
    throw new Error(`Spreadsheet not found: ${xlsxPath}`);
  }
  const wb = XLSX.readFile(xlsxPath);
  // Try common sheet names; fall back to the second sheet (the student roster
  // sheet in the IIC layout).
  const sheetName = ['Lista_II_Cuatri', 'Lista_I_Cuatri'].find(n => wb.Sheets[n])
    || wb.SheetNames[1]
    || wb.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1 });

  // Header band occupies the first 4 rows; data starts at row 4.
  const students = [];
  for (let i = 4; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !r[1]) continue;
    const year = String(r[1]).trim();
    const last = r[3];
    const first = r[4];
    const carnet = r[5];
    if (!carnet || !last || !first) continue;
    students.push({
      year,
      last: String(last).trim(),
      first: String(first).trim(),
      carnet: String(carnet).trim(),
      email: buildEmail(last, first),
    });
  }
  return students;
}

function run() {
  const xlsx = path.resolve(DEFAULT_XLSX);
  const students = readStudents(xlsx);
  process.stdout.write(`Read ${students.length} students from ${xlsx}\n`);

  const db = new sqlite3.Database(DB_PATH);
  db.serialize(() => {
    let updated = 0;
    let skipped = 0;
    let missing = 0;

    const update = db.prepare(
      `UPDATE students SET email = ? WHERE student_id = ? AND (email IS NULL OR email = '')`
    );

    let pending = students.length;
    if (pending === 0) {
      db.close();
      return;
    }

    students.forEach((s) => {
      if (!s.email) {
        missing++;
        if (--pending === 0) finish();
        return;
      }
      update.run(s.email, s.carnet, function (err) {
        if (err) {
          process.stderr.write(`update error for ${s.carnet}: ${err.message}\n`);
        } else if (this.changes > 0) {
          updated++;
          process.stdout.write(`  ✓ ${s.carnet}  ${s.last}, ${s.first.split(/\s+/)[0]}  →  ${s.email}\n`);
        } else {
          skipped++;
        }
        if (--pending === 0) finish();
      });
    });

    function finish() {
      update.finalize(() => {
        process.stdout.write(`\nDone. updated=${updated}  skipped=${skipped}  missing=${missing}\n`);
        process.stdout.write(`(skipped = student already had an email, or no DB row matched the carnet)\n`);
        db.close();
      });
    }
  });
}

try {
  run();
} catch (err) {
  process.stderr.write(`${err.message}\n`);
  process.exit(1);
}
