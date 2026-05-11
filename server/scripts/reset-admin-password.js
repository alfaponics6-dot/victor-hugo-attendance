/**
 * Admin Password Reset Script
 * Run: node scripts/reset-admin-password.js <new-password>
 * 
 * Use this only if admin forgets password and has server access
 */

const bcrypt = require('bcrypt');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'attendance.db');
const newPassword = process.argv[2];

if (!newPassword) {
  console.error('Usage: node scripts/reset-admin-password.js <new-password>');
  console.error('Password must be at least 8 characters');
  process.exit(1);
}

if (newPassword.length < 8) {
  console.error('Error: Password must be at least 8 characters');
  process.exit(1);
}

async function resetPassword() {
  const db = new sqlite3.Database(DB_PATH);
  
  try {
    const hash = await bcrypt.hash(newPassword, 12);
    
    db.run(
      `UPDATE leaders SET password_hash = ? WHERE role = 'admin'`,
      [hash],
      function(err) {
        if (err) {
          console.error('Error:', err.message);
          process.exit(1);
        }
        
        if (this.changes === 0) {
          console.error('No admin account found');
          process.exit(1);
        }
        
        console.log('Admin password reset successfully');
        console.log('Updated', this.changes, 'account(s)');
        db.close();
      }
    );
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

resetPassword();
