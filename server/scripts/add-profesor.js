/**
 * Script to add Professor Victor Hugo Morales to the system
 * Run: node scripts/add-profesor.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const path = require('path');
const readline = require('readline');

const DB_PATH = process.env.DB_PATH
  ? path.resolve(__dirname, '..', process.env.DB_PATH)
  : path.join(__dirname, '..', 'attendance.db');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function question(prompt) {
  return new Promise(resolve => rl.question(prompt, resolve));
}

async function main() {
  console.log('\n=== Agregar Profesor Victor Hugo Morales ===\n');

  const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) {
      console.error('Error connecting to database:', err.message);
      process.exit(1);
    }
  });

  // Check if profesor already exists
  const existing = await new Promise((resolve, reject) => {
    db.get(
      `SELECT id, name, role FROM leaders WHERE role = 'profesor'`,
      [],
      (err, row) => {
        if (err) reject(err);
        else resolve(row);
      }
    );
  });

  if (existing) {
    console.log(`Profesor already exists: ${existing.name} (ID: ${existing.id})`);

    const resetPassword = await question('\nDo you want to reset the password? (y/n): ');

    if (resetPassword.toLowerCase() === 'y') {
      const newPassword = await question('Enter new password (min 8 characters): ');

      if (newPassword.length < 8) {
        console.error('Password must be at least 8 characters');
        rl.close();
        db.close();
        process.exit(1);
      }

      const hash = await bcrypt.hash(newPassword, 12);

      await new Promise((resolve, reject) => {
        db.run(
          `UPDATE leaders SET password_hash = ? WHERE id = ?`,
          [hash, existing.id],
          function(err) {
            if (err) reject(err);
            else resolve(this.changes);
          }
        );
      });

      console.log('\nPassword updated successfully!');
    }
  } else {
    // Create new profesor
    const name = await question('Enter professor name (default: Victor Hugo Morales): ') || 'Victor Hugo Morales';
    const password = await question('Enter password (min 8 characters): ');

    if (password.length < 8) {
      console.error('Password must be at least 8 characters');
      rl.close();
      db.close();
      process.exit(1);
    }

    const hash = await bcrypt.hash(password, 12);

    const result = await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO leaders (name, project_id, role, password_hash) VALUES (?, NULL, 'profesor', ?)`,
        [name, hash],
        function(err) {
          if (err) reject(err);
          else resolve(this.lastID);
        }
      );
    });

    console.log(`\nProfesor created successfully!`);
    console.log(`  Name: ${name}`);
    console.log(`  ID: ${result}`);
    console.log(`  Role: profesor`);
  }

  console.log('\nThe professor can now log in at the login page.\n');

  rl.close();
  db.close();
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
