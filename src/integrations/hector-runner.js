import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';

const STATUS = new Set(['accepted', 'confirmed', 'placed', 'rejected', 'declined', 'ambiguous', 'unknown', 'pending', 'submitting']);

function parseResult(stdout, exitCode) {
  const lines = String(stdout || '').trim().split(/\r?\n/).filter(Boolean);
  let parsed = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    try { parsed = JSON.parse(lines[i]); break; } catch {}
  }
  if (!parsed && lines.length) {
    try { parsed = JSON.parse(lines.join('\n')); } catch {}
  }
  const raw = String(parsed?.status ?? parsed?.result?.status ?? parsed?.outcome ?? '').toLowerCase();
  if (['accepted', 'confirmed', 'placed'].includes(raw) || parsed?.accepted === true || parsed?.confirmed === true) return { status: 'accepted', providerReference: safeReference(parsed) };
  if (['rejected', 'declined'].includes(raw) || parsed?.accepted === false && parsed?.rejected === true) return { status: 'rejected', providerReference: safeReference(parsed) };
  if (STATUS.has(raw) || exitCode !== 0) return { status: 'unknown', providerReference: null };
  return { status: 'unknown', providerReference: null };
}

function safeReference(parsed) {
  const value = parsed?.orderId ?? parsed?.order_id ?? parsed?.betId ?? parsed?.reference ?? parsed?.result?.orderId ?? null;
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value) ? value : null;
}

export async function runHectorSingleBet({ binary = 'hector', cookie, instruction, accountId, timeoutMs = 20000, journalDir = path.join(os.homedir(), '.local', 'state', 'betgo', 'hector') }) {
  if (!cookie || typeof cookie !== 'string') throw new TypeError('SportyBet session cookie is required.');
  if (!instruction?.eventId || !instruction?.marketId || !instruction?.outcomeId || !Number.isFinite(instruction.oddsDecimal) || instruction.oddsDecimal <= 1) {
    throw new TypeError('A validated single-selection instruction is required.');
  }
  const stake = (instruction.stakeMinor / 100).toFixed(2);
  const probability = (1 / instruction.oddsDecimal).toFixed(8);
  try { await mkdir(journalDir, { recursive: true, mode: 0o700 }); } catch { return { status: 'unknown', providerReference: null }; }
  const args = ['--json', 'bet', 'single', '--event-id', instruction.eventId, '--sport-id', 'sr:sport:1', '--product-id', '3', '--market-id', instruction.marketId, '--outcome-id', instruction.outcomeId, '--odds', instruction.oddsDecimal.toFixed(2), '--probability', probability, '--stake', stake, '--payment-type', '0', '--execute', '--confirm-order', '--max-stake', stake];
  return new Promise((resolve) => {
    let stdout = '';
    let settled = false;
    const finish = (result) => { if (settled) return; settled = true; clearTimeout(timer); resolve(result); };
    let child;
    let timer;
    try {
      child = spawn(binary, args, {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...process.env, SPORTYBET_COOKIE: cookie, HECTOR_JOURNAL_PATH: path.join(journalDir, `account-${accountId}.jsonl`), NO_COLOR: '1' }
      });
    } catch { return finish({ status: 'unknown', providerReference: null }); }
    timer = setTimeout(() => { child.kill('SIGKILL'); finish({ status: 'unknown', providerReference: null }); }, timeoutMs);
    child.stdout.on('data', (chunk) => { if (stdout.length < 1024 * 1024) stdout += chunk.toString('utf8').slice(0, 1024 * 1024 - stdout.length); });
    child.on('error', () => finish({ status: 'unknown', providerReference: null }));
    child.on('close', (code) => finish(parseResult(stdout, code)));
  });
}
