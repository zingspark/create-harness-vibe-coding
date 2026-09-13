import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { scoreRun } from '../scripts/harness-intelligence-bench.mjs';
import { makeHarnessTempRoot } from './support/temp-root.js';

const roots = new Set();

function tempRoot(prefix = 'harness-intelligence-092-test-') {
  const root = makeHarnessTempRoot(prefix);
  roots.add(root);
  return root;
}

afterEach(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots.clear();
});

function hashFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function evidence(file, source = 'fresh isolated run') {
  return { source, path: file, sha256: hashFile(file) };
}

test('AC-04 regression: a not-applicable B4 skip cannot satisfy the frozen learning scenario', () => {
  const report = scoreRun({
    categories: {
      B4: {
        status: 'skip',
        notApplicable: true,
        reason: 'Memory learning is not applicable to this benchmark runner.',
      },
    },
  });

  assert.equal(report.categories.B4.status, 'fail', 'old oracle incorrectly accepted whole-category B4 skip');
  assert.equal(report.categories.B4.code, 'B4_REQUIRED');
});

test('AC-09 fixture keeps B4 required and sealed holdout absent', async () => {
  const { validateFixture } = await import('../scripts/harness-intelligence-bench.mjs');
  const result = validateFixture();
  assert.equal(result.ok, true, result.message);
  assert.equal(result.evidence?.files.includes('b4/user-prompt.md'), true);
});

test('AC-07 self-reported B1/B3/B5/B6 JSON cannot pass without raw artifacts', () => {
  const root = tempRoot();
  const report = scoreRun({
    isolatedRoot: root,
    evidenceRoot: root,
    categories: {
      B1: { installedRoot: root, sentinelPath: path.join(root, 'sentinel.txt'), installedArtifactPath: path.join(root, 'artifact.js') },
      B3: { eventsPath: path.join(root, 'events.json'), sideEffectsPath: path.join(root, 'effects.json'), retry: { explicit: true, attempt: 2 } },
      B5: { lookupPerformed: true, sources: [{ url: 'https://github.com/example/project', version: '1', license: 'MIT', decision: 'adapt', evidence: 'claimed', recheckTrigger: 'never' }] },
      B6: { backend: { projectRoot: root, taskId: 'task', url: 'http://127.0.0.1:1', startedFromCli: true, openBrowser: false }, ui: { projectRoot: root, taskId: 'task', observedAfterCli: true, apiAgreement: true } },
    },
  });
  for (const id of ['B1', 'B3', 'B5', 'B6']) assert.notEqual(report.categories[id].status, 'pass', `${id} must not accept hand-filled claims`);
  assert.equal(report.status, 'fail');
});

test('AC-04 B4 accepts only the scoped teach/skip/counterexample/supersede/restore/feedback trace', () => {
  const root = tempRoot();
  const before = path.join(root, 'before.json');
  const restored = path.join(root, 'restored.json');
  const trace = path.join(root, 'trace.jsonl');
  const feedback = path.join(root, 'feedback.jsonl');
  fs.writeFileSync(before, JSON.stringify({
    rules: [{ id: 'rule-1', scope: 'project', status: 'active' }],
    audit: [{ id: 'audit-0', kind: 'teach', ruleId: 'rule-1' }],
  }) + '\n');
  fs.writeFileSync(restored, JSON.stringify({
    rules: [{ id: 'rule-1', scope: 'project', status: 'active' }],
    audit: [
      { id: 'audit-0', kind: 'teach', ruleId: 'rule-1' },
      { id: 'audit-1', kind: 'counterexample', ruleId: 'rule-1' },
      { id: 'audit-2', kind: 'restore', ruleId: 'rule-1' },
    ],
  }) + '\n');
  fs.writeFileSync(trace, [
    { kind: 'teach', ruleId: 'rule-1', scope: 'project' },
    { kind: 'scene', sceneId: 'scene-new', applies: false },
    { kind: 'skip', ruleId: 'rule-1', scope: 'project', applies: false, unrelatedRulesEligible: true },
    { kind: 'counterexample', ruleId: 'rule-1', evidenceRef: 'counterexample-1' },
    { kind: 'supersede', ruleId: 'rule-1', replacementId: 'rule-2' },
    { kind: 'restore', ruleId: 'rule-1' },
    { kind: 'feedback', ruleId: 'rule-1', outcome: 'useful' },
  ].map(item => `${JSON.stringify(item)}\n`).join(''));
  fs.writeFileSync(feedback, JSON.stringify({ ruleId: 'rule-1', outcome: 'useful', evidence: 'feedback-1' }) + '\n');
  const spec = {
    ruleId: 'rule-1',
    scope: 'project',
    traceEvidence: evidence(trace),
    stateBeforeEvidence: evidence(before),
    stateRestoredEvidence: evidence(restored),
    feedbackEvidence: evidence(feedback),
  };
  const report = scoreRun({ isolatedRoot: root, evidenceRoot: root, categories: { B4: spec } });
  assert.equal(report.categories.B4.status, 'pass', report.categories.B4.message);
  assert.equal(report.categories.B4.evidence.mechanical, 'pass');
});

