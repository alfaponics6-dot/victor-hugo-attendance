#!/usr/bin/env node
/**
 * One-shot importer for the II-Cuatrimestre 2026F student list + rotations.
 *
 * Wipes the students/attendance/rotations tables (CASCADE), then re-imports
 * students from `Lista_II_Cuatri` and rotation assignments from
 * `Rotaciones_IIC2026`. Projects and leaders are left untouched.
 *
 * Run with `--dry` first to preview without writing.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const XLSX = require('xlsx');

const DRY = process.argv.includes('--dry');
const FILE = process.argv.find(a => a.startsWith('--file='))?.slice('--file='.length)
  || path.join('C:', 'Users', 'carly', 'Downloads', 'EF_IIC_Cuatrimestre_2026F Estudiantes.xlsx');
const DB_PATH = path.join(__dirname, '..', 'attendance.db');

// Project-name → DB project name mappings (some rotation-sheet headers don't
// match the canonical project name in the DB).
const PROJECT_NAME_MAPPINGS = {
  'Producción de plantulas  y manejo de Vivero Forestal': 'Producción de plantulas y manejo de Vivero Forestal',
  'Topografía: Levantamientos planimétricos y altimétricos': 'Facilitador de Topografía: levantamientos planimétricos y altimétricos',
  'Levantamiento satelital y detección remota con Drones': 'Facilitador de procesos de levantamiento satelital y detección remota con drones',
  'Monitoreo del activo biológico forestal de la Universidad EARTH / Manejo y conservación de fauna': 'Monitoreo del activo biológico forestal de la Universidad EARTH',
  'Ensayo agroforestal Coffee EARTH/Sistema agroforestal basado en café y cacao': 'Ensayo Agroforestal y Sistema agroforestal Coffee EARTH',
  'Silvicultura de precisión': 'Silvicultura de precisión',
  'Sistema agroforestal basado en café y cacao': 'Líder de conservación y manejo de fauna'
};

const ROTATION_PROJECT_COLUMNS = [
  'Producción de plantulas  y manejo de Vivero Forestal',
  'Topografía: Levantamientos planimétricos y altimétricos',
  'Levantamiento satelital y detección remota con Drones',
  'Monitoreo del activo biológico forestal de la Universidad EARTH / Manejo y conservación de fauna',
  'Ensayo agroforestal Coffee EARTH/Sistema agroforestal basado en café y cacao',
  'Silvicultura de precisión',
  'Sistema agroforestal basado en café y cacao'
];

const excelSerialToYYYYMMDD = (serial) => {
  // Excel epoch (Windows) = 1899-12-30. We want the local-calendar date,
  // not a UTC-shifted one - match the original importer's behavior.
  const d = new Date(Date.UTC(1899, 11, 30) + serial * 86400 * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

const normalizeName = (s) => (s || '').replace(/\s+/g, ' ').trim();

// ----------------------------------------------------------------------------
// Parse the Lista_II_Cuatri sheet
// ----------------------------------------------------------------------------
function parseStudentList(wb) {
  const sheet = wb.Sheets['Lista_II_Cuatri'];
  if (!sheet) throw new Error('Sheet "Lista_II_Cuatri" missing');
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });

  const students = [];
  for (const row of rows) {
    const idx = row[0];
    const apellido = row[3];
    const nombre = row[4];
    const carnet = row[5];
    const pais = row[7];
    if (typeof idx !== 'number' || !apellido || !nombre) continue;

    // Build canonical name in the same shape used by the rotation sheet:
    // "Apellido  Nombre" (note: original Excel uses double-space in some
    // rows). We match flexibly later by collapsing whitespace.
    const fullName = normalizeName(`${apellido} ${nombre}`);
    students.push({
      idx,
      name: fullName,
      apellido: normalizeName(apellido),
      nombre: normalizeName(nombre),
      carnet: carnet ? String(carnet) : null,
      pais
    });
  }
  return students;
}

// ----------------------------------------------------------------------------
// Parse the Rotaciones_IIC2026 sheet
// ----------------------------------------------------------------------------
function parseRotations(wb) {
  const sheet = wb.Sheets['Rotaciones_IIC2026'];
  if (!sheet) throw new Error('Sheet "Rotaciones_IIC2026" missing');
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });

  // Header row (index 0) has the project names in columns 1..7.
  const header = rows[0] || [];
  const colToProject = {}; // colIndex -> rotation-sheet project name
  for (let c = 1; c <= 7; c++) {
    if (header[c]) colToProject[c] = header[c];
  }

  const rotations = [];
  let current = null;

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row) continue;

    const firstCell = row[0];
    if (typeof firstCell === 'string' && /^ROTACI[ÓO]N\s+\d+/i.test(firstCell)) {
      if (current) rotations.push(current);
      const num = parseInt(firstCell.match(/\d+/)[0], 10);
      const sessionSerials = [row[8], row[9], row[10], row[11]].filter(v => typeof v === 'number');
      const sessionDates = sessionSerials.map(excelSerialToYYYYMMDD);
      current = {
        rotationNumber: num,
        startDate: sessionDates[0] || null,
        endDate: sessionDates[sessionDates.length - 1] || null,
        sessionDates,
        assignments: [] // { projectName, studentName }
      };
      // The header row also has student names in cols 1..7
      for (const [cStr, projName] of Object.entries(colToProject)) {
        const c = Number(cStr);
        const studentName = row[c];
        if (typeof studentName === 'string' && studentName.trim()) {
          current.assignments.push({ projectName: projName, studentName: normalizeName(studentName) });
        }
      }
      continue;
    }

    if (!current) continue;

    for (const [cStr, projName] of Object.entries(colToProject)) {
      const c = Number(cStr);
      const studentName = row[c];
      if (typeof studentName === 'string' && studentName.trim()) {
        current.assignments.push({ projectName: projName, studentName: normalizeName(studentName) });
      }
    }
  }
  if (current) rotations.push(current);
  return rotations;
}

// ----------------------------------------------------------------------------
// Match student names between rotation sheet and Lista
// ----------------------------------------------------------------------------
function buildNameIndex(students) {
  const byNorm = new Map();
  for (const s of students) {
    byNorm.set(s.name.toLowerCase(), s);
  }
  return byNorm;
}

function findStudent(rotName, byNorm, students) {
  const key = normalizeName(rotName).toLowerCase();
  if (byNorm.has(key)) return byNorm.get(key);
  // Fuzzy: try matching token sets (rotation names sometimes have inversions
  // or extra/missing accents).
  const tokens = key.split(' ').filter(Boolean);
  let best = null;
  let bestScore = 0;
  for (const s of students) {
    const stoks = s.name.toLowerCase().split(' ').filter(Boolean);
    const overlap = tokens.filter(t => stoks.includes(t)).length;
    if (overlap > bestScore && overlap >= Math.min(3, tokens.length)) {
      bestScore = overlap;
      best = s;
    }
  }
  return best;
}

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------
(async () => {
  console.log('Importing from:', FILE);
  console.log('Mode:', DRY ? 'DRY RUN (no writes)' : 'WRITE');

  const wb = XLSX.readFile(FILE);
  const students = parseStudentList(wb);
  const rotations = parseRotations(wb);

  console.log(`\nParsed ${students.length} students from Lista_II_Cuatri.`);
  console.log(`Parsed ${rotations.length} rotations from Rotaciones_IIC2026.`);
  for (const rot of rotations) {
    console.log(`  Rotación ${rot.rotationNumber}: ${rot.startDate} → ${rot.endDate} (${rot.assignments.length} assignments)`);
  }

  // Open DB
  const db = new sqlite3.Database(DB_PATH);
  const all = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => e ? rej(e) : res(r)));
  const get = (sql, p = []) => new Promise((res, rej) => db.get(sql, p, (e, r) => e ? rej(e) : res(r)));
  const run = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function(e) { e ? rej(e) : res(this); }));

  await run('PRAGMA foreign_keys = ON');

  const projects = await all('SELECT id, project_name FROM projects');
  const projectIdByName = new Map();
  for (const p of projects) projectIdByName.set(p.project_name, p.id);

  // Resolve rotation-sheet project names to DB project ids.
  const rotProjectToId = new Map();
  const unmappedProjects = [];
  for (const rotName of ROTATION_PROJECT_COLUMNS) {
    const dbName = PROJECT_NAME_MAPPINGS[rotName] || rotName;
    const id = projectIdByName.get(dbName);
    if (id) rotProjectToId.set(rotName, id);
    else unmappedProjects.push(rotName);
  }
  if (unmappedProjects.length) {
    console.error('\n!!! UNMAPPED PROJECTS (will skip rotations for these):');
    for (const n of unmappedProjects) console.error('  -', n);
  }

  // Determine each student's "home" project = the project they're in for
  // their first appearance across rotations.
  const studentByName = buildNameIndex(students);
  const homeProjectByStudent = new Map(); // student.name -> projectId
  const assignmentsResolved = [];
  const unresolvedAssignments = [];

  for (const rot of rotations) {
    for (const a of rot.assignments) {
      const student = findStudent(a.studentName, studentByName, students);
      const projectId = rotProjectToId.get(a.projectName);
      if (!student || !projectId) {
        unresolvedAssignments.push({
          rotation: rot.rotationNumber,
          projectName: a.projectName,
          studentName: a.studentName,
          missingStudent: !student,
          missingProject: !projectId
        });
        continue;
      }
      if (!homeProjectByStudent.has(student.name)) {
        homeProjectByStudent.set(student.name, projectId);
      }
      assignmentsResolved.push({
        rotationNumber: rot.rotationNumber,
        startDate: rot.startDate,
        endDate: rot.endDate,
        studentName: student.name,
        projectId
      });
    }
  }

  console.log('\n=== STUDENTS WITHOUT A ROTATION (will be assigned to project_id 1 as fallback) ===');
  const studentsWithoutHome = students.filter(s => !homeProjectByStudent.has(s.name));
  for (const s of studentsWithoutHome) console.log(`  ${s.name} (carnet ${s.carnet})`);

  console.log(`\nResolved ${assignmentsResolved.length} rotation assignments.`);
  console.log(`Unresolved: ${unresolvedAssignments.length}`);
  for (const u of unresolvedAssignments.slice(0, 20)) {
    console.log(`  rot ${u.rotation} project="${u.projectName}" student="${u.studentName}" ${u.missingStudent ? '[NO_STUDENT]' : ''}${u.missingProject ? '[NO_PROJECT]' : ''}`);
  }
  if (unresolvedAssignments.length > 20) {
    console.log(`  ... ${unresolvedAssignments.length - 20} more`);
  }

  if (DRY) {
    console.log('\n--- DRY RUN, no DB writes performed ---');
    db.close();
    return;
  }

  // Write phase
  console.log('\n=== Writing to DB ===');
  await run('BEGIN IMMEDIATE TRANSACTION');
  try {
    // Wipe existing student data. CASCADE handles attendance + rotations.
    await run('DELETE FROM attendance');
    await run('DELETE FROM rotations');
    await run('DELETE FROM students');

    // Insert students
    const studentIdByName = new Map();
    for (const s of students) {
      const homeProjectId = homeProjectByStudent.get(s.name) || 1;
      const result = await run(
        'INSERT INTO students (name, student_id, email, project_id) VALUES (?, ?, ?, ?)',
        [s.name, s.carnet, null, homeProjectId]
      );
      studentIdByName.set(s.name, result.lastID);
    }
    console.log(`Inserted ${studentIdByName.size} students.`);

    // Insert rotations
    let rotInserted = 0;
    for (const a of assignmentsResolved) {
      const sid = studentIdByName.get(a.studentName);
      if (!sid) continue;
      await run(
        'INSERT INTO rotations (rotation_number, student_id, project_id, start_date, end_date) VALUES (?, ?, ?, ?, ?)',
        [a.rotationNumber, sid, a.projectId, a.startDate, a.endDate]
      );
      rotInserted++;
    }
    console.log(`Inserted ${rotInserted} rotation rows.`);

    await run('COMMIT');
    console.log('Committed.');
  } catch (e) {
    await run('ROLLBACK').catch(() => {});
    console.error('Aborted, rolling back:', e.message);
    throw e;
  } finally {
    db.close();
  }
})();
