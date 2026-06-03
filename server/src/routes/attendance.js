const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const db = require('../config/database');
const { authenticateToken, rejectStaleAuthor } = require('../middleware/auth');
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

// Bulk-submit also takes the global writeMutex inside the DB layer (every
// call serializes), so an attacker spamming it can starve every other
// writer. The general /api limiter (1000/min) is shared across ALL leaders
// because we're behind the Cloudflare edge IP, so it provides no real
// per-leader bound. Cap a single leader's bulk submits at a generous 30/min
// (a legitimate day produces 1–2 submissions per project per leader).
const bulkLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.BULK_RATE_LIMIT) || 30,
  standardHeaders: true,
  legacyHeaders: false,
  // Key on the authenticated user, not req.ip — every leader shares one
  // edge IP through the Cloudflare tunnel.
  keyGenerator: (req) => (req.user && req.user.id ? `bulk:${req.user.id}` : `bulk:ip:${req.ip}`),
  message: { error: 'Too many bulk submissions, please try again in a moment.' },
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
  const s = String(date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return 'Invalid date format (expected YYYY-MM-DD)';
  }
  // Reject calendar-impossible dates ("2025-02-30", "2025-13-01"). The regex
  // alone passes them, and `new Date("2025-02-30Z")` silently rolls over to
  // March 2, which would corrupt the (student_id, date) uniqueness model.
  const [y, m, d] = s.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return 'Invalid date';
  const parsed = new Date(Date.UTC(y, m - 1, d));
  if (
    parsed.getUTCFullYear() !== y ||
    parsed.getUTCMonth() !== m - 1 ||
    parsed.getUTCDate() !== d
  ) {
    return 'Invalid date';
  }
  const submitted = parsed.getTime();
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

// HH:MM, 24-hour. The DB declares `time TIME NOT NULL` and we never want
// "lol" or "25:99" landing in it as a free-form string.
const TIME_RE = /^([0-1][0-9]|2[0-3]):[0-5][0-9]$/;
const isValidTime = (t) => typeof t === 'string' && TIME_RE.test(t);

// Bound and normalize an observation string. Returns either the trimmed
// string (≤500 chars), `null` for absent/empty input, or `false` if the
// caller-supplied value is the wrong type / over the limit so the route
// can 400. We treat the explicit string "null" as the sentinel "no
// observation" rather than a literal value the user wanted to store.
const normalizeObservation = (v) => {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') return false;
  const trimmed = v.trim();
  if (trimmed === '' || trimmed === 'null') return null;
  if (trimmed.length > 500) return false;
  return trimmed;
};

// Coerce a possibly-string studentId to a positive integer. Returns NaN for
// anything we shouldn't accept (negatives, floats, hex tricks, NaN, "1e5").
const toPositiveInt = (v) => {
  if (typeof v === 'number') return Number.isInteger(v) && v > 0 ? v : NaN;
  if (typeof v !== 'string') return NaN;
  if (!/^[0-9]+$/.test(v.trim())) return NaN;
  const n = parseInt(v, 10);
  return Number.isInteger(n) && n > 0 ? n : NaN;
};

// ----------------------------------------------------------------------------

