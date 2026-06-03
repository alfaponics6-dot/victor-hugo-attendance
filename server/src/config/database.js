const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const DB_PATH = process.env.DB_PATH
  ? path.resolve(__dirname, process.env.DB_PATH)
  : path.join(__dirname, '..', '..', 'attendance.db');

/**
 * JS-level serializer for transactional writes. The sqlite3 binding owns a
 * single underlying connection, so two concurrent callers issuing
 * `BEGIN IMMEDIATE TRANSACTION` on the same handle race and one of them gets
 * "SQLITE_ERROR: cannot start a transaction within a transaction". Wrapping
 * write paths in this mutex turns those races into clean queuing.
 */
class AsyncMutex {
  constructor() { this._chain = Promise.resolve(); }
  run(fn) {
    const next = this._chain.then(() => fn());
    this._chain = next.catch(() => {});
    return next;
  }
}

class Database {
  constructor() {
    this.writeMutex = new AsyncMutex();
    // Per-project write queue. Unrelated projects' bulk submissions don't
    // block each other; same-project submissions serialize cleanly.
    this._projectMutexes = new Map();
    this.db = new sqlite3.Database(DB_PATH, (err) => {
      if (err) {
        process.stderr.write(`Database error: ${err.message}\n`);
      } else {
        // WAL allows concurrent reads while a writer is active.
        this.db.run('PRAGMA journal_mode = WAL');
        // synchronous=NORMAL is the recommended pairing with WAL: durable
        // (no risk of corruption on crash) but ~20× faster commit than FULL.
        // FULL fsyncs after every transaction; NORMAL fsyncs at checkpoints.
        this.db.run('PRAGMA synchronous = NORMAL');
        // Wait up to 10 seconds if the database is locked.
        this.db.run('PRAGMA busy_timeout = 10000');
        // Foreign-key enforcement for our ON DELETE policies.
        this.db.run('PRAGMA foreign_keys = ON');
        // Keep more of the DB hot in memory (default is 2000 pages = ~8MB).
        this.db.run('PRAGMA cache_size = -20000'); // ~20 MB
        this.initializeTables();
      }
    });
  }

  _projectMutex(projectId) {
    const key = String(projectId);
    if (!this._projectMutexes.has(key)) this._projectMutexes.set(key, new AsyncMutex());
    return this._projectMutexes.get(key);
  }

  // Run a body of code with the global write lock held. Used by paths that
  // can't reuse `insertBulkAttendance` (e.g. the admin re-import, which calls
  // insertProject + insertLeader many times and must not race the leaders'
  // bulk submits on the same sqlite3 connection).
  runExclusive(fn) {
    return this.writeMutex.run(fn);
  }

  initializeTables() {
    this.db.serialize(() => {
      // Projects table
      this.db.run(`
        CREATE TABLE IF NOT EXISTS projects (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_number INTEGER NOT NULL,
          project_name TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Leaders table. ON DELETE SET NULL on project_id so a project removal
      // doesn't orphan-delete leader rows; reassign instead.
      this.db.run(`
        CREATE TABLE IF NOT EXISTS leaders (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          project_id INTEGER,
          role TEXT DEFAULT 'leader',
          password_hash TEXT,
          email TEXT,
          can_delete_students INTEGER NOT NULL DEFAULT 1,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
        )
      `);

      // Add missing columns if they don't exist (for existing databases)
      this.db.run(`ALTER TABLE leaders ADD COLUMN role TEXT DEFAULT 'leader'`, () => {});
      this.db.run(`ALTER TABLE leaders ADD COLUMN password_hash TEXT`, () => {});
      this.db.run(`ALTER TABLE leaders ADD COLUMN email TEXT`, () => {});
      // Per-account override for the destructive `DELETE /students/:id`
      // endpoints. Defaults to 1 (allowed) so existing admins keep the
      // ability they had before this column existed. Set to 0 to revoke
      // delete from a specific admin without changing their role.
      this.db.run(`ALTER TABLE leaders ADD COLUMN can_delete_students INTEGER NOT NULL DEFAULT 1`, () => {});
      // Coordinator flag: when set, a profesor sees the "Supervisión"
      // tab that shows which other profes have submitted the daily
      // start/end attendance passes for each project. Default 0; flip
      // to 1 for the lead profesor (currently Ronald, leaders.id=16).
      this.db.run(`ALTER TABLE leaders ADD COLUMN is_coordinator INTEGER NOT NULL DEFAULT 0`, () => {});

      // Students table
      this.db.run(`
        CREATE TABLE IF NOT EXISTS students (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          student_id TEXT,
          email TEXT,
          project_id INTEGER NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        )
      `);

      // Attendance table. CASCADE on student/project so deleting a student or
      // project removes their attendance; SET NULL on leader_id so leader
      // turnover preserves history.
      this.db.run(`
        CREATE TABLE IF NOT EXISTS attendance (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          student_id INTEGER NOT NULL,
          project_id INTEGER NOT NULL,
          leader_id INTEGER,
          date DATE NOT NULL,
          time TIME NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('present', 'absent')),
          justification TEXT,
          observation TEXT,
          attachment_file_path TEXT,
          attachment_file_name TEXT,
          timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
          FOREIGN KEY (leader_id) REFERENCES leaders(id) ON DELETE SET NULL,
          UNIQUE(student_id, date)
        )
      `);

      // Add missing columns if they don't exist (for existing databases)
      this.db.run(`ALTER TABLE attendance ADD COLUMN justification TEXT`, () => {});
      this.db.run(`ALTER TABLE attendance ADD COLUMN observation TEXT`, () => {});
      this.db.run(`ALTER TABLE attendance ADD COLUMN attachment_file_path TEXT`, () => {});
      this.db.run(`ALTER TABLE attendance ADD COLUMN attachment_file_name TEXT`, () => {});

      // Audit log for attendance resolutions (offline-queue conflict
      // overrides). Every resolve call appends a row with the full payload
      // so a later review can reconstruct who overwrote what and when.
      this.db.run(`
        CREATE TABLE IF NOT EXISTS attendance_resolutions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id INTEGER NOT NULL,
          leader_id INTEGER,
          date DATE NOT NULL,
          resolution_mode TEXT NOT NULL,
          records_count INTEGER NOT NULL,
          replaced_count INTEGER NOT NULL,
          payload_json TEXT NOT NULL,
          source_ip TEXT,
          user_agent TEXT,
          resolved_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
          FOREIGN KEY (leader_id) REFERENCES leaders(id) ON DELETE SET NULL
        )
      `);
      // Backfill columns for existing DBs created before source_ip/user_agent
      // were added. SQLite has no IF NOT EXISTS on ALTER COLUMN; swallow the
      // duplicate-column errors silently.
      this.db.run(`ALTER TABLE attendance_resolutions ADD COLUMN source_ip TEXT`, () => {});
      this.db.run(`ALTER TABLE attendance_resolutions ADD COLUMN user_agent TEXT`, () => {});
      this.db.run(`CREATE INDEX IF NOT EXISTS idx_resolutions_project_date ON attendance_resolutions(project_id, date)`);

      // Web Push subscriptions. Used by the periodic cron to wake each
      // installed PWA's service worker so it can drain the offline queue
      // without the leader having to open the app. endpoint is unique
      // per subscription (browser-issued URL); a leader can have multiple
      // subscriptions if they install on multiple devices.
      this.db.run(`
        CREATE TABLE IF NOT EXISTS push_subscriptions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          leader_id INTEGER,
          endpoint TEXT NOT NULL UNIQUE,
          p256dh TEXT NOT NULL,
          auth TEXT NOT NULL,
          user_agent TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          last_pushed_at DATETIME,
          last_status INTEGER,
          FOREIGN KEY (leader_id) REFERENCES leaders(id) ON DELETE CASCADE
        )
      `);
      this.db.run(`CREATE INDEX IF NOT EXISTS idx_push_subs_leader ON push_subscriptions(leader_id)`);

      // Per-leader sync hint. Updated by the X-Queue-Size header on
      // every authenticated request; consulted by the push cron so we
      // only wake devices that actually have queued data. Without this,
      // every leader gets a 30-min notification even when there's
      // nothing to sync.
      this.db.run(`
        CREATE TABLE IF NOT EXISTS leader_sync_state (
          leader_id INTEGER PRIMARY KEY,
          last_known_queue_size INTEGER NOT NULL DEFAULT 0,
          sync_needed_at DATETIME,
          last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          last_email_sent_at DATETIME,
          FOREIGN KEY (leader_id) REFERENCES leaders(id) ON DELETE CASCADE
        )
      `);
      // Backfill column for existing DBs created before email-notify
      // escalation was added. SQLite has no ADD COLUMN IF NOT EXISTS, so
      // we swallow the duplicate-column error.
      this.db.run(`ALTER TABLE leader_sync_state ADD COLUMN last_email_sent_at DATETIME`, () => {});
      this.db.run(`CREATE INDEX IF NOT EXISTS idx_sync_state_needed ON leader_sync_state(sync_needed_at)`);

      // Profesor-only attendance "passes": one START and one END pass
      // per student per session day, captured by a profesor (not by the
      // student's leader). Kept in its own table so it doesn't clash
      // with the leader's UNIQUE(student_id, date) index on the main
      // attendance table — same student can now have a leader row + a
      // profe-start row + a profe-end row for the same date.
      this.db.run(`
        CREATE TABLE IF NOT EXISTS profesor_attendance (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          profesor_id INTEGER NOT NULL,
          project_id INTEGER NOT NULL,
          student_id INTEGER NOT NULL,
          date DATE NOT NULL,
          pass_type TEXT NOT NULL CHECK(pass_type IN ('start', 'end')),
          status TEXT NOT NULL CHECK(status IN ('present', 'absent')),
          recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          observation TEXT,
          FOREIGN KEY (profesor_id) REFERENCES leaders(id) ON DELETE SET NULL,
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
          FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
        )
      `);
      this.db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_profe_attendance_unique ON profesor_attendance(student_id, date, pass_type)`);
      this.db.run(`CREATE INDEX IF NOT EXISTS idx_profe_attendance_project_date ON profesor_attendance(project_id, date)`);
      this.db.run(`CREATE INDEX IF NOT EXISTS idx_profe_attendance_profesor ON profesor_attendance(profesor_id, date DESC)`);

