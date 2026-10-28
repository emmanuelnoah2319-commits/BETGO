import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnoseProject } from '../scripts/doctor.js';

const root = new URL('..', import.meta.url).pathname;

test('diagnostic reports Node support, environment template and fail-closed betting status', () => {
  const report = diagnoseProject({ root, nodeVersion: '22.1.0' });
  assert.equal(report.checks.find((check) => check.id === 'node-version').ok, true);
  assert.equal(report.checks.find((check) => check.id === 'mongodb-config-template').ok, true);
  assert.match(report.checks.find((check) => check.id === 'betting-safety').message, /remains disabled/);
});

test('diagnostic rejects unsupported Node versions', () => {
  const report = diagnoseProject({ root, nodeVersion: '20.9.0' });
  assert.equal(report.checks.find((check) => check.id === 'node-version').ok, false);
  assert.equal(report.ok, false);
});

test('diagnostic reports missing dependencies without hiding the exact names', () => {
  const report = diagnoseProject({ root, nodeVersion: '22.1.0' });
  const dependencyCheck = report.checks.find((check) => check.id === 'dependencies');
  if (report.missingDependencies.length > 0) {
    assert.equal(dependencyCheck.ok, false);
    for (const dependency of report.missingDependencies) assert.match(dependencyCheck.message, new RegExp(dependency));
  } else {
    assert.equal(dependencyCheck.ok, true);
  }
});
