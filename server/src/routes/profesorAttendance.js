// Profesor-only attendance "passes": each session day has a start pass
// and an end pass, both marked by a profesor (separate from the leader's
// own attendance). Rows live in `profesor_attendance`.

const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { authenticateToken, requireProfesor } = require('../middleware/auth');

router.use(authenticateToken);
router.use(requireProfesor);

const VALID_PASSES = new Set(['start', 'end']);
const VALID_STATUSES = new Set(['present', 'absent']);
const DATE_RX = /^\d{4}-\d{2}-\d{2}$/;

// GET /profesor-attendance/project/:projectId/date/:date
// Returns every profe-pass row for that project + date (both passes).
// Client pivots into { start: {...by studentId}, end: {...} }.
router.get('/project/:projectId/date/:date', async (req, res) => {
  try {
    const projectId = Number(req.params.projectId);
    const { date } = req.params;
    if (!Number.isInteger(projectId) || projectId < 1) {
      return res.status(400).json({ error: 'Invalid projectId' });
    }
    if (!DATE_RX.test(date)) {
      return res.status(400).json({ error: 'Invalid date (expected YYYY-MM-DD)' });
    }
    const rows = await db.getProfesorAttendanceForProjectDate(projectId, date);
    res.json(rows);
  } catch (err) {
    console.error('GET /profesor-attendance failed:', err);
    res.status(500).json({ error: 'Failed to fetch profesor attendance' });
  }
});

// POST /profesor-attendance/bulk
// Body: { projectId, date, passType: 'start'|'end', entries: [{student_id, status, observation?}] }
// Upserts every entry in a single transaction. The same (student, date, pass)
// can be re-saved freely — it overwrites the previous row's status and
// stamps recorded_at to NOW.
router.post('/bulk', express.json(), async (req, res) => {
  try {
    const { projectId, date, passType, entries } = req.body || {};
    const pid = Number(projectId);
    if (!Number.isInteger(pid) || pid < 1) {
      return res.status(400).json({ error: 'Invalid projectId' });
    }
    if (!DATE_RX.test(date || '')) {
      return res.status(400).json({ error: 'Invalid date (expected YYYY-MM-DD)' });
    }
    if (!VALID_PASSES.has(passType)) {
      return res.status(400).json({ error: 'Invalid passType (expected "start" or "end")' });
    }
    if (!Array.isArray(entries) || entries.length === 0) {
      return res.status(400).json({ error: 'entries must be a non-empty array' });
    }
    for (const e of entries) {
      if (!Number.isInteger(e.student_id) || e.student_id < 1) {
        return res.status(400).json({ error: 'Each entry needs an integer student_id' });
      }
      if (!VALID_STATUSES.has(e.status)) {
        return res.status(400).json({ error: 'Each entry needs status of "present" or "absent"' });
      }
    }
    const result = await db.bulkUpsertProfesorAttendance({
      profesorId: req.user.id,
      projectId: pid,
      date,
      passType,
      entries,
    });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('POST /profesor-attendance/bulk failed:', err);
    res.status(500).json({ error: 'Failed to save profesor attendance' });
  }
});

module.exports = router;
