const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { publicKey } = require('../config/vapid');
const { authenticateToken } = require('../middleware/auth');

// Public: clients fetch this once to know what VAPID key to use when
// subscribing for push. The VAPID public key is meant to be public.
router.get('/vapid-public-key', (req, res) => {
  res.json({ publicKey });
});

// Save / refresh the device's push subscription. Authenticated so we can
// associate the subscription with the leader. Same endpoint posted twice
// (e.g., on every login) just upserts.
router.post('/subscribe', authenticateToken, express.json(), async (req, res) => {
  try {
    const { subscription } = req.body || {};
    if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
      return res.status(400).json({ error: 'Invalid subscription payload' });
    }
    await db.upsertPushSubscription({
      leaderId: req.user?.id ?? null,
      endpoint: subscription.endpoint,
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
      userAgent: (req.headers['user-agent'] || '').slice(0, 500) || null,
    });
    res.json({ success: true });
  } catch (e) {
    console.error('Push subscribe failed:', e);
    res.status(500).json({ error: 'Failed to save subscription' });
  }
});

// Drop the subscription. Called on logout from the device that owns it.
router.delete('/subscribe', authenticateToken, express.json(), async (req, res) => {
  try {
    const { endpoint } = req.body || {};
    if (!endpoint) {
      return res.status(400).json({ error: 'endpoint required' });
    }
    await db.removePushSubscription(endpoint);
    res.json({ success: true });
  } catch (e) {
    console.error('Push unsubscribe failed:', e);
    res.status(500).json({ error: 'Failed to remove subscription' });
  }
});

module.exports = router;
