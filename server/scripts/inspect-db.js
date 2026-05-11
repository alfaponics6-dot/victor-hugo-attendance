const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const DB = path.join(__dirname, '..', 'attendance.db');
const db = new sqlite3.Database(DB);

const all = (sql, p = []) => new Promise((res, rej) =>
  db.all(sql, p, (e, r) => e ? rej(e) : res(r))
);

(async () => {
  const projects = await all('SELECT id, project_number, project_name FROM projects ORDER BY project_number');
  console.log('PROJECTS:', projects.length);
  for (const p of projects) console.log(`  [${p.id}] #${p.project_number} ${p.project_name}`);

  const leaders = await all('SELECT id, name, project_id, role, password_hash IS NOT NULL as has_pw FROM leaders ORDER BY role, name');
  console.log('\nLEADERS:', leaders.length);
  for (const l of leaders) console.log(`  [${l.id}] ${l.name} (project ${l.project_id}, role=${l.role}, has_pw=${l.has_pw})`);

  const studentCount = await all('SELECT COUNT(*) as c FROM students');
  console.log('\nSTUDENTS:', studentCount[0].c);
  const attCount = await all('SELECT COUNT(*) as c FROM attendance');
  console.log('ATTENDANCE rows:', attCount[0].c);
  const rotCount = await all('SELECT COUNT(*) as c FROM rotations');
  console.log('ROTATIONS rows:', rotCount[0].c);

  db.close();
})();
