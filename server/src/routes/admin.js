const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { parseExcelAndPopulateDB, EXCEL_PATH } = require('../utils/excelParser');
const { authenticateToken, requireAdmin, requireProfesor, requireCoordinador } = require('../middleware/auth');
const { validateStudentId, validateDateParam, validateDateQuery, validateCloseDay, validateCloseSession } = require('../middleware/validation');

// Profesor routes (before admin-only middleware)
// Get all absent students with filters
router.get('/absences', authenticateToken, requireProfesor, validateDateQuery, async (req, res) => {
  try {
    const { date, projectId, justification } = req.query;
    const absences = await db.getAbsentStudents(date, projectId, justification);
    res.json(absences);
  } catch (error) {
    console.error('Error fetching absences:', error);
    res.status(500).json({ error: 'Failed to fetch absences' });
  }
});

// Get all projects for filter dropdown
router.get('/projects', authenticateToken, requireProfesor, async (req, res) => {
  try {
    const projects = await db.getProjects();
    res.json(projects);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch projects' });
  }
});

// Get attendance summary by date range
router.get('/attendance-summary', authenticateToken, requireProfesor, validateDateQuery, async (req, res) => {
  try {
    const { startDate, endDate, projectId } = req.query;
    const summary = await db.getAttendanceSummary(startDate, endDate, projectId);
    res.json(summary);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch attendance summary' });
  }
});

// ── Jornada / daily sign-off ───────────────────────────────────────────────

// Per-project status for a date: which lists were passed (+ time + leader) and
// the close/lock state. Visible to profesor / coordinador / admin.
router.get('/daily-status', authenticateToken, requireProfesor, validateDateQuery, async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const projects = await db.getDailyStatus(date);
    res.json({ date, projects });
  } catch (error) {
    console.error('Error fetching daily status:', error);
    res.status(500).json({ error: 'Failed to fetch daily status' });
  }
});

// Profesor "cierra el día" for a project. Review checkmark — does NOT lock.
// Requires both lists already passed and the date not yet locked.
router.post('/close-day', authenticateToken, requireProfesor, validateCloseDay, async (req, res) => {
  try {
    const { projectId, date } = req.body;
    await db.closeDayForProject(Number(projectId), date, req.user.id);
    const projects = await db.getDailyStatus(date);
    res.json({ success: true, date, projects });
  } catch (error) {
    if (error && error.code === 'LISTS_INCOMPLETE') {
      return res.status(409).json({
        error: 'Lists incomplete',
        message: 'Ambas listas (primera y segunda) deben estar pasadas antes de cerrar el día.'
      });
    }
    if (error && error.code === 'DATE_LOCKED') {
      return res.status(409).json({ error: 'Date locked', message: 'La jornada de esta fecha ya fue cerrada.' });
    }
    console.error('Error closing day:', error);
    res.status(500).json({ error: 'Failed to close day' });
  }
});

// Coordinador "cierra la jornada" for a date — LOCKS it. Requires every
// expected project to be day-closed first.
router.post('/close-session', authenticateToken, requireCoordinador, validateCloseSession, async (req, res) => {
  try {
    const { date } = req.body;
    const result = await db.closeSessionForDate(date, req.user.id);
    const projects = await db.getDailyStatus(date);
    res.json({ success: true, date, locked: result.projects, projects });
  } catch (error) {
    if (error && error.code === 'DAYS_INCOMPLETE') {
      return res.status(409).json({
        error: 'Days incomplete',
        message: 'Todos los proyectos deben tener el día cerrado antes de cerrar la jornada.',
        pending: error.pending || []
      });
    }
    if (error && error.code === 'NO_PROJECTS') {
      return res.status(400).json({ error: 'No projects', message: 'No hay proyectos programados para esta fecha.' });
    }
    console.error('Error closing session:', error);
    res.status(500).json({ error: 'Failed to close session' });
  }
});

// All admin routes require authentication and admin role
router.use(authenticateToken);
router.use(requireAdmin);

// Admin: Get all students
router.get('/students', async (req, res) => {
  try {
    const students = await db.getAllStudents();
    res.json(students);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch students' });
  }
});

// Admin: Get global attendance by date
router.get('/attendance/:date', validateDateParam, async (req, res) => {
  try {
    const { date } = req.params;
    const attendance = await db.getAllAttendanceByDate(date);
    res.json(attendance);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch attendance' });
  }
});

// Admin: Delete a student
router.delete('/students/:studentId', validateStudentId, async (req, res) => {
  try {
    const { studentId } = req.params;
    const result = await db.deleteStudent(studentId);
    if (result === 0) {
      return res.status(404).json({ error: 'Student not found' });
    }
    res.json({ success: true });
  } catch (error) {
    if (error && error.code === 'SQLITE_CONSTRAINT') {
      return res.status(409).json({
        error: 'Cannot delete student',
        message: 'El estudiante tiene registros vinculados. Si la base de datos no fue migrada con ON DELETE CASCADE, archive en lugar de eliminar.'
      });
    }
    res.status(500).json({ error: 'Failed to delete student' });
  }
});

// Admin: Re-import projects + leaders from the seed spreadsheet.
// Use with caution: this only inserts; it does not deduplicate or remove.
// Intended for seeding a fresh database from a corrected spreadsheet.
//
// The import body is wrapped in `db.runExclusive` so it holds the same
// write lock used by leader bulk-attendance submissions. Without this,
// the re-import's many INSERT statements race leader transactions on the
// shared sqlite3 connection.
router.post('/reimport-spreadsheet', async (req, res) => {
  try {
    const existing = await db.getProjects();
    const force = req.body && req.body.force === true;
    if (existing.length > 0 && !force) {
      return res.status(409).json({
        error: 'Database already populated',
        message: `Found ${existing.length} existing projects. Pass {"force": true} to import anyway (rows will be appended, not replaced).`,
        excelPath: EXCEL_PATH
      });
    }
    const result = await db.runExclusive(() => parseExcelAndPopulateDB());
    res.json({ success: true, ...result, excelPath: EXCEL_PATH });
  } catch (error) {
    res.status(500).json({ error: 'Re-import failed', message: error.message });
  }
});

module.exports = router;