      // Daily sign-off (jornada). One row per (project, date): a profesor
      // "cierra el día" once both the leader's primera lista (the `attendance`
      // table) and segunda lista (the 'end' pass in profesor_attendance) are
      // in; the coordinador then "cierra la jornada" for the whole date,
      // setting locked=1. Only `locked` blocks further pass writes — a
      // profe's day-close is a review checkmark, not a lock.
      this.db.run(`
        CREATE TABLE IF NOT EXISTS daily_signoff (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id INTEGER NOT NULL,
          date DATE NOT NULL,
          closed_day_by INTEGER,
          closed_day_at DATETIME,
          closed_session_by INTEGER,
          closed_session_at DATETIME,
          locked INTEGER NOT NULL DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
          FOREIGN KEY (closed_day_by) REFERENCES leaders(id) ON DELETE SET NULL,
          FOREIGN KEY (closed_session_by) REFERENCES leaders(id) ON DELETE SET NULL,
          UNIQUE(project_id, date)
        )
      `);
      this.db.run(`CREATE INDEX IF NOT EXISTS idx_signoff_date ON daily_signoff(date)`);

      // Rotations table - track student rotation assignments
      this.db.run(`
        CREATE TABLE IF NOT EXISTS rotations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          rotation_number INTEGER NOT NULL,
          student_id INTEGER NOT NULL,
          project_id INTEGER NOT NULL,
          start_date DATE NOT NULL,
          end_date DATE NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        )
      `);

