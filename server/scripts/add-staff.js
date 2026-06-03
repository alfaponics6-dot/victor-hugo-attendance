/**
 * Add staff accounts (profesor or coordinador) to the system. Unlike the
 * legacy add-profesor.js (which manages only the single original profesor),
 * this always creates a NEW account, so you can add the several profesores who
 * review and close each day. Run it again per person, or answer "y" to add
 * another in the same run.
 *
 * Usage:
 *   node scripts/add-staff.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const path = require('path');
const readline = require('readline');

const DB_PATH = process.env.DB_PATH
  ? path.resolve(__dirname, '..', process.env.DB_PATH)
  : path.join(__dirname, '..', 'attendance.db');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (q) => new Promise((resolve) => rl.question(q, resolve));
const get = (db, sql, p = []) => new Promise((res, rej) => db.get(sql, p, (e, r) => (e ? rej(e) : res(r))));
const run = (db, sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { e ? rej(e) : res(this.lastID); }));

async function addOne(db) {
  let role = (await question('Rol (profesor/coordinador) [profesor]: ')).trim().toLowerCase() || 'profesor';
  if (role !== 'profesor' && role !== 'coordinador') {
    console.log(`Rol "${role}" no válido; usando "profesor".`);
    role = 'profesor';
  }

  const name = (await question('Nombre completo: ')).trim();
  if (!name) { console.error('El nombre es obligatorio.'); return; }

  const existing = await get(db, `SELECT id, role FROM leaders WHERE name = ?`, [name]);
  if (existing) {
    console.log(`Ya existe una cuenta "${name}" (id ${existing.id}, role=${existing.role}). Omitida.`);
    return;
  }

  const password = await question('Contraseña (mínimo 8 caracteres): ');
  if (!password || password.length < 8) { console.error('La contraseña debe tener al menos 8 caracteres.'); return; }

  const hash = await bcrypt.hash(password, 12);
  const id = await run(
    db,
    `INSERT INTO leaders (name, project_id, role, password_hash) VALUES (?, NULL, ?, ?)`,
    [name, role, hash]
  );
  console.log(`✔ Creado: ${name} (id ${id}, role=${role})`);
}

async function main() {
  console.log('\n=== Agregar personal (profesor / coordinador) ===\n');
  const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) { console.error('Error connecting to database:', err.message); process.exit(1); }
  });

  // eslint-disable-next-line no-constant-condition
  while (true) {
    await addOne(db);
    const again = (await question('\n¿Agregar otra cuenta? (y/n): ')).trim().toLowerCase();
    if (again !== 'y') break;
    console.log('');
  }

  console.log('\nListo. Las cuentas ya pueden iniciar sesión con su contraseña.\n');
  rl.close();
  db.close();
}

main().catch((err) => { console.error('Error:', err); process.exit(1); });
