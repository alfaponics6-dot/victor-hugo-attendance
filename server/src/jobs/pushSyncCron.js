const cron = require('node-cron');
const db = require('../config/database');
const { webpush } = require('../config/vapid');
const emailNotifier = require('./syncEmailNotifier');

// Periodic wake-up push to every subscribed device. The receiving service
// worker uses this as a trigger to drain its offline write queue — iOS
// Safari doesn't implement Background Sync so without this leaders would
// have to manually open the app to flush queued attendance.
//
// Schedule: every 30 minutes between 06:00 and 22:00 local time. Outside
// those hours leaders are likely off-shift and battery savings matter.
// Override with PUSH_CRON_SCHEDULE if you want a different cadence.
const SCHEDULE = process.env.PUSH_CRON_SCHEDULE || '*/30 6-22 * * *';
const TIMEZONE = process.env.PUSH_CRON_TZ || 'America/Costa_Rica';

async function runOnce() {
  let subs;
  try {
    // Only wake devices whose leader has flagged pending data — the
    // X-Queue-Size header + /push/heartbeat keep this state honest.
    // Without this filter we'd ping every leader every 30 min even
    // when the queue is empty (notification spam on iOS).
    subs = await db.listPushSubscriptionsNeedingSync();
  } catch (e) {
    console.error('Push cron: could not read subscriptions:', e.message);
    return { sent: 0, failed: 0 };
  }
  if (!subs.length) return { sent: 0, failed: 0 };

  const payload = JSON.stringify({ type: 'sync-trigger', at: Date.now() });
  let sent = 0;
  let failed = 0;
  // Sequential to avoid bursting through any push-service rate limiter.
  for (const sub of subs) {
    const subscription = {
      endpoint: sub.endpoint,
      keys: { p256dh: sub.p256dh, auth: sub.auth },
    };
    try {
      // web-push uses Node's default HTTPS agent which has NO socket
      // timeout. A single hung push endpoint would stall the entire
      // cron tick — Promise.race with a 10s deadline forces forward
      // progress so a misbehaving Apple/Mozilla edge can't block the
      // other leaders' wake-ups.
      await Promise.race([
        webpush.sendNotification(subscription, payload, {
          TTL: 60 * 5,
          urgency: 'normal',
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('push timeout')), 10_000),
        ),
      ]);
      sent += 1;
      db.markPushed(sub.endpoint, 200).catch(() => {});
    } catch (err) {
      failed += 1;
      const status = err?.statusCode ?? 0;
      // 404 / 410 = the browser unsubscribed or the endpoint is dead.
      // Drop the row so we don't keep pushing into the void.
      if (status === 404 || status === 410) {
        db.removePushSubscription(sub.endpoint).catch(() => {});
      } else {
        db.markPushed(sub.endpoint, status).catch(() => {});
      }
    }
  }
  return { sent, failed };
}

function start() {
  if (!cron.validate(SCHEDULE)) {
    console.error(`Push cron: invalid schedule "${SCHEDULE}", not starting`);
    return;
  }
  cron.schedule(
    SCHEDULE,
    async () => {
      const tickStart = Date.now();
      let pushSent = 0;
      let pushFailed = 0;
      let emailSent = 0;
      let emailFailed = 0;
      try {
        const r = await runOnce();
        pushSent = r.sent ?? 0;
        pushFailed = r.failed ?? 0;
      } catch (e) {
        console.error('Push cron error:', e.message);
      }
      try {
        const r = await emailNotifier.runOnce();
        emailSent = r.sent ?? 0;
        emailFailed = r.failed ?? 0;
      } catch (e) {
        console.error('Email escalation error:', e.message);
      }
      // Always log a tick line so the operator can distinguish "cron
      // healthy, nothing to do" from "cron is dead." Previous behavior
      // logged nothing when sent=0 failed=0 — silent ticks looked
      // identical to a stopped scheduler.
      const elapsedMs = Date.now() - tickStart;
      console.log(
        `Push cron tick (${elapsedMs}ms): push sent=${pushSent}/failed=${pushFailed}, email sent=${emailSent}/failed=${emailFailed}`,
      );
    },
    { timezone: TIMEZONE },
  );
  console.log(`Push cron scheduled: "${SCHEDULE}" (${TIMEZONE})`);
  // Warn loudly if email escalation is unconfigured. Without this an
  // operator who forgot SMTP_USER/SMTP_PASS gets identical "0/0" cron
  // logs to a healthy-but-quiet system.
  if (!require('../config/mailer').isConfigured()) {
    console.warn('[startup] Email escalation disabled — SMTP_USER + SMTP_PASS not set in .env');
  }
}

module.exports = { start, runOnce };
