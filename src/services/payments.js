export async function initializeFlutterwavePayment(config, { email, fullName, amountNgn, reference, callbackUrl, metadata }) {
  if (!config.flutterwaveSecretKey) {
    const error = new Error('Payments are not configured. Set FLW_SECRET_KEY before approving paid applications.');
    error.code = 'PAYMENTS_NOT_CONFIGURED';
    throw error;
  }
  const response = await fetch('https://api.flutterwave.com/v3/payments', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.flutterwaveSecretKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tx_ref: reference, amount: String(amountNgn), currency: 'NGN', redirect_url: callbackUrl,
      customer: { email, name: fullName },
      customizations: { title: 'BETGO subscription', description: '30-day bookmaker bot subscription' },
      meta: metadata
    })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.status !== 'success' || !payload.data?.link) {
    const error = new Error('Flutterwave could not initialize the payment. No activation has occurred.');
    error.code = 'PAYMENT_INITIALIZATION_FAILED';
    throw error;
  }
  return payload.data;
}

export async function verifyFlutterwavePayment(config, transactionId) {
  if (!config.flutterwaveSecretKey) throw new Error('Payment verification is not configured.');
  if (!/^\d+$/.test(String(transactionId))) return null;
  const response = await fetch(`https://api.flutterwave.com/v3/transactions/${encodeURIComponent(transactionId)}/verify`, {
    headers: { Authorization: `Bearer ${config.flutterwaveSecretKey}` }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.status !== 'success' || payload.data?.status !== 'successful') return null;
  return payload.data;
}
