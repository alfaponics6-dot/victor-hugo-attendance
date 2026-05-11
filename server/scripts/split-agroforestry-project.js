/**
 * One-off DB migration:
 *
 * The seed spreadsheet collapsed two distinct projects into a single row
 * (#8 - "Ensayo Agroforestal y Sistema agroforestal Coffee EARTH"), giving
 * us 4 leaders + 36 students all on one project_id. In reality they are
 * two separate projects with different leader pairs and different student
 * rotation groupings:
 *
 *   Ensayo Agroforestal y Sistema agroforestal Coffee EARTH (existing #8)
 *     leaders: María José Mesén Vásquez, María Fernanda Ugalde Herrera
 *
 *   Sistema agroforestal basado en café y cacao (new #11)
 *     leaders: Ana Lucía Martínez Muñoz, Gerardo Stiven Pineda
 *
 * Both share the same 36-student pool but visit it on offset rotation
 * weeks. Rotation date windows are reused from the existing project #8
 * entries so attendance can already start in week 1.
 *
 * Idempotent: re-running will keep the same final state — leaders are
 * reassigned by name, rotations are DELETEd+re-INSERTed.
 */
const path = require('path');
const sqlite3 = require('sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'attendance.db');

const NEW_PROJECT = {
  number: 11,
  name: 'Sistema agroforestal basado en café y cacao',
};

const NEW_LEADER_NAMES = [
  'Ana Lucía Martínez Muñoz',
  'Gerardo Stiven Pineda',
];

const EXISTING_PROJECT_NAME = 'Ensayo Agroforestal y Sistema agroforestal Coffee EARTH';

// 7 rotation groups for the new "Sistema agroforestal basado en café y cacao"
// project. The order here defines rotation 1..7 mapping to the same
// start/end-date windows the existing project #8 used.
const SISTEMA_ROTATIONS = [
  [ // R1
    'Barrios Marro Sergio Ignacio',
    'Cruz Gamboa Sebastián',
    'Espejo Hilares Priscila Beatriz',
    'Mora Aburto Ania Adelina',
    'Sánchez Mejias Isaac',
  ],
  [ // R2
    'Bale Kayla',
    'Chery Roberto',
    'Enamorado Digna',
    'Johnline Belcard Aubourg',
    'Sanchez Evelyn Mayeli',
  ],
  [ // R3
    'Araya Diaz Keisha Cristina',
    'Azuero Vásquez Mauro Emilio',
    'Chacón Araya Heiner Emanuel',
    'Mlingi Agnes',
    'Nizigama Epafrodite',
  ],
  [ // R4
    'Ceballos Ortega Jorge Ismael',
    'Chicas Díaz Nisi Elim',
    'Esquit Asijtuj Astrid Mishel',
    'Lorenzo Franco Aurianny Lismairy',
    'PHIRI PRECIOUS OSCAR',
  ],
  [ // R5
    'Campuzano Hidalgo Holger Diego',
    'Ezekiel Niyonizigiye',
    'Moreno Mejia Rigoberto',
    'Rodríguez Massiel',
    'Sánchez Aguirre María José',
  ],
  [ // R6
    'Caballero Sánchez Darianna Elaine',
    'Dubón Herrera María Celeste',
    'Durán Ureña Yismey Yeilyn',
    'Gamboa Salas Freddy',
    'Kauthar Sabrina IGIHOZO',
  ],
  [ // R7
    'Deng Susan Yar',
    'Jok Magret Awel Manyang',
    'Khulamba Maranatha',
    'López Ramos Luis Diego',
    'Sibaja Fonseca Jean Carlos',
    'Villatoro Moscoso Karen Fernanda Maribel',
  ],
];

// Ensayo's groups are Sistema shifted by +2 — verified against the user's
// own listing. Computed instead of duplicated so the two stay in sync.
const ENSAYO_ROTATIONS = SISTEMA_ROTATIONS.map(
  (_, i) => SISTEMA_ROTATIONS[(i + 2) % SISTEMA_ROTATIONS.length]
);

// Loose name match: trim, collapse internal whitespace, lowercase. We do NOT
// strip accents because both sources (DB and the user's spec) carry them.
const norm = (s) =>
  String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();

function all(db, sql, params = []) {
  return new Promise((resolve, reject) =>
    db.all(sql, params, (e, rows) => (e ? reject(e) : resolve(rows)))
  );
}
function get(db, sql, params = []) {
  return new Promise((resolve, reject) =>
    db.get(sql, params, (e, row) => (e ? reject(e) : resolve(row)))
  );
}
function run(db, sql, params = []) {
  return new Promise((resolve, reject) =>
    db.run(sql, params, function (e) { e ? reject(e) : resolve(this); })
  );
}

async function main() {
  const db = new sqlite3.Database(DB_PATH);

  // 1. Locate the existing project by name (was project_number=8).
  const existing = await get(db, 'SELECT id, project_number FROM projects WHERE project_name = ?', [EXISTING_PROJECT_NAME]);
  if (!existing) throw new Error(`Could not find project named "${EXISTING_PROJECT_NAME}"`);
  console.log(`Existing project: id=${existing.id} number=${existing.project_number}`);

  // 2. Insert (or look up) the new project.
  let newRow = await get(db, 'SELECT id FROM projects WHERE project_number = ? OR project_name = ?', [NEW_PROJECT.number, NEW_PROJECT.name]);
  let newProjectId;
  if (newRow) {
    newProjectId = newRow.id;
    console.log(`New project already present: id=${newProjectId}`);
  } else {
    const r = await run(db, 'INSERT INTO projects (project_number, project_name) VALUES (?, ?)', [NEW_PROJECT.number, NEW_PROJECT.name]);
    newProjectId = r.lastID;
    console.log(`Created new project id=${newProjectId} number=${NEW_PROJECT.number}`);
  }

  // 3. Reassign the two leaders to the new project.
  for (const name of NEW_LEADER_NAMES) {
    const r = await run(db, 'UPDATE leaders SET project_id = ? WHERE name = ?', [newProjectId, name]);
    if (r.changes === 0) console.warn(`!! Leader "${name}" not found, skipping`);
    else console.log(`Reassigned leader "${name}" → project ${newProjectId}`);
  }

  // 4. Load students and build a name → id map.
  const students = await all(db, 'SELECT id, name FROM students');
  const byNorm = new Map();
  students.forEach((s) => byNorm.set(norm(s.name), s.id));

  function lookup(name) {
    const id = byNorm.get(norm(name));
    if (!id) throw new Error(`Student not found: "${name}"`);
    return id;
  }

  // 5. Pull the canonical rotation date windows from the existing project #8.
  const dateWindows = await all(db,
    `SELECT DISTINCT rotation_number, start_date, end_date
       FROM rotations
      WHERE project_id = ?
      ORDER BY rotation_number`,
    [existing.id]
  );
  if (dateWindows.length !== 7) {
    throw new Error(`Expected 7 rotation date windows on existing project, got ${dateWindows.length}`);
  }
  console.log(`Reusing ${dateWindows.length} rotation date windows`);

  // 6. Wipe + reinsert rotations for both projects.
  await run(db, 'DELETE FROM rotations WHERE project_id = ?', [existing.id]);
  await run(db, 'DELETE FROM rotations WHERE project_id = ?', [newProjectId]);

  const insert = `INSERT INTO rotations (rotation_number, student_id, project_id, start_date, end_date) VALUES (?, ?, ?, ?, ?)`;

  let inserted = 0;
  for (const dw of dateWindows) {
    const i = dw.rotation_number - 1;
    for (const name of SISTEMA_ROTATIONS[i]) {
      await run(db, insert, [dw.rotation_number, lookup(name), newProjectId, dw.start_date, dw.end_date]);
      inserted++;
    }
    for (const name of ENSAYO_ROTATIONS[i]) {
      await run(db, insert, [dw.rotation_number, lookup(name), existing.id, dw.start_date, dw.end_date]);
      inserted++;
    }
  }

  console.log(`\nRotations inserted: ${inserted}`);

  // 7. Summary.
  const sistemaCount = await get(db, 'SELECT COUNT(*) AS n FROM rotations WHERE project_id = ?', [newProjectId]);
  const ensayoCount = await get(db, 'SELECT COUNT(*) AS n FROM rotations WHERE project_id = ?', [existing.id]);
  console.log(`\nFinal:`);
  console.log(`  Sistema agroforestal café y cacao (id=${newProjectId}):  ${sistemaCount.n} rotation rows`);
  console.log(`  Ensayo Agroforestal Coffee EARTH (id=${existing.id}):    ${ensayoCount.n} rotation rows`);

  const leaders = await all(db,
    `SELECT l.id, l.name, l.project_id, p.project_name
       FROM leaders l LEFT JOIN projects p ON l.project_id = p.id
      WHERE l.project_id IN (?, ?) ORDER BY l.project_id, l.name`,
    [existing.id, newProjectId]
  );
  console.log(`\nLeaders by project:`);
  leaders.forEach(l => console.log(`  #${l.id}  ${l.name}  →  ${l.project_name}`));

  db.close();
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
