// Resend only delivers from a domain you have verified. Its shared testing sender (onboarding@resend.dev) delivers
// only to the email address of the Resend account owner, so it is never usable for real applicants.
const TESTING_DOMAIN = 'resend.dev';
const PLACEHOLDER_DOMAINS = new Set(['example.com', 'example.org', 'example.net', 'localhost']);

export function parseSenderAddress(from) {
  const text = String(from || '').trim();
  const bracketed = text.match(/<([^<>]+)>\s*$/);
  const address = (bracketed ? bracketed[1] : text).trim().toLowerCase();
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(address) ? address : null;
}

// What the configured sender can actually do. `ready` is false whenever Resend would certainly reject or restrict mail.
export function emailSenderStatus(config) {
  if (!config.resendApiKey || !config.emailFrom) {
    return { mode: 'unconfigured', ready: false, code: 'EMAIL_NOT_CONFIGURED', message: 'Customer email is not configured. Set RESEND_API_KEY and EMAIL_FROM.' };
  }
  const address = parseSenderAddress(config.emailFrom);
  if (!address) {
    return { mode: 'invalid', ready: false, code: 'EMAIL_SENDER_INVALID', message: 'EMAIL_FROM must look like "BETGO <no-reply@your-verified-domain>".' };
  }
  const domain = address.split('@')[1];
  if (PLACEHOLDER_DOMAINS.has(domain)) {
    return { mode: 'placeholder', ready: false, code: 'EMAIL_SENDER_INVALID', message: `EMAIL_FROM uses the placeholder domain ${domain}. Resend rejects mail from domains you have not verified; verify a domain you control and use it here.` };
  }
  if (domain === TESTING_DOMAIN) {
    const recipient = String(config.emailTestingRecipient || '').trim().toLowerCase();
    return recipient
      ? { mode: 'testing', ready: true, testingRecipient: recipient, message: `Testing sender in use: mail is only sent to ${recipient}. Verify your own domain before approving real applicants.` }
      : { mode: 'testing', ready: false, code: 'EMAIL_TESTING_RECIPIENT_REQUIRED', message: 'The Resend testing sender only delivers to your own Resend account email. Set EMAIL_TESTING_RECIPIENT to that address, or verify a domain you control.' };
  }
  return { mode: 'custom_domain', ready: true, domain, message: `Sending from ${domain}. Confirm the domain shows as Verified in the Resend dashboard.` };
}

// Cheap, side-effect-free check used before any state is changed on the customer's behalf.
export function emailPreflight(config, to) {
  const status = emailSenderStatus(config);
  if (!status.ready) return { status: 503, code: status.code, message: `${status.message} Nothing was changed.` };
  if (status.mode === 'testing' && String(to || '').trim().toLowerCase() !== status.testingRecipient) {
    return { status: 503, code: 'EMAIL_TESTING_RECIPIENT_ONLY', message: `The Resend testing sender can only email ${status.testingRecipient}. Verify a domain you control before emailing ${to}. Nothing was changed.` };
  }
  return null;
}

export async function sendEmail(config, { to, subject, text, html }) {
  const blocked = emailPreflight(config, to);
  if (blocked) {
    const error = new Error(blocked.message);
    error.code = blocked.code;
    throw error;
  }
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.resendApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: config.emailFrom, to: [to], subject, text, ...(html ? { html } : {}) })
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const error = new Error(`Email provider rejected the message (${response.status}).`);
    error.code = 'EMAIL_PROVIDER_ERROR';
    error.providerStatus = response.status;
    // Resend explains domain/recipient rejections here; it is for server logs and the owner, never for customers.
    error.providerMessage = typeof body?.message === 'string' ? body.message.slice(0, 300) : null;
    throw error;
  }
  return response.json();
}
