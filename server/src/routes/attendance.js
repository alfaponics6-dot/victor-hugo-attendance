const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const db = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const {
  validateAttendance,
  validateProjectId,
  validateStudentId,
  validateDateParam
} = require('../middleware/validation');
const { uploadSingle, validateFileSignature } = require('../middleware/upload');
const fs = require('fs').promises;
const path = require('path');

// Apply authentication to all routes in this file
router.use(authenticateToken);
router.use(require('../middleware/syncStateTracker').syncStateTracker);

// Tighter limit for the resolve endpoint: it's destructive (deletes and
// re-inserts the day's rows), so a runaway client or compromised leader
// shouldn't be able to spam it. 10/min is well above any legitimate
// resolution flow but well below abuse rates.
const resolveLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.RESOLVE_RATE_LIMIT) || 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many resolution attempts, please try again in a moment.' },
});

// Helpers --------------------------------------------------------------------

const isPrivileged = (user) => user && (user.role === 'admin' || user.role === 'profesor');

const userOwnsProject = (user, projectId) => {
  if (!user) return false;
  if (isPrivileged(user)) return true;
  return Number(user.projectId) === Number(projectId);
};

const safeUnlink = async (filePath) => {
  if (!filePath) return;
  try {
    await fs.unlink(filePath);
  } catch (e) {
    // File already gone or unreadable - nothing to do.
  }
};

// Return null if the submitted date is sane (YYYY-MM-DD, within a
// generous window around the server clock), otherwise an error message
// the route can surface. The bounds are deliberately wide: leaders may
// legitimately back-date a missed day or sync after a long offline
// stretch, but a clock skew of weeks/years is always wrong.
const sanityCheckAttendanceDate = (date) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) {
    return 'Invalid date format (expected YYYY-MM-DD)';
  }
  const submitted = new Date(date + 'T00:00:00Z').getTime();
  if (!Number.isFinite(submitted)) return 'Invalid date';
  const now = Date.now();
  const oneDayMs = 24 * 60 * 60 * 1000;
  const pastWindowDays = Number(process.env.ATTENDANCE_PAST_DAYS) || 60;
  const futureWindowDays = Number(process.env.ATTENDANCE_FUTURE_DAYS) || 2;
  if (submitted < now - pastWindowDays * oneDayMs) {
    return `Date is more than ${pastWindowDays} days in the past`;
  }
  if (submitted > now + futureWindowDays * oneDayMs) {
    return `Date is more than ${futureWindowDays} days in the future`;
  }
  return null;
};

// ----------------------------------------------------------------------------