test('AC-04 pending independent review blocks overall pass even after mechanical evidence', () => {
  const report = scoreRun({
    isolatedRoot: tempRoot(),
    evidenceRoot: tempRoot(),
    independentReview: { status: 'pending' },
    categories: { B4: { status: 'skip', notApplicable: true } },
  });
  assert.equal(report.independentReview.status, 'pending');
  assert.equal(report.status, 'fail');
});

test('AC-07 B2 still executes the fixed 1350/1800 public oracle with strict stdout', () => {
  const root = tempRoot();
  const data = path.join(root, 'data.json');
  const cli = path.join(root, 'billing-cli.mjs');
  fs.writeFileSync(data, JSON.stringify({ records: [{ id: 'a', amountMinor: 1200, currency: 'CNY' }, { id: 'b', amountMinor: 600, currency: 'CNY' }, { id: 'r', amountMinor: -450, currency: 'CNY' }] }) + '\n');
  fs.writeFileSync(cli, `import fs from 'node:fs';\nconst data=JSON.parse(fs.readFileSync(process.argv[2]));\nconst exclude=process.argv.includes('--exclude-refunds');\nconst total=data.records.filter(r=>!exclude||r.amountMinor>=0).reduce((sum,r)=>sum+r.amountMinor,0);\nprocess.stdout.write(JSON.stringify({currency:'CNY',totalMinor:total}));\n`);
  const report = scoreRun({ isolatedRoot: root, evidenceRoot: root, categories: { B2: { cliPath: cli, dataPath: data } } });
  assert.equal(report.categories.B2.status, 'pass', report.categories.B2.message);
  assert.deepEqual(report.categories.B2.evidence.noFlag, { currency: 'CNY', totalMinor: 1350 });
  assert.deepEqual(report.categories.B2.evidence.excludeRefunds, { currency: 'CNY', totalMinor: 1800 });
});

