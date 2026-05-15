// SMTP transport for outbound emails (currently the "you have pending
// attendance to sync" escalation when push notifications don't reach
// the leader's device). Reads credentials from environment so they stay
// out of git.
//
// Required env vars:
//   SMTP_HOST       smtp.gmail.com (default)
//   SMTP_PORT       587 (default, STARTTLS)
//   SMTP_USER       gmail address
//   SMTP_PASS       Gmail App Password (16 chars, no spaces)
//   SMTP_FROM       optional, defaults to SMTP_USER
//
// If SMTP_USER or SMTP_PASS are missing, the module exports a stub
// transport whose sendMail returns { skipped: true } — so the server
// boots and email-dependent code paths short-circuit gracefully.

const nodemailer = require('nodemailer');

const host = process.env.SMTP_HOST || 'smtp.gmail.com';
const port = parseInt(process.env.SMTP_PORT || '587', 10);
const user = process.env.SMTP_USER;
const pass = process.env.SMTP_PASS;
const from = process.env.SMTP_FROM || user || null;

let transporter = null;
let configured = false;

if (user && pass) {
  transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465, // 465=SSL, anything else (587, 25) uses STARTTLS
    auth: { user, pass },
  });
  configured = true;
}

async function sendMail({ to, subject, html, text }) {
  if (!configured || !transporter) {
    return { skipped: true, reason: 'SMTP not configured' };
  }
  if (!to) {
    return { skipped: true, reason: 'No recipient' };
  }
  try {
    const info = await transporter.sendMail({
      from,
      to,
      subject,
      text,
      html,
    });
    return { sent: true, messageId: info.messageId };
  } catch (err) {
    return { sent: false, error: err.message };
  }
}

module.exports = {
  sendMail,
  isConfigured: () => configured,
};
