// Stage 3 (IMPLEMENTATION_CHECKLIST.md): configurable email notifications
// to an admin recipient. Uses Resend's plain HTTP API (no SDK dependency)
// so this works with just an API key in env. If it's unconfigured, say so
// honestly -- never claim a send was attempted, let alone tested, without
// real credentials.
function getEmailConfig() {
  const apiKey = process.env.ALERT_EMAIL_API_KEY || null;
  const to = process.env.ALERT_EMAIL_TO || null;
  const from = process.env.ALERT_EMAIL_FROM || null;
  const configured = Boolean(apiKey && to && from);
  return {
    configured,
    to,
    from,
    provider: configured ? 'resend' : null,
    // Never set true by this module -- only a real send attempt that
    // actually completes (see sendAlertEmail) may claim that, and even
    // then only for that one call, not as a persistent "verified" state.
    note: configured
      ? null
      : 'Email alerts are unconfigured -- set ALERT_EMAIL_API_KEY, ALERT_EMAIL_TO and ALERT_EMAIL_FROM to enable them. In-app alerts work regardless.'
  };
}

async function sendAlertEmail(subject, text) {
  const cfg = getEmailConfig();
  if (!cfg.configured) {
    return { sent: false, reason: cfg.note };
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.ALERT_EMAIL_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ from: cfg.from, to: [cfg.to], subject, text })
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { sent: false, reason: `Resend API returned ${res.status}: ${body.slice(0, 300)}` };
    }
    return { sent: true };
  } catch (err) {
    return { sent: false, reason: `Email send failed: ${err.message}` };
  }
}

module.exports = { getEmailConfig, sendAlertEmail };
