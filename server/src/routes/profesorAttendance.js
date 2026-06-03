// Profesor-only attendance "passes": each session day has a start pass
// and an end pass, both marked by a profesor (separate from the leader's
// own attendance). Rows live in `profesor_attendance`.

const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { authenticateToken, requireProfesor, rejectStaleAuthor } = require('../middleware/auth');

router.use(authenticateToken);

// The project's own leader (or an admin) may read/write that project's passes.
// The "segunda lista" (final pass) is now owned by leaders; profesores are
// review-only and use the jornada/compliance endpoints below.
function leaderOwnsOrAdmin(req, projectId) {
  const u = req.user;
  if (!u) return false;
  if (u.role === 'admin') return true;
  if (u.role === 'leader') return Number(u.projectId) === Number(projectId);
  return false;
}

// Coordinator (is_coordinator flag) or admin. Re-reads the live row so a flag
// flip takes effect immediately without waiting for token refresh.
async function isCoordinatorOrAdmin(req) {
  if (req.user && req.user.role === 'admin') return true;
  const me = await db.getLeaderById(req.user.id);
  return !!me && Number(me.is_coordinator) === 1;
}

const VALID_PASSES = new Set(['start', 'end']);
const VALID_STATUSES = new Set(['present', 'absent']);
const DATE_RX = /^\d{4}-\d{2}-\d{2}$/;
// Hard caps on profe-pass dates. A bug elsewhere (or a fat-finger on
// the date picker) could otherwise let a profe mark attendance for
// "1900-01-01" or "2999-12-31", which corrupts compliance reports and
// makes per-day cron jobs run unbounded date ranges. 7 days in the
// future tolerates a planned-ahead scenario without enabling abuse.
const MAX_PAST_DAYS = 60;
const MAX_FUTURE_DAYS = 7;

// Shape check + real-date check. `2026-13-99` passes the regex but is
// a junk date; rejecting at the route boundary turns a 500 from the
// DB layer into a clear 400 for the client.
function isValidIsoDate(s) {
  if (!DATE_RX.test(s || '')) return false;
  const d = new Date(s + 'T00:00:00Z');
  if (isNaN(d.getTime())) return false;
  // Round-trip catches things like Feb 30: Date() normalizes silently.
  return d.toISOString().slice(0, 10) === s;
}

