/**
 * Promote a profesor to the 'coordinador' role (e.g. Ronald Fernández Mesén).
 * The coordinador can review every profesor's day-close and then "cerrar la
 * jornada" (lock the date).
 *
 * Usage:
 *   node scripts/promote-coordinador.js            # interactive picker
 *   node scripts/promote-coordinador.js 16         # promote leader id 16
 *   node scripts/promote-coordinador.js "Ronald"   # promote by name match
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const readline = require('readline');

const DB_PATH = process.env.DB_PATH
  ? path.resolve(__dirname, '..', process.env.DB_PATH)
  : path.join(__dirname, '..', 'attendance.db');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (q) => new Promise((resolve) => rl.question(q, resolve));

const all = (db, sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => (e ? rej(e) : res(r))));
const run = (db, sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { e ? rej(e) : res(this.changes); }));

async function main() {
  console.log('\n=== Promover a Coordinador ===\n');
  const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) { console.error('Error connecting to database:', err.message); process.exit(1); }
  });

  const arg = process.argv[2];
  const candidates = await all(
    db,
    `SELECT id, name, role FROM leaders WHERE role IN ('profesor', 'coordinador') ORDER BY role, name`
  );

  if (candidates.length === 0) {
    console.error('No hay profesores en el sistema. Crea uno primero con: npm run add-staff');
    rl.close(); db.close(); process.exit(1);
  }

  let target = null;
  if (arg) {
    const byId = /^\d+$/.test(arg) ? candidates.find((c) => c.id === Number(arg)) : null;
    const byName = candidates.find((c) => c.name.toLowerCase().includes(String(arg).toLowerCase()));
    target = byId || byName || null;
    if (!target) { console.error(`No se encontró un profesor que coincida con "${arg}".`); rl.close(); db.close(); process.exit(1); }
  } else {
    console.log('Profesores disponibles:');
    candidates.forEach((c) => console.log(`  [${c.id}] ${c.name} (role=${c.role})`));
    const id = await question('\nID del profesor a promover a coordinador: ');
    target = candidates.find((c) => c.id === Number(id));
    if (!target) { console.error('ID inválido.'); rl.close(); db.close(); process.exit(1); }
  }

  if (target.role === 'coordinador') {
    console.log(`\n${target.name} ya es coordinador. Nada que hacer.\n`);
    rl.close(); db.close(); return;
  }

  const changes = await run(db, `UPDATE leaders SET role = 'coordinador' WHERE id = ?`, [target.id]);
  if (changes === 0) {
    console.error('No se actualizó ninguna fila.');
    rl.close(); db.close(); process.exit(1);
  }

  console.log(`\n✔ ${target.name} (id ${target.id}) ahora es coordinador.`);
  console.log('Usa la misma contraseña de profesor para iniciar sesión.\n');
  rl.close(); db.close();
}

main().catch((err) => { console.error('Error:', err); process.exit(1); });
