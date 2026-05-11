const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const {
  validateStudent,
  validateStudentUpdate,
  validateProjectId,
  validateStudentId,
  validateRotation,
  validateThreshold,
  validateDays
} = require('../middleware/validation');

// Apply authentication to all routes in this file
router.use(authenticateToken);

// Helper: check that the authenticated user can view/modify the given project's data.
// Admin/profesor can access any project; leader is restricted to their own project.
const userCanModifyProject = (user, projectId) => {
  if (!user) return false;
  if (user.role === 'admin' || user.role === 'profesor') return true;
  return Number(user.projectId) === Number(projectId);
};

// Get all projects
router.get('/', async (req, res) => {
  try {
    const projects = await db.getProjects();
    res.json(projects);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch projects' });
  }
});

// Collaborators: the OTHER leaders on the requestor's project. Returns
// name + email so the Correos tab can put them in the CC line of the
// mailto link. Only the same-project teammates are exposed; this is not a
// general "list everyone with email" endpoint.
router.get('/my/collaborators', async (req, res) => {
  try {
    const me = req.user;
    if (!me || !me.projectId) return res.json([]);
    const rows = await new Promise((resolve, reject) => {
      db.db.all(
        `SELECT id, name, email FROM leaders
          WHERE project_id = ? AND id <> ? AND email IS NOT NULL AND email <> ''`,
        [me.projectId, me.id],
        (err, r) => err ? reject(err) : resolve(r)
      );
    });
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch collaborators' });
  }
});

// Get students for a project
router.get('/:projectId/students', validateProjectId, async (req, res) => {
  try {
    const { projectId } = req.params;
    if (!userCanModifyProject(req.user, projectId)) {
      return res.status(403).json({ error: 'Forbidden: cannot view students of another project' });
    }
    const students = await db.getStudentsByProjectId(projectId);
    res.json(students);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch students' });
  }
});