// Returns null if the date is acceptable for a profe-pass write, or an
// error string describing why it isn't. Read endpoints don't enforce
// this — coordinators may legitimately review old or future dates.
function dateOutOfWriteRange(s) {
  const day = new Date(s + 'T00:00:00Z').getTime();
  const today = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z').getTime();
  const dayMs = 24 * 60 * 60 * 1000;
  if (day < today - MAX_PAST_DAYS * dayMs) {
    return `Date is too far in the past (max ${MAX_PAST_DAYS} days back)`;
  }
  if (day > today + MAX_FUTURE_DAYS * dayMs) {
    return `Date is too far in the future (max ${MAX_FUTURE_DAYS} days ahead)`;
  }
  return null;
}

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
    if (!isValidIsoDate(date)) {
      return res.status(400).json({ error: 'Invalid date (expected YYYY-MM-DD)' });
    }
    // Readable by the project's leader, any profesor (review), or admin.
    const u = req.user;
    const canRead = u.role === 'admin' || u.role === 'profesor'
      || (u.role === 'leader' && Number(u.projectId) === projectId);
    if (!canRead) return res.status(403).json({ error: 'Forbidden' });
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
router.post('/bulk', express.json(), rejectStaleAuthor, async (req, res) => {
  try {
    const { projectId, date, passType, entries } = req.body || {};
    const pid = Number(projectId);
    if (!Number.isInteger(pid) || pid < 1) {
      return res.status(400).json({ error: 'Invalid projectId' });
    }
    if (!isValidIsoDate(date)) {
      return res.status(400).json({ error: 'Invalid date (expected YYYY-MM-DD)' });
    }
    // Bound the writable date window. Reads stay open so coordinators
    // can audit older entries, but new writes can't be back- or forward-
    // dated arbitrarily — that would silently corrupt cross-period
    // compliance reports and make replay of an old queued-offline POST
    // overwrite a perfectly fine current row.
    const dateErr = dateOutOfWriteRange(date);
    if (dateErr) return res.status(400).json({ error: dateErr });
    // Only the project's own leader (or admin) marks this list now.
    if (!leaderOwnsOrAdmin(req, pid)) {
      return res.status(403).json({ error: 'Only the project leader or an admin can mark this list' });
    }
    // Block writes once the coordinator has locked this date's jornada.
    if (await db.isDateLocked(pid, date)) {
      return res.status(409).json({
        error: 'Jornada cerrada',
        message: 'La jornada de esta fecha ya fue cerrada. No se puede modificar.',
      });
    }
    if (!VALID_PASSES.has(passType)) {
      return res.status(400).json({ error: 'Invalid passType (expected "start" or "end")' });
    }
    if (!Array.isArray(entries) || entries.length === 0) {
      return res.status(400).json({ error: 'entries must be a non-empty array' });
    }
    // Hard cap on payload size. findStudentsNotInProject silently dedupes
    // and clips to 500 — without an explicit cap here a payload of 600
    // entries would have the last 100 skip the cross-tenant validation
    // entirely (the dedup-clip in the validator would pop them out of
    // the IN-clause), and the upsert would happily write them. Catch
    // oversize batches at the boundary instead.
    if (entries.length > 500) {
      return res.status(400).json({ error: 'Too many entries (max 500 per request)' });
    }
    for (const e of entries) {
      if (!Number.isInteger(e.student_id) || e.student_id < 1) {
        return res.status(400).json({ error: 'Each entry needs an integer student_id' });
      }
      if (!VALID_STATUSES.has(e.status)) {
        return res.status(400).json({ error: 'Each entry needs status of "present" or "absent"' });
      }
    }
    // Deduplicate by student_id, last-write-wins. Without this, a
    // double-tapped Save (or a malformed payload) submits two rows for
    // the same student in the same transaction: the upsert handles it
    // correctly but `updated` ends up overstated and writing the same
    // primary-key collision twice burns transaction work for nothing.
    const dedupMap = new Map();
    for (const e of entries) dedupMap.set(e.student_id, e);
    const cleanEntries = [...dedupMap.values()];

    // Cross-tenant guard: every student in the payload must belong to
    // the projectId being marked. Without this, a profe could submit
    // {projectId: 1, entries: [{student_id: <X belongs to project 2>}]}
    // and the row would be silently filed under project 1, corrupting
    // both projects' compliance views. Live integration test caught
    // this on Simon's account; fixing here.
    const wrong = await db.findStudentsNotInProject(
      cleanEntries.map((e) => e.student_id),
      pid,
    );
    if (wrong.length > 0) {
      return res.status(400).json({
        error: 'Some students do not belong to the given project',
        studentIds: wrong,
      });
    }
    const result = await db.bulkUpsertProfesorAttendance({
      profesorId: req.user.id,
      projectId: pid,
      date,
      passType,
      entries: cleanEntries,
    });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('POST /profesor-attendance/bulk failed:', err);
    res.status(500).json({ error: 'Failed to save profesor attendance' });
  }
});

