const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const { validateDateQuery } = require('../middleware/validation');

// Apply authentication to all routes in this file
router.use(authenticateToken);
router.use(require('../middleware/syncStateTracker').syncStateTracker);

// Get overall statistics. Accepts either ?date=YYYY-MM-DD or
// ?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD for range mode.
router.get('/overall', validateDateQuery, async (req, res) => {
  try {
    const { date, startDate, endDate } = req.query;
    const stats = await db.getOverallStatistics(
      date || null,
      startDate && endDate ? { startDate, endDate } : undefined
    );
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch overall statistics' });
  }
});

// Get statistics by project. Same date / range semantics as /overall.
router.get('/by-project', validateDateQuery, async (req, res) => {
  try {
    const { date, startDate, endDate } = req.query;
    const stats = await db.getProjectStatistics(
      date || null,
      startDate && endDate ? { startDate, endDate } : undefined
    );
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch project statistics' });
  }
});

// Get attendance history (last N days)
router.get('/history', async (req, res) => {
  try {
    const { days = 7 } = req.query;
    const history = await db.getAttendanceHistory(parseInt(days));
    res.json(history);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch attendance history' });
  }
});

// Get statistics for a specific leader's project
router.get('/leader/:leaderId', async (req, res) => {
  try {
    const { leaderId } = req.params;
    const { date } = req.query;
    const stats = await db.getLeaderProjectStatistics(parseInt(leaderId), date || null);
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch leader statistics' });
  }
});

// Get detailed student data with emails for all projects (for export)
// Admin only - contains sensitive PII (emails)
router.get('/students-detail', requireAdmin, validateDateQuery, async (req, res) => {
  try {
    const { date } = req.query;
    const students = await db.getDetailedStudentDataForExport(date || null);
    res.json(students);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch detailed student data' });
  }
});

module.exports = router;
