const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '8h';

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

// Middleware para verificar rol profesor (incluye coordinador y admin, que
// están por encima del profesor y deben ver lo mismo o más).
const requireProfesor = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({
      error: 'Not authenticated',
      message: 'Authentication required'
    });
  }

  if (!['profesor', 'coordinador', 'admin'].includes(req.user.role)) {
    return res.status(403).json({
      error: 'Forbidden',
      message: 'Professor privileges required'
    });
  }

  next();
};

// Middleware para verificar rol coordinador. El admin (superusuario) también
// pasa, de modo que pueda cerrar la jornada si hace falta.
const requireCoordinador = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({
      error: 'Not authenticated',
      message: 'Authentication required'
    });
  }

  if (req.user.role !== 'coordinador' && req.user.role !== 'admin') {
    return res.status(403).json({
      error: 'Forbidden',
      message: 'Coordinator privileges required'
    });
  }

  next();
};

// Convert the JWT_EXPIRES_IN string ("8h", "30m", "60s") into milliseconds for
// the cookie's Max-Age. Defaults to 8h if the format is unrecognized.
const tokenLifetimeMs = () => {
  const v = process.env.JWT_EXPIRES_IN || '8h';
  const m = String(v).match(/^(\d+)([smhd])$/);
  if (!m) return 8 * 60 * 60 * 1000;
  const n = parseInt(m[1], 10);
  switch (m[2]) {
    case 's': return n * 1000;
    case 'm': return n * 60 * 1000;
    case 'h': return n * 60 * 60 * 1000;
    case 'd': return n * 24 * 60 * 60 * 1000;
    default: return 8 * 60 * 60 * 1000;
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
  requireCoordinador,
  setAuthCookie,
  clearAuthCookie,
  JWT_EXPIRES_IN
};
