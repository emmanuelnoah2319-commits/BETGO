export async function sendEmail(config, { to, subject, text }) {
  if (!config.resendApiKey || !config.emailFrom) {
    const error = new Error('Email is not configured. Set RESEND_API_KEY and EMAIL_FROM before sending customer emails.');
    error.code = 'EMAIL_NOT_CONFIGURED';
    throw error;
  }
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.resendApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: config.emailFrom, to: [to], subject, text })
  });
  if (!response.ok) {
    const error = new Error(`Email provider rejected the message (${response.status}).`);
    error.code = 'EMAIL_PROVIDER_ERROR';
    throw error;
  }
  return response.json();
}