test('AC-07 B1/B3/B5/B6 mechanical checks require and consume real artifact bytes', () => {
  const root = tempRoot();
  const installed = path.join(root, 'installed');
  const project = path.join(root, 'project');
  fs.mkdirSync(installed);
  fs.mkdirSync(project);

  const sentinel = path.join(installed, 'sentinel.txt');
  const artifact = path.join(installed, 'artifact.js');
  const archive = path.join(root, 'candidate.tgz');
  const receipt = path.join(root, 'install-receipt.json');
  const installLog = path.join(root, 'install.log');
  fs.copyFileSync(path.resolve('benchmarks/harness-intelligence-092/b1/sentinel.txt'), sentinel);
  fs.writeFileSync(artifact, 'installed artifact\n');
  fs.writeFileSync(archive, 'candidate package bytes\n');
  const sourceSha = 'a'.repeat(40);
  const packageHash = hashFile(archive);
  fs.writeFileSync(receipt, JSON.stringify({ sourceSha, packageHash, packageArchivePath: archive, packageArchiveSha256: packageHash, installedRoot: installed, sentinelPath: sentinel, installedArtifactPath: artifact, artifactSha256: hashFile(artifact), sentinelSha256: hashFile(sentinel), files: ['artifact.js'] }) + '\n');
  fs.writeFileSync(installLog, `install source=${sourceSha} package=${packageHash}\n`);

  const result = path.join(project, 'result.txt');
  fs.writeFileSync(result, 'one result\n');
  const events = path.join(root, 'events.jsonl');
  const sessionId = 'session-b3';
  const retrySession = 'session-b3-retry';
  fs.writeFileSync(events, [
    { seq: 1, kind: 'request', dispatchId: 'cancel', taskId: 'task-b3', sessionId: 'session-cancel', requestId: 'cancel-1', attempt: 1 },
    { seq: 2, kind: 'ack', dispatchId: 'cancel', taskId: 'task-b3', sessionId: 'session-cancel', requestId: 'cancel-1', replyTo: 'cancel-1', attempt: 1 },
    { seq: 3, kind: 'cancelled', status: 'cancelled', dispatchId: 'cancel', taskId: 'task-b3', sessionId: 'session-cancel', requestId: 'cancel-1', replyTo: 'cancel-1', attempt: 1 },
    { seq: 4, kind: 'request', dispatchId: 'd', taskId: 'task-b3', sessionId, requestId: 'r1', attempt: 1 },
    { seq: 5, kind: 'ack', dispatchId: 'd', taskId: 'task-b3', sessionId, requestId: 'r1', replyTo: 'r1', attempt: 1 },
    { seq: 6, kind: 'failed', status: 'failed', dispatchId: 'd', taskId: 'task-b3', sessionId, requestId: 'r1', replyTo: 'r1', attempt: 1 },
    { seq: 7, kind: 'request', dispatchId: 'd', taskId: 'task-b3', sessionId: retrySession, requestId: 'r1', attempt: 2 },
    { seq: 8, kind: 'ack', dispatchId: 'd', taskId: 'task-b3', sessionId: retrySession, requestId: 'r1', replyTo: 'r1', attempt: 2 },
    { seq: 9, kind: 'result', status: 'succeeded', dispatchId: 'd', taskId: 'task-b3', sessionId: retrySession, requestId: 'r1', replyTo: 'r1', attempt: 2 },
  ].map(item => `${JSON.stringify(item)}\n`).join(''));
  const effects = path.join(root, 'effects.jsonl');
  fs.writeFileSync(effects, [
    { kind: 'dispatch', dispatchId: 'cancel', idempotencyKey: 'cancel-key', taskId: 'task-b3', sessionId: 'session-cancel', requestId: 'cancel-1', attempt: 1 },
    { kind: 'dispatch', dispatchId: 'd', idempotencyKey: 'k', taskId: 'task-b3', sessionId, requestId: 'r1', attempt: 1 },
    { kind: 'dispatch', dispatchId: 'd', idempotencyKey: 'k', taskId: 'task-b3', sessionId: retrySession, requestId: 'r1', attempt: 2 },
    { kind: 'write', dispatchId: 'd', taskId: 'task-b3', path: result, sha256: hashFile(result), sessionId: retrySession, requestId: 'r1', attempt: 2 },
  ].map(item => `${JSON.stringify(item)}\n`).join(''));
  const execution = path.join(root, 'execution.log');
  fs.writeFileSync(execution, 'source runtime codex; target runtime claude; model Luna; effort xhigh\n');

  const prompt = path.join(root, 'csv-task.md');
  const csv = path.join(root, 'input.csv');
  const lookup = path.join(root, 'lookup.log');
  const capture = path.join(root, 'source.md');
  const decision = path.join(root, 'decision.log');
  fs.writeFileSync(prompt, 'Parse the CSV input and produce a report.\n');
  fs.writeFileSync(csv, 'id,amount\na,1\n');
  fs.writeFileSync(lookup, 'lookup https://github.com/example/csv-parser\n');
  fs.writeFileSync(capture, '# csv parser source\n');
  fs.writeFileSync(decision, 'adapt because the API fits; recheck on version change\n');

  const state = path.join(project, 'canonical-state.json');
  const screenshot = path.join(root, 'ui.png');
  fs.writeFileSync(state, '{"taskId":"task-1","status":"running"}\n');
  // A complete 1x1 PNG, not merely a signature: the scorer decodes the
  // chunks, CRCs, and inflated scanline before accepting visual evidence.
  fs.writeFileSync(screenshot, Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  ));
  const backend = path.join(root, 'backend.json');
  const ui = path.join(root, 'ui.json');
  const stateSha = hashFile(state);
  fs.writeFileSync(backend, JSON.stringify({ projectRoot: project, taskId: 'task-1', url: 'http://127.0.0.1:3210', startedFromCli: true, openBrowser: false, lock: { mode: 'started', acquired: true }, canonicalStatePath: state, canonicalStateSha256: stateSha }) + '\n');
  fs.writeFileSync(ui, JSON.stringify({ projectRoot: project, taskId: 'task-1', url: 'http://127.0.0.1:3210', observedAfterCli: true, canonicalStatePath: state, canonicalStateSha256: stateSha, api: { projectRoot: project, taskId: 'task-1' } }) + '\n');

  const report = scoreRun({
    sourceSha,
    packageHash,
    isolatedRoot: root,
    evidenceRoot: root,
    duplicateSideEffects: 0,
    categories: {
      B1: { installedRoot: installed, sentinelPath: sentinel, sentinelSha256: hashFile(sentinel), installedArtifactPath: artifact, installedArtifactSha256: hashFile(artifact), packageArchiveEvidence: evidence(archive), installReceipt: evidence(receipt), installLog: evidence(installLog) },
      B3: { eventsEvidence: evidence(events), sideEffectsEvidence: evidence(effects), executionEvidence: evidence(execution), taskId: 'task-b3', retry: { explicit: true, dispatchId: 'd', attempt: 2, requestId: 'r1', sessionId: retrySession, taskId: 'task-b3' }, resultPath: result, resultSha256: hashFile(result) },
      B5: { lookupPerformed: true, task: { requiresCsvParsing: true, promptEvidence: evidence(prompt), csvInputEvidence: evidence(csv) }, lookupEvidence: evidence(lookup), decisionEvidence: evidence(decision), sources: [{ url: 'https://github.com/example/csv-parser', version: '1.0.0', license: 'MIT', decision: 'adapt', decisionReason: 'API fits', recheckTrigger: 'version change', captureEvidence: evidence(capture) }] },
      B6: { backendEvidence: evidence(backend), uiEvidence: evidence(ui), canonicalStateEvidence: evidence(state), screenshotEvidence: evidence(screenshot) },
    },
  });
  for (const id of ['B1', 'B3', 'B5', 'B6']) assert.equal(report.categories[id].status, 'pass', `${id}: ${report.categories[id].message}`);
});