// GET /profesor-attendance/compliance/:date
// Coordinator-only oversight view. Returns one row per project with
// the latest start-pass and end-pass status (who, when, counts), so
// the lead profe can see at a glance which projects still need
// today's final pass. Other profes (and admins) get 403.
router.get('/compliance/:date', async (req, res) => {
  try {
    const { date } = req.params;
    if (!isValidIsoDate(date)) {
      return res.status(400).json({ error: 'Invalid date (expected YYYY-MM-DD)' });
    }
    // Inline coordinator check: only the lead profesor should see this.
    // We re-read the live row so a coordinator flag flip takes effect
    // immediately, without waiting for token refresh.
    // Type-cast guard: sqlite3 normally returns INTEGER as JS number,
    // but a future driver swap (or aggregation through some adapter)
    // could return '1' as a string and bypass strict !== 1. Compare
    // via Number() so either shape works.
    const me = await db.getLeaderById(req.user.id);
    if (!me || Number(me.is_coordinator) !== 1) {
      return res.status(403).json({ error: 'Coordinator access required' });
    }
    const rows = await db.getProfesorAttendanceCompliance(date);
    res.json(rows);
  } catch (err) {
    console.error('GET /profesor-attendance/compliance failed:', err);
    res.status(500).json({ error: 'Failed to load compliance' });
  }
});

// GET /profesor-attendance/jornada/:date
// Review surface for profesores (and coordinator/admin): per-project status of
// the primera lista (leader attendance) + segunda lista (end pass) + sign-off.
router.get('/jornada/:date', requireProfesor, async (req, res) => {
  try {
    const { date } = req.params;
    if (!isValidIsoDate(date)) {
      return res.status(400).json({ error: 'Invalid date (expected YYYY-MM-DD)' });
    }
    const projects = await db.getJornadaStatus(date);
    res.json({ date, projects });
  } catch (err) {
    console.error('GET /profesor-attendance/jornada failed:', err);
    res.status(500).json({ error: 'Failed to load jornada status' });
  }
});

// POST /profesor-attendance/close-day  { projectId, date }
// A profesor closes a project's day (review checkmark; requires both lists).
router.post('/close-day', requireProfesor, express.json(), async (req, res) => {
  try {
    const { projectId, date } = req.body || {};
    const pid = Number(projectId);
    if (!Number.isInteger(pid) || pid < 1) return res.status(400).json({ error: 'Invalid projectId' });
    if (!isValidIsoDate(date)) return res.status(400).json({ error: 'Invalid date (expected YYYY-MM-DD)' });
    await db.closeDayForProject(pid, date, req.user.id);
    const projects = await db.getJornadaStatus(date);
    res.json({ success: true, date, projects });
  } catch (err) {
    if (err && err.code === 'LISTS_INCOMPLETE') {
      return res.status(409).json({ error: 'Lists incomplete', message: 'Faltan la primera o la segunda lista de este proyecto.' });
    }
    if (err && err.code === 'DATE_LOCKED') {
      return res.status(409).json({ error: 'Date locked', message: 'La jornada de esta fecha ya fue cerrada.' });
    }
    console.error('POST /profesor-attendance/close-day failed:', err);
    res.status(500).json({ error: 'Failed to close day' });
  }
});

// POST /profesor-attendance/close-session  { date }
// The coordinator (or admin) locks the whole jornada for a date. Requires
// every project with students to be day-closed first.
router.post('/close-session', express.json(), async (req, res) => {
  try {
    if (!(await isCoordinatorOrAdmin(req))) {
      return res.status(403).json({ error: 'Coordinator access required' });
    }
    const { date } = req.body || {};
    if (!isValidIsoDate(date)) return res.status(400).json({ error: 'Invalid date (expected YYYY-MM-DD)' });
    const result = await db.closeSessionForDate(date, req.user.id);
    const projects = await db.getJornadaStatus(date);
    res.json({ success: true, date, locked: result.projects, projects });
  } catch (err) {
    if (err && err.code === 'DAYS_INCOMPLETE') {
      return res.status(409).json({
        error: 'Days incomplete',
        message: 'Todos los proyectos deben tener el día cerrado antes de cerrar la jornada.',
        pending: err.pending || [],
      });
    }
    if (err && err.code === 'NO_PROJECTS') {
      return res.status(400).json({ error: 'No projects scheduled' });
    }
    console.error('POST /profesor-attendance/close-session failed:', err);
    res.status(500).json({ error: 'Failed to close session' });
  }
});

module.exports = router;
