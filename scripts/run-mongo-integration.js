import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

export function validateMongoIntegrationEnvironment(env = process.env) {
  const uri = env.MONGO_TEST_URI;
  if (typeof uri !== 'string' || !uri.trim()) {
    return { ok: false, error: 'MONGO_TEST_URI is required. The integration test will not silently skip.' };
  }
  let parsed;
  try {
    parsed = new URL(uri);
  } catch {
    return { ok: false, error: 'MONGO_TEST_URI must be a valid mongodb:// or mongodb+srv:// URI.' };
  }
  if (!['mongodb:', 'mongodb+srv:'].includes(parsed.protocol)) {
    return { ok: false, error: 'MONGO_TEST_URI must use mongodb:// or mongodb+srv://.' };
  }
  const databasePath = decodeURIComponent(parsed.pathname.replace(/^\//, '')).toLowerCase();
  if (/\b(prod|production|live)\b/.test(databasePath)) {
    return { ok: false, error: 'Refusing an integration URI whose database path looks production-like.' };
  }
  if (env.BETGO_CONFIRM_DISPOSABLE_MONGO !== 'true') {
    return { ok: false, error: 'Set BETGO_CONFIRM_DISPOSABLE_MONGO=true only after confirming this MongoDB server is dedicated to disposable tests.' };
  }
  return { ok: true };
}

async function main() {
  const validation = validateMongoIntegrationEnvironment();
  if (!validation.ok) {
    console.error(`BETGO MongoDB integration test blocked: ${validation.error}`);
    process.exitCode = 2;
    return;
  }
  const child = spawn(process.execPath, ['--test', 'test/mongo.integration.test.js'], {
    cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
    env: process.env,
    stdio: 'inherit'
  });
  child.on('error', (error) => {
    console.error(`Could not start MongoDB integration tests: ${error.message}`);
    process.exitCode = 1;
  });
  child.on('exit', (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