      // Indexes for the hot read paths. Without these, attendance queries
      // and statistics aggregations do full table scans on every request,
      // which gets painful as the table grows past a quarter.
      this.db.run(`CREATE INDEX IF NOT EXISTS idx_attendance_student_date ON attendance(student_id, date)`);
      this.db.run(`CREATE INDEX IF NOT EXISTS idx_attendance_project_date ON attendance(project_id, date)`);
      this.db.run(`CREATE INDEX IF NOT EXISTS idx_attendance_date ON attendance(date)`);
      this.db.run(`CREATE INDEX IF NOT EXISTS idx_students_project ON students(project_id)`);
      this.db.run(`CREATE INDEX IF NOT EXISTS idx_rotations_project_dates ON rotations(project_id, start_date, end_date)`);
      this.db.run(`CREATE INDEX IF NOT EXISTS idx_rotations_student ON rotations(student_id)`);
      this.db.run(`CREATE INDEX IF NOT EXISTS idx_leaders_project ON leaders(project_id)`);
    });
  }

  // Project queries
  insertProject(projectNumber, projectName) {
    return new Promise((resolve, reject) => {
      this.db.run(
        'INSERT INTO projects (project_number, project_name) VALUES (?, ?)',
        [projectNumber, projectName],
        function(err) {
          if (err) reject(err);
          else resolve(this.lastID);
        }
      );
    });
  }

  getProjects() {
    return new Promise((resolve, reject) => {
      this.db.all('SELECT * FROM projects', [], (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  }

  getProjectById(id) {
    return new Promise((resolve, reject) => {
      this.db.get('SELECT * FROM projects WHERE id = ?', [id], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  }

  // Leader queries
  insertLeader(name, projectId) {
    return new Promise((resolve, reject) => {
      this.db.run(
        'INSERT INTO leaders (name, project_id) VALUES (?, ?)',
        [name, projectId],
        function(err) {
          if (err) reject(err);
          else resolve(this.lastID);
        }
      );
    });
  }

  getLeaders() {
    return new Promise((resolve, reject) => {
      this.db.all(
        `SELECT leaders.*, projects.project_name, projects.project_number
         FROM leaders
         LEFT JOIN projects ON leaders.project_id = projects.id
         ORDER BY leaders.name`,
        [],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });
  }

  getLeaderById(id) {
    return new Promise((resolve, reject) => {
      this.db.get(
        `SELECT leaders.*, projects.project_name, projects.project_number
         FROM leaders
         LEFT JOIN projects ON leaders.project_id = projects.id
         WHERE leaders.id = ?`,
        [id],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });
  }

  // Auth con password (incluye password_hash y role)
  getLeaderByIdWithAuth(id) {
    return new Promise((resolve, reject) => {
      this.db.get(
        `SELECT leaders.*, projects.project_name, projects.project_number
         FROM leaders LEFT JOIN projects ON leaders.project_id = projects.id
         WHERE leaders.id = ?`,
        [id],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });
  }

  // Check if admin needs initial setup (no password set)
  checkAdminNeedsSetup() {
    return new Promise((resolve, reject) => {
      this.db.get(
        `SELECT id FROM leaders WHERE role = 'admin' AND (password_hash IS NULL OR password_hash = '')`,
        [],
        (err, row) => {
          if (err) reject(err);
          else resolve(row ? true : false);
        }
      );
    });
  }

  // Set admin password
  setAdminPassword(adminId, passwordHash) {
    return new Promise((resolve, reject) => {
      this.db.run(
        `UPDATE leaders SET password_hash = ? WHERE id = ? AND role = 'admin'`,
        [passwordHash, adminId],
        function(err) {
          if (err) reject(err);
          else resolve(this.changes);
        }
      );
    });
  }

  // Set password for any privileged user (admin or profesor)
  setUserPassword(userId, passwordHash) {
    return new Promise((resolve, reject) => {
      this.db.run(
        `UPDATE leaders SET password_hash = ? WHERE id = ? AND role IN ('admin', 'profesor')`,
        [passwordHash, userId],
        function(err) {
          if (err) reject(err);
          else resolve(this.changes);
        }
      );
    });
  }

  // Check if profesor needs initial setup (no password set)
  checkProfesorNeedsSetup() {
    return new Promise((resolve, reject) => {
      this.db.get(
        `SELECT id FROM leaders WHERE role = 'profesor' AND (password_hash IS NULL OR password_hash = '')`,
        [],
        (err, row) => {
          if (err) reject(err);
          else resolve(row ? true : false);
        }
      );
    });
  }

  // Admin: Obtener todos los estudiantes
  getAllStudents() {
    return new Promise((resolve, reject) => {
      this.db.all(
        `SELECT students.*, projects.project_name, projects.project_number
         FROM students JOIN projects ON students.project_id = projects.id
         ORDER BY projects.project_number, students.name`,
        [],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });
  }

  // Admin: Asistencia global por fecha
  getAllAttendanceByDate(date) {
    return new Promise((resolve, reject) => {
      this.db.all(
        `SELECT attendance.*, students.name as student_name, students.student_id,
                projects.project_name, projects.project_number,
                (SELECT GROUP_CONCAT(l.name, ', ') FROM leaders l WHERE l.project_id = projects.id AND l.role = 'leader') as leader_name
         FROM attendance
         JOIN students ON attendance.student_id = students.id
         JOIN projects ON attendance.project_id = projects.id
         WHERE attendance.date = ?
         ORDER BY projects.project_number, students.name`,
        [date],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });
  }

  // Student queries
  insertStudent(name, studentId, email, projectId) {
    return new Promise((resolve, reject) => {
      this.db.run(
        'INSERT INTO students (name, student_id, email, project_id) VALUES (?, ?, ?, ?)',
        [name, studentId, email, projectId],
        function(err) {
          if (err) reject(err);
          else resolve(this.lastID);
        }
      );
    });
  }

  getStudentById(id) {
    return new Promise((resolve, reject) => {
      this.db.get(
        'SELECT * FROM students WHERE id = ?',
        [id],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });
  }

  getStudentsByProjectId(projectId) {
    return new Promise((resolve, reject) => {
      this.db.all(
        'SELECT * FROM students WHERE project_id = ? ORDER BY name',
        [projectId],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });
  }

  updateStudent(id, name, studentId, email) {
    return new Promise((resolve, reject) => {
      this.db.run(
        'UPDATE students SET name = ?, student_id = ?, email = ? WHERE id = ?',
        [name, studentId, email, id],
        function(err) {
          if (err) reject(err);
          else resolve(this.changes);
        }
      );
    });
  }

  deleteStudent(id) {
    return new Promise((resolve, reject) => {
      this.db.run('DELETE FROM students WHERE id = ?', [id], function(err) {
        if (err) reject(err);
        else resolve(this.changes);
      });
    });
  }

  // Attendance queries.
  //
  // Plain INSERT only (no ON CONFLICT). The previous "DO UPDATE" variant
  // meant two concurrent submitters for the same student+date silently
  // overwrote each other, defeating the route's 409 "already submitted"
  // contract. Same write mutex used by the bulk path so we can't get the
  // "transaction within transaction" race on the shared sqlite3 connection.
  insertAttendance(studentId, projectId, leaderId, date, time, status, justification = null, observation = null, attachmentFilePath = null, attachmentFileName = null) {
    return this.writeMutex.run(() => new Promise((resolve, reject) => {
      this.db.run(
        `INSERT INTO attendance (student_id, project_id, leader_id, date, time, status, justification, observation, attachment_file_path, attachment_file_name, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
        [studentId, projectId, leaderId, date, time, status, justification, observation, attachmentFilePath, attachmentFileName],
        function(err) {
          if (err) reject(err);
          else resolve(this.lastID);
        }
      );
    }));
  }

  getAttendanceByProjectAndDate(projectId, date) {
    return new Promise((resolve, reject) => {
      this.db.all(
        `SELECT attendance.*, students.name as student_name, students.student_id
         FROM attendance
         JOIN students ON attendance.student_id = students.id
         WHERE attendance.project_id = ? AND attendance.date = ?
         ORDER BY students.name`,
        [projectId, date],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });
  }

  getAttendanceByStudent(studentId) {
    return new Promise((resolve, reject) => {
      this.db.all(
        `SELECT
          attendance.*,
          projects.project_name,
          projects.project_number,
          (SELECT GROUP_CONCAT(l.name, ', ') FROM leaders l WHERE l.project_id = projects.id AND l.role = 'leader') as leader_name
         FROM attendance
         LEFT JOIN projects ON attendance.project_id = projects.id
         WHERE attendance.student_id = ?
         ORDER BY attendance.date DESC, attendance.time DESC`,
        [studentId],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });
  }

  getAttendanceSummaryByStudent(studentId) {
    return new Promise((resolve, reject) => {
      this.db.get(
        `SELECT
          COUNT(*) as total_records,
          SUM(CASE WHEN status = 'present' THEN 1 ELSE 0 END) as total_present,
          SUM(CASE WHEN status = 'absent' THEN 1 ELSE 0 END) as total_absent,
          MIN(date) as first_date,
          MAX(date) as last_date
         FROM attendance
         WHERE student_id = ?`,
        [studentId],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });
  }

  // Get students with low attendance (below threshold). Counts only the
  // attendance rows that fall inside the current rotation window for this
  // project, so a student's bad history on another project doesn't follow
  // them.
  getStudentsWithLowAttendance(projectId, threshold = 75) {
    return new Promise((resolve, reject) => {
      this.db.get(
        `SELECT DISTINCT rotation_number
         FROM rotations
         WHERE date('now') BETWEEN start_date AND end_date
         LIMIT 1`,
        [],
        (err, rotationRow) => {
          if (err) { reject(err); return; }
          if (!rotationRow) { resolve([]); return; }

          const rotationNumber = rotationRow.rotation_number;

          this.db.all(
            `SELECT
              students.id,
              students.name,
              students.student_id,
              COUNT(attendance.id) as total_records,
              SUM(CASE WHEN attendance.status = 'present' THEN 1 ELSE 0 END) as total_present,
              SUM(CASE WHEN attendance.status = 'absent' THEN 1 ELSE 0 END) as total_absent,
              CASE
                WHEN COUNT(attendance.id) > 0
                THEN ROUND((SUM(CASE WHEN attendance.status = 'present' THEN 1 ELSE 0 END) * 100.0) / COUNT(attendance.id), 1)
                ELSE 0
              END as attendance_rate
             FROM students
             INNER JOIN rotations ON students.id = rotations.student_id
             LEFT JOIN attendance ON students.id = attendance.student_id
                                  AND attendance.project_id = rotations.project_id
                                  AND attendance.date BETWEEN rotations.start_date AND rotations.end_date
             WHERE rotations.project_id = ? AND rotations.rotation_number = ?
             GROUP BY students.id
             HAVING (CASE
                       WHEN COUNT(attendance.id) > 0
                       THEN (SUM(CASE WHEN attendance.status = 'present' THEN 1 ELSE 0 END) * 100.0) / COUNT(attendance.id)
                       ELSE 0
                     END) < ?
             ORDER BY attendance_rate ASC, students.name ASC`,
            [projectId, rotationNumber, threshold],
            (err, rows) => {
              if (err) reject(err);
              else resolve(rows);
            }
          );
        }
      );
    });
  }

  // Get students with consecutive absences inside the current rotation window
  // for this project. Cross-project / cross-rotation attendance is ignored so
  // historical streaks from other rotations don't pollute the alert.
  getStudentsWithConsecutiveAbsences(projectId, days = 3) {
    return new Promise((resolve, reject) => {
      this.db.get(
        `SELECT DISTINCT rotation_number
         FROM rotations
         WHERE date('now') BETWEEN start_date AND end_date
         LIMIT 1`,
        [],
        (err, rotationRow) => {
          if (err) { reject(err); return; }
          if (!rotationRow) { resolve([]); return; }

          const rotationNumber = rotationRow.rotation_number;

          this.db.all(
            `SELECT
              students.id,
              students.name,
              students.student_id,
              attendance.date,
              attendance.status
             FROM students
             INNER JOIN rotations ON students.id = rotations.student_id
             LEFT JOIN attendance ON students.id = attendance.student_id
                                  AND attendance.project_id = rotations.project_id
                                  AND attendance.date BETWEEN rotations.start_date AND rotations.end_date
             WHERE rotations.project_id = ? AND rotations.rotation_number = ?
             ORDER BY students.id, attendance.date DESC`,
            [projectId, rotationNumber],
        (err, rows) => {
          if (err) {
            reject(err);
            return;
          }

          // Process to find consecutive absences
          const studentsWithIssues = [];
          const studentGroups = {};

          rows.forEach(row => {
            if (!studentGroups[row.id]) {
              studentGroups[row.id] = {
                id: row.id,
                name: row.name,
                student_id: row.student_id,
                records: []
              };
            }
            if (row.date) {
              studentGroups[row.id].records.push({
                date: row.date,
                status: row.status
              });
            }
          });

          // Check for consecutive absences (looking through entire history, not just most recent)
          Object.values(studentGroups).forEach(student => {
            if (student.records.length === 0) return;

            // Sort records by date ascending to check chronologically
            const sortedRecords = [...student.records].sort((a, b) =>
              new Date(a.date) - new Date(b.date)
            );

            let consecutiveAbsences = 0;
            let maxConsecutiveAbsences = 0;
            let currentStreakStartDate = null;
            let maxStreakStartDate = null;

            // Scan through all records to find maximum consecutive absence streak
            for (let i = 0; i < sortedRecords.length; i++) {
              if (sortedRecords[i].status === 'absent') {
                if (consecutiveAbsences === 0) {
                  currentStreakStartDate = sortedRecords[i].date;
                }
                consecutiveAbsences++;
                if (consecutiveAbsences > maxConsecutiveAbsences) {
                  maxConsecutiveAbsences = consecutiveAbsences;
                  maxStreakStartDate = currentStreakStartDate;
                }
              } else {
                consecutiveAbsences = 0;
                currentStreakStartDate = null;
              }
            }

            // Report if any streak meets the threshold
            if (maxConsecutiveAbsences >= days) {
              studentsWithIssues.push({
                id: student.id,
                name: student.name,
                student_id: student.student_id,
                consecutive_absences: maxConsecutiveAbsences,
                last_absence_date: maxStreakStartDate
              });
            }
          });

          resolve(studentsWithIssues);
        }
      );
        }
      );
    });
  }

  // Check if attendance already exists for a student on a specific date
  checkAttendanceExists(studentId, date) {
    return new Promise((resolve, reject) => {
      this.db.get(
        'SELECT id FROM attendance WHERE student_id = ? AND date = ?',
        [studentId, date],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });
  }

  // Check if attendance has been submitted for a project on a specific date
  checkProjectAttendanceExists(projectId, date) {
    return new Promise((resolve, reject) => {
      this.db.get(
        'SELECT id FROM attendance WHERE project_id = ? AND date = ? LIMIT 1',
        [projectId, date],
        (err, row) => {
          if (err) reject(err);
          else resolve(row ? true : false);
        }
      );
    });
  }

  // Update existing attendance
  updateAttendance(studentId, date, time, status) {
    return new Promise((resolve, reject) => {
      this.db.run(
        'UPDATE attendance SET time = ?, status = ?, timestamp = CURRENT_TIMESTAMP WHERE student_id = ? AND date = ?',
        [time, status, studentId, date],
        function(err) {
          if (err) reject(err);
          else resolve(this.changes);
        }
      );
    });
  }

  // Validate that a student belongs to a project (checks base project OR rotation assignment)
  validateStudentBelongsToProject(studentId, projectId, date = null) {
    return new Promise((resolve, reject) => {
      // If date is provided, check rotation assignment for that date
      if (date) {
        this.db.get(
          `SELECT id FROM students
           WHERE id = ?
           AND (
             project_id = ?
             OR id IN (
               SELECT student_id FROM rotations
               WHERE student_id = ?
               AND project_id = ?
               AND ? BETWEEN start_date AND end_date
             )
           )`,
          [studentId, projectId, studentId, projectId, date],
          (err, row) => {
            if (err) reject(err);
            else resolve(row ? true : false);
          }
        );
      } else {
        // No date provided, only check base project
        this.db.get(
          'SELECT id FROM students WHERE id = ? AND project_id = ?',
          [studentId, projectId],
          (err, row) => {
            if (err) reject(err);
            else resolve(row ? true : false);
          }
        );
      }
    });
  }

  // Statistics queries.
  //
  // - With no date: pure roster counts (no attendance dimension).
  // - With a single date: counts for that date.
  // - With a startDate+endDate range: sums attendance rows in the inclusive
  //   range. We aggregate per-row (each attendance record is counted once),
  //   not per-student-distinct, because over a range the same student
  //   contributes multiple rows.
  getOverallStatistics(date, { startDate, endDate } = {}) {
    return new Promise((resolve, reject) => {
      if (startDate && endDate) {
        const query = `
          SELECT
            (SELECT COUNT(*) FROM students) as total_students,
            (SELECT COUNT(*) FROM projects) as total_projects,
            COALESCE(SUM(CASE WHEN status = 'present' THEN 1 ELSE 0 END), 0) as total_present,
            COALESCE(SUM(CASE WHEN status = 'absent' AND justification = 'justificada' THEN 1 ELSE 0 END), 0) as total_absent_justified,
            COALESCE(SUM(CASE WHEN status = 'absent' AND justification = 'injustificada' THEN 1 ELSE 0 END), 0) as total_absent_unjustified,
            COALESCE(SUM(CASE WHEN status = 'absent' THEN 1 ELSE 0 END), 0) as total_absent
          FROM attendance
          WHERE date BETWEEN ? AND ?
        `;
        this.db.get(query, [startDate, endDate], (err, row) => err ? reject(err) : resolve(row));
        return;
      }

      const query = date ?
        `SELECT
          COUNT(DISTINCT students.id) as total_students,
          COUNT(DISTINCT projects.id) as total_projects,
          COUNT(DISTINCT CASE WHEN attendance.status = 'present' THEN attendance.student_id END) as total_present,
          COUNT(DISTINCT CASE WHEN attendance.status = 'absent' AND attendance.justification = 'justificada' THEN attendance.student_id END) as total_absent_justified,
          COUNT(DISTINCT CASE WHEN attendance.status = 'absent' AND attendance.justification = 'injustificada' THEN attendance.student_id END) as total_absent_unjustified,
          COUNT(DISTINCT CASE WHEN attendance.status = 'absent' THEN attendance.student_id END) as total_absent
         FROM students
         LEFT JOIN projects ON students.project_id = projects.id
         LEFT JOIN attendance ON students.id = attendance.student_id AND attendance.date = ?` :
        `SELECT
          COUNT(DISTINCT students.id) as total_students,
          COUNT(DISTINCT projects.id) as total_projects
         FROM students
         LEFT JOIN projects ON students.project_id = projects.id`;

      this.db.get(query, date ? [date] : [], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  }

  getProjectStatistics(date, { startDate, endDate } = {}) {
    return new Promise((resolve, reject) => {
      // Range mode: aggregate attendance rows in [startDate, endDate]. We
      // don't constrain by rotation_number here because over a multi-week
      // range we want every project's attendance regardless of which
      // rotation those students happened to be assigned to.
      if (startDate && endDate) {
        const query = `
          SELECT
            projects.id,
            projects.project_number,
            projects.project_name,
            (SELECT COUNT(*) FROM students WHERE project_id = projects.id) as total_students,
            COALESCE(SUM(CASE WHEN attendance.status = 'present' THEN 1 ELSE 0 END), 0) as present,
            COALESCE(SUM(CASE WHEN attendance.status = 'absent' AND attendance.justification = 'justificada' THEN 1 ELSE 0 END), 0) as absent_justified,
            COALESCE(SUM(CASE WHEN attendance.status = 'absent' AND attendance.justification = 'injustificada' THEN 1 ELSE 0 END), 0) as absent_unjustified,
            COALESCE(SUM(CASE WHEN attendance.status = 'absent' THEN 1 ELSE 0 END), 0) as absent
          FROM projects
          LEFT JOIN attendance ON attendance.project_id = projects.id
            AND attendance.date BETWEEN ? AND ?
          GROUP BY projects.id
          ORDER BY projects.project_number
        `;
        this.db.all(query, [startDate, endDate], (err, rows) => err ? reject(err) : resolve(rows));
        return;
      }

      if (!date) {
        // Without date, return total students in each project (from students table)
        const query = `SELECT
          projects.id,
          projects.project_number,
          projects.project_name,
          COUNT(DISTINCT students.id) as total_students
         FROM projects
         LEFT JOIN students ON projects.id = students.project_id
         GROUP BY projects.id
         ORDER BY projects.project_number`;

        this.db.all(query, [], (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        });
        return;
      }

      // With date: Get current rotation first, then calculate stats based on rotations
      this.db.get(
        `SELECT DISTINCT rotation_number
         FROM rotations
         WHERE ? BETWEEN start_date AND end_date
         LIMIT 1`,
        [date],
        (err, rotationRow) => {
          if (err) {
            reject(err);
            return;
          }

          const rotationNumber = rotationRow ? rotationRow.rotation_number : null;

          if (!rotationNumber) {
            // No active rotation, return zeros
            this.db.all(
              `SELECT id, project_number, project_name, 0 as total_students, 0 as present, 0 as absent
               FROM projects
               ORDER BY project_number`,
              [],
              (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
              }
            );
            return;
          }

          // Get stats based on current rotation
          const query = `SELECT
            projects.id,
            projects.project_number,
            projects.project_name,
            COUNT(DISTINCT rotations.student_id) as total_students,
            COUNT(DISTINCT CASE WHEN attendance.status = 'present' AND attendance.date = ? THEN students.id END) as present,
            COUNT(DISTINCT CASE WHEN attendance.status = 'absent' AND attendance.justification = 'justificada' AND attendance.date = ? THEN students.id END) as absent_justified,
            COUNT(DISTINCT CASE WHEN attendance.status = 'absent' AND attendance.justification = 'injustificada' AND attendance.date = ? THEN students.id END) as absent_unjustified,
            COUNT(DISTINCT CASE WHEN attendance.status = 'absent' AND attendance.date = ? THEN students.id END) as absent
           FROM projects
           LEFT JOIN rotations ON projects.id = rotations.project_id AND rotations.rotation_number = ?
           LEFT JOIN students ON rotations.student_id = students.id
           LEFT JOIN attendance ON students.id = attendance.student_id
                                AND attendance.project_id = projects.id
                                AND attendance.date = ?
           GROUP BY projects.id
           ORDER BY projects.project_number`;

          this.db.all(query, [date, date, date, date, rotationNumber, date], (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
          });
        }
      );
    });
  }

  getLeaderProjectStatistics(leaderId, date) {
    return new Promise((resolve, reject) => {
      // First get the leader's project
      this.db.get(
        'SELECT project_id FROM leaders WHERE id = ?',
        [leaderId],
        (err, leader) => {
          if (err || !leader) {
            reject(err || new Error('Leader not found'));
            return;
          }

          const projectId = leader.project_id;

          if (!date) {
            // Return total students for this project
            this.db.get(
              `SELECT COUNT(*) as total_students FROM students WHERE project_id = ?`,
              [projectId],
              (err, row) => {
                if (err) reject(err);
                else resolve({ total_students: row.total_students, present: 0, absent: 0 });
              }
            );
            return;
          }

          // Get current rotation
          this.db.get(
            `SELECT DISTINCT rotation_number
             FROM rotations
             WHERE ? BETWEEN start_date AND end_date
             LIMIT 1`,
            [date],
            (err, rotationRow) => {
              if (err) {
                reject(err);
                return;
              }

              const rotationNumber = rotationRow ? rotationRow.rotation_number : null;

              if (!rotationNumber) {
                resolve({ total_students: 0, present: 0, absent: 0 });
                return;
              }

              // Get stats for this leader's project and rotation
              const query = `SELECT
                COUNT(DISTINCT rotations.student_id) as total_students,
                COUNT(DISTINCT CASE WHEN attendance.status = 'present' AND attendance.leader_id = ? THEN students.id END) as present,
                COUNT(DISTINCT CASE WHEN attendance.status = 'absent' AND attendance.leader_id = ? THEN students.id END) as absent
               FROM rotations
               LEFT JOIN students ON rotations.student_id = students.id
               LEFT JOIN attendance ON students.id = attendance.student_id
                                    AND attendance.project_id = ?
                                    AND attendance.date = ?
               WHERE rotations.project_id = ? AND rotations.rotation_number = ?`;

              this.db.get(query, [leaderId, leaderId, projectId, date, projectId, rotationNumber], (err, row) => {
                if (err) reject(err);
                else resolve(row);
              });
            }
          );
        }
      );
    });
  }

  getAttendanceHistory(days = 7) {
    return new Promise((resolve, reject) => {
      this.db.all(
        `SELECT
          date,
          COUNT(DISTINCT CASE WHEN status = 'present' THEN student_id END) as present,
          COUNT(DISTINCT CASE WHEN status = 'absent' THEN student_id END) as absent,
          COUNT(DISTINCT student_id) as total
         FROM attendance
         WHERE date >= date('now', '-' || ? || ' days')
         GROUP BY date
         ORDER BY date DESC`,
        [days],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });
  }

  // Rotation queries
  insertRotation(rotationNumber, studentId, projectId, startDate, endDate) {
    return new Promise((resolve, reject) => {
      this.db.run(
        'INSERT INTO rotations (rotation_number, student_id, project_id, start_date, end_date) VALUES (?, ?, ?, ?, ?)',
        [rotationNumber, studentId, projectId, startDate, endDate],
        function(err) {
          if (err) reject(err);
          else resolve(this.lastID);
        }
      );
    });
  }

  getRotationsByStudent(studentId) {
    return new Promise((resolve, reject) => {
      this.db.all(
        `SELECT rotations.*, projects.project_name
         FROM rotations
         JOIN projects ON rotations.project_id = projects.id
         WHERE rotations.student_id = ?
         ORDER BY rotations.rotation_number`,
        [studentId],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });
  }

  getRotationsByProject(projectId) {
    return new Promise((resolve, reject) => {
      this.db.all(
        `SELECT rotations.*, students.name as student_name
         FROM rotations
         JOIN students ON rotations.student_id = students.id
         WHERE rotations.project_id = ?
         ORDER BY rotations.rotation_number, students.name`,
        [projectId],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });
  }

  getAvailableRotationNumbers(projectId) {
    return new Promise((resolve, reject) => {
      this.db.all(
        `SELECT DISTINCT rotation_number
         FROM rotations
         WHERE project_id = ?
         ORDER BY rotation_number`,
        [projectId],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows.map(row => row.rotation_number));
        }
      );
    });
  }

  getCurrentRotationForStudent(studentId, date) {
    return new Promise((resolve, reject) => {
      this.db.get(
        `SELECT rotations.*, projects.project_name
         FROM rotations
         JOIN projects ON rotations.project_id = projects.id
         WHERE rotations.student_id = ?
         AND ? BETWEEN rotations.start_date AND rotations.end_date`,
        [studentId, date],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });
  }

  getCurrentRotation() {
    return new Promise((resolve, reject) => {
      this.db.get(
        `SELECT DISTINCT rotation_number
         FROM rotations
         WHERE date('now') BETWEEN start_date AND end_date
         LIMIT 1`,
        [],
        (err, row) => {
          if (err) reject(err);
          else resolve(row ? row.rotation_number : null);
        }
      );
    });
  }

  getAllRotationsSchedule() {
    return new Promise((resolve, reject) => {
      this.db.all(
        `SELECT DISTINCT rotation_number, start_date, end_date
         FROM rotations
         ORDER BY rotation_number`,
        [],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });
  }

  getStudentsByProjectAndRotation(projectId, rotationNumber) {
    return new Promise((resolve, reject) => {
      this.db.all(
        `SELECT students.*, rotations.start_date, rotations.end_date
         FROM students
         JOIN rotations ON students.id = rotations.student_id
         WHERE rotations.project_id = ? AND rotations.rotation_number = ?
         ORDER BY students.name`,
        [projectId, rotationNumber],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });
  }

  getDetailedStudentDataForExport(date = null) {
    return new Promise((resolve, reject) => {
      let query;
      let params;

      if (date) {
        // Get students with attendance data for a specific date
        query = `
          SELECT
            s.id,
            s.name,
            s.student_id,
            s.email,
            p.project_number,
            p.project_name,
            a.status,
            a.justification,
            a.observation,
            a.date
          FROM students s
          INNER JOIN projects p ON s.project_id = p.id
          LEFT JOIN attendance a ON s.id = a.student_id AND a.date = ?
          ORDER BY p.project_number, s.name
        `;
        params = [date];
      } else {
        // Get all students with their project info (no date filter)
        query = `
          SELECT
            s.id,
            s.name,
            s.student_id,
            s.email,
            p.project_number,
            p.project_name
          FROM students s
          INNER JOIN projects p ON s.project_id = p.id
          ORDER BY p.project_number, s.name
        `;
        params = [];
      }

      this.db.all(query, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  }

  // Bulk insert attendance for multiple students atomically.
  //
  // Concurrency: serialized through `writeMutex` so that with 14 leaders all
  // pressing "Guardar" at the same moment, the bulk inserts queue cleanly
  // instead of racing each other into "cannot start a transaction within a
  // transaction" errors on the shared sqlite3 connection.
  //
  // Atomicity: opens `BEGIN IMMEDIATE TRANSACTION`, then re-checks for an
  // existing attendance row for (projectId, date) INSIDE the transaction.
  // If one already exists, rolls back and rejects with a custom error
  // (`code = 'ATTENDANCE_ALREADY_SUBMITTED'`) so the route can return 409.
  // Otherwise inserts all rows. The UNIQUE(student_id, date) constraint
  // gives a defense-in-depth backstop and surfaces as SQLITE_CONSTRAINT.
  insertBulkAttendance(records) {
    if (!records || records.length === 0) {
      return Promise.reject(new Error('No records to insert'));
    }
    const projectId = records[0].projectId;
    const date = records[0].date;

    // Global serialization: the sqlite3 binding has one underlying connection,
    // so concurrent BEGIN statements race regardless of "logical" partitioning
    // by project. A per-project mutex sounds appealing but fails in practice
    // — we must keep all writers serialized at the JS layer.
    return this.writeMutex.run(() => new Promise((resolve, reject) => {
      this.db.serialize(() => {
        this.db.run('BEGIN IMMEDIATE TRANSACTION', (beginErr) => {
          if (beginErr) { reject(beginErr); return; }

          const fail = (err) => this.db.run('ROLLBACK', () => reject(err));

          // Re-check inside the transaction so two near-simultaneous submitters
          // can't both pass the outer existence check and then both insert.
          this.db.get(
            'SELECT id FROM attendance WHERE project_id = ? AND date = ? LIMIT 1',
            [projectId, date],
            (checkErr, row) => {
              if (checkErr) return fail(checkErr);
              if (row) {
                const e = new Error('Attendance for this project and date already exists');
                e.code = 'ATTENDANCE_ALREADY_SUBMITTED';
                return fail(e);
              }

              const stmt = this.db.prepare(`
                INSERT INTO attendance (student_id, project_id, leader_id, date, time, status, justification, observation, attachment_file_path, attachment_file_name, timestamp)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
              `);

              let firstError = null;
              for (const record of records) {
                stmt.run(
                  [record.studentId, record.projectId, record.leaderId, record.date, record.time, record.status, record.justification, record.observation, record.attachmentFilePath, record.attachmentFileName],
                  function (err) {
                    if (err && !firstError) firstError = err;
                  }
                );
              }

              stmt.finalize((finalizeErr) => {
                const err = firstError || finalizeErr;
                if (err) return fail(err);
                this.db.run('COMMIT', (commitErr) => {
                  if (commitErr) return reject(commitErr);
                  resolve({ inserted: records.length });
                });
              });
            }
          );
        });
      });
    }));
  }

  // Replace attendance for a (projectId, date) atomically. Used by the
  // offline-queue conflict resolver: when a leader's queued submission
  // hits a 409 because someone else already saved, the resolver UI lets
  // them pick a final per-student outcome and POSTs the merged result
  // here. We delete the existing rows and insert the new ones inside one
  // transaction so a partial failure can't leave the day in a half state.
  //
  // Records is the SAME shape as insertBulkAttendance expects.
  // resolutionMode is just metadata (overwrite vs merge) for the audit log.
  resolveBulkAttendance(records, resolutionMode, payloadJson, identity = {}) {
    if (!records || records.length === 0) {
      return Promise.reject(new Error('No records to insert'));
    }
    const projectId = records[0].projectId;
    const leaderId = records[0].leaderId;
    const date = records[0].date;
    const sourceIp = identity.sourceIp ?? null;
    const userAgent = identity.userAgent ?? null;

    return this.writeMutex.run(() => new Promise((resolve, reject) => {
      this.db.serialize(() => {
        this.db.run('BEGIN IMMEDIATE TRANSACTION', (beginErr) => {
          if (beginErr) { reject(beginErr); return; }

          const fail = (err) => this.db.run('ROLLBACK', () => reject(err));

          // Count what we're about to wipe so the audit row is honest.
          this.db.get(
            'SELECT COUNT(*) AS n FROM attendance WHERE project_id = ? AND date = ?',
            [projectId, date],
            (countErr, countRow) => {
              if (countErr) return fail(countErr);
              const replaced = countRow?.n ?? 0;

              this.db.run(
                'DELETE FROM attendance WHERE project_id = ? AND date = ?',
                [projectId, date],
                (delErr) => {
                  if (delErr) return fail(delErr);

                  const stmt = this.db.prepare(`
                    INSERT INTO attendance (student_id, project_id, leader_id, date, time, status, justification, observation, attachment_file_path, attachment_file_name, timestamp)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                  `);
                  let firstError = null;
                  for (const r of records) {
                    stmt.run(
                      [r.studentId, r.projectId, r.leaderId, r.date, r.time, r.status, r.justification, r.observation, r.attachmentFilePath, r.attachmentFileName],
                      function (err) { if (err && !firstError) firstError = err; }
                    );
                  }
                  stmt.finalize((finalizeErr) => {
                    const err = firstError || finalizeErr;
                    if (err) return fail(err);

                    this.db.run(
                      `INSERT INTO attendance_resolutions
                       (project_id, leader_id, date, resolution_mode, records_count, replaced_count, payload_json, source_ip, user_agent)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                      [projectId, leaderId, date, resolutionMode, records.length, replaced, payloadJson, sourceIp, userAgent],
                      (auditErr) => {
                        if (auditErr) return fail(auditErr);
                        this.db.run('COMMIT', (commitErr) => {
                          if (commitErr) return reject(commitErr);
                          resolve({ inserted: records.length, replaced });
                        });
                      }
                    );
                  });
                }
              );
            }
          );
        });
      });
    }));
  }

  // ----- Push subscriptions (Web Push) -----

  // Insert or refresh a subscription. The endpoint is unique per
  // browser/device, so a leader logging in on a new tablet creates a new
  // row without disturbing their other devices.
  upsertPushSubscription({ leaderId, endpoint, p256dh, auth, userAgent }) {
    // Under writeMutex so it can't race the cron's removePushSubscription
    // for a 410'd endpoint — without serialization, a fresh subscribe
    // could be issued and then immediately deleted by a stale cron
    // iteration, silently unsubscribing the device.
    return this.writeMutex.run(() => new Promise((resolve, reject) => {
      this.db.run(
        `INSERT INTO push_subscriptions (leader_id, endpoint, p256dh, auth, user_agent)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET
           leader_id = excluded.leader_id,
           p256dh = excluded.p256dh,
           auth = excluded.auth,
           user_agent = excluded.user_agent`,
        [leaderId ?? null, endpoint, p256dh, auth, userAgent ?? null],
        function (err) {
          if (err) reject(err);
          else resolve(this.lastID);
        },
      );
    }));
  }

  removePushSubscription(endpoint) {
    return this.writeMutex.run(() => new Promise((resolve, reject) => {
      this.db.run(
        'DELETE FROM push_subscriptions WHERE endpoint = ?',
        [endpoint],
        function (err) {
          if (err) reject(err);
          else resolve(this.changes);
        },
      );
    }));
  }

  listPushSubscriptions() {
    return new Promise((resolve, reject) => {
      this.db.all(
        `SELECT id, leader_id, endpoint, p256dh, auth FROM push_subscriptions`,
        [],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        },
      );
    });
  }

  // Push subscriptions for leaders whose sync state currently flags
  // pending work. Used by the cron — without the join filter we'd push
  // every device every 30 min regardless of need.
  listPushSubscriptionsNeedingSync() {
    return new Promise((resolve, reject) => {
      this.db.all(
        `SELECT s.id, s.leader_id, s.endpoint, s.p256dh, s.auth
         FROM push_subscriptions s
         JOIN leader_sync_state st ON st.leader_id = s.leader_id
         WHERE st.sync_needed_at IS NOT NULL`,
        [],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        },
      );
    });
  }

  // Leaders whose sync has been flagged for more than the given number
  // of minutes AND who haven't been emailed in the last 24 hours. Used
  // by the email-escalation job — push notifications missed them so we
  // fall back to email. Joins to leaders for the email address.
  listLeadersForEmailEscalation(staleMinutes = 60) {
    return new Promise((resolve, reject) => {
      this.db.all(
        `SELECT
           st.leader_id,
           st.last_known_queue_size,
           st.sync_needed_at,
           l.name AS leader_name,
           l.email AS leader_email
         FROM leader_sync_state st
         JOIN leaders l ON l.id = st.leader_id
         WHERE st.sync_needed_at IS NOT NULL
           AND st.sync_needed_at <= datetime('now', '-' || ? || ' minutes')
           AND (st.last_email_sent_at IS NULL
                OR st.last_email_sent_at <= datetime('now', '-24 hours'))
           AND l.email IS NOT NULL
           AND l.email != ''`,
        [staleMinutes],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        },
      );
    });
  }

  markLeaderEmailed(leaderId) {
    return new Promise((resolve, reject) => {
      this.db.run(
        `UPDATE leader_sync_state SET last_email_sent_at = CURRENT_TIMESTAMP
         WHERE leader_id = ?`,
        [leaderId],
        function (err) {
          if (err) reject(err);
          else resolve(this.changes);
        },
      );
    });
  }

  // Update the per-leader sync hint. queueSize is what the client
  // claims is currently pending in IndexedDB. > 0 sets sync_needed_at;
  // 0 clears it. Always updates last_seen_at so we have a "last
  // contact" signal for future device-pruning logic.
  upsertLeaderSyncState(leaderId, queueSize) {
    if (!leaderId) return Promise.resolve();
    const sizeNum = Number.isFinite(queueSize) ? queueSize : 0;
    const needed = sizeNum > 0 ? 'CURRENT_TIMESTAMP' : 'NULL';
    // When queue clears (sizeNum===0), also reset last_email_sent_at so
    // a future pending session can trigger a fresh email after the
    // staleness threshold — the 24h debounce was meant to prevent
    // duplicate emails inside one session, not across sessions.
    const emailReset = sizeNum === 0 ? ', last_email_sent_at = NULL' : '';
    // Goes through the same writeMutex as bulk-attendance writes: without
    // it, the upsert competes with BEGIN IMMEDIATE on the single sqlite3
    // connection, and 14 leaders pressing Guardar at the same moment can
    // pile up "database is locked" busy-timeouts on the unprivileged
    // tracker path while the privileged bulk-write transaction holds the
    // lock.
    return this.writeMutex.run(() => new Promise((resolve, reject) => {
      this.db.run(
        `INSERT INTO leader_sync_state (leader_id, last_known_queue_size, sync_needed_at, last_seen_at)
         VALUES (?, ?, ${needed}, CURRENT_TIMESTAMP)
         ON CONFLICT(leader_id) DO UPDATE SET
           last_known_queue_size = excluded.last_known_queue_size,
           sync_needed_at = ${needed},
           last_seen_at = CURRENT_TIMESTAMP${emailReset}`,
        [leaderId, sizeNum],
        function (err) {
          if (err) reject(err);
          else resolve(this.changes);
        },
      );
    }));
  }

  // Mark a successful push so we can age out devices that haven't been
  // heard from in a long time (future cleanup job — not used yet).
  markPushed(endpoint, status) {
    // Under writeMutex for the same reason as upsert/remove — see the
    // comment on upsertPushSubscription. A markPushed UPDATE racing a
    // concurrent DELETE for the same endpoint would silently no-op.
    return this.writeMutex.run(() => new Promise((resolve, reject) => {
      this.db.run(
        `UPDATE push_subscriptions
         SET last_pushed_at = CURRENT_TIMESTAMP, last_status = ?
         WHERE endpoint = ?`,
        [status, endpoint],
        function (err) {
          if (err) reject(err);
          else resolve(this.changes);
        },
      );
    }));
  }

  // Get all absent students with optional filters (for profesor view)
  getAbsentStudents(date = null, projectId = null, justification = null) {
    return new Promise((resolve, reject) => {
      let query = `
        SELECT
          attendance.id as attendance_id,
          attendance.date,
          attendance.time,
          attendance.status,
          attendance.justification,
          attendance.observation,
          attendance.attachment_file_name,
          students.id as student_id,
          students.name as student_name,
          students.student_id as student_code,
          students.email as student_email,
          projects.id as project_id,
          projects.project_number,
          projects.project_name,
          (SELECT GROUP_CONCAT(l.name, ', ') FROM leaders l WHERE l.project_id = projects.id AND l.role = 'leader') as leader_name
        FROM attendance
        JOIN students ON attendance.student_id = students.id
        JOIN projects ON attendance.project_id = projects.id
        WHERE attendance.status = 'absent'
      `;

      const params = [];

      if (date) {
        query += ` AND attendance.date = ?`;
        params.push(date);
      }

      if (projectId) {
        query += ` AND projects.id = ?`;
        params.push(projectId);
      }

      if (justification && (justification === 'justificada' || justification === 'injustificada')) {
        query += ` AND attendance.justification = ?`;
        params.push(justification);
      }

      query += ` ORDER BY attendance.date DESC, projects.project_number, students.name`;

      this.db.all(query, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  }

  // Get attendance summary for date range (for profesor view)
  getAttendanceSummary(startDate = null, endDate = null, projectId = null) {
    return new Promise((resolve, reject) => {
      let query = `
        SELECT
          attendance.date,
          projects.project_name,
          projects.project_number,
          COUNT(CASE WHEN attendance.status = 'present' THEN 1 END) as present_count,
          COUNT(CASE WHEN attendance.status = 'absent' THEN 1 END) as absent_count,
          COUNT(CASE WHEN attendance.status = 'absent' AND attendance.justification = 'justificada' THEN 1 END) as justified_count,
          COUNT(CASE WHEN attendance.status = 'absent' AND attendance.justification = 'injustificada' THEN 1 END) as unjustified_count
        FROM attendance
        JOIN projects ON attendance.project_id = projects.id
        WHERE 1=1
      `;

      const params = [];

      if (startDate) {
        query += ` AND attendance.date >= ?`;
        params.push(startDate);
      }

      if (endDate) {
        query += ` AND attendance.date <= ?`;
        params.push(endDate);
      }

      if (projectId) {
        query += ` AND projects.id = ?`;
        params.push(projectId);
      }

      query += ` GROUP BY attendance.date, projects.id ORDER BY attendance.date DESC, projects.project_number`;

      this.db.all(query, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  }

  // ── Profesor attendance ───────────────────────────────────────────────
  // Reads + writes for the profe-only "start" / "end" attendance passes.
  // Kept fully separate from leader attendance so the existing UNIQUE
  // index on (student_id, date) stays intact and the two data sources
  // can be cross-referenced later (e.g. comparing the leader's count
  // against the profe's start/end pass).

  // Fetch every profe-pass row for a project on a given date. Returns
  // both passes interleaved; callers pivot client-side.
  getProfesorAttendanceForProjectDate(projectId, date) {
    return new Promise((resolve, reject) => {
      this.db.all(
        `SELECT pa.id, pa.profesor_id, pa.project_id, pa.student_id,
                pa.date, pa.pass_type, pa.status, pa.recorded_at, pa.observation,
                s.name AS student_name, s.student_id AS student_code,
                l.name AS profesor_name
         FROM profesor_attendance pa
         LEFT JOIN students s ON s.id = pa.student_id
         LEFT JOIN leaders l  ON l.id = pa.profesor_id
         WHERE pa.project_id = ? AND pa.date = ?
         ORDER BY pa.pass_type, s.name`,
        [projectId, date],
        (err, rows) => (err ? reject(err) : resolve(rows || [])),
      );
    });
  }

  // Bulk upsert for one (project, date, pass_type). Each entry:
  //   { student_id, status, observation? }
  // We run the whole batch in a single transaction under writeMutex so
  // a profe pressing "Guardar" with 30 students can't race the periodic
  // sync writer on the same sqlite3 connection.
  bulkUpsertProfesorAttendance({ profesorId, projectId, date, passType, entries }) {
    return this.writeMutex.run(() => new Promise((resolve, reject) => {
      this.db.serialize(() => {
        this.db.run('BEGIN IMMEDIATE', (beginErr) => {
          if (beginErr) return reject(beginErr);
          const stmt = this.db.prepare(
            `INSERT INTO profesor_attendance
               (profesor_id, project_id, student_id, date, pass_type, status, observation, recorded_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
             ON CONFLICT(student_id, date, pass_type) DO UPDATE SET
               status = excluded.status,
               observation = excluded.observation,
               profesor_id = excluded.profesor_id,
               recorded_at = CURRENT_TIMESTAMP`
          );
          let errored = null;
          for (const e of entries) {
            stmt.run(
              profesorId,
              projectId,
              e.student_id,
              date,
              passType,
              e.status,
              e.observation || null,
              (err) => { if (err && !errored) errored = err; },
            );
          }
          stmt.finalize((finalizeErr) => {
            if (errored || finalizeErr) {
              this.db.run('ROLLBACK', () => reject(errored || finalizeErr));
            } else {
              this.db.run('COMMIT', (commitErr) => commitErr ? reject(commitErr) : resolve({ updated: entries.length }));
            }
          });
        });
      });
    }));
  }

  // Return the subset of given student IDs that do NOT belong to the
  // given project. Used by POST /profesor-attendance/bulk to reject
  // cross-tenant writes before they hit the upsert. Empty input or
  // all-correct input returns []. Note: a student id that doesn't
  // exist at all is also returned as "not in project" — same response
  // either way (the row would have been junk).
  findStudentsNotInProject(studentIds, projectId) {
    if (!Array.isArray(studentIds) || studentIds.length === 0) {
      return Promise.resolve([]);
    }
    // Deduplicate so the IN-clause stays minimal; cap at 500 to keep
    // the placeholder list bounded.
    const ids = [...new Set(studentIds)].slice(0, 500);
    const placeholders = ids.map(() => '?').join(',');
    return new Promise((resolve, reject) => {
      this.db.all(
        `SELECT id FROM students WHERE id IN (${placeholders}) AND project_id = ?`,
        [...ids, projectId],
        (err, rows) => {
          if (err) return reject(err);
          const ok = new Set((rows || []).map((r) => r.id));
          resolve(ids.filter((id) => !ok.has(id)));
        },
      );
    });
  }

  // Coordinator compliance view: for a given date, return one row per
  // project that has any students, with the latest start- and end-pass
  // status (who marked, when, how many present). NULL pass columns mean
  // no profe has saved that pass yet — the supervisor's "still pending"
  // signal.
  getProfesorAttendanceCompliance(date) {
    return new Promise((resolve, reject) => {
      const sql = `
        WITH project_rosters AS (
          SELECT DISTINCT p.id AS project_id,
                 p.project_name,
                 p.project_number,
                 (SELECT COUNT(*) FROM students s WHERE s.project_id = p.id) AS roster_size
          FROM projects p
          WHERE EXISTS (SELECT 1 FROM students s WHERE s.project_id = p.id)
        ),
        latest_per_pass AS (
          SELECT pa.project_id, pa.pass_type,
                 MAX(pa.recorded_at) AS latest_recorded_at,
                 COUNT(*)              AS rows_count,
                 SUM(CASE WHEN pa.status = 'present' THEN 1 ELSE 0 END) AS present_count
          FROM profesor_attendance pa
          WHERE pa.date = ?
          GROUP BY pa.project_id, pa.pass_type
        ),
        latest_row AS (
          -- Pick the actual most-recent row per (project, pass) so we
          -- can name the profe who saved it last.
          SELECT pa.project_id, pa.pass_type, pa.profesor_id, pa.recorded_at,
                 l.name AS profesor_name
          FROM profesor_attendance pa
          LEFT JOIN leaders l ON l.id = pa.profesor_id
          WHERE pa.date = ?
            AND pa.recorded_at = (
              SELECT MAX(p2.recorded_at) FROM profesor_attendance p2
              WHERE p2.project_id = pa.project_id AND p2.pass_type = pa.pass_type AND p2.date = ?
            )
          GROUP BY pa.project_id, pa.pass_type
        )
        SELECT pr.project_id, pr.project_name, pr.project_number, pr.roster_size,
               s_lp.latest_recorded_at AS start_recorded_at,
               s_lr.profesor_name       AS start_profesor_name,
               s_lp.present_count       AS start_present_count,
               s_lp.rows_count          AS start_rows_count,
               e_lp.latest_recorded_at AS end_recorded_at,
               e_lr.profesor_name       AS end_profesor_name,
               e_lp.present_count       AS end_present_count,
               e_lp.rows_count          AS end_rows_count
        FROM project_rosters pr
        LEFT JOIN latest_per_pass s_lp ON s_lp.project_id = pr.project_id AND s_lp.pass_type = 'start'
        LEFT JOIN latest_per_pass e_lp ON e_lp.project_id = pr.project_id AND e_lp.pass_type = 'end'
        LEFT JOIN latest_row      s_lr ON s_lr.project_id = pr.project_id AND s_lr.pass_type = 'start'
        LEFT JOIN latest_row      e_lr ON e_lr.project_id = pr.project_id AND e_lr.pass_type = 'end'
        ORDER BY pr.project_number, pr.project_name`;
      this.db.all(sql, [date, date, date], (err, rows) => (err ? reject(err) : resolve(rows || [])));
    });
  }

  // ── Jornada / daily sign-off ───────────────────────────────────────────

  // Per-project status for a date: primera lista (from the leader `attendance`
  // table), segunda lista (the 'end' pass, reusing the compliance query), and
  // the sign-off/lock state. Drives the profe/coordinador review surface.
  getJornadaStatus(date) {
    const allAsync = (sql, p) =>
      new Promise((res, rej) => this.db.all(sql, p, (e, r) => (e ? rej(e) : res(r || []))));
    return Promise.all([
      this.getProfesorAttendanceCompliance(date), // per project: roster + end_* (segunda)
      allAsync(
        `SELECT a.project_id,
                MIN(a.time) AS first_time,
                COUNT(*) AS rows_count,
                SUM(CASE WHEN a.status = 'present' THEN 1 ELSE 0 END) AS present_count
         FROM attendance a WHERE a.date = ? GROUP BY a.project_id`,
        [date],
      ),
      allAsync(
        `SELECT ds.*,
                (SELECT name FROM leaders WHERE id = ds.closed_day_by) AS closed_day_name,
                (SELECT name FROM leaders WHERE id = ds.closed_session_by) AS closed_session_name
         FROM daily_signoff ds WHERE ds.date = ?`,
        [date],
      ),
    ]).then(([compliance, att, signoffs]) => {
      const attByP = {};
      for (const a of att) attByP[a.project_id] = a;
      const soByP = {};
      for (const s of signoffs) soByP[s.project_id] = s;
      return compliance.map((c) => {
        const a = attByP[c.project_id];
        const so = soByP[c.project_id] || {};
        return {
          project_id: c.project_id,
          project_number: c.project_number,
          project_name: c.project_name,
          roster_size: c.roster_size,
          primera: {
            passed: !!a,
            time: a ? a.first_time : null,
            present: a ? a.present_count : 0,
            rows: a ? a.rows_count : 0,
          },
          segunda: {
            passed: !!c.end_recorded_at,
            recorded_at: c.end_recorded_at || null,
            by: c.end_profesor_name || null,
            present: c.end_present_count || 0,
            rows: c.end_rows_count || 0,
          },
          closedDay: { by: so.closed_day_name || null, at: so.closed_day_at || null },
          closedSession: { by: so.closed_session_name || null, at: so.closed_session_at || null },
          locked: !!so.locked,
        };
      });
    });
  }

  // Profe closes a project's day. Requires BOTH lists present (primera in
  // `attendance`, segunda = 'end' pass) and the date not already locked.
  // Review checkmark only — does not lock.
  closeDayForProject(projectId, date, userId) {
    return this.writeMutex.run(() => new Promise((resolve, reject) => {
      this.db.get(
        `SELECT
           (SELECT COUNT(*) FROM attendance WHERE project_id = ? AND date = ?) AS primera,
           (SELECT COUNT(*) FROM profesor_attendance WHERE project_id = ? AND date = ? AND pass_type = 'end') AS segunda,
           (SELECT locked FROM daily_signoff WHERE project_id = ? AND date = ?) AS locked`,
        [projectId, date, projectId, date, projectId, date],
        (err, row) => {
          if (err) return reject(err);
          if (row && row.locked) { const e = new Error('Date locked'); e.code = 'DATE_LOCKED'; return reject(e); }
          if (!row || !row.primera || !row.segunda) {
            const e = new Error('Lists incomplete'); e.code = 'LISTS_INCOMPLETE'; return reject(e);
          }
          this.db.run(
            `INSERT INTO daily_signoff (project_id, date, closed_day_by, closed_day_at)
             VALUES (?, ?, ?, CURRENT_TIMESTAMP)
             ON CONFLICT(project_id, date) DO UPDATE SET
               closed_day_by = excluded.closed_day_by, closed_day_at = CURRENT_TIMESTAMP`,
            [projectId, date, userId],
            (uErr) => (uErr ? reject(uErr) : resolve({ projectId, date })),
          );
        },
      );
    }));
  }

  // Coordinator closes the whole jornada for a date: every project with
  // students must be day-closed first, then all are locked (locked=1).
  closeSessionForDate(date, userId) {
    return this.writeMutex.run(() => new Promise((resolve, reject) => {
      this.db.all(
        `SELECT DISTINCT p.id, p.project_number, p.project_name
         FROM projects p WHERE EXISTS (SELECT 1 FROM students s WHERE s.project_id = p.id)
         ORDER BY p.project_number`,
        [],
        (err, projects) => {
          if (err) return reject(err);
          if (!projects.length) { const e = new Error('No projects'); e.code = 'NO_PROJECTS'; return reject(e); }
          this.db.all(
            `SELECT project_id FROM daily_signoff WHERE date = ? AND closed_day_by IS NOT NULL`,
            [date],
            (e2, closedRows) => {
              if (e2) return reject(e2);
              const closed = new Set(closedRows.map((r) => r.project_id));
              const pending = projects.filter((p) => !closed.has(p.id));
              if (pending.length) {
                const e = new Error('Days incomplete'); e.code = 'DAYS_INCOMPLETE';
                e.pending = pending.map((p) => ({ project_id: p.id, project_number: p.project_number, project_name: p.project_name }));
                return reject(e);
              }
              this.db.serialize(() => {
                this.db.run('BEGIN IMMEDIATE', (bErr) => {
                  if (bErr) return reject(bErr);
                  const stmt = this.db.prepare(
                    `INSERT INTO daily_signoff (project_id, date, closed_session_by, closed_session_at, locked)
                     VALUES (?, ?, ?, CURRENT_TIMESTAMP, 1)
                     ON CONFLICT(project_id, date) DO UPDATE SET
                       closed_session_by = excluded.closed_session_by,
                       closed_session_at = CURRENT_TIMESTAMP, locked = 1`,
                  );
                  let errored = null;
                  for (const p of projects) stmt.run(p.id, date, userId, (er) => { if (er && !errored) errored = er; });
                  stmt.finalize((fErr) => {
                    const e = errored || fErr;
                    if (e) { this.db.run('ROLLBACK', () => reject(e)); return; }
                    this.db.run('COMMIT', (cErr) => (cErr ? reject(cErr) : resolve({ date, projects: projects.length })));
                  });
                });
              });
            },
          );
        },
      );
    }));
  }

  // True if the (project, date) jornada has been locked by the coordinator.
  isDateLocked(projectId, date) {
    return new Promise((resolve, reject) => {
      this.db.get(
        `SELECT locked FROM daily_signoff WHERE project_id = ? AND date = ?`,
        [projectId, date],
        (err, row) => (err ? reject(err) : resolve(!!(row && row.locked))),
      );
    });
  }

  close() {
    return new Promise((resolve, reject) => {
      this.db.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}

module.exports = new Database();