// Bulk mark attendance for multiple students (preferred method)
router.post('/bulk', express.json(), async (req, res) => {
  try {
    const { date, time, records } = req.body;

    // projectId/leaderId are pulled from the authenticated user, not the body,
    // so a leader cannot submit attendance against another project or under
    // another leader's name.
    const projectId = req.user.projectId;
    const leaderId = req.user.id;

    if (!projectId || !leaderId) {
      return res.status(403).json({ error: 'Authenticated user has no project assignment' });
    }

    if (!date || !time || !records || !Array.isArray(records)) {
      return res.status(400).json({ error: 'Missing required fields: date, time, records' });
    }

    if (records.length === 0) {
      return res.status(400).json({ error: 'No attendance records provided' });
    }

    // Hard cap on a single bulk submission. A real rotation has at most a
    // few dozen students; anything higher is either malformed or abusive.
    if (records.length > 200) {
      return res.status(413).json({ error: 'Too many records in a single submission (max 200)' });
    }

    // Sanity-check the client-supplied date against the server clock. A
    // device with a wildly wrong time can otherwise insert "attendance"
    // dated weeks in the future or years in the past, which corrupts the
    // (student_id, date) unique constraint logic and statistics.
    const dateErr = sanityCheckAttendanceDate(date);
    if (dateErr) return res.status(400).json({ error: dateErr });

    // NOTE: the project+date duplicate check now runs INSIDE the transaction
    // in insertBulkAttendance so the check+insert pair is atomic. We don't
    // pre-check here anymore — that race let two near-simultaneous submitters
    // both pass the check and both then try to insert.

    // Validate all records
    for (const record of records) {
      if (!record.studentId || !record.status) {
        return res.status(400).json({ error: 'Each record must have studentId and status' });
      }
      if (record.status !== 'present' && record.status !== 'absent') {
        return res.status(400).json({ error: 'Status must be either "present" or "absent"' });
      }
      if (record.justification && !['justificada', 'injustificada'].includes(record.justification)) {
        return res.status(400).json({ error: 'Justification must be "justificada" or "injustificada"' });
      }
      if (record.status === 'present' && record.justification) {
        return res.status(400).json({ error: 'Justification can only be provided for absent status' });
      }
    }

    // Strip any client-supplied attachment paths - only the multer file-upload
    // path may set those. Client-supplied paths would allow path traversal in
    // the attachment download handler.
    const bulkRecords = records.map(record => ({
      studentId: parseInt(record.studentId),
      projectId: Number(projectId),
      leaderId: Number(leaderId),
      date,
      time,
      status: record.status,
      justification: record.status === 'absent' ? (record.justification || 'injustificada') : null,
      observation: record.observation || null,
      attachmentFilePath: null,
      attachmentFileName: null
    }));

    try {
      const result = await db.insertBulkAttendance(bulkRecords);
      res.json({
        success: true,
        message: 'Attendance recorded successfully',
        count: result.inserted
      });
    } catch (err) {
      // Both the in-transaction duplicate check (ATTENDANCE_ALREADY_SUBMITTED)
      // and the UNIQUE(student_id,date) constraint backstop (SQLITE_CONSTRAINT)
      // map to 409 — the user-facing meaning is the same.
      if (err && (err.code === 'ATTENDANCE_ALREADY_SUBMITTED' || err.code === 'SQLITE_CONSTRAINT')) {
        return res.status(409).json({
          error: 'Attendance already submitted',
          message: 'La asistencia ya fue guardada para esta fecha. No se puede modificar.'
        });
      }
      throw err;
    }
  } catch (error) {
    console.error('Error in bulk attendance:', error);
    res.status(500).json({ error: 'Failed to mark attendance' });
  }
});

