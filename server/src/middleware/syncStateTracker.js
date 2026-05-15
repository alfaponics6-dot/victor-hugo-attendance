const db = require('../config/database');

// Best-effort piggyback: every authenticated client carries an
// X-Queue-Size header reflecting how many writes are currently waiting
// in their IndexedDB queue. We use it to update per-leader sync state
// so the push cron only wakes devices that actually have pending data.
//
// Failures here MUST NOT block the underlying request — if the DB write
// fails, the worst case is a few extra (or skipped) wake-up pushes.
function syncStateTracker(req, res, next) {
  const raw = req.headers['x-queue-size'];
  if (raw !== undefined && req.user?.id) {
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 0 && n < 100000) {
      db.upsertLeaderSyncState(req.user.id, n).catch(() => {});
    }
  }
  next();
}

module.exports = { syncStateTracker };