test('AC-09 B3 accepts an independent cancellation dispatch and one retried dispatch in a new session', () => {
  const root = tempRoot();
  const result = path.join(root, 'result.txt');
  fs.writeFileSync(result, 'retried result\n');
  const events = path.join(root, 'events.jsonl');
  const rows = [
    { seq: 1, kind: 'request', dispatchId: 'dispatch-cancel', sessionId: 'session-cancel', requestId: 'request-cancel', replyTo: 'request-cancel', attempt: 1 },
    { seq: 2, kind: 'ack', dispatchId: 'dispatch-cancel', sessionId: 'session-cancel', requestId: 'request-cancel', replyTo: 'request-cancel', attempt: 1 },
    { seq: 3, kind: 'cancelled', status: 'cancelled', dispatchId: 'dispatch-cancel', sessionId: 'session-cancel', requestId: 'request-cancel', replyTo: 'request-cancel', attempt: 1 },
    { seq: 4, kind: 'request', dispatchId: 'dispatch-retry', sessionId: 'session-first', requestId: 'request-retry', replyTo: 'request-retry', attempt: 1 },
    { seq: 5, kind: 'ack', dispatchId: 'dispatch-retry', sessionId: 'session-first', requestId: 'request-retry', replyTo: 'request-retry', attempt: 1 },
    { seq: 6, kind: 'failed', status: 'failed', dispatchId: 'dispatch-retry', sessionId: 'session-first', requestId: 'request-retry', replyTo: 'request-retry', attempt: 1 },
    { seq: 7, kind: 'request', dispatchId: 'dispatch-retry', sessionId: 'session-retry', requestId: 'request-retry', replyTo: 'request-retry', attempt: 2 },
    { seq: 8, kind: 'ack', dispatchId: 'dispatch-retry', sessionId: 'session-retry', requestId: 'request-retry', replyTo: 'request-retry', attempt: 2 },
    { seq: 9, kind: 'result', status: 'succeeded', dispatchId: 'dispatch-retry', sessionId: 'session-retry', requestId: 'request-retry', replyTo: 'request-retry', attempt: 2 },
  ];
  fs.writeFileSync(events, rows.map(row => `${JSON.stringify(row)}\n`).join(''));
  const effects = path.join(root, 'effects.jsonl');
  fs.writeFileSync(effects, [
    { kind: 'dispatch', dispatchId: 'dispatch-cancel', idempotencyKey: 'idempotency-cancel', sessionId: 'session-cancel', requestId: 'request-cancel', attempt: 1 },
    { kind: 'dispatch', dispatchId: 'dispatch-retry', idempotencyKey: 'idempotency-retry', sessionId: 'session-first', requestId: 'request-retry', attempt: 1 },
    { kind: 'dispatch', dispatchId: 'dispatch-retry', idempotencyKey: 'idempotency-retry', sessionId: 'session-retry', requestId: 'request-retry', attempt: 2 },
    { kind: 'write', path: result, sha256: hashFile(result), sessionId: 'session-retry', requestId: 'request-retry', attempt: 2 },
  ].map(row => `${JSON.stringify(row)}\n`).join(''));
  const execution = path.join(root, 'execution.log');
  fs.writeFileSync(execution, 'requested runtime codex; target runtime claude; model gpt-5.6-luna; effort xhigh\n');

  const report = scoreRun({
    isolatedRoot: root,
    evidenceRoot: root,
    duplicateSideEffects: 0,
    categories: {
      B3: {
        eventsEvidence: evidence(events),
        sideEffectsEvidence: evidence(effects),
        executionEvidence: evidence(execution),
        retry: { explicit: true, dispatchId: 'dispatch-retry', attempt: 2, requestId: 'request-retry', sessionId: 'session-retry' },
        resultPath: result,
        resultSha256: hashFile(result),
      },
    },
  });
  assert.equal(report.categories.B3.status, 'pass', report.categories.B3.message);
  assert.equal(report.categories.B3.evidence.dispatchId, 'dispatch-retry');
  assert.equal(report.categories.B3.evidence.sessionId, 'session-retry');
});

