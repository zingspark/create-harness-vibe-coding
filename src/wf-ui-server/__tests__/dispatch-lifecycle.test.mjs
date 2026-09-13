// Dispatch lifecycle contract tests (AC-05 / AC-07).
//
// These tests are intentionally contract-first.  The runtime fixture records
// real spawn calls while leaving completion under test control: a PTY handle
// alone must not be treated as a successful task result.
import test, { before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { makeHarnessTempRoot } from '../../../tests/support/temp-root.js';
import { SessionRegistry } from '../session-registry.mjs';

const fixtureDir = path.resolve('tests/fixtures/runtime-092');
const fixturePath = path.join(fixtureDir, 'pty-adapter.mjs');
const fixtureUrl = pathToFileURL(fixturePath).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === './pty-adapter.mjs'
      && String(context.parentURL || '').endsWith('/src/wf-ui-server/server.mjs')) {
      return { url: fixtureUrl, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const { startServer, stopServer } = await import('../server.mjs');
const { recorder, emitExit } = await import(fixtureUrl);

const originalPath = process.env.PATH || '';
const taskId = 'task-runtime-092';

// Test-owned trusted catalog for lifecycle behavior.  The fixture's fake
// codex executable is a PTY adapter, not a model/list provider; constructor
// DI keeps these lifecycle tests focused on dispatch state transitions without
// authorizing models from the HTTP envelope.
async function modelCapabilityProbe({ runtime, model, effort }) {
  if (runtime !== 'codex' || model !== 'gpt-5.6-luna'
    || !['low', 'medium', 'high', 'xhigh'].includes(String(effort || '').toLowerCase())) {
    return {
      status: 'unsupported',
      sourceKind: 'test-authoritative-catalog',
      verificationLevel: 'authoritative',
      complete: true,
      model,
      reason: { code: 'MODEL_NOT_IN_AUTHORITATIVE_CATALOG', message: 'The test catalog excludes this selection.' },
    };
  }
  return {
    status: 'supported',
    sourceKind: 'test-authoritative-catalog',
    verificationLevel: 'authoritative',
    complete: true,
    model,
    supportedEfforts: ['low', 'medium', 'high', 'xhigh'],
  };
}

function jsonRequest(baseUrl, route, { method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(route, baseUrl);
    const payload = body === undefined ? null : JSON.stringify(body);
    const request = http.request({
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method,
      headers: payload
        ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
        : {},
    }, response => {
      let data = '';
      response.on('data', chunk => { data += chunk; });
      response.on('end', () => {
        try {
          resolve({ status: response.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: response.statusCode, body: data });
        }
      });
    });
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

function dispatchRequest(projectRoot, overrides = {}) {
  return {
    dispatchId: 'dispatch-runtime-092-001',
    taskId,
    runtime: 'codex',
    model: 'gpt-5.6-luna',
    effort: 'xhigh',
    transport: 'pty',
    role: 'implementer',
    objective: 'exercise the dispatch lifecycle contract',
    initialPrompt: 'Reply with an explicit structured result when complete.',
    contextRefs: ['context-node-runtime-092'],
    parentSessionId: 'parent-session-runtime-092',
    projectRoot,
    ...overrides,
  };
}

function readSessionEvents(projectRoot, sessionId) {
  const file = path.join(projectRoot, 'Harness', 'tasks', taskId, 'sessions', sessionId, 'events.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}

function waitForTurn() {
  return new Promise(resolve => setTimeout(resolve, 35));
}

let root;
let server;
let baseUrl;

before(() => {
  if (process.platform !== 'win32') {
    fs.chmodSync(path.join(fixtureDir, 'codex'), 0o755);
  }
  process.env.PATH = `${fixtureDir}${path.delimiter}${originalPath}`;
});

after(() => {
  process.env.PATH = originalPath;
  if (process.platform !== 'win32') {
    fs.chmodSync(path.join(fixtureDir, 'codex'), 0o644);
  }
});

beforeEach(async () => {
  root = makeHarnessTempRoot('dispatch-runtime-092-');
  fs.mkdirSync(path.join(root, 'Harness', 'tasks', taskId), { recursive: true });
  recorder.reset();
  const started = await startServer({
    projectRoot: root,
    host: '127.0.0.1',
    port: 0,
    sessionRegistry: new SessionRegistry(),
    eventsWs: false,
    modelCapabilityProbe,
  });
  server = started.server;
  baseUrl = `http://127.0.0.1:${started.port}`;
});

afterEach(async () => {
  if (server) await stopServer(server);
  server = null;
  if (root) {
    const resolved = path.resolve(root);
    const allowed = path.resolve('Harness', '.temp') + path.sep;
    assert.ok(resolved.startsWith(allowed), `refusing to remove non-temp root: ${root}`);
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
  root = null;
});

test('AC-05 dispatch request returns explicit requested/effective routing and replays by canonical key', async () => {
  const request = dispatchRequest(root);

  // Arrange/Act: the first POST must create one managed PTY dispatch.
  const first = await jsonRequest(baseUrl, '/api/sessions', { method: 'POST', body: request });

  // Assert: response shape and explicit route selection are part of the API contract.
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(first.body.ok, true, JSON.stringify(first.body));
  assert.equal(first.body.dispatchId, request.dispatchId);
  assert.ok(first.body.sessionId, 'dispatch must return a sessionId');
  assert.ok(first.body.graphNodeId, 'dispatch must return a graphNodeId');
  assert.equal(first.body.replayed, false);
  assert.deepEqual(first.body.requested, {
    runtime: request.runtime,
    model: request.model,
    effort: request.effort,
    transport: request.transport,
  });
  assert.deepEqual(first.body.effective, first.body.requested,
    'explicit runtime/model/effort/transport must not be silently replaced');
  assert.equal(recorder.count(), 1, 'first dispatch must spawn exactly one PTY');

  // Act: retrying the identical request is an idempotent replay, not a spawn.
  const replay = await jsonRequest(baseUrl, '/api/sessions', { method: 'POST', body: request });

  // Assert: the canonical dispatch points to the original execution and marks replay.
  assert.ok([200, 201].includes(replay.status), JSON.stringify(replay.body));
  assert.equal(replay.body.ok, true, JSON.stringify(replay.body));
  assert.equal(replay.body.dispatchId, request.dispatchId);
  assert.equal(replay.body.sessionId, first.body.sessionId);
  assert.equal(replay.body.graphNodeId, first.body.graphNodeId);
  assert.equal(replay.body.replayed, true);
  assert.equal(recorder.count(), 1, 'idempotent replay must not spawn a second PTY');

  // Act/Assert: same key with changed payload is a conflict, never a new run.
  const conflict = await jsonRequest(baseUrl, '/api/sessions', {
    method: 'POST',
    body: { ...request, model: 'different-model' },
  });
  assert.equal(conflict.status, 409, JSON.stringify(conflict.body));
  assert.ok(conflict.body?.error || conflict.body?.message,
    'idempotency conflict must explain why the payload is rejected');
  assert.equal(recorder.count(), 1, 'conflict must not spawn a second PTY');
});

test('AC-05 unsupported effort is rejected instead of silently downgraded', async () => {
  const response = await jsonRequest(baseUrl, '/api/sessions', {
    method: 'POST',
    body: dispatchRequest(root, { effort: 'unsupported-effort' }),
  });

  assert.ok([400, 422].includes(response.status), JSON.stringify(response.body));
  assert.ok(response.body?.error || response.body?.message,
    'unsupported effort must have an explicit rejection reason');
  assert.equal(recorder.count(), 0, 'invalid routing must not spawn a PTY');
});

test('AC-03 contextPackPath stays inside project and is consumed by the spawned runtime', async () => {
  const packPath = path.join(root, 'Harness', 'context-pack.md');
  fs.writeFileSync(packPath, 'PACK_SENTINEL_AC03\n', 'utf8');

  const accepted = await jsonRequest(baseUrl, '/api/sessions', {
    method: 'POST',
    body: dispatchRequest(root, { contextPackPath: packPath }),
  });
  assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
  assert.match(JSON.stringify(recorder.calls[0]?.options), /PACK_SENTINEL_AC03/,
    'runtime spawn must receive the actual context pack content');
});

test('AC-03 contextPackPath outside project root is rejected before runtime spawn', async () => {
  const outside = path.resolve(root, '..', 'context-pack-outside-092.md');
  fs.writeFileSync(outside, 'OUTSIDE_SENTINEL_AC03\n', 'utf8');
  try {
    const rejected = await jsonRequest(baseUrl, '/api/sessions', {
      method: 'POST',
      body: dispatchRequest(root, {
        dispatchId: 'dispatch-runtime-092-outside',
        contextPackPath: outside,
      }),
    });
    assert.ok([400, 403, 422].includes(rejected.status), JSON.stringify(rejected.body));
    assert.equal(recorder.count(), 0, 'out-of-project context must not spawn a runtime');
  } finally {
    fs.rmSync(outside, { force: true });
  }
});

test('AC-05 terminal replay returns the terminal result without respawn or event append', async () => {
  const request = dispatchRequest(root, { dispatchId: 'dispatch-runtime-092-terminal' });
  const first = await jsonRequest(baseUrl, '/api/sessions', { method: 'POST', body: request });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(emitExit(first.body.sessionId, 0), true, 'fixture exit should settle terminal state');
  await waitForTurn();
  const before = readSessionEvents(root, first.body.sessionId);
  assert.ok(before.some(event => event.type === 'session.exited'),
    `terminal dispatch must record task-bound exit event: ${JSON.stringify(before)}`);

  const replay = await jsonRequest(baseUrl, '/api/sessions', { method: 'POST', body: request });
  assert.ok([200, 201].includes(replay.status), JSON.stringify(replay.body));
  assert.equal(replay.body.replayed, true, JSON.stringify(replay.body));
  assert.equal(replay.body.sessionId, first.body.sessionId);
  assert.equal(recorder.count(), 1, 'terminal replay must not respawn');
  assert.deepEqual(readSessionEvents(root, first.body.sessionId), before,
    'terminal replay must not append another lifecycle event');
});

test('AC-05 restart with no live PTY handle marks the session lost and does not auto-execute', async () => {
  const request = dispatchRequest(root, { dispatchId: 'dispatch-runtime-092-restart' });
  const first = await jsonRequest(baseUrl, '/api/sessions', { method: 'POST', body: request });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const sessionId = first.body.sessionId;
  await stopServer(server);
  server = null;
  recorder.reset();

  const restarted = await startServer({
    projectRoot: root,
    host: '127.0.0.1',
    port: 0,
    sessionRegistry: new SessionRegistry(),
    eventsWs: false,
    modelCapabilityProbe,
  });
  server = restarted.server;
  baseUrl = `http://127.0.0.1:${restarted.port}`;

  const all = await jsonRequest(baseUrl, '/api/sessions?all=1');
  const recovered = all.body.find(session => session.sessionId === sessionId);
  assert.ok(recovered, JSON.stringify(all.body));
  assert.ok(['interrupted', 'failed'].includes(recovered.status),
    `lost PTY must be explicit, got ${recovered.status}`);
  const replay = await jsonRequest(baseUrl, '/api/sessions', { method: 'POST', body: request });
  assert.equal(replay.body.replayed, true, JSON.stringify(replay.body));
  assert.equal(recorder.count(), 0, 'restart must not silently rerun a lost PTY');
});

test('AC-05 cancel has one terminal state and replaying cancel cannot create another terminal', async () => {
  const request = dispatchRequest(root, { dispatchId: 'dispatch-runtime-092-cancel' });
  const created = await jsonRequest(baseUrl, '/api/sessions', { method: 'POST', body: request });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const cancel = await jsonRequest(baseUrl, `/api/sessions/${created.body.sessionId}/cancel`, {
    method: 'POST',
    body: {},
  });
  assert.equal(cancel.status, 200, JSON.stringify(cancel.body));
  const cancelled = cancel.body.cancelled || cancel.body.session || cancel.body;
  assert.equal(cancelled.status, 'cancelled', JSON.stringify(cancel.body));
  const terminalEvents = readSessionEvents(root, created.body.sessionId)
    .filter(event => ['cancelled', 'failed', 'completed', 'exited'].includes(event.status)
      || /cancel/i.test(String(event.type || '')));

  const replay = await jsonRequest(baseUrl, `/api/sessions/${created.body.sessionId}/cancel`, {
    method: 'POST',
    body: {},
  });
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  const replayed = replay.body.cancelled || replay.body.session || replay.body;
  assert.equal(replayed.status, 'cancelled', JSON.stringify(replay.body));
  assert.deepEqual(readSessionEvents(root, created.body.sessionId)
    .filter(event => ['cancelled', 'failed', 'completed', 'exited'].includes(event.status)
      || /cancel/i.test(String(event.type || ''))), terminalEvents,
  'cancel replay must preserve one terminal outcome');
  assert.equal(recorder.count(), 1, 'cancel replay must not spawn another runtime');
});