// Bulk mark attendance for multiple students (preferred method)
router.post('/bulk', bulkLimiter, express.json(), rejectStaleAuthor, async (req, res) => {
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

    // The DB declares `time TIME NOT NULL` and we render the value back in
    // the UI verbatim — a free-form string like "lol" silently inserts and
    // then breaks display / sorting. Enforce HH:MM here.
    if (!isValidTime(time)) {
      return res.status(400).json({ error: 'time must be in HH:MM format' });
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

    // Block writes once the coordinator has locked this date's jornada. Also
    // protects offline writes replayed after the lock — they surface a clear
    // 'Jornada cerrada' 409 instead of silently landing in a closed day.
    if (await db.isDateLocked(projectId, date)) {
      return res.status(409).json({
        error: 'Jornada cerrada',
        message: 'La jornada de esta fecha ya fue cerrada. No se puede modificar.'
      });
    }

    // NOTE: the project+date duplicate check now runs INSIDE the transaction
    // in insertBulkAttendance so the check+insert pair is atomic. We don't
    // pre-check here anymore — that race let two near-simultaneous submitters
    // both pass the check and both then try to insert.

    // Validate all records. We deliberately check structurally first (cheap)
    // and only hit the DB for the per-student ownership check once every
    // record has passed validation.
    const seenStudentIds = new Set();
    const normalizedRecords = [];
    for (const record of records) {
      if (!record || typeof record !== 'object') {
        return res.status(400).json({ error: 'Each record must be an object' });
      }
      const studentId = toPositiveInt(record.studentId);
      if (!studentId) {
        return res.status(400).json({ error: 'Each record must have a positive integer studentId' });
      }
      // Same student twice in one submission would either hit the UNIQUE
      // constraint mid-transaction (rolling back the whole batch with a
      // confusing 409) or — if we ever loosen that — silently keep only
      // the last one. Reject up front so the client sees a clear error.
      if (seenStudentIds.has(studentId)) {
        return res.status(400).json({ error: 'Duplicate studentId in batch', studentId });
      }
      seenStudentIds.add(studentId);
      if (!record.status) {
        return res.status(400).json({ error: 'Each record must have studentId and status' });
      }
      if (record.status !== 'present' && record.status !== 'absent') {
        return res.status(400).json({ error: 'Status must be either "present" or "absent"' });
      }
      if (record.justification != null && !['justificada', 'injustificada'].includes(record.justification)) {
        return res.status(400).json({ error: 'Justification must be "justificada" or "injustificada"' });
      }
      if (record.status === 'present' && record.justification) {
        return res.status(400).json({ error: 'Justification can only be provided for absent status' });
      }
      const observation = normalizeObservation(record.observation);
      if (observation === false) {
        return res.status(400).json({ error: 'observation must be a string up to 500 characters' });
      }
      normalizedRecords.push({ raw: record, studentId, observation });
    }

    // CROSS-TENANT GUARD. Without this, a leader can POST attendance for
    // ANY studentId they care to fabricate — projectId/leaderId are
    // overridden from the JWT, so the row goes under THIS leader's
    // project, but the studentId itself was never verified to belong
    // here. Validate every student against (projectId, date) which
    // accepts either base-project assignment or a rotation row covering
    // that date.
    for (const { studentId } of normalizedRecords) {
      const ok = await db.validateStudentBelongsToProject(studentId, projectId, date);
      if (!ok) {
        return res.status(403).json({
          error: 'Student does not belong to this project for the given date',
          studentId,
        });
      }
    }

    // Strip any client-supplied attachment paths - only the multer file-upload
    // path may set those. Client-supplied paths would allow path traversal in
    // the attachment download handler.
    const bulkRecords = normalizedRecords.map(({ raw, studentId, observation }) => ({
      studentId,
      projectId: Number(projectId),
      leaderId: Number(leaderId),
      date,
      time,
      status: raw.status,
      justification: raw.status === 'absent' ? (raw.justification || 'injustificada') : null,
      observation,
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
router.post('/bulk/resolve', resolveLimiter, express.json(), rejectStaleAuthor, async (req, res) => {
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
    if (!isValidTime(time)) {
      return res.status(400).json({ error: 'time must be in HH:MM format' });
    }
    if (records.length === 0) {
      return res.status(400).json({ error: 'No attendance records provided' });
    }
    if (records.length > 200) {
      return res.status(413).json({ error: 'Too many records in a single submission (max 200)' });
    }
    const dateErr = sanityCheckAttendanceDate(date);
    if (dateErr) return res.status(400).json({ error: dateErr });
    // A locked jornada is the coordinator's final word — it can't be
    // resolved/overwritten either (this is the path a queued offline write
    // takes after a 409, so it must respect the lock too).
    if (await db.isDateLocked(projectId, date)) {
      return res.status(409).json({
        error: 'Jornada cerrada',
        message: 'La jornada de esta fecha ya fue cerrada. No se puede modificar.'
      });
    }
    if (resolution !== 'overwrite' && resolution !== 'merge') {
      return res.status(400).json({ error: 'resolution must be "overwrite" or "merge"' });
    }

    const seenStudentIds = new Set();
    const normalizedRecords = [];
    for (const record of records) {
      if (!record || typeof record !== 'object') {
        return res.status(400).json({ error: 'Each record must be an object' });
      }
      const studentId = toPositiveInt(record.studentId);
      if (!studentId) {
        return res.status(400).json({ error: 'Each record must have a positive integer studentId' });
      }
      if (seenStudentIds.has(studentId)) {
        return res.status(400).json({ error: 'Duplicate studentId in batch', studentId });
      }
      seenStudentIds.add(studentId);
      if (!record.status) {
        return res.status(400).json({ error: 'Each record must have studentId and status' });
      }
      if (record.status !== 'present' && record.status !== 'absent') {
        return res.status(400).json({ error: 'Status must be either "present" or "absent"' });
      }
      if (record.justification != null && !['justificada', 'injustificada'].includes(record.justification)) {
        return res.status(400).json({ error: 'Justification must be "justificada" or "injustificada"' });
      }
      if (record.status === 'present' && record.justification) {
        return res.status(400).json({ error: 'Justification can only be provided for absent status' });
      }
      const observation = normalizeObservation(record.observation);
      if (observation === false) {
        return res.status(400).json({ error: 'observation must be a string up to 500 characters' });
      }
      normalizedRecords.push({ raw: record, studentId, observation });
    }

    // Ownership check: every studentId must belong to this leader's project
    // (either as base assignment or via a rotation row covering `date`).
    // Without this a leader could resolve attendance for students they have
    // no relationship to.
    for (const { studentId } of normalizedRecords) {
      const ok = await db.validateStudentBelongsToProject(studentId, projectId, date);
      if (!ok) {
        return res.status(403).json({
          error: 'Student does not belong to this project for the given date',
          studentId,
        });
      }
    }

    const bulkRecords = normalizedRecords.map(({ raw, studentId, observation }) => ({
      studentId,
      projectId: Number(projectId),
      leaderId: Number(leaderId),
      date,
      time,
      status: raw.status,
      justification: raw.status === 'absent' ? (raw.justification || 'injustificada') : null,
      observation,
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

// Orphan-file guard. multer writes the upload to disk BEFORE
// validateAttendance runs (it can't validate fields it hasn't parsed yet),
// so a request with a bad studentId / date / status used to leave the file
// sitting in /uploads forever. This middleware tags the request with a
// `keepUpload()` opt-in that the handler flips on success; on response
// finish, if the flag is still false and we have a file, we delete it.
const trackUploadCleanup = (req, res, next) => {
  let keep = false;
  req.keepUpload = () => { keep = true; };
  res.on('finish', () => {
    if (!keep && req.file && req.file.path) {
      // Fire and forget; safeUnlink swallows errors.
      safeUnlink(req.file.path);
    }
  });
  // Also handle premature client disconnects so we don't leak files on
  // aborted uploads either.
  res.on('close', () => {
    if (!keep && req.file && req.file.path) {
      safeUnlink(req.file.path);
    }
  });
  next();
};

// Mark attendance for a single student (multipart, supports attachment)
router.post('/', rejectStaleAuthor, uploadSingle, trackUploadCleanup, validateAttendance, async (req, res) => {
  try {
    const studentId = toPositiveInt(req.body.studentId);
    const projectId = req.user.projectId;
    const leaderId = req.user.id;
    const { date, time, status, justification } = req.body;

    if (!projectId || !leaderId) {
      return res.status(403).json({ error: 'Authenticated user has no project assignment' });
    }

    // validateAttendance has already enforced shape, but be defensive: the
    // express-validator middleware can be bypassed if someone re-wires the
    // chain, and we never want to insert a row with NaN/null in NOT NULL
    // columns.
    if (!studentId) {
      return res.status(400).json({ error: 'studentId must be a positive integer' });
    }
    if (!date || !status) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    // The attendance table declares `time TIME NOT NULL`; the validator
    // currently treats it as optional. Catch the omission here so we return
    // 400 instead of a 500 from the constraint violation.
    if (!isValidTime(time)) {
      return res.status(400).json({ error: 'time is required and must be in HH:MM format' });
    }
    // Same date sanity bounds as the bulk endpoints.
    const dateErr = sanityCheckAttendanceDate(date);
    if (dateErr) return res.status(400).json({ error: dateErr });

    // Block writes once the coordinator has locked this date's jornada.
    if (await db.isDateLocked(projectId, date)) {
      return res.status(409).json({
        error: 'Jornada cerrada',
        message: 'La jornada de esta fecha ya fue cerrada. No se puede modificar.'
      });
    }

    if (status !== 'present' && status !== 'absent') {
      return res.status(400).json({ error: 'Status must be either "present" or "absent"' });
    }
    if (justification != null && !['justificada', 'injustificada'].includes(justification)) {
      return res.status(400).json({ error: 'Justification must be "justificada" or "injustificada"' });
    }
    if (status === 'present' && justification) {
      return res.status(400).json({ error: 'Justification can only be provided for absent status' });
    }

    const observation = normalizeObservation(req.body.observation);
    if (observation === false) {
      return res.status(400).json({ error: 'observation must be a string up to 500 characters' });
    }

    let attachmentFilePath = null;
    let attachmentFileName = null;
    if (req.file) {
      // Defense against MIME-type spoofing: read the file's actual signature.
      const ok = await validateFileSignature(req.file.path);
      if (!ok) {
        return res.status(400).json({ error: 'Tipo de archivo no válido. El contenido no coincide con la extensión.' });
      }
      const backendRoot = path.join(__dirname, '..', '..');
      attachmentFilePath = path.relative(backendRoot, req.file.path);
      attachmentFileName = req.file.originalname;
    }

    // Cheap structural and ownership checks BEFORE the DB existence check so
    // we don't burn a query on a request that's about to 400/403 anyway.
    const isValid = await db.validateStudentBelongsToProject(studentId, projectId, date);
    if (!isValid) {
      return res.status(403).json({ error: 'Student does not belong to this project for the specified date' });
    }

    // Check if attendance has already been submitted for THIS STUDENT on this date.
    // This is a pre-check for a friendlier 409; the UNIQUE(student_id, date)
    // constraint inside insertAttendance is the actual guarantee.
    const studentAttendanceExists = await db.checkAttendanceExists(studentId, date);
    if (studentAttendanceExists) {
      return res.status(409).json({
        error: 'Attendance already submitted',
        message: 'La asistencia ya fue guardada para este estudiante en esta fecha. No se puede modificar.'
      });
    }

    const finalJustification = status === 'absent'
      ? (justification || 'injustificada')
      : null;

    try {
      const result = await db.insertAttendance(
        studentId,
        Number(projectId),
        Number(leaderId),
        date,
        time,
        status,
        finalJustification,
        observation,
        attachmentFilePath,
        attachmentFileName
      );

      // Only here do we commit to keeping the uploaded file on disk.
      req.keepUpload();
      res.json({
        success: true,
        message: 'Attendance recorded successfully',
        result
      });
    } catch (err) {
      // A racing concurrent submitter could win the UNIQUE(student_id, date)
      // contest between our pre-check above and the INSERT. Surface that as
      // 409 — same user-facing meaning.
      if (err && err.code === 'SQLITE_CONSTRAINT') {
        return res.status(409).json({
          error: 'Attendance already submitted',
          message: 'La asistencia ya fue guardada para este estudiante en esta fecha. No se puede modificar.'
        });
      }
      throw err;
    }
  } catch (error) {
    console.error('Error marking attendance:', error);
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
// Validate both params up front so a path-traversal attempt in :date
// (e.g. "../../etc/passwd") gets rejected before we even touch the DB.
router.get('/attachment/:studentId/:date', [...validateStudentId, ...validateDateParam], async (req, res) => {
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
    // The stored value should always be a relative path (set via
    // path.relative(backendRoot, ...)) but we never trust the DB blindly —
    // an absolute path here, a "..", or even pointing at the uploads dir
    // itself (a directory, not a file) is all rejected.
    const backendRoot = path.join(__dirname, '..', '..');
    const uploadsRoot = path.join(backendRoot, 'uploads');
    if (path.isAbsolute(record.attachment_file_path)) {
      return res.status(400).json({ error: 'Invalid attachment path' });
    }
    const resolved = path.resolve(backendRoot, record.attachment_file_path);
    if (!resolved.startsWith(uploadsRoot + path.sep)) {
      return res.status(400).json({ error: 'Invalid attachment path' });
    }

    try {
      const stat = await fs.stat(resolved);
      if (!stat.isFile()) {
        return res.status(404).json({ error: 'Attachment file not found on server' });
      }
    } catch {
      return res.status(404).json({ error: 'Attachment file not found on server' });
    }

    // Sanitize the download filename — record.attachment_file_name came
    // from the client originally and could contain CR/LF that would let
    // it inject extra Content-Disposition headers. Multer already wrote
    // the file with a sanitized on-disk name; for the download header,
    // strip control characters and fall back to a safe default.
    const rawName = String(record.attachment_file_name || '');
    const safeName = rawName.replace(/[\r\n"\\\x00-\x1f]/g, '_').slice(0, 200) || 'attachment';

    res.download(resolved, safeName, (err) => {
      if (err && !res.headersSent) {
        res.status(500).json({ error: 'Failed to download attachment' });
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch attachment' });
  }
});

module.exports = router;