// Resolve a duplicate-attendance conflict that was queued offline. The
// client UI lets the leader pick a final per-student outcome (or pick
// "all mine" / "all theirs"), then POSTs the merged result here. We
// REPLACE the existing rows for (projectId, date) atomically and write
// an audit row so the resolution is reviewable later.
router.post('/bulk/resolve', resolveLimiter, express.json(), async (req, res) => {
  try {
    const { date, time, records, resolution } = req.body;

    const projectId = req.user.projectId;
    const leaderId = req.user.id;

    if (!projectId || !leaderId) {
      return res.status(403).json({ error: 'Authenticated user has no project assignment' });
    }
    if (!date || !time || !records || !Array.isArray(records)) {
      return res.status(400).json({ error: 'Missing required fields: date, time, records' });
    }
    if (records.length === 0) {
      return res.status(400).json({ error: 'No attendance records provided' });
    }
    if (records.length > 200) {
      return res.status(413).json({ error: 'Too many records in a single submission (max 200)' });
    }
    const dateErr = sanityCheckAttendanceDate(date);
    if (dateErr) return res.status(400).json({ error: dateErr });
    if (resolution !== 'overwrite' && resolution !== 'merge') {
      return res.status(400).json({ error: 'resolution must be "overwrite" or "merge"' });
    }

    for (const record of records) {
      if (!record.studentId || !record.status) {
        return res.status(400).json({ error: 'Each record must have studentId and status' });
      }
      if (record.status !== 'present' && record.status !== 'absent') {
        return res.status(400).json({ error: 'Status must be either "present" or "absent"' });
      }
      if (record.justification && !['justificada', 'injustificada'].includes(record.justification)) {
        return res.status(400).json({ error: 'Justification must be "justificada" or "injustificada"' });
      }
      if (record.status === 'present' && record.justification) {
        return res.status(400).json({ error: 'Justification can only be provided for absent status' });
      }
    }

    // Ownership check: every studentId must belong to this leader's project
    // (either as base assignment or via a rotation row covering `date`).
    // Without this a leader could resolve attendance for students they have
    // no relationship to.
    for (const record of records) {
      const ok = await db.validateStudentBelongsToProject(
        parseInt(record.studentId),
        projectId,
        date,
      );
      if (!ok) {
        return res.status(403).json({
          error: 'Student does not belong to this project for the given date',
          studentId: record.studentId,
        });
      }
    }

    const bulkRecords = records.map((record) => ({
      studentId: parseInt(record.studentId),
      projectId: Number(projectId),
      leaderId: Number(leaderId),
      date,
      time,
      status: record.status,
      justification: record.status === 'absent' ? (record.justification || 'injustificada') : null,
      observation: record.observation || null,
      attachmentFilePath: null,
      attachmentFileName: null,
    }));

    // Persist the original payload (not the sanitized server-side version)
    // so reviewers see what the client actually sent.
    const payloadJson = JSON.stringify({ date, time, records, resolution });
    // Best-effort identity tags for the audit row.
    const sourceIp = req.ip || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || null;
    const userAgent = (req.headers['user-agent'] || '').slice(0, 500) || null;

    const result = await db.resolveBulkAttendance(bulkRecords, resolution, payloadJson, {
      sourceIp,
      userAgent,
    });
    res.json({
      success: true,
      message: 'Attendance resolved successfully',
      inserted: result.inserted,
      replaced: result.replaced,
    });
  } catch (error) {
    console.error('Error resolving bulk attendance:', error);
    res.status(500).json({ error: 'Failed to resolve attendance' });
  }
});

// Mark attendance for a single student (multipart, supports attachment)
router.post('/', uploadSingle, validateAttendance, async (req, res) => {
  const filePath = req.file ? req.file.path : null;

  try {
    const studentId = parseInt(req.body.studentId);
    const projectId = req.user.projectId;
    const leaderId = req.user.id;
    const { date, time, status, justification, observation } = req.body;

    if (!projectId || !leaderId) {
      await safeUnlink(filePath);
      return res.status(403).json({ error: 'Authenticated user has no project assignment' });
    }

    if (!studentId || !date || !status) {
      await safeUnlink(filePath);
      return res.status(400).json({ error: 'Missing required fields' });
    }

    let attachmentFilePath = null;
    let attachmentFileName = null;
    if (req.file) {
      // Defense against MIME-type spoofing: read the file's actual signature.
      const ok = await validateFileSignature(req.file.path);
      if (!ok) {
        await safeUnlink(filePath);
        return res.status(400).json({ error: 'Tipo de archivo no válido. El contenido no coincide con la extensión.' });
      }
      const backendRoot = path.join(__dirname, '..', '..');
      attachmentFilePath = path.relative(backendRoot, req.file.path);
      attachmentFileName = req.file.originalname;
    }

    // Check if attendance has already been submitted for THIS STUDENT on this date
    const studentAttendanceExists = await db.checkAttendanceExists(studentId, date);
    if (studentAttendanceExists) {
      await safeUnlink(filePath);
      return res.status(409).json({
        error: 'Attendance already submitted',
        message: 'La asistencia ya fue guardada para este estudiante en esta fecha. No se puede modificar.'
      });
    }

    if (status !== 'present' && status !== 'absent') {
      await safeUnlink(filePath);
      return res.status(400).json({ error: 'Status must be either "present" or "absent"' });
    }

    if (status === 'present' && justification) {
      await safeUnlink(filePath);
      return res.status(400).json({ error: 'Justification can only be provided for absent status' });
    }

    const finalJustification = status === 'absent'
      ? (justification || 'injustificada')
      : null;

    const isValid = await db.validateStudentBelongsToProject(studentId, projectId, date);
    if (!isValid) {
      await safeUnlink(filePath);
      return res.status(403).json({ error: 'Student does not belong to this project for the specified date' });
    }

    const result = await db.insertAttendance(
      studentId,
      Number(projectId),
      Number(leaderId),
      date,
      time,
      status,
      finalJustification,
      observation || null,
      attachmentFilePath,
      attachmentFileName
    );

    res.json({
      success: true,
      message: 'Attendance recorded successfully',
      result
    });
  } catch (error) {
    console.error('Error marking attendance:', error);
    await safeUnlink(filePath);
    res.status(500).json({ error: 'Failed to mark attendance' });
  }
});