test('AC-09 B3 rejects a retry event with a stale replyTo even when the dispatch shape is valid', () => {
  const root = tempRoot();
  const result = path.join(root, 'result.txt');
  fs.writeFileSync(result, 'retried result\n');
  const events = path.join(root, 'events.jsonl');
  fs.writeFileSync(events, [
    { seq: 1, kind: 'request', dispatchId: 'dispatch-cancel', sessionId: 'session-cancel', requestId: 'request-cancel', replyTo: 'request-cancel', attempt: 1 },
    { seq: 2, kind: 'ack', dispatchId: 'dispatch-cancel', sessionId: 'session-cancel', requestId: 'request-cancel', replyTo: 'request-cancel', attempt: 1 },
    { seq: 3, kind: 'cancelled', status: 'cancelled', dispatchId: 'dispatch-cancel', sessionId: 'session-cancel', requestId: 'request-cancel', replyTo: 'request-cancel', attempt: 1 },
    { seq: 4, kind: 'request', dispatchId: 'dispatch-retry', sessionId: 'session-first', requestId: 'request-retry', replyTo: 'request-retry', attempt: 1 },
    { seq: 5, kind: 'ack', dispatchId: 'dispatch-retry', sessionId: 'session-first', requestId: 'request-retry', replyTo: 'request-retry', attempt: 1 },
    { seq: 6, kind: 'failed', status: 'failed', dispatchId: 'dispatch-retry', sessionId: 'session-first', requestId: 'request-retry', replyTo: 'request-retry', attempt: 1 },
    { seq: 7, kind: 'request', dispatchId: 'dispatch-retry', sessionId: 'session-retry', requestId: 'request-retry', replyTo: 'request-retry', attempt: 2 },
    { seq: 8, kind: 'ack', dispatchId: 'dispatch-retry', sessionId: 'session-retry', requestId: 'request-retry', replyTo: 'request-retry', attempt: 2 },
    { seq: 9, kind: 'result', status: 'succeeded', dispatchId: 'dispatch-retry', sessionId: 'session-retry', requestId: 'request-retry', replyTo: 'request-first', attempt: 2 },
  ].map(row => `${JSON.stringify(row)}\n`).join(''));
  const effects = path.join(root, 'effects.jsonl');
  fs.writeFileSync(effects, [
    { kind: 'dispatch', dispatchId: 'dispatch-cancel', idempotencyKey: 'idempotency-cancel', sessionId: 'session-cancel', requestId: 'request-cancel', attempt: 1 },
    { kind: 'dispatch', dispatchId: 'dispatch-retry', idempotencyKey: 'idempotency-retry', sessionId: 'session-first', requestId: 'request-retry', attempt: 1 },
    { kind: 'dispatch', dispatchId: 'dispatch-retry', idempotencyKey: 'idempotency-retry', sessionId: 'session-retry', requestId: 'request-retry', attempt: 2 },
    { kind: 'write', path: result, sha256: hashFile(result), sessionId: 'session-retry', requestId: 'request-retry', attempt: 2 },
  ].map(row => `${JSON.stringify(row)}\n`).join(''));
  const execution = path.join(root, 'execution.log');
  fs.writeFileSync(execution, 'requested runtime codex; target runtime claude; model gpt-5.6-luna; effort xhigh\n');
  const report = scoreRun({
    isolatedRoot: root,
    evidenceRoot: root,
    duplicateSideEffects: 0,
    categories: {
      B3: {
        eventsEvidence: evidence(events),
        sideEffectsEvidence: evidence(effects),
        executionEvidence: evidence(execution),
        retry: { explicit: true, dispatchId: 'dispatch-retry', attempt: 2, requestId: 'request-retry', sessionId: 'session-retry' },
        resultPath: result,
        resultSha256: hashFile(result),
      },
    },
  });
  assert.notEqual(report.categories.B3.status, 'pass');
  assert.equal(report.categories.B3.code, 'STALE_ATTEMPT');
});

