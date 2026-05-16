require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const bodyParser = require('body-parser');
const rateLimit = require('express-rate-limit');
const { parseExcelAndPopulateDB } = require('./utils/excelParser');
const db = require('./config/database');
const { requestId } = require('./middleware/requestId');

const app = express();
const PORT = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === 'production';

// Trust proxy for HTTPS behind reverse proxy. This affects req.ip parsing for
// rate limiting; it does NOT relax the CORS allowlist below.
if (process.env.TRUST_PROXY === 'true') {
  app.set('trust proxy', 1);
}

// Security headers
app.use(helmet({
  contentSecurityPolicy: isProduction
    ? {
        useDefaults: true,
        directives: {
          'default-src': ["'self'"],
          'script-src': ["'self'"],
          'style-src': ["'self'", "'unsafe-inline'"],
          'img-src': ["'self'", 'data:', 'blob:'],
          'connect-src': ["'self'"],
          'object-src': ["'none'"],
          'frame-ancestors': ["'none'"],
          'base-uri': ["'self'"],
          'form-action': ["'self'"]
        }
      }
    : false,
  crossOriginEmbedderPolicy: false
}));

// CORS - always honor the configured allowlist. We deliberately do NOT relax
// this when behind a trusted proxy: CORS_ORIGINS is the source of truth.
const allowedOrigins = (process.env.CORS_ORIGINS || (isProduction ? '' : 'http://localhost:5173,http://localhost:3000'))
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

app.use(cors({
  origin: function (origin, callback) {
    // Same-origin / non-browser clients (curl, mobile) - no Origin header.
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  // X-Queue-Size: client tells us how many writes are pending in the
  // offline queue, so the push cron can target only devices that need a
  // wake-up (see middleware/syncStateTracker.js).
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Queue-Size']
}));

// JSON bodies are small (attendance records, login payloads). Attachments
// go through multer/multipart on /attendance, not through this parser, so
// 1mb is plenty here. nginx's client_max_body_size should be set to ~8M to
// cover the 5MB attachment ceiling plus form overhead — see
// deploy/nginx-victorhugo.conf.
app.use(bodyParser.json({ limit: '1mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '1mb' }));

// Request-id must be installed before the routes so the handlers and the
// error logger can read req.id. Sits after CORS so the X-Request-Id
// response header isn't dropped by the browser preflight check.
app.use(requestId);

// Rate limiting - the app is reachable from the public internet via the
// Cloudflare tunnel, so unbounded credential attempts would be a brute-force
// vector. The strict bucket is applied only to credential-checking endpoints
// (/login, /setup) inside routes/auth.js; everything else under /api uses
// the general limiter.
// Bumped from 200 → 1000/min because behind the Cloudflare tunnel
// `req.ip` resolves to a single shared edge IP, so EVERY leader's
// requests fall into one bucket. With 14 leaders each firing the
// ~12-request login prime, an end-of-shift reconnect wave produces
// ~168 requests in seconds. 1000/min leaves comfortable headroom while
// the per-credential limiter on /auth/login still bounds brute force
// at 30/min. Override via GENERAL_RATE_LIMIT for tighter deployments.
const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.GENERAL_RATE_LIMIT) || 1000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' }
});

// Routes
const authRoutes = require('./routes/auth');
const projectRoutes = require('./routes/projects');
const attendanceRoutes = require('./routes/attendance');
const statisticsRoutes = require('./routes/statistics');
const adminRoutes = require('./routes/admin');
const pushRoutes = require('./routes/push');
const profesorAttendanceRoutes = require('./routes/profesorAttendance');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');

app.use('/api/', generalLimiter);
app.use('/api/auth', authRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/statistics', statisticsRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/push', pushRoutes);
app.use('/api/profesor-attendance', profesorAttendanceRoutes);

// Liveness probe — cheap, no I/O. Use this for "is the process alive?" checks.
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Server is running' });
});

// Readiness probe — exercises the database. Use this for the nginx upstream
// health check, the OCI uptime alarm, and any "should I serve traffic?" gate.
// Returns 503 if the DB is unreachable / corrupted / locked beyond timeout.
app.get('/api/health/ready', async (req, res) => {
  try {
    const result = await Promise.race([
      new Promise((resolve, reject) =>
        db.db.get('SELECT 1 AS ok', (err, row) => (err ? reject(err) : resolve(row)))
      ),
      new Promise((_, reject) => setTimeout(() => reject(new Error('db timeout')), 2000)),
    ]);
    res.json({ status: 'ready', db: result?.ok === 1 ? 'up' : 'unknown' });
  } catch (err) {
    res.status(503).json({ status: 'not-ready', error: err.message });
  }
});

// NOTE: /uploads is intentionally NOT served as static. Attachments must go
// through /api/attendance/attachment/:studentId/:date which enforces
// per-student authorization and path validation.

// Error handling middleware (must be last)
app.use(notFoundHandler);
app.use(errorHandler);

// Initialize database with Excel data on first boot. Errors are logged in
// every environment - silent failure was masking missing/malformed seed files.
async function initializeDatabase() {
  try {
    const projects = await db.getProjects();
    if (projects.length === 0) {
      const result = await parseExcelAndPopulateDB();
      process.stdout.write(
        `Seeded DB from spreadsheet: ${result.projectsInserted} projects, ${result.leadersInserted} leaders\n`
      );
    }
  } catch (error) {
    process.stderr.write(`Database init error: ${error.message}\n${error.stack || ''}\n`);
  }
}

// Start server. We seed the DB *before* binding the listener so the first
// request never sees an empty projects table during cold start.
let server;
(async () => {
  await initializeDatabase();
  server = app.listen(PORT, () => {
    process.stdout.write(`Server listening on port ${PORT}\n`);
  });
  // Start the periodic push cron AFTER the server is listening so a slow
  // DB seed doesn't keep the cron firing into a half-initialized app.
  // Skip in NODE_ENV=test to avoid background timers leaking into specs.
  if (process.env.NODE_ENV !== 'test' && process.env.PUSH_CRON_DISABLE !== 'true') {
    require('./jobs/pushSyncCron').start();
  }
})();

// Graceful shutdown: stop accepting new connections, let in-flight requests
// finish (up to 10s), then close the DB. systemd will SIGKILL after its
// TimeoutStopSec so we cap our own wait at 9s to stay under that ceiling.
function shutdown(signal) {
  process.stdout.write(`Received ${signal}, draining...\n`);
  const force = setTimeout(() => {
    process.stderr.write('Drain timed out, forcing exit\n');
    process.exit(1);
  }, 9000);
  force.unref();

  const closeDb = () => db.close().catch(() => {}).finally(() => process.exit(0));
  if (server) {
    server.close((err) => {
      if (err) process.stderr.write(`server.close error: ${err.message}\n`);
      closeDb();
    });
  } else {
    closeDb();
  }
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
