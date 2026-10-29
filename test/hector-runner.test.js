import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runHectorSingleBet } from '../src/integrations/hector-runner.js';

test('Hector adapter constructs a single-selection guarded command without shell execution', async () => {
  const source = await readFile(new URL('../src/integrations/hector-runner.js', import.meta.url), 'utf8');
  assert.match(source, /shell:\s*false/);
  assert.match(source, /'--execute', '--confirm-order', '--max-stake'/);
  assert.match(source, /SPORTYBET_COOKIE:\s*cookie/);
});

test('Hector adapter validates required wager identifiers before spawning', async () => {
  await assert.rejects(() => runHectorSingleBet({ cookie: 'sid=abcdefghijklmnopqrstuvwxyz1234567890', instruction: { stakeMinor: 500, oddsDecimal: 2 }, accountId: 'abc' }), /validated single-selection/);
});

test('Hector adapter classifies explicit provider confirmation and never returns raw output', async () => {
  const { mkdtemp, writeFile, chmod, rm } = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'betgo-hector-test-'));
  const binary = path.join(directory, 'fake-hector');
  try {
    await writeFile(binary, '#!/usr/bin/env node\nconsole.log(JSON.stringify({status:"accepted",orderId:"abc_123",secret:"must-not-return"}));\n');
    await chmod(binary, 0o700);
    const result = await runHectorSingleBet({
      binary,
      cookie: 'sid=abcdefghijklmnopqrstuvwxyz1234567890',
      instruction: { eventId: 'sr:match:123456', marketId: '1', outcomeId: '1', oddsDecimal: 2.1, stakeMinor: 500 },
      accountId: 'account-1',
      journalDir: path.join(directory, 'journal')
    });
    assert.deepEqual(result, { status: 'accepted', providerReference: 'abc_123' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Hector adapter classifies unrecognized output as unknown', async () => {
  const { mkdtemp, writeFile, chmod, rm } = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'betgo-hector-unknown-'));
  const binary = path.join(directory, 'fake-hector');
  try {
    await writeFile(binary, '#!/usr/bin/env node\nconsole.log(JSON.stringify({status:"completed"}));\n');
    await chmod(binary, 0o700);
    const result = await runHectorSingleBet({
      binary,
      cookie: 'sid=abcdefghijklmnopqrstuvwxyz1234567890',
      instruction: { eventId: 'sr:match:123456', marketId: '1', outcomeId: '1', oddsDecimal: 2.1, stakeMinor: 500 },
      accountId: 'account-1',
      journalDir: path.join(directory, 'journal')
    });
    assert.deepEqual(result, { status: 'unknown', providerReference: null });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