test('AC-09 B3 rejects more than one retry for a dispatch', () => {
  const root = tempRoot();
  const result = path.join(root, 'result.txt');
  fs.writeFileSync(result, 'retried result\n');
  const events = path.join(root, 'events.jsonl');
  fs.writeFileSync(events, [
    { seq: 1, kind: 'request', dispatchId: 'dispatch-cancel', sessionId: 'session-cancel', requestId: 'request-cancel', attempt: 1 },
    { seq: 2, kind: 'ack', dispatchId: 'dispatch-cancel', sessionId: 'session-cancel', requestId: 'request-cancel', replyTo: 'request-cancel', attempt: 1 },
    { seq: 3, kind: 'cancelled', status: 'cancelled', dispatchId: 'dispatch-cancel', sessionId: 'session-cancel', requestId: 'request-cancel', replyTo: 'request-cancel', attempt: 1 },
    { seq: 4, kind: 'request', dispatchId: 'dispatch-retry', sessionId: 'session-first', requestId: 'request-retry', attempt: 1 },
    { seq: 5, kind: 'ack', dispatchId: 'dispatch-retry', sessionId: 'session-first', requestId: 'request-retry', replyTo: 'request-retry', attempt: 1 },
    { seq: 6, kind: 'failed', status: 'failed', dispatchId: 'dispatch-retry', sessionId: 'session-first', requestId: 'request-retry', replyTo: 'request-retry', attempt: 1 },
    { seq: 7, kind: 'request', dispatchId: 'dispatch-retry', sessionId: 'session-second', requestId: 'request-retry', attempt: 3 },
    { seq: 8, kind: 'ack', dispatchId: 'dispatch-retry', sessionId: 'session-second', requestId: 'request-retry', replyTo: 'request-retry', attempt: 3 },
    { seq: 9, kind: 'result', status: 'succeeded', dispatchId: 'dispatch-retry', sessionId: 'session-second', requestId: 'request-retry', replyTo: 'request-retry', attempt: 3 },
  ].map(row => `${JSON.stringify(row)}\n`).join(''));
  const effects = path.join(root, 'effects.jsonl');
  fs.writeFileSync(effects, `${JSON.stringify({ kind: 'dispatch', dispatchId: 'dispatch-retry', idempotencyKey: 'idempotency-retry' })}\n`);
  const execution = path.join(root, 'execution.log');
  fs.writeFileSync(execution, 'requested runtime codex; target runtime claude\n');
  const report = scoreRun({
    isolatedRoot: root,
    evidenceRoot: root,
    duplicateSideEffects: 0,
    categories: {
      B3: {
        eventsEvidence: evidence(events),
        sideEffectsEvidence: evidence(effects),
        executionEvidence: evidence(execution),
        retry: { explicit: true, dispatchId: 'dispatch-retry', attempt: 3, requestId: 'request-retry', sessionId: 'session-second' },
        resultPath: result,
        resultSha256: hashFile(result),
      },
    },
  });
  assert.equal(report.categories.B3.code, 'RETRY_NOT_PROVEN');
});

