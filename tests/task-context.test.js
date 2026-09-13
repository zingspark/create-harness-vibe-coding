import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeHarnessTempRoot } from './support/temp-root.js';

const repoRoot = path.resolve('.');
const fixtureRoot = path.resolve('tests/fixtures/harness-092/project');
const script = path.resolve('Harness/scripts/task-context.mjs');
const tempRoots = new Set();

function project(prefix = 'task-context-') {
  const root = makeHarnessTempRoot(prefix);
  tempRoots.add(root);
  fs.cpSync(fixtureRoot, root, { recursive: true });
  return root;
}

after(() => {
  for (const root of tempRoots) fs.rmSync(root, { recursive: true, force: true });
});

function input(root, name, value) {
  const file = path.join(root, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(value), 'utf8');
  return file;
}

function run(root, args) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

function json(result) {
  try {
    return JSON.parse(result.stdout.trim());
  } catch {
    assert.fail(`expected JSON CLI output; status=${result.status}; stdout=${result.stdout}; stderr=${result.stderr}`);
  }
}

function contextPayload(overrides = {}) {
  return {
    context: {
      intent: {
        original: 'Preserve the original context intent',
        current: 'Current intent from the test writer',
        changes: [{ summary: 'Test change', reason: 'AC-02', source: 'test' }],
      },
      constraints: ['Keep the pack bounded', 'Do not read full logs'],
      facts: [{ id: 'fact-test', text: 'A fact from the contract test', source: 'test', status: 'verified' }],
      assumptions: [{ id: 'assumption-test', text: 'A bounded assumption', status: 'open', evidenceRefs: ['E-test'] }],
      decisions: [{ id: 'decision-test', decision: 'Use role-specific context', reason: 'Finite context', rejectedAlternatives: ['All logs'], evidenceRefs: ['E-test'] }],
      evidence: [{ id: 'E-test', path: 'Harness/logs/huge.log', claim: 'Evidence is a pointer', status: 'verified' }],
      attempts: [{ id: 'attempt-test', action: 'Pack context', outcome: 'pending', evidenceRefs: ['E-test'] }],
      handoff: { summary: 'Hand off the bounded context', unresolved: ['Choose final role'] },
      ...overrides.context,
    },
    nextAction: overrides.nextAction ?? 'Run the context pack',
  };
}

test('AC-02 update records the context schema and root nextAction', () => {
  const root = project();
  const file = input(root, 'context-update', contextPayload());
  const result = run(root, ['update', 'task-context-fixture', '--project', root, '--input', file, '--apply', '--json']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const state = JSON.parse(fs.readFileSync(path.join(root, 'Harness/tasks/task-context-fixture/STATE.json'), 'utf8'));
  assert.equal(state.nextAction, 'Run the context pack');
  assert.equal(state.context.intent.current, 'Current intent from the test writer');
  for (const field of ['constraints', 'facts', 'assumptions', 'decisions', 'evidence', 'attempts', 'handoff']) assert.ok(field in state.context);
});

test('AC-02 original intent remains immutable across later updates', () => {
  const root = project();
  const file = input(root, 'immutable-intent', {
    context: { intent: { original: 'MUST NOT REPLACE', current: 'Updated current', changes: [] } },
    nextAction: 'Continue after immutable update',
  });
  const result = run(root, ['update', 'task-context-fixture', '--project', root, '--input', file, '--apply', '--json']);
  const state = JSON.parse(fs.readFileSync(path.join(root, 'Harness/tasks/task-context-fixture/STATE.json'), 'utf8'));
  assert.equal(state.context.intent.original, 'Preserve the original context intent');
  assert.notEqual(state.context.intent.original, 'MUST NOT REPLACE');
  assert.ok(result.status === 0 || result.status === 1);
});

test('AC-02 update without --apply does not write task state', () => {
  const root = project();
  const statePath = path.join(root, 'Harness/tasks/task-context-fixture/STATE.json');
  const before = fs.readFileSync(statePath, 'utf8');
  const file = input(root, 'dry-update', contextPayload({ nextAction: 'Must not persist' }));
  const result = run(root, ['update', 'task-context-fixture', '--project', root, '--input', file, '--json']);
  assert.notEqual(result.status, 0);
  assert.equal(fs.readFileSync(statePath, 'utf8'), before);
});

test('AC-02 show reads legacy task goal and nextAction when context is absent', () => {
  const root = project();
  const result = run(root, ['show', 'legacy-task', '--project', root, '--json']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = json(result);
  const text = JSON.stringify(output);
  assert.match(text, /Migrate the legacy context task/);
  assert.match(text, /Resume legacy task/);
});

test('AC-03 pack is role-scoped, pointer-based, and excludes evidence body contents', () => {
  const root = project();
  fs.mkdirSync(path.join(root, 'Harness/logs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'Harness/logs/huge.log'), 'SECRET_LOG_BODY\n'.repeat(1000), 'utf8');
  const result = run(root, ['pack', 'task-context-fixture', '--project', root, '--role', 'test-writer', '--budget-bytes', '2400', '--json']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = json(result);
  assert.equal(output.taskId, 'task-context-fixture');
  assert.equal(output.role, 'test-writer');
  assert.equal(typeof output.pack, 'string');
  assert.ok(Array.isArray(output.references));
  assert.ok(!output.pack.includes('SECRET_LOG_BODY'));
  assert.match(output.pack, /Preserve the current context intent/);
  assert.match(output.pack, /Keep the pack bounded/);
  assert.match(output.pack, /Confirm the final byte budget/);
  assert.match(output.pack, /Review the context pack/);
});

test('AC-03 pack UTF-8 bytes stay within budget and identical input has stable hash', () => {
  const root = project();
  const args = ['pack', 'task-context-fixture', '--project', root, '--role', 'verifier', '--budget-bytes', '1800', '--json'];
  const first = run(root, args);
  const second = run(root, args);
  assert.equal(first.status, 0, first.stderr || first.stdout);
  assert.equal(second.status, 0, second.stderr || second.stdout);
  const a = json(first);
  const b = json(second);
  assert.equal(a.hash, b.hash);
  assert.ok(Buffer.byteLength(a.pack, 'utf8') <= a.budget.limitBytes);
  assert.equal(a.budget.usedBytes, Buffer.byteLength(a.pack, 'utf8'));
});

test('AC-03 pack reports an explicit error when minimum required context cannot fit', () => {
  const root = project();
  const result = run(root, ['pack', 'task-context-fixture', '--project', root, '--role', 'test-writer', '--budget-bytes', '32', '--json']);
  assert.notEqual(result.status, 0);
  const output = json(result);
  assert.match(JSON.stringify(output), /budget|fit|minimum|required/i);
});

test('AC-02 task-context rejects path traversal and writes no escaped task', () => {
  const root = project();
  const escaped = path.join(path.dirname(root), 'context-escape', 'STATE.json');
  const file = input(root, 'escape', contextPayload());
  const result = run(root, ['update', '../context-escape', '--project', root, '--input', file, '--apply', '--json']);
  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(escaped), false);
});
