const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
// Default raised from 8h to 30d for the offline-first deployment: leaders
// often go offline for the bulk of their shift and come back hours later
// to sync. An 8h cookie expiring mid-shift forces a re-login and breaks
// auto-sync of queued writes. Override via JWT_EXPIRES_IN env if a shorter
// session is desired (testing, CI, security rotation drills).
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '30d';

// Fail fast at module load: a bad secret here was producing the same 500
// later on every login. Catching it during boot makes the misconfiguration
// obvious from systemd logs.
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  throw new Error('JWT_SECRET must be set in environment variables and be at least 32 characters');
}

const validateJwtConfig = () => {
  if (!JWT_SECRET || JWT_SECRET.length < 32) {
    throw new Error('JWT_SECRET must be set in environment variables and be at least 32 characters');
  }
};

// Generar token JWT
const generateToken = (payload) => {
  validateJwtConfig();
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
};

// Verificar token JWT
const verifyToken = (token) => {
  validateJwtConfig();
  return jwt.verify(token, JWT_SECRET);
};

// Read the JWT from the HttpOnly cookie or, as a fallback, the Authorization
// header. The cookie is the preferred path for browser clients; the header
// stays supported for server-to-server / scripted use.
const extractToken = (req) => {
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  const cookieHeader = req.headers['cookie'];
  if (!cookieHeader) return null;
  const match = cookieHeader.match(/(?:^|;\s*)auth_token=([^;]+)/);
  if (!match) return null;
  // Malformed URI escapes in a cookie value throw on decodeURIComponent.
  // A garbage cookie should be treated as "no token", not crash the request.
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
};

// Middleware para autenticar requests
const authenticateToken = (req, res, next) => {
  const token = extractToken(req);

  if (!token) {
    return res.status(401).json({
      error: 'Access denied',
      message: 'No authentication token provided'
    });
  }

  try {
    validateJwtConfig();
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        error: 'Token expired',
        message: 'Please login again'
      });
    }
    return res.status(403).json({
      error: 'Invalid token',
      message: 'Authentication failed'
    });
  }
};

// Middleware para verificar rol admin
const requireAdmin = (req, res, next) => {
  // Primero debe pasar por authenticateToken
  if (!req.user) {
    return res.status(401).json({
      error: 'Not authenticated',
      message: 'Authentication required'
    });
  }

  if (req.user.role !== 'admin') {
    return res.status(403).json({
      error: 'Forbidden',
      message: 'Admin privileges required'
    });
  }

  next();
};

// Per-account override for destructive student deletion. Defaults to
// allowed for all admins (the column defaults to 1); set a leader's
// `can_delete_students` to 0 in the DB to revoke this specific
// capability without changing their role. The check fetches the live
// row each request — JWT payloads don't carry this flag, so a flag
// change takes effect immediately instead of waiting for token refresh.
//
// Also enforces that the caller is an admin/profesor: the middleware is
// reused from routes that don't pre-gate by role (e.g. projects router
// only requires authenticateToken), so without this check a plain
// leader with the default flag would be allowed to delete any student.
const requireCanDeleteStudents = async (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  try {
    const db = require('../config/database');
    const leader = await db.getLeaderById(req.user.id);
    if (!leader) {
      return res.status(401).json({ error: 'User not found' });
    }
    const role = leader.role || 'leader';
    if (role !== 'admin' && role !== 'profesor') {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'Solo administradores y profesores pueden eliminar estudiantes.',
      });
    }
    // Allow-by-default semantics: the column defaults to 1, so only an
    // explicit zero/'0' revokes. Handle the stringly-typed case too in
    // case a future migration surfaces text instead of INTEGER — the
    // original `=== 0` check would silently grant access on `'0'`.
    const flag = leader.can_delete_students;
    if (flag === 0 || flag === '0') {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'Esta cuenta no tiene permiso para eliminar estudiantes.',
      });
    }
    next();
  } catch (err) {
    next(err);
  }
};

// Middleware para verificar rol profesor (o admin)
const requireProfesor = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({
      error: 'Not authenticated',
      message: 'Authentication required'
    });
  }

  if (req.user.role !== 'profesor' && req.user.role !== 'admin') {
    return res.status(403).json({
      error: 'Forbidden',
      message: 'Professor privileges required'
    });
  }

  next();
};

// Convert the JWT_EXPIRES_IN string ("8h", "30m", "60s") into milliseconds for
// the cookie's Max-Age. Defaults to 8h if the format is unrecognized.
const tokenLifetimeMs = () => {
  // Default MUST match the JWT signing default above (currently '30d').
  // If they diverge, the cookie maxAge expires before the JWT itself —
  // a stale leader gets booted out at maxAge even though the JWT is
  // still valid. Both fall back to 30 days if unset.
  const v = process.env.JWT_EXPIRES_IN || JWT_EXPIRES_IN || '30d';
  const m = String(v).match(/^(\d+)([smhd])$/);
  const fallback = 30 * 24 * 60 * 60 * 1000;
  if (!m) return fallback;
  const n = parseInt(m[1], 10);
  switch (m[2]) {
    case 's': return n * 1000;
    case 'm': return n * 60 * 1000;
    case 'h': return n * 60 * 60 * 1000;
    case 'd': return n * 24 * 60 * 60 * 1000;
    default: return fallback;
  }
};

const cookieOptions = () => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict',
  maxAge: tokenLifetimeMs(),
  path: '/'
});

const setAuthCookie = (res, token) => {
  res.cookie('auth_token', token, cookieOptions());
};

const clearAuthCookie = (res) => {
  res.clearCookie('auth_token', { ...cookieOptions(), maxAge: 0 });
};

module.exports = {
  generateToken,
  authenticateToken,
  requireAdmin,
  requireProfesor,
  requireCanDeleteStudents,
  setAuthCookie,
  clearAuthCookie,
  JWT_EXPIRES_IN
};
