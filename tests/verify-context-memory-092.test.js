import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeHarnessTempRoot } from './support/temp-root.js';

const repoRoot = path.resolve('.');
const taskCli = path.resolve('Harness/scripts/task-context.mjs');
const fixtureRoot = path.resolve('tests/fixtures/harness-092/project');
const roots = new Set();

function run(args, cwd = repoRoot) {
  return spawnSync(process.execPath, [taskCli, ...args], { cwd, encoding: 'utf8' });
}

function project() {
  const root = makeHarnessTempRoot('harness-092-verify-red-');
  roots.add(root);
  fs.cpSync(fixtureRoot, root, { recursive: true });
  return root;
}

afterEach(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots.clear();
});

function writeInput(root, name, value) {
  const file = path.join(root, `${name}.json`);
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`, 'utf8');
  return file;
}

test('AC-02/AC-03 canonical task context accepts the frozen path/url evidence shape', () => {
  const root = project();
  const result = run([
    'pack', 'task-context-fixture', '--project', root,
    '--role', 'verifier', '--budget-bytes', '10000', '--json',
  ], root);
  assert.equal(result.status, 0, result.stdout || result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.match(payload.pack, /Current Intent/);
  assert.match(payload.pack, /Next Action/);
});

test('AC-02 first accepted context write must lock original intent before a later update', () => {
  const root = project();
  const statePath = path.join(root, 'Harness/tasks/task-context-fixture/STATE.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.context = {};
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');

  const first = run([
    'update', 'task-context-fixture', '--project', root,
    '--input', writeInput(root, 'first', { context: { intent: { current: 'FIRST_CURRENT' } }, nextAction: 'First' }),
    '--apply', '--json',
  ]);
  if (first.status === 0) {
    const afterFirst = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.ok(afterFirst.context?.intent?.original, 'an accepted first write must establish original');

    const second = run([
      'update', 'task-context-fixture', '--project', root,
      '--input', writeInput(root, 'second', { context: { intent: { original: 'LATE_REPLACEMENT' } }, nextAction: 'Second' }),
      '--apply', '--json',
    ]);
    assert.equal(second.status, 0, second.stdout || second.stderr);
    const finalState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.notEqual(finalState.context.intent.original, 'LATE_REPLACEMENT');
  }
});

test('AC-03 updating an existing scoped entry must not drop its role/work-item guard', () => {
  const root = project();
  const statePath = path.join(root, 'Harness/tasks/task-context-fixture/STATE.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.context.facts.push({
    id: 'scoped-fact',
    text: 'SCOPED_UPDATE_SENTINEL',
    source: 'fixture',
    status: 'verified',
    roles: ['verifier'],
    workItems: ['W-ONLY'],
  });
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');

  const update = run([
    'update', 'task-context-fixture', '--project', root,
    '--input', writeInput(root, 'scoped-update', {
      context: { facts: [{ id: 'scoped-fact', text: 'SCOPED_UPDATE_SENTINEL', source: 'fixture', status: 'verified' }] },
      nextAction: 'Check scope',
    }),
    '--apply', '--json',
  ]);
  assert.equal(update.status, 0, update.stdout || update.stderr);

  const pack = run([
    'pack', 'task-context-fixture', '--project', root, '--role', 'developer',
    '--work-item', 'W-OTHER', '--budget-bytes', '10000', '--json',
  ]);
  assert.equal(pack.status, 0, pack.stdout || pack.stderr);
  assert.doesNotMatch(JSON.parse(pack.stdout).pack, /SCOPED_UPDATE_SENTINEL/);
});