test('AC-09 B3 rejects a retry that reuses the failed attempt session', () => {
  const root = tempRoot();
  const result = path.join(root, 'result.txt');
  fs.writeFileSync(result, 'retried result\n');
  const events = path.join(root, 'events.jsonl');
  fs.writeFileSync(events, [
    { seq: 1, kind: 'request', dispatchId: 'dispatch-cancel', sessionId: 'session-cancel', requestId: 'request-cancel', attempt: 1 },
    { seq: 2, kind: 'ack', dispatchId: 'dispatch-cancel', sessionId: 'session-cancel', requestId: 'request-cancel', replyTo: 'request-cancel', attempt: 1 },
    { seq: 3, kind: 'cancelled', status: 'cancelled', dispatchId: 'dispatch-cancel', sessionId: 'session-cancel', requestId: 'request-cancel', replyTo: 'request-cancel', attempt: 1 },
    { seq: 4, kind: 'request', dispatchId: 'dispatch-retry', sessionId: 'session-reused', requestId: 'request-retry', attempt: 1 },
    { seq: 5, kind: 'ack', dispatchId: 'dispatch-retry', sessionId: 'session-reused', requestId: 'request-retry', replyTo: 'request-retry', attempt: 1 },
    { seq: 6, kind: 'failed', status: 'failed', dispatchId: 'dispatch-retry', sessionId: 'session-reused', requestId: 'request-retry', replyTo: 'request-retry', attempt: 1 },
    { seq: 7, kind: 'request', dispatchId: 'dispatch-retry', sessionId: 'session-reused', requestId: 'request-retry', attempt: 2 },
    { seq: 8, kind: 'ack', dispatchId: 'dispatch-retry', sessionId: 'session-reused', requestId: 'request-retry', replyTo: 'request-retry', attempt: 2 },
    { seq: 9, kind: 'result', status: 'succeeded', dispatchId: 'dispatch-retry', sessionId: 'session-reused', requestId: 'request-retry', replyTo: 'request-retry', attempt: 2 },
  ].map(row => `${JSON.stringify(row)}\n`).join(''));
  const effects = path.join(root, 'effects.jsonl');
  fs.writeFileSync(effects, `${JSON.stringify({ kind: 'dispatch', dispatchId: 'dispatch-retry', idempotencyKey: 'idempotency-retry' })}\n`);
  const execution = path.join(root, 'execution.log');
  fs.writeFileSync(execution, 'requested runtime codex; target runtime claude\n');
  const report = scoreRun({
    isolatedRoot: root,
    evidenceRoot: root,
    duplicateSideEffects: 0,
    categories: {
      B3: {
        eventsEvidence: evidence(events),
        sideEffectsEvidence: evidence(effects),
        executionEvidence: evidence(execution),
        retry: { explicit: true, dispatchId: 'dispatch-retry', attempt: 2, requestId: 'request-retry', sessionId: 'session-reused' },
        resultPath: result,
        resultSha256: hashFile(result),
      },
    },
  });
  assert.equal(report.categories.B3.code, 'IDENTITY_JOIN_FAILED');
});
