// Independent runtime review probes for task-upgrade-harness-092 (AC-05/06/07).
// This file deliberately reads task-bound session storage rather than the
// unbound A2A session directory used by the original lifecycle smoke tests.
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
const taskId = 'task-runtime-review-092';
const authoritativeModel = 'gpt-5.6-luna';
const authoritativeEfforts = ['low', 'medium', 'high', 'xhigh'];

// This is deliberately test-owned authority.  The HTTP envelope must not be
// able to add a model to this catalog; production receives the equivalent
// probe only through the server-construction seam.
let probeCalls = [];
let probeResultOverride = null;

async function modelCapabilityProbe(args) {
  const { runtime, model, effort, projectRoot, deadlineAt } = args;
  probeCalls.push({ runtime, model, effort, projectRoot, deadlineAt });
  if (probeResultOverride !== null) {
    return typeof probeResultOverride === 'function'
      ? await probeResultOverride(args)
      : probeResultOverride;
  }
  if (model === authoritativeModel) {
    return {
      status: 'supported',
      sourceKind: 'test-authoritative-catalog',
      verificationLevel: 'authoritative',
      complete: true,
      model,
      supportedEfforts: [...authoritativeEfforts],
    };
  }
  return {
    status: 'unsupported',
    sourceKind: 'test-authoritative-catalog',
    verificationLevel: 'authoritative',
    complete: true,
    model,
    reason: {
      code: 'MODEL_NOT_IN_AUTHORITATIVE_CATALOG',
      message: 'The model is not present in the complete test catalog.',
    },
  };
}

function jsonRequest(baseUrl, route, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(route, baseUrl);
    const payload = body === undefined ? null : JSON.stringify(body);
    const request = http.request({
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method,
      headers: payload
        ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers }
        : headers,
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
    dispatchId: 'dispatch-runtime-review-092',
    taskId,
    runtime: 'codex',
    model: 'gpt-5.6-luna',
    effort: 'xhigh',
    transport: 'pty',
    role: 'verifier',
    objective: 'independent runtime review fixture',
    initialPrompt: 'Perform the bounded fixture task.',
    contextRefs: ['review-context-node'],
    parentSessionId: 'review-parent-session',
    projectRoot,
    ...overrides,
  };
}

