import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeFlutterwavePayment, verifyFlutterwavePayment } from '../src/services/payments.js';

const config = { flutterwaveSecretKey: 'test-secret' };

test('initializes Flutterwave checkout in NGN and returns its hosted link', async () => {
  const previousFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return { ok: true, json: async () => ({ status: 'success', data: { link: 'https://checkout.example/pay' } }) };
  };
  try {
    const result = await initializeFlutterwavePayment(config, {
      email: 'member@example.com', fullName: 'Test Member', amountNgn: 5000,
      reference: 'betgo_test_ref', callbackUrl: 'https://betgo.example/payment/return', metadata: { subscriptionDays: 30 }
    });
    assert.equal(result.link, 'https://checkout.example/pay');
    assert.equal(request.url, 'https://api.flutterwave.com/v3/payments');
    assert.equal(request.options.headers.Authorization, 'Bearer test-secret');
    const body = JSON.parse(request.options.body);
    assert.equal(body.tx_ref, 'betgo_test_ref');
    assert.equal(body.amount, '5000');
    assert.equal(body.currency, 'NGN');
  } finally { globalThis.fetch = previousFetch; }
});

test('does not return a checkout link when Flutterwave initialization fails', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, json: async () => ({ status: 'error' }) });
  try {
    await assert.rejects(() => initializeFlutterwavePayment(config, {
      email: 'member@example.com', fullName: 'Test Member', amountNgn: 5000,
      reference: 'betgo_test_ref', callbackUrl: 'https://betgo.example/payment/return', metadata: {}
    }), { code: 'PAYMENT_INITIALIZATION_FAILED' });
  } finally { globalThis.fetch = previousFetch; }
});

test('verifies only numeric transaction IDs and successful transactions', async () => {
  const previousFetch = globalThis.fetch;
  let requestedUrl;
  globalThis.fetch = async (url) => {
    requestedUrl = url;
    return { ok: true, json: async () => ({ status: 'success', data: { id: 12345, tx_ref: 'betgo_ref', status: 'successful', amount: 5000, currency: 'NGN' } }) };
  };
  try {
    assert.equal(await verifyFlutterwavePayment(config, 'not-an-id'), null);
    assert.equal(requestedUrl, undefined);
    const result = await verifyFlutterwavePayment(config, 12345);
    assert.equal(result.tx_ref, 'betgo_ref');
    assert.equal(requestedUrl, 'https://api.flutterwave.com/v3/transactions/12345/verify');
  } finally { globalThis.fetch = previousFetch; }
});