// Get attendance records for a project on a specific date
router.get('/project/:projectId/date/:date', [...validateProjectId, ...validateDateParam], async (req, res) => {
  try {
    const { projectId, date } = req.params;
    if (!userOwnsProject(req.user, projectId)) {
      return res.status(403).json({ error: 'Forbidden: cannot view attendance for another project' });
    }
    const attendance = await db.getAttendanceByProjectAndDate(projectId, date);
    res.json(attendance);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch attendance records' });
  }
});

// Get attendance history for a specific student.
// For a leader, we return 403 uniformly whether the student doesn't exist OR
// exists in a different project — distinguishing 404 vs 403 here would leak
// existence-in-other-projects. Admin/profesor (no projectId) keep the 404.
router.get('/student/:studentId', validateStudentId, async (req, res) => {
  try {
    const { studentId } = req.params;
    const student = await db.getStudentById(studentId);
    const isLeader = req.user && req.user.role !== 'admin' && req.user.role !== 'profesor';
    if (isLeader && (!student || !userOwnsProject(req.user, student.project_id))) {
      return res.status(403).json({ error: 'Forbidden: cannot view this student' });
    }
    if (!student) {
      return res.status(404).json({ error: 'Student not found' });
    }
    const attendance = await db.getAttendanceByStudent(studentId);
    res.json(attendance);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch student attendance' });
  }
});

// Download attachment for a specific student and date. Same 403-uniform
// leader treatment as /student/:studentId above — don't leak existence.
router.get('/attachment/:studentId/:date', async (req, res) => {
  try {
    const { studentId, date } = req.params;

    const student = await db.getStudentById(studentId);
    const isLeader = req.user && req.user.role !== 'admin' && req.user.role !== 'profesor';
    if (isLeader && (!student || !userOwnsProject(req.user, student.project_id))) {
      return res.status(403).json({ error: 'Forbidden: cannot view this student' });
    }
    if (!student) {
      return res.status(404).json({ error: 'Student not found' });
    }

    const attendance = await db.getAttendanceByStudent(studentId);
    const record = attendance.find(a => a.date === date);

    if (!record) {
      return res.status(404).json({ error: 'Attendance record not found' });
    }

    if (!record.attachment_file_path) {
      return res.status(404).json({ error: 'No attachment found for this record' });
    }

    // Defense in depth: even though attachment_file_path is set server-side,
    // resolve it under the uploads dir and reject anything that escapes.
    const backendRoot = path.join(__dirname, '..', '..');
    const uploadsRoot = path.join(backendRoot, 'uploads');
    const resolved = path.resolve(backendRoot, record.attachment_file_path);
    if (!resolved.startsWith(uploadsRoot + path.sep) && resolved !== uploadsRoot) {
      return res.status(400).json({ error: 'Invalid attachment path' });
    }

    try {
      await fs.access(resolved);
    } catch {
      return res.status(404).json({ error: 'Attachment file not found on server' });
    }

    res.download(resolved, record.attachment_file_name, (err) => {
      if (err && !res.headersSent) {
        res.status(500).json({ error: 'Failed to download attachment' });
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch attachment' });
  }
});

module.exports = router;
