const db = require('../config/database');
const { sendMail, isConfigured } = require('../config/mailer');

// Email escalation: when a leader has been flagged sync_needed_at for
// more than STALE_MINUTES and we haven't emailed them in the last 24
// hours, send a nudge to their registered address. Push notifications
// alone are unreliable on iOS Safari PWAs — Apple may throttle or skip
// delivery silently. Email gives us a backup channel that always lands.
const STALE_MINUTES = Number(process.env.SYNC_EMAIL_STALE_MINUTES) || 60;
const APP_URL = process.env.APP_URL || 'https://forestryescenary.com';

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildBody({ leaderName, queueSize }) {
  const safeName = escapeHtml(leaderName || 'líder');
  const n = Math.max(1, Math.floor(queueSize || 1));
  const subject = `Asistencia EF 2026: ${n} registro${n === 1 ? '' : 's'} sin enviar`;
  const text =
    `Hola ${safeName},\n\n` +
    `Tenemos ${n} registro${n === 1 ? '' : 's'} de asistencia guardado${n === 1 ? '' : 's'} ` +
    `en su dispositivo que aún no se ${n === 1 ? 'ha enviado' : 'han enviado'} al servidor.\n\n` +
    `Por favor abra la aplicación (${APP_URL}) cuando tenga señal para terminar de sincronizar.\n\n` +
    `Universidad EARTH · Escenario Forestal 2026`;
  const html = `
<!doctype html>
<html lang="es">
  <body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f7f8fa;margin:0;padding:24px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;padding:28px;border:1px solid #e5e7eb;">
      <tr><td>
        <h2 style="margin:0 0 12px 0;color:#0f172a;font-size:18px;">Asistencia sin sincronizar</h2>
        <p style="margin:0 0 12px 0;color:#334155;font-size:14px;line-height:1.5;">
          Hola <strong>${safeName}</strong>,
        </p>
        <p style="margin:0 0 12px 0;color:#334155;font-size:14px;line-height:1.5;">
          Tenemos <strong>${n}</strong> registro${n === 1 ? '' : 's'} de asistencia
          guardado${n === 1 ? '' : 's'} en su dispositivo que aún no
          ${n === 1 ? 'ha sido enviado' : 'han sido enviados'} al servidor.
        </p>
        <p style="margin:0 0 20px 0;color:#334155;font-size:14px;line-height:1.5;">
          Por favor abra la aplicación cuando tenga señal para terminar de sincronizar — los datos se enviarán automáticamente.
        </p>
        <p style="margin:0 0 24px 0;">
          <a href="${APP_URL}" style="display:inline-block;background:#0ea5e9;color:white;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px;">
            Abrir Asistencia EF 2026
          </a>
        </p>
        <p style="margin:0;color:#94a3b8;font-size:12px;line-height:1.4;">
          Universidad EARTH · Escenario Forestal 2026<br/>
          Este es un recordatorio automático. Recibirá uno por día como máximo
          mientras tenga datos pendientes.
        </p>
      </td></tr>
    </table>
  </body>
</html>`.trim();
  return { subject, text, html };
}

async function runOnce() {
  if (!isConfigured()) {
    return { skipped: true, reason: 'SMTP not configured' };
  }
  let candidates;
  try {
    candidates = await db.listLeadersForEmailEscalation(STALE_MINUTES);
  } catch (e) {
    console.error('Email escalation: could not query candidates:', e.message);
    return { sent: 0, failed: 0 };
  }
  if (!candidates.length) return { sent: 0, failed: 0 };

  let sent = 0;
  let failed = 0;
  for (const row of candidates) {
    const body = buildBody({
      leaderName: row.leader_name,
      queueSize: row.last_known_queue_size,
    });
    const result = await sendMail({
      to: row.leader_email,
      subject: body.subject,
      text: body.text,
      html: body.html,
    });
    if (result.sent) {
      sent += 1;
      await db.markLeaderEmailed(row.leader_id).catch(() => {});
    } else if (!result.skipped) {
      failed += 1;
      console.warn(`Email escalation: send failed to ${row.leader_email}:`, result.error);
    }
  }
  return { sent, failed };
}

module.exports = { runOnce };
