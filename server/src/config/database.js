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
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
        )
      `);

      // Add missing columns if they don't exist (for existing databases)
      this.db.run(`ALTER TABLE leaders ADD COLUMN role TEXT DEFAULT 'leader'`, () => {});
      this.db.run(`ALTER TABLE leaders ADD COLUMN password_hash TEXT`, () => {});
      this.db.run(`ALTER TABLE leaders ADD COLUMN email TEXT`, () => {});

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
          resolved_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
          FOREIGN KEY (leader_id) REFERENCES leaders(id) ON DELETE SET NULL
        )
      `);
      this.db.run(`CREATE INDEX IF NOT EXISTS idx_resolutions_project_date ON attendance_resolutions(project_id, date)`);

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
  resolveBulkAttendance(records, resolutionMode, payloadJson) {
    if (!records || records.length === 0) {
      return Promise.reject(new Error('No records to insert'));
    }
    const projectId = records[0].projectId;
    const leaderId = records[0].leaderId;
    const date = records[0].date;

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
                       (project_id, leader_id, date, resolution_mode, records_count, replaced_count, payload_json)
                       VALUES (?, ?, ?, ?, ?, ?, ?)`,
                      [projectId, leaderId, date, resolutionMode, records.length, replaced, payloadJson],
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
