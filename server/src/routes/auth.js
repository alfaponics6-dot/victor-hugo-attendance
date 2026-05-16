const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const db = require('../config/database');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { validateLogin } = require('../middleware/validation');
const { generateToken, authenticateToken, setAuthCookie, clearAuthCookie } = require('../middleware/auth');

// Strict bucket for the credential-checking endpoints. Applied per-route so
// /verify, /logout, /leaders, etc. are not blocked when a user navigates the
// app rapidly. The default of 30/min reflects the realistic floor for a
// school deployment: ~14 leaders + admin/profesor + retries all bursting
// from one campus IP at 8am can legitimately exceed 10/min. Override via
// `LOGIN_RATE_LIMIT` for high-traffic instances.
const credentialLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.LOGIN_RATE_LIMIT) || 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many authentication attempts, please try again later.' }
});

// Constant-time comparison so the leader access code can't be inferred via
// timing.
const constantTimeEqual = (a, b) => {
  const aBuf = Buffer.from(String(a || ''), 'utf8');
  const bBuf = Buffer.from(String(b || ''), 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
};

// Get all leaders (including admin + profesor) for the login dropdown. The
// cohort is hand-curated by EARTH staff and every authorized user needs to
// pick themselves from the list, so we don't filter by role here. Email is
// stripped — the dropdown only needs identification fields.
router.get('/leaders', async (req, res) => {
  try {
    const leaders = await db.getLeaders();
    const sanitized = leaders.map(l => ({
      id: l.id,
      name: l.name,
      project_id: l.project_id,
      project_name: l.project_name,
      project_number: l.project_number,
      role: l.role || 'leader'
    }));
    res.json(sanitized);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch leaders' });
  }
});

// Check if initial setup is needed (no admin password set)
router.get('/setup-status', async (req, res) => {
  try {
    const needsSetup = await db.checkAdminNeedsSetup();
    res.json({ needsSetup });
  } catch (error) {
    res.status(500).json({ error: 'Failed to check setup status' });
  }
});

// Initial admin setup - set password for the first time
router.post('/setup', credentialLimiter, async (req, res) => {
  try {
    const { adminId, password, confirmPassword } = req.body;

    if (!adminId || !password || !confirmPassword) {
      return res.status(400).json({ error: 'All fields are required' });
    }

    if (password !== confirmPassword) {
      return res.status(400).json({ error: 'Passwords do not match' });
    }

    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const needsSetup = await db.checkAdminNeedsSetup();
    if (!needsSetup) {
      return res.status(400).json({ error: 'Setup already completed' });
    }

    const admin = await db.getLeaderByIdWithAuth(adminId);
    if (!admin || admin.role !== 'admin') {
      return res.status(400).json({ error: 'Invalid admin account' });
    }

    const hash = await bcrypt.hash(password, 12);
    await db.setAdminPassword(adminId, hash);

    res.json({ success: true, message: 'Admin setup completed' });
  } catch (error) {
    res.status(500).json({ error: 'Setup failed' });
  }
});

// Login with JWT authentication.
// - leader role: requires `accessCode` matching LEADER_ACCESS_CODE.
// - admin / profesor roles: require their personal password.
router.post('/login', credentialLimiter, validateLogin, async (req, res) => {
  try {
    const { leaderId, password, accessCode } = req.body;

    if (!leaderId) {
      return res.status(400).json({ error: 'Leader ID required' });
    }

    const leader = await db.getLeaderByIdWithAuth(leaderId);
    if (!leader) {
      return res.status(404).json({ error: 'Leader not found' });
    }

    const role = leader.role || 'leader';

    if (role === 'admin' || role === 'profesor') {
      if (!password) {
        return res.status(400).json({ error: 'Password required', requiresPassword: true });
      }

      if (!leader.password_hash) {
        return res.status(400).json({ error: 'Setup required', requiresSetup: true });
      }

      const match = await bcrypt.compare(password, leader.password_hash);
      if (!match) {
        return res.status(401).json({ error: 'Invalid password' });
      }
    } else {
      // role === 'leader'
      const expected = process.env.LEADER_ACCESS_CODE;
      if (!expected) {
        return res.status(500).json({ error: 'Server is missing LEADER_ACCESS_CODE configuration' });
      }
      if (!accessCode) {
        return res.status(400).json({ error: 'Access code required', requiresAccessCode: true });
      }
      if (!constantTimeEqual(accessCode, expected)) {
        return res.status(401).json({ error: 'Invalid access code' });
      }
    }

    const token = generateToken({
      id: leader.id,
      name: leader.name,
      projectId: leader.project_id,
      role
    });

    // Issue HttpOnly cookie. Token is also returned in the body for
    // backwards compatibility with API consumers; web clients should ignore
    // the body token and rely on the cookie.
    setAuthCookie(res, token);

    res.json({
      success: true,
      token,
      leader: {
        id: leader.id,
        name: leader.name,
        email: leader.email || null,
        projectId: leader.project_id,
        projectName: leader.project_name,
        projectNumber: leader.project_number,
        role,
        canDeleteStudents: leader.can_delete_students !== 0,
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Login failed' });
  }
});

// Logout - clear the auth cookie. No-op for clients using the header path.
router.post('/logout', (req, res) => {
  clearAuthCookie(res);
  res.json({ success: true });
});

// Verify token endpoint - also revalidates role/project against the DB so a
// demoted user's still-valid token loses privileges immediately.
router.get('/verify', authenticateToken, async (req, res) => {
  try {
    const fresh = await db.getLeaderById(req.user.id);
    if (!fresh) {
      return res.status(401).json({ error: 'User no longer exists' });
    }
    res.json({
      valid: true,
      user: {
        id: fresh.id,
        name: fresh.name,
        email: fresh.email || null,
        projectId: fresh.project_id,
        projectName: fresh.project_name,
        projectNumber: fresh.project_number,
        role: fresh.role || 'leader',
        canDeleteStudents: fresh.can_delete_students !== 0,
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Verification failed' });
  }
});

// Change password (admin or profesor).
router.post('/change-password', credentialLimiter, authenticateToken, async (req, res) => {
  try {
    const { currentPassword, newPassword, confirmPassword } = req.body;

    if (req.user.role !== 'admin' && req.user.role !== 'profesor') {
      return res.status(403).json({ error: 'Only admins and profesores can change password' });
    }

    if (!currentPassword || !newPassword || !confirmPassword) {
      return res.status(400).json({ error: 'All fields are required' });
    }

    if (newPassword !== confirmPassword) {
      return res.status(400).json({ error: 'New passwords do not match' });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const leader = await db.getLeaderByIdWithAuth(req.user.id);
    if (!leader || !leader.password_hash) {
      return res.status(400).json({ error: 'No password set for this account' });
    }
    const match = await bcrypt.compare(currentPassword, leader.password_hash);
    if (!match) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const hash = await bcrypt.hash(newPassword, 12);
    await db.setUserPassword(req.user.id, hash);

    res.json({ success: true, message: 'Password changed successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to change password' });
  }
});

module.exports = router;