// Add a new student to a project
router.post('/:projectId/students', [...validateProjectId, ...validateStudent], async (req, res) => {
  try {
    const { projectId } = req.params;
    const { name, studentId, email } = req.body;

    if (!userCanModifyProject(req.user, projectId)) {
      return res.status(403).json({ error: 'Forbidden: cannot modify students in another project' });
    }

    if (!name) {
      return res.status(400).json({ error: 'Student name is required' });
    }

    const newStudentId = await db.insertStudent(name, studentId || null, email || null, projectId);

    res.json({
      success: true,
      studentId: newStudentId,
      message: 'Student added successfully'
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to add student' });
  }
});

// Update student information
router.put('/students/:studentId', validateStudentUpdate, async (req, res) => {
  try {
    const { studentId } = req.params;
    const { name, student_id, email } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Student name is required' });
    }

    const existing = await db.getStudentById(studentId);
    if (!existing) {
      return res.status(404).json({ error: 'Student not found' });
    }
    if (!userCanModifyProject(req.user, existing.project_id)) {
      return res.status(403).json({ error: 'Forbidden: cannot modify students in another project' });
    }

    const changes = await db.updateStudent(studentId, name, student_id || null, email || null);

    if (changes === 0) {
      return res.status(404).json({ error: 'Student not found' });
    }

    res.json({
      success: true,
      message: 'Student updated successfully'
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update student' });
  }
});

// Delete a student
router.delete('/students/:studentId', validateStudentId, async (req, res) => {
  try {
    const { studentId } = req.params;

    const existing = await db.getStudentById(studentId);
    if (!existing) {
      return res.status(404).json({ error: 'Student not found' });
    }
    if (!userCanModifyProject(req.user, existing.project_id)) {
      return res.status(403).json({ error: 'Forbidden: cannot modify students in another project' });
    }

    const changes = await db.deleteStudent(studentId);

    if (changes === 0) {
      return res.status(404).json({ error: 'Student not found' });
    }

    res.json({
      success: true,
      message: 'Student deleted successfully'
    });
  } catch (error) {
    if (error && error.code === 'SQLITE_CONSTRAINT') {
      return res.status(409).json({
        error: 'Cannot delete student',
        message: 'El estudiante tiene registros de asistencia o rotaciones. Archive en lugar de eliminar.'
      });
    }
    res.status(500).json({ error: 'Failed to delete student' });
  }
});

// Get current rotation number
router.get('/current-rotation', async (req, res) => {
  try {
    const rotationNumber = await db.getCurrentRotation();

    if (!rotationNumber) {
      return res.status(404).json({ error: 'No active rotation found' });
    }

    res.json({ rotationNumber });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch current rotation' });
  }
});

// Get all rotations schedule
router.get('/rotations-schedule', async (req, res) => {
  try {
    const rotations = await db.getAllRotationsSchedule();
    const currentRotation = await db.getCurrentRotation();
    res.json({ rotations, currentRotation });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch rotations schedule' });
  }
});

// Get students for a specific rotation
router.get('/:projectId/rotations/:rotationNumber/students', validateRotation, async (req, res) => {
  try {
    const { projectId, rotationNumber } = req.params;
    if (!userCanModifyProject(req.user, projectId)) {
      return res.status(403).json({ error: 'Forbidden: cannot view students of another project' });
    }
    const students = await db.getStudentsByProjectAndRotation(projectId, rotationNumber);
    res.json(students);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch students' });
  }
});

// Get students for current rotation
router.get('/:projectId/current-rotation-students', validateProjectId, async (req, res) => {
  try {
    const { projectId } = req.params;
    if (!userCanModifyProject(req.user, projectId)) {
      return res.status(403).json({ error: 'Forbidden: cannot view students of another project' });
    }
    const rotationNumber = await db.getCurrentRotation();

    if (!rotationNumber) {
      return res.status(404).json({ error: 'No active rotation found' });
    }

    const students = await db.getStudentsByProjectAndRotation(projectId, rotationNumber);
    res.json({ students, rotationNumber });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch students' });
  }
});

// Get available rotation numbers for a project
router.get('/:projectId/available-rotations', validateProjectId, async (req, res) => {
  try {
    const { projectId } = req.params;
    if (!userCanModifyProject(req.user, projectId)) {
      return res.status(403).json({ error: 'Forbidden: cannot view rotations for another project' });
    }
    const rotationNumbers = await db.getAvailableRotationNumbers(projectId);
    res.json({ rotationNumbers });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch rotation numbers' });
  }
});

// Get attendance history for a specific student
router.get('/students/:studentId/attendance', validateStudentId, async (req, res) => {
  try {
    const { studentId } = req.params;
    const existing = await db.getStudentById(studentId);
    if (!existing) {
      return res.status(404).json({ error: 'Student not found' });
    }
    if (!userCanModifyProject(req.user, existing.project_id)) {
      return res.status(403).json({ error: 'Forbidden: cannot view this student' });
    }
    const attendance = await db.getAttendanceByStudent(studentId);
    const summary = await db.getAttendanceSummaryByStudent(studentId);

    res.json({
      attendance,
      summary
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch attendance' });
  }
});

// Get students with low attendance
router.get('/:projectId/alerts/low-attendance', [...validateProjectId, ...validateThreshold], async (req, res) => {
  try {
    const { projectId } = req.params;
    if (!userCanModifyProject(req.user, projectId)) {
      return res.status(403).json({ error: 'Forbidden: cannot view alerts for another project' });
    }
    const threshold = req.query.threshold || 75;
    const students = await db.getStudentsWithLowAttendance(projectId, threshold);
    res.json(students);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch alerts' });
  }
});

// Get students with consecutive absences
router.get('/:projectId/alerts/consecutive-absences', [...validateProjectId, ...validateDays], async (req, res) => {
  try {
    const { projectId } = req.params;
    if (!userCanModifyProject(req.user, projectId)) {
      return res.status(403).json({ error: 'Forbidden: cannot view alerts for another project' });
    }
    const days = req.query.days || 3;
    const students = await db.getStudentsWithConsecutiveAbsences(projectId, days);
    res.json(students);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch alerts' });
  }
});

module.exports = router;
