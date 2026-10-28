import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

export function diagnoseProject({ root = projectRoot, nodeVersion = process.versions.node } = {}) {
  const packagePath = path.join(root, 'package.json');
  const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
  const dependencies = Object.keys(packageJson.dependencies ?? {});
  const missingDependencies = dependencies.filter((name) => {
    try {
      require.resolve(name, { paths: [root] });
      return false;
    } catch {
      return true;
    }
  });
  const majorVersion = Number(nodeVersion.split('.')[0]);
  const checks = [
    {
      id: 'node-version',
      ok: Number.isInteger(majorVersion) && majorVersion >= 22,
      message: `Node.js ${nodeVersion} detected; BETGO requires Node.js 22 or newer.`
    },
    {
      id: 'dependencies',
      ok: missingDependencies.length === 0,
      message: missingDependencies.length === 0
        ? 'All declared production dependencies can be resolved.'
        : `Missing dependencies: ${missingDependencies.join(', ')}. Run npm install with working access to the npm registry.`
    },
    {
      id: 'environment-file',
      ok: existsSync(path.join(root, '.env')),
      message: existsSync(path.join(root, '.env'))
        ? '.env exists; verify secrets are valid and never commit this file.'
        : 'No .env file found. For local setup, copy .env.example to .env and set a unique SESSION_SECRET.'
    },
    {
      id: 'mongodb-config-template',
      ok: existsSync(path.join(root, '.env.example')),
      message: existsSync(path.join(root, '.env.example'))
        ? '.env.example exists.'
        : '.env.example is missing.'
    },
    {
      id: 'betting-safety',
      ok: true,
      message: 'This diagnostic does not activate bookmaker connectors; real bet placement remains disabled.'
    }
  ];

  return Object.freeze({
    ok: checks.every((check) => check.ok),
    missingDependencies,
    checks: Object.freeze(checks.map((check) => Object.freeze(check)))
  });
}

function printReport(report) {
  console.log('BETGO environment diagnostic');
  console.log('');
  for (const check of report.checks) {
    console.log(`${check.ok ? 'PASS' : 'FAIL'} ${check.id}: ${check.message}`);
  }
  console.log('');
  console.log(report.ok ? 'Environment checks passed.' : 'Environment is not ready. Fix the failed checks before starting BETGO.');
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  const report = diagnoseProject();
  printReport(report);
  if (!report.ok) process.exitCode = 1;
}
