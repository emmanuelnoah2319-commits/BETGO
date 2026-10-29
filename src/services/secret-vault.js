import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

function keyFromSecret(secret) {
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('SESSION_SECRET must contain at least 32 characters.');
  return createHash('sha256').update('BETGO SportyBet session vault\0').update(secret).digest();
}

export function encryptSecret(value, secret) {
  if (typeof value !== 'string' || value.length < 20 || value.length > 12000 || /[\r\n]/.test(value)) {
    throw new TypeError('Session cookie must be a single line between 20 and 12000 characters.');
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFromSecret(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return { version: 1, iv: iv.toString('base64url'), ciphertext: ciphertext.toString('base64url'), tag: cipher.getAuthTag().toString('base64url') };
}

export function decryptSecret(record, secret) {
  if (!record || record.version !== 1 || typeof record.iv !== 'string' || typeof record.ciphertext !== 'string' || typeof record.tag !== 'string') {
    throw new Error('Encrypted session is missing or invalid.');
  }
  const decipher = createDecipheriv('aes-256-gcm', keyFromSecret(secret), Buffer.from(record.iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(record.tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(record.ciphertext, 'base64url')), decipher.final()]).toString('utf8');
}
