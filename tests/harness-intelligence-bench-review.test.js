import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { scoreRun } from '../scripts/harness-intelligence-bench.mjs';
import { makeHarnessTempRoot } from './support/temp-root.js';

const roots = new Set();

function tempRoot(prefix = 'harness-intelligence-092-review-') {
  const root = makeHarnessTempRoot(prefix);
  roots.add(root);
  return root;
}

afterEach(() => {
  for (const root of roots) {
    const resolved = path.resolve(root);
    const allowed = path.resolve('Harness', '.temp') + path.sep;
    assert.ok(resolved.startsWith(allowed), `refusing to remove non-temp root: ${root}`);
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
  roots.clear();
});

function hashFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function evidence(file, source = 'independent reviewer fixture') {
  return { source, path: file, sha256: hashFile(file) };
}

function writeJsonLines(file, values) {
  fs.writeFileSync(file, `${values.map(value => JSON.stringify(value)).join('\n')}\n`);
}

test('AC-09 reviewer RED/HIGH: B3 binds ACK and RESULT to the current retry attempt', () => {
  const root = tempRoot();
  const resultPath = path.join(root, 'result.txt');
  const eventsPath = path.join(root, 'events.jsonl');
  const effectsPath = path.join(root, 'effects.jsonl');
  const executionPath = path.join(root, 'execution.log');
  fs.writeFileSync(resultPath, 'one result\n');
  writeJsonLines(eventsPath, [
    { seq: 1, kind: 'request', dispatchId: 'dispatch-1', requestId: 'request-1', attempt: 1 },
    { seq: 2, kind: 'ack', dispatchId: 'dispatch-1', requestId: 'request-1', replyTo: 'request-1', attempt: 1 },
    { seq: 3, kind: 'cancelled', status: 'cancelled', dispatchId: 'dispatch-1', requestId: 'request-1', replyTo: 'request-1', attempt: 1 },
    { seq: 4, kind: 'request', dispatchId: 'dispatch-1', requestId: 'request-2', attempt: 2 },
    // The retry has no ACK. Its failed and successful terminal messages point
    // at the cancelled first request, not at request-2/current attempt 2.
    { seq: 5, kind: 'failed', status: 'failed', dispatchId: 'dispatch-1', requestId: 'request-2', replyTo: 'request-1', attempt: 2 },
    { seq: 6, kind: 'result', status: 'succeeded', dispatchId: 'dispatch-1', requestId: 'request-2', replyTo: 'request-1', attempt: 2 },
  ]);
  writeJsonLines(effectsPath, [
    { kind: 'dispatch', dispatchId: 'dispatch-1', requestId: 'request-1', idempotencyKey: 'once' },
    { kind: 'dispatch', dispatchId: 'dispatch-1', requestId: 'request-2', idempotencyKey: 'once' },
    { kind: 'write', path: resultPath, sha256: hashFile(resultPath) },
  ]);
  fs.writeFileSync(executionPath, 'source runtime codex; target runtime claude; model Luna; effort xhigh\n');

  const report = scoreRun({
    isolatedRoot: root,
    evidenceRoot: root,
    duplicateSideEffects: 0,
    categories: {
      B3: {
        eventsEvidence: evidence(eventsPath),
        sideEffectsEvidence: evidence(effectsPath),
        executionEvidence: evidence(executionPath),
        retry: { explicit: true, attempt: 2 },
        resultPath,
        resultSha256: hashFile(resultPath),
      },
    },
  });

  assert.notEqual(
    report.categories.B3.status,
    'pass',
    'B3 must reject a retry whose ACK/RESULT is not bound to the current request/attempt',
  );
});

test('AC-09 reviewer RED/HIGH: B4 restores effective rule state without deleting append-only audit history', () => {
  const root = tempRoot();
  const beforePath = path.join(root, 'state-before.json');
  const restoredPath = path.join(root, 'state-restored.json');
  const tracePath = path.join(root, 'trace.jsonl');
  const feedbackPath = path.join(root, 'feedback.jsonl');
  const before = {
    rules: [{ id: 'rule-1', scope: 'project', status: 'active' }],
    audit: [{ id: 'audit-0', kind: 'teach', ruleId: 'rule-1' }],
  };
  const restored = {
    rules: [{ id: 'rule-1', scope: 'project', status: 'active' }],
    // A valid restore appends the counterexample/supersede/restore history;
    // deleting these entries to make the whole document byte-identical is
    // forbidden by the benchmark's non-destructive audit requirement.
    audit: [
      ...before.audit,
      { id: 'audit-1', kind: 'counterexample', ruleId: 'rule-1' },
      { id: 'audit-2', kind: 'restore', ruleId: 'rule-1' },
    ],
  };
  fs.writeFileSync(beforePath, `${JSON.stringify(before)}\n`);
  fs.writeFileSync(restoredPath, `${JSON.stringify(restored)}\n`);
  writeJsonLines(tracePath, [
    { kind: 'teach', ruleId: 'rule-1', scope: 'project' },
    { kind: 'scene', sceneId: 'scene-new', applies: false },
    { kind: 'skip', ruleId: 'rule-1', scope: 'project', applies: false, unrelatedRulesEligible: true },
    { kind: 'counterexample', ruleId: 'rule-1', evidenceRef: 'counterexample-1' },
    { kind: 'supersede', ruleId: 'rule-1', replacementId: 'rule-2' },
    { kind: 'restore', ruleId: 'rule-1' },
    { kind: 'feedback', ruleId: 'rule-1', outcome: 'useful' },
  ]);
  fs.writeFileSync(feedbackPath, '{"ruleId":"rule-1","outcome":"useful","evidence":"feedback-1"}\n');

  assert.notEqual(hashFile(beforePath), hashFile(restoredPath), 'audit history is intentionally append-only');
  assert.deepEqual(restored.rules, before.rules, 'the effective rule projection is restored');

  const report = scoreRun({
    isolatedRoot: root,
    evidenceRoot: root,
    categories: {
      B4: {
        ruleId: 'rule-1',
        scope: 'project',
        traceEvidence: evidence(tracePath),
        stateBeforeEvidence: evidence(beforePath),
        stateRestoredEvidence: evidence(restoredPath),
        feedbackEvidence: evidence(feedbackPath),
      },
    },
  });

  assert.equal(
    report.categories.B4.status,
    'pass',
    `B4 should compare the effective rule state and preserve audit history; got ${report.categories.B4.code}: ${report.categories.B4.message}`,
  );
});

test('AC-09 reviewer RED/HIGH: B6 cannot accept a fake screenshot from a PNG header alone', () => {
  const root = tempRoot();
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  const statePath = path.join(project, 'canonical-state.json');
  const backendPath = path.join(root, 'backend.json');
  const uiPath = path.join(root, 'ui.json');
  const screenshotPath = path.join(root, 'screenshot.png');
  fs.writeFileSync(statePath, '{"taskId":"task-1","status":"running"}\n');
  // This is only the PNG signature, not a decodable screenshot.
  fs.writeFileSync(screenshotPath, Buffer.from([137, 80, 78, 71]));
  const stateSha = hashFile(statePath);
  const backend = {
    projectRoot: project,
    taskId: 'task-1',
    url: 'http://127.0.0.1:3210',
    startedFromCli: true,
    openBrowser: false,
    lock: { mode: 'started', acquired: true },
    canonicalStatePath: statePath,
    canonicalStateSha256: stateSha,
  };
  const ui = {
    projectRoot: project,
    taskId: 'task-1',
    url: backend.url,
    observedAfterCli: true,
    canonicalStatePath: statePath,
    canonicalStateSha256: stateSha,
    api: { projectRoot: project, taskId: 'task-1' },
  };
  fs.writeFileSync(backendPath, `${JSON.stringify(backend)}\n`);
  fs.writeFileSync(uiPath, `${JSON.stringify(ui)}\n`);

  const report = scoreRun({
    isolatedRoot: root,
    evidenceRoot: root,
    categories: {
      B6: {
        backendEvidence: evidence(backendPath),
        uiEvidence: evidence(uiPath),
        canonicalStateEvidence: evidence(statePath),
        screenshotEvidence: evidence(screenshotPath),
      },
    },
  });

  assert.notEqual(
    report.categories.B6.status,
    'pass',
    'B6 must reject an undecodable signature-only image and require real browser evidence',
  );
});

test('AC-09 reviewer GREEN: B2 public prompts do not leak the fixed oracle or cripple the baseline', () => {
  const fixture = path.resolve('benchmarks/harness-intelligence-092/b2');
  const stage1 = fs.readFileSync(path.join(fixture, 'stage1-user-prompt.md'), 'utf8');
  const stage2 = fs.readFileSync(path.join(fixture, 'stage2-user-prompt.md'), 'utf8');
  const baseline = fs.readFileSync(path.join(fixture, 'baseline-handoff.md'), 'utf8');
  for (const text of [stage1, stage2, baseline]) {
    assert.doesNotMatch(text, /\b(?:1350|1800)\b/, 'public prompt leaked an oracle answer');
  }
  assert.match(stage2, /--exclude-refunds/);
  assert.match(baseline, /--exclude-refunds/);
  assert.match(baseline, /same-model, same-runtime, same-effort/);
  assert.match(baseline, /`b2\/data\.json`/);
});