function sessionDir(projectRoot, sessionId) {
  return path.join(projectRoot, 'Harness', 'tasks', taskId, 'sessions', sessionId);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readSessionState(projectRoot, sessionId) {
  return readJson(path.join(sessionDir(projectRoot, sessionId), 'STATE.json'));
}

function readSessionEvents(projectRoot, sessionId) {
  const file = path.join(sessionDir(projectRoot, sessionId), 'events.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}

function assertNoDispatchSideEffects(projectRoot) {
  assert.equal(recorder.count(), 0, 'rejected capability must not spawn a worker');
  assert.equal(
    fs.existsSync(path.join(projectRoot, 'Harness', 'tasks', taskId, 'sessions')),
    false,
    'rejected capability must not create task-bound session state',
  );
  assert.equal(
    fs.existsSync(path.join(projectRoot, 'Harness', 'tasks', taskId, 'peers')),
    false,
    'rejected capability must not create a peer capsule',
  );
}

function assertCapabilityError(response, code) {
  assert.notEqual(response.status, 201, `capability rejection must not create a session: ${JSON.stringify(response.body)}`);
  assert.equal(response.body?.error?.code, code, JSON.stringify(response.body));
}

function readPeerCapsule(projectRoot, sessionId) {
  const state = readSessionState(projectRoot, sessionId);
  const dir = path.join(projectRoot, 'Harness', 'tasks', taskId, 'peers', state.peerId);
  return {
    request: readJson(path.join(dir, 'REQUEST.json')),
    state: readJson(path.join(dir, 'STATE.json')),
    events: fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8')
      .split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)),
    result: fs.existsSync(path.join(dir, 'RESULT.json'))
      ? readJson(path.join(dir, 'RESULT.json')) : null,
  };
}

function waitForTurn() {
  return new Promise(resolve => setTimeout(resolve, 35));
}

let root;
let server;
let baseUrl;

before(() => {
  if (process.platform !== 'win32') fs.chmodSync(path.join(fixtureDir, 'codex'), 0o755);
  process.env.PATH = `${fixtureDir}${path.delimiter}${originalPath}`;
});

after(() => {
  process.env.PATH = originalPath;
  if (process.platform !== 'win32') fs.chmodSync(path.join(fixtureDir, 'codex'), 0o644);
});

beforeEach(async () => {
  root = makeHarnessTempRoot('runtime-review-092-');
  fs.mkdirSync(path.join(root, 'Harness', 'tasks', taskId), { recursive: true });
  recorder.reset();
  probeCalls = [];
  probeResultOverride = null;
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

test('AC-05 authoritative catalog hit passes the exact model and effort to the probe', async () => {
  const request = dispatchRequest(root, {
    dispatchId: 'dispatch-review-capability-supported',
    model: authoritativeModel,
    effort: 'xhigh',
  });
  const response = await jsonRequest(baseUrl, '/api/sessions', { method: 'POST', body: request });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  assert.equal(probeCalls.length, 1, JSON.stringify(probeCalls));
  assert.equal(probeCalls[0].runtime, request.runtime);
  assert.equal(probeCalls[0].model, request.model);
  assert.equal(probeCalls[0].effort, request.effort);
  assert.equal(probeCalls[0].projectRoot, root);
  assert.ok(Number.isFinite(probeCalls[0].deadlineAt), JSON.stringify(probeCalls[0]));
  assert.equal(recorder.count(), 1);
});

test('AC-05 a probe result for a different model is rejected before spawn', async () => {
  probeResultOverride = ({ model }) => ({
    status: 'supported',
    sourceKind: 'test-authoritative-catalog',
    verificationLevel: 'authoritative',
    complete: true,
    model: `${model}-mismatch`,
    supportedEfforts: [...authoritativeEfforts],
  });
  const response = await jsonRequest(baseUrl, '/api/sessions', {
    method: 'POST',
    body: dispatchRequest(root, { dispatchId: 'dispatch-review-capability-model-mismatch' }),
  });
  assertCapabilityError(response, 'UNSUPPORTED');
  assertNoDispatchSideEffects(root);
});

test('AC-05 an unverified probe result is not a model allow-list', async () => {
  probeResultOverride = ({ model }) => ({
    status: 'unverified',
    sourceKind: 'none',
    verificationLevel: 'unverified',
    complete: false,
    model,
    reason: { code: 'NO_AUTHORITATIVE_SOURCE', message: 'No authoritative model catalog is available.' },
  });
  const response = await jsonRequest(baseUrl, '/api/sessions', {
    method: 'POST',
    body: dispatchRequest(root, { dispatchId: 'dispatch-review-capability-unverified' }),
  });
  assertCapabilityError(response, 'UNVERIFIED');
  assertNoDispatchSideEffects(root);
});

test('AC-05 a missing probe result fails closed and does not create dispatch state', async () => {
  probeResultOverride = () => undefined;
  const response = await jsonRequest(baseUrl, '/api/sessions', {
    method: 'POST',
    body: dispatchRequest(root, { dispatchId: 'dispatch-review-capability-missing-probe' }),
  });
  assert.notEqual(response.status, 201, JSON.stringify(response.body));
  assert.ok(['UNVERIFIED', 'UNAVAILABLE'].includes(response.body?.error?.code), JSON.stringify(response.body));
  assertNoDispatchSideEffects(root);
});

test('AC-05 a probe failure is reported unavailable before worker spawn', async () => {
  probeResultOverride = async () => {
    throw new Error('authoritative provider probe failed');
  };
  const response = await jsonRequest(baseUrl, '/api/sessions', {
    method: 'POST',
    body: dispatchRequest(root, { dispatchId: 'dispatch-review-capability-probe-failure' }),
  });
  assertCapabilityError(response, 'UNAVAILABLE');
  assertNoDispatchSideEffects(root);
});

test('AC-05 absent effort metadata never treats a model as supported', async () => {
  probeResultOverride = ({ model }) => ({
    status: 'supported',
    sourceKind: 'test-authoritative-catalog',
    verificationLevel: 'authoritative',
    complete: true,
    model,
    // Deliberately omit supportedEfforts: the service must not invent xhigh.
  });
  const response = await jsonRequest(baseUrl, '/api/sessions', {
    method: 'POST',
    body: dispatchRequest(root, { dispatchId: 'dispatch-review-capability-no-effort-metadata' }),
  });
  assert.notEqual(response.status, 201, JSON.stringify(response.body));
  assert.ok(['UNSUPPORTED', 'UNVERIFIED'].includes(response.body?.error?.code), JSON.stringify(response.body));
  assertNoDispatchSideEffects(root);
});

test('AC-05 an explicit effort exclusion is unsupported before worker spawn', async () => {
  probeResultOverride = ({ model }) => ({
    status: 'supported',
    sourceKind: 'test-authoritative-catalog',
    verificationLevel: 'authoritative',
    complete: true,
    model,
    supportedEfforts: ['low', 'medium', 'high'],
  });
  const response = await jsonRequest(baseUrl, '/api/sessions', {
    method: 'POST',
    body: dispatchRequest(root, {
      dispatchId: 'dispatch-review-capability-effort-excluded',
      effort: 'xhigh',
    }),
  });
  assertCapabilityError(response, 'UNSUPPORTED');
  assertNoDispatchSideEffects(root);
});

test('AC-05 HTTP payload catalog claims cannot authorize an unknown model', async () => {
  const response = await jsonRequest(baseUrl, '/api/sessions', {
    method: 'POST',
    body: dispatchRequest(root, {
      dispatchId: 'dispatch-review-capability-payload-forgery',
      model: 'gpt-9-model-does-not-exist-092',
      modelCapability: {
        status: 'supported',
        sourceKind: 'caller-supplied',
        verificationLevel: 'authoritative',
        complete: true,
        model: 'gpt-9-model-does-not-exist-092',
        supportedEfforts: ['xhigh'],
      },
      supportedModels: ['gpt-9-model-does-not-exist-092'],
    }),
  });
  assertCapabilityError(response, 'UNSUPPORTED');
  assertNoDispatchSideEffects(root);
});

test('AC-05 concurrent identical capability probes are deduplicated by dispatch key', async () => {
  const request = dispatchRequest(root, { dispatchId: 'dispatch-review-capability-dedupe' });
  const [left, right] = await Promise.all([
    jsonRequest(baseUrl, '/api/sessions', { method: 'POST', body: request }),
    jsonRequest(baseUrl, '/api/sessions', { method: 'POST', body: request }),
  ]);
  assert.ok([left.status, right.status].every(status => [200, 201].includes(status)), `${JSON.stringify({ left, right })}`);
  assert.equal(probeCalls.length, 1, JSON.stringify(probeCalls));
  assert.ok(Number.isFinite(probeCalls[0].deadlineAt), JSON.stringify(probeCalls[0]));
  assert.equal(recorder.count(), 1);
});

test('AC-05 an unavailable probe cleans up its in-flight decision for a later retry', async () => {
  let attempts = 0;
  probeResultOverride = ({ model }) => {
    attempts += 1;
    if (attempts === 1) {
      return {
        status: 'unavailable',
        sourceKind: 'test-authoritative-catalog',
        verificationLevel: 'authoritative',
        complete: true,
        model,
        reason: { code: 'MODEL_CAPABILITY_TIMEOUT', message: 'catalog probe deadline elapsed' },
      };
    }
    return {
      status: 'supported',
      sourceKind: 'test-authoritative-catalog',
      verificationLevel: 'authoritative',
      complete: true,
      model,
      supportedEfforts: [...authoritativeEfforts],
    };
  };
  const request = dispatchRequest(root, { dispatchId: 'dispatch-review-capability-timeout-cleanup' });
  const first = await jsonRequest(baseUrl, '/api/sessions', { method: 'POST', body: request });
  assertCapabilityError(first, 'UNAVAILABLE');
  assertNoDispatchSideEffects(root);
  const second = await jsonRequest(baseUrl, '/api/sessions', { method: 'POST', body: request });
  assert.equal(second.status, 201, JSON.stringify(second.body));
  assert.equal(probeCalls.length, 2, JSON.stringify(probeCalls));
  assert.equal(recorder.count(), 1);
});

test('AC-05 concurrent identical dispatches create one session and one PTY', async () => {
  const request = dispatchRequest(root, { dispatchId: 'dispatch-review-concurrent' });
  const [left, right] = await Promise.all([
    jsonRequest(baseUrl, '/api/sessions', { method: 'POST', body: request }),
    jsonRequest(baseUrl, '/api/sessions', { method: 'POST', body: request }),
  ]);

  assert.ok([left.status, right.status].every(status => [200, 201].includes(status)), `${JSON.stringify({ left, right })}`);
  assert.equal(left.body.sessionId, right.body.sessionId);
  assert.equal([left.body.replayed, right.body.replayed].filter(Boolean).length, 1);
  assert.equal(recorder.count(), 1);
});

test('AC-05 changed payload for an existing dispatch is a conflict and does not spawn', async () => {
  const request = dispatchRequest(root, { dispatchId: 'dispatch-review-conflict' });
  const first = await jsonRequest(baseUrl, '/api/sessions', { method: 'POST', body: request });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const changed = await jsonRequest(baseUrl, '/api/sessions', {
    method: 'POST',
    body: { ...request, objective: 'changed after dispatch acceptance' },
  });
  assert.equal(changed.status, 409, JSON.stringify(changed.body));
  assert.equal(changed.body?.error?.code, 'DISPATCH_CONFLICT');
  assert.equal(recorder.count(), 1);
});

test('AC-05 unsupported runtime/model/transport selections fail explicitly before spawn', async () => {
  const cases = [
    ['runtime', { runtime: 'not-a-runtime' }],
    ['model', { model: 'unsupported-model-092' }],
    ['unknown-model-capability', { model: 'gpt-9-model-does-not-exist-092' }],
    ['transport', { transport: 'websocket' }],
  ];
  for (const [label, overrides] of cases) {
    const response = await jsonRequest(baseUrl, '/api/sessions', {
      method: 'POST',
      body: dispatchRequest(root, { ...overrides, dispatchId: `dispatch-review-unsupported-${label}` }),
    });
    assert.equal(response.status, 422, `${label}: ${JSON.stringify(response.body)}`);
    assert.equal(response.body?.error?.code, 'UNSUPPORTED', `${label}: ${JSON.stringify(response.body)}`);
  }
  assert.equal(recorder.count(), 0);
});

test('AC-05 task and context traversal are rejected before any worker spawn', async () => {
  const badTask = await jsonRequest(baseUrl, '/api/sessions', {
    method: 'POST',
    body: dispatchRequest(root, {
      dispatchId: 'dispatch-review-task-traversal',
      taskId: '../escape-task',
    }),
  });
  assert.equal(badTask.status, 400, JSON.stringify(badTask.body));
  assert.equal(badTask.body?.error?.code, 'BAD_DISPATCH');

  const outsidePack = path.resolve(root, '..', 'outside-review-pack.md');
  const badContext = await jsonRequest(baseUrl, '/api/sessions', {
    method: 'POST',
    body: dispatchRequest(root, {
      dispatchId: 'dispatch-review-context-traversal',
      contextPackPath: outsidePack,
    }),
  });
  assert.equal(badContext.status, 422, JSON.stringify(badContext.body));
  assert.equal(badContext.body?.error?.code, 'CONTEXT_OUTSIDE_PROJECT');
  assert.equal(recorder.count(), 0);
});

test('AC-03 context pack symlink escaping project is rejected before spawn', async () => {
  const outsideRoot = makeHarnessTempRoot('harness-context-outside-092-');
  const outsidePack = path.join(outsideRoot, 'outside.md');
  const linkDir = path.join(root, 'Harness', 'linked-context-dir');
  const linkPath = path.join(linkDir, 'outside.md');
  fs.writeFileSync(outsidePack, 'OUTSIDE_CONTEXT_SENTINEL\n', 'utf8');
  try {
    try {
      // Windows junctions do not require Developer Mode/admin symlink
      // privileges and still exercise the realpath containment boundary.
      if (process.platform === 'win32') fs.symlinkSync(outsideRoot, linkDir, 'junction');
      else fs.symlinkSync(outsidePack, linkPath, 'file');
    } catch (error) {
      throw new Error(`symlink fixture unavailable: ${error.code || error.message}`);
    }
    const response = await jsonRequest(baseUrl, '/api/sessions', {
      method: 'POST',
      body: dispatchRequest(root, {
        dispatchId: 'dispatch-review-context-symlink',
        contextPackPath: linkPath,
      }),
    });
    assert.equal(response.status, 422, JSON.stringify(response.body));
    assert.equal(response.body?.error?.code, 'CONTEXT_OUTSIDE_PROJECT');
    assert.equal(recorder.count(), 0);
  } finally {
    fs.rmSync(outsideRoot, { recursive: true, force: true });
  }
});

test('AC-03 context pack inside project is consumed by the worker launch prompt', async () => {
  const packPath = path.join(root, 'Harness', 'tasks', taskId, 'review-context.md');
  fs.writeFileSync(packPath, 'CONTEXT_PACK_SENTINEL_RUNTIME_REVIEW_092\n', 'utf8');
  const request = dispatchRequest(root, {
    dispatchId: 'dispatch-review-context-consume',
    contextPackPath: packPath,
  });
  const response = await jsonRequest(baseUrl, '/api/sessions', { method: 'POST', body: request });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  const call = recorder.calls[0];
  assert.match(call?.options?.initialPrompt || '', /CONTEXT_PACK_SENTINEL_RUNTIME_REVIEW_092/);
});

test('AC-05 worker receives dispatch identity at spawn instead of relying on user-supplied report flags', async () => {
  const request = dispatchRequest(root, { dispatchId: 'dispatch-review-worker-identity' });
  const response = await jsonRequest(baseUrl, '/api/sessions', { method: 'POST', body: request });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  const call = recorder.calls[0];
  assert.equal(call?.options?.dispatchId, request.dispatchId,
    'spawn adapter must receive the canonical dispatchId for trusted worker reporting');
  const capability = call?.options?.workerCapability;
  assert.equal(typeof capability, 'string');
  assert.ok(capability.length > 0, 'spawn adapter must receive a service-issued worker capability');
  assert.equal(response.body?.workerCapability, undefined,
    'the public session response must not expose the worker capability');
  const capsule = readPeerCapsule(root, response.body.sessionId);
  assert.equal(JSON.stringify(capsule).includes(capability), false,
    'task-bound peer capsules must not expose the worker capability');
});

test('AC-05 initial ACK and terminal RESULT preserve requestId/replyTo in the task-bound peer capsule', async () => {
  const request = dispatchRequest(root, {
    dispatchId: 'dispatch-review-correlation',
    requestId: 'request-review-1',
    replyTo: 'request-review-parent',
  });
  const created = await jsonRequest(baseUrl, '/api/sessions', { method: 'POST', body: request });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const capsule = readPeerCapsule(root, created.body.sessionId);
  const ack = capsule.events.find(event => event.type === 'dispatch.ack');
  assert.equal(ack?.requestId, request.requestId);
  assert.equal(ack?.replyTo, request.replyTo);

  const progress = await jsonRequest(baseUrl, `/api/dispatches/${request.dispatchId}/progress`, {
    method: 'POST',
    body: {
      sessionId: created.body.sessionId,
      taskId,
      requestId: request.requestId,
      replyTo: request.replyTo,
      progress: 'fixture progress',
    },
    headers: {
      'X-Harness-Worker-Capability': recorder.calls[0]?.options?.workerCapability || '',
      'X-Harness-Session-Id': created.body.sessionId,
    },
  });
  assert.equal(progress.status, 201, JSON.stringify(progress.body));

  const result = await jsonRequest(baseUrl, `/api/dispatches/${request.dispatchId}/result`, {
    method: 'POST',
    body: {
      sessionId: created.body.sessionId,
      taskId,
      requestId: request.requestId,
      replyTo: request.replyTo,
      status: 'succeeded',
      result: { evidence: 'fixture-result' },
    },
    headers: {
      'X-Harness-Worker-Capability': recorder.calls[0]?.options?.workerCapability || '',
      'X-Harness-Session-Id': created.body.sessionId,
    },
  });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  const completed = readPeerCapsule(root, created.body.sessionId);
  const terminalEvents = completed.events.filter(event => event.type === 'dispatch.succeeded');
  assert.equal(terminalEvents.length, 1);
  assert.equal(terminalEvents[0].requestId, request.requestId);
  assert.equal(terminalEvents[0].replyTo, request.replyTo);
  assert.equal(completed.result.requestId, request.requestId);
  assert.equal(completed.result.replyTo, request.replyTo);

  const replay = await jsonRequest(baseUrl, `/api/dispatches/${request.dispatchId}/result`, {
    method: 'POST',
    body: {
      sessionId: created.body.sessionId,
      taskId,
      requestId: request.requestId,
      replyTo: request.replyTo,
      status: 'succeeded',
      result: { evidence: 'fixture-result' },
    },
    headers: {
      'X-Harness-Worker-Capability': recorder.calls[0]?.options?.workerCapability || '',
      'X-Harness-Session-Id': created.body.sessionId,
    },
  });
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.equal(replay.body.replayed, true, JSON.stringify(replay.body));
  assert.equal(readPeerCapsule(root, created.body.sessionId).events.filter(event => event.type === 'dispatch.succeeded').length, 1);
});

test('AC-05 duplicate terminal result is replayed and writes one terminal capsule event', async () => {
  const request = dispatchRequest(root, { dispatchId: 'dispatch-review-result-idempotency' });
  const created = await jsonRequest(baseUrl, '/api/sessions', { method: 'POST', body: request });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const capability = recorder.calls[0]?.options?.workerCapability;
  assert.equal(typeof capability, 'string');
  assert.ok(capability.length > 0);
  const body = {
    sessionId: created.body.sessionId,
    taskId,
    status: 'succeeded',
    result: { evidence: 'idempotency-fixture' },
  };
  const first = await jsonRequest(baseUrl, `/api/dispatches/${request.dispatchId}/result`, {
    method: 'POST',
    body,
    headers: {
      'X-Harness-Worker-Capability': capability,
      'X-Harness-Session-Id': created.body.sessionId,
    },
  });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const replay = await jsonRequest(baseUrl, `/api/dispatches/${request.dispatchId}/result`, {
    method: 'POST',
    body,
    headers: {
      'X-Harness-Worker-Capability': capability,
      'X-Harness-Session-Id': created.body.sessionId,
    },
  });
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.equal(replay.body?.replayed, true, JSON.stringify(replay.body));
  const capsule = readPeerCapsule(root, created.body.sessionId);
  assert.equal(capsule.events.filter(event => event.type === 'dispatch.succeeded').length, 1);
  assert.equal(capsule.state.status, 'succeeded');
});

test('AC-05 duplicate cancel is idempotent and writes one terminal capsule event', async () => {
  const request = dispatchRequest(root, { dispatchId: 'dispatch-review-cancel-idempotency' });
  const created = await jsonRequest(baseUrl, '/api/sessions', { method: 'POST', body: request });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const route = `/api/sessions/${created.body.sessionId}/cancel`;
  const first = await jsonRequest(baseUrl, route, { method: 'POST', body: {} });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body?.cancelled?.status, 'cancelled', JSON.stringify(first.body));
  const replay = await jsonRequest(baseUrl, route, { method: 'POST', body: {} });
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.equal(replay.body?.cancelled?.status, 'cancelled', JSON.stringify(replay.body));
  const capsule = readPeerCapsule(root, created.body.sessionId);
  assert.equal(capsule.events.filter(event => event.type === 'dispatch.cancelled').length, 1);
  assert.equal(capsule.state.status, 'cancelled');
});

test('AC-05 explicit retry is limited to one new attempt after failed transport', async () => {
  const request = dispatchRequest(root, { dispatchId: 'dispatch-review-retry' });
  const first = await jsonRequest(baseUrl, '/api/sessions', { method: 'POST', body: request });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(emitExit(first.body.sessionId, 23), true);
  await waitForTurn();

  const retry = await jsonRequest(baseUrl, '/api/sessions', {
    method: 'POST',
    body: { ...request, retry: true },
  });
  assert.equal(retry.status, 201, JSON.stringify(retry.body));
  assert.equal(retry.body.attempt, 1, JSON.stringify(retry.body));
  assert.notEqual(retry.body.sessionId, first.body.sessionId);
  assert.equal(recorder.count(), 2);

  assert.equal(emitExit(retry.body.sessionId, 24), true);
  await waitForTurn();

  const exhausted = await jsonRequest(baseUrl, '/api/sessions', {
    method: 'POST',
    body: { ...request, retry: true },
  });
  assert.equal(exhausted.status, 409, JSON.stringify(exhausted.body));
  assert.equal(exhausted.body?.error?.code, 'DISPATCH_RETRY_EXHAUSTED');
  assert.equal(recorder.count(), 2);
});

test('AC-05 a PTY exit is failed transport evidence, not success, and reads from task-bound storage', async () => {
  const request = dispatchRequest(root, { dispatchId: 'dispatch-review-exit' });
  const created = await jsonRequest(baseUrl, '/api/sessions', { method: 'POST', body: request });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(emitExit(created.body.sessionId, 0), true);
  await waitForTurn();
  const state = readSessionState(root, created.body.sessionId);
  assert.equal(state.status, 'failed', JSON.stringify(state));
  assert.equal(state.dispatchStatus, 'failed', JSON.stringify(state));
  assert.ok(readSessionEvents(root, created.body.sessionId).some(event => event.type === 'session.exited'));
});

test('AC-05 restart downgrades a lost dispatched PTY and does not pretend to rerun it', async () => {
  const request = dispatchRequest(root, { dispatchId: 'dispatch-review-restart' });
  const created = await jsonRequest(baseUrl, '/api/sessions', { method: 'POST', body: request });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  await stopServer(server);
  server = null;
  recorder.reset();
  const restarted = await startServer({
    projectRoot: root,
    host: '127.0.0.1',
    port: 0,
    sessionRegistry: new SessionRegistry(),
    eventsWs: false,
  });
  server = restarted.server;
  baseUrl = `http://127.0.0.1:${restarted.port}`;
  const all = await jsonRequest(baseUrl, '/api/sessions?all=1');
  const recovered = all.body.find(session => session.sessionId === created.body.sessionId);
  assert.equal(recovered?.status, 'interrupted', JSON.stringify(recovered));
  assert.equal(recovered?.dispatchStatus, 'interrupted', JSON.stringify(recovered));
  const replay = await jsonRequest(baseUrl, '/api/sessions', { method: 'POST', body: request });
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.equal(replay.body?.replayed, true, JSON.stringify(replay.body));
  assert.equal(recorder.count(), 0, 'restart must not silently rerun a lost PTY');
});

test('AC-05 an unbound caller cannot claim succeeded without the worker session identity', async () => {
  const request = dispatchRequest(root, { dispatchId: 'dispatch-review-forged-result' });
  const created = await jsonRequest(baseUrl, '/api/sessions', { method: 'POST', body: request });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const forged = await jsonRequest(baseUrl, `/api/dispatches/${request.dispatchId}/result`, {
    method: 'POST',
    body: { taskId, status: 'succeeded', result: { claimedBy: 'unbound-caller' } },
  });
  assert.ok([401, 403, 409].includes(forged.status),
    `dispatch result must be bound to an authenticated worker session: ${JSON.stringify(forged.body)}`);
});

test('AC-05 a worker with the wrong session identity cannot claim a result', async () => {
  const request = dispatchRequest(root, { dispatchId: 'dispatch-review-wrong-session' });
  const created = await jsonRequest(baseUrl, '/api/sessions', { method: 'POST', body: request });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const capability = recorder.calls[0]?.options?.workerCapability;
  assert.equal(typeof capability, 'string');
  const forged = await jsonRequest(baseUrl, `/api/dispatches/${request.dispatchId}/result`, {
    method: 'POST',
    body: {
      sessionId: created.body.sessionId,
      taskId,
      status: 'succeeded',
      result: { claimedBy: 'wrong-session' },
    },
    headers: {
      'X-Harness-Worker-Capability': capability,
      'X-Harness-Session-Id': 'session-not-the-worker-092',
    },
  });
  assert.equal(forged.status, 401, JSON.stringify(forged.body));
  assert.equal(forged.body?.error?.code, 'DISPATCH_WORKER_UNAUTHORIZED');
  assert.equal(readPeerCapsule(root, created.body.sessionId).state.status, 'running');
});

test('AC-05 a worker with the wrong capability cannot claim a result', async () => {
  const request = dispatchRequest(root, { dispatchId: 'dispatch-review-wrong-capability' });
  const created = await jsonRequest(baseUrl, '/api/sessions', { method: 'POST', body: request });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const capability = recorder.calls[0]?.options?.workerCapability;
  assert.equal(typeof capability, 'string');
  const forged = await jsonRequest(baseUrl, `/api/dispatches/${request.dispatchId}/result`, {
    method: 'POST',
    body: {
      sessionId: created.body.sessionId,
      taskId,
      status: 'succeeded',
      result: { claimedBy: 'wrong-capability' },
    },
    headers: {
      'X-Harness-Worker-Capability': `${capability}-forged`,
      'X-Harness-Session-Id': created.body.sessionId,
    },
  });
  assert.equal(forged.status, 401, JSON.stringify(forged.body));
  assert.equal(forged.body?.error?.code, 'DISPATCH_WORKER_UNAUTHORIZED');
  assert.equal(readPeerCapsule(root, created.body.sessionId).state.status, 'running');
});

test('AC-05 an old attempt cannot report and its old capability cannot bind the retry', async () => {
  const request = dispatchRequest(root, { dispatchId: 'dispatch-review-wrong-attempt' });
  const first = await jsonRequest(baseUrl, '/api/sessions', { method: 'POST', body: request });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const oldCapability = recorder.calls[0]?.options?.workerCapability;
  assert.equal(typeof oldCapability, 'string');
  assert.equal(emitExit(first.body.sessionId, 23), true);
  await waitForTurn();

  const retry = await jsonRequest(baseUrl, '/api/sessions', {
    method: 'POST',
    body: { ...request, retry: true },
  });
  assert.equal(retry.status, 201, JSON.stringify(retry.body));
  assert.equal(retry.body.attempt, 1, JSON.stringify(retry.body));
  assert.notEqual(retry.body.sessionId, first.body.sessionId);
  const retryCapability = recorder.calls[1]?.options?.workerCapability;
  assert.equal(typeof retryCapability, 'string');
  assert.notEqual(retryCapability, oldCapability);

  const oldAttempt = await jsonRequest(baseUrl, `/api/dispatches/${request.dispatchId}/result`, {
    method: 'POST',
    body: {
      sessionId: first.body.sessionId,
      taskId,
      status: 'succeeded',
      result: { claimedBy: 'old-attempt' },
    },
    headers: {
      'X-Harness-Worker-Capability': oldCapability,
      'X-Harness-Session-Id': first.body.sessionId,
    },
  });
  assert.equal(oldAttempt.status, 409, JSON.stringify(oldAttempt.body));
  assert.equal(oldAttempt.body?.error?.code, 'DISPATCH_ATTEMPT_CONFLICT');

  const oldCapabilityOnRetry = await jsonRequest(baseUrl, `/api/dispatches/${request.dispatchId}/result`, {
    method: 'POST',
    body: {
      sessionId: retry.body.sessionId,
      taskId,
      status: 'succeeded',
      result: { claimedBy: 'old-capability' },
    },
    headers: {
      'X-Harness-Worker-Capability': oldCapability,
      'X-Harness-Session-Id': retry.body.sessionId,
    },
  });
  assert.equal(oldCapabilityOnRetry.status, 401, JSON.stringify(oldCapabilityOnRetry.body));
  assert.equal(oldCapabilityOnRetry.body?.error?.code, 'DISPATCH_WORKER_UNAUTHORIZED');
  assert.equal(readPeerCapsule(root, retry.body.sessionId).state.status, 'running');
});
