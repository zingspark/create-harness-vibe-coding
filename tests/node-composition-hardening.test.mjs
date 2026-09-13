// High-risk hardening checks for composition-api/v0.1.
// This file deliberately uses only the real wf-ui HTTP API against isolated
// temporary projects; it does not write Harness/a2a state or invoke a UI.
import test, { after, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { makeHarnessTempRoot } from './support/temp-root.js';
import { SessionRegistry } from '../src/wf-ui-server/session-registry.mjs';
import { startServer, stopServer } from '../src/wf-ui-server/server.mjs';

const fixtureDir = path.resolve('tests/fixtures/runtime-092');
const originalPath = process.env.PATH || '';
let root;
let started;
let baseUrl;

function requestJson(method, route, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(route, baseUrl);
    const payload = body === undefined ? '' : JSON.stringify(body);
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method,
      headers: {
        Authorization: `Bearer ${started.token}`,
        ...(payload ? {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        } : {}),
      },
    }, response => {
      let text = '';
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(text); } catch { parsed = text; }
        resolve({ status: response.statusCode, body: parsed });
      });
    });
    req.once('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function details(response) {
  return `${response.status}: ${JSON.stringify(response.body)}`;
}

async function createNode(payload) {
  const response = await requestJson('POST', '/api/workflow/nodes', payload);
  assert.equal(response.status, 201, details(response));
  assert.ok(response.body.node?.nodeId, details(response));
  return response.body.node;
}

async function createAgent() {
  const response = await requestJson('POST', '/api/sessions', {
    runtime: 'codex',
    agentKind: 'main',
    role: 'Main Agent',
    objective: 'composition hardening HTTP fixture',
    attachGraphNode: true,
    deferPtySpawn: true,
  });
  assert.equal(response.status, 201, details(response));
  const nodeId = response.body.graphNodeId || response.body.nodeId;
  assert.ok(nodeId, details(response));
  assert.ok(response.body.sessionId, details(response));
  return { ...response.body, nodeId };
}

async function connect(from, to, relation, direction = 'source-to-target', handles = {}) {
  const response = await requestJson('POST', '/api/workflow/edges', {
    from,
    to,
    relation,
    direction,
    ...handles,
  });
  assert.equal(response.status, 201, details(response));
  return response.body.edge;
}

async function composition(id) {
  return requestJson('GET', `/api/workflow/compositions/${encodeURIComponent(id)}`);
}

async function restartBackend() {
  await stopServer(started.server);
  started = await startServer({
    projectRoot: root,
    host: '127.0.0.1',
    port: 0,
    sessionRegistry: new SessionRegistry(),
    eventsWs: false,
    chatWs: false,
  });
  baseUrl = `http://127.0.0.1:${started.port}`;
}

beforeEach(async () => {
  process.env.PATH = `${fixtureDir}${path.delimiter}${originalPath}`;
  root = makeHarnessTempRoot('node-composition-hardening-');
  fs.mkdirSync(path.join(root, 'Harness', 'tasks'), { recursive: true });
  started = await startServer({
    projectRoot: root,
    host: '127.0.0.1',
    port: 0,
    sessionRegistry: new SessionRegistry(),
    eventsWs: false,
    chatWs: false,
  });
  baseUrl = `http://127.0.0.1:${started.port}`;
});

afterEach(async () => {
  if (started) await stopServer(started.server);
  started = null;
  baseUrl = null;
  if (root) fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  root = null;
});

after(() => {
  process.env.PATH = originalPath;
});

test('COMPOSE-HARDEN-A: arbitrary composition ids are rejected or resolve to the canonical composition', async () => {
  const response = await composition('attacker-selected-composition');
  assert.ok(
    response.status >= 400 || response.body.compositionId === 'workflow-none',
    `arbitrary composition id must not become a second source of truth: ${details(response)}`,
  );
});

test('COMPOSE-HARDEN-B: concurrent timer actions with one idempotency key record one transition', async () => {
  const agent = await createAgent();
  const timer = await createNode({
    nodeId: 'event-composition-hardening-timer',
    type: 'timer',
    title: 'Hardening Timer',
    enabled: false,
    schedule: { mode: 'interval', intervalSeconds: 60 },
    controlPolicy: { agentCanSetInterval: true, minIntervalSeconds: 5, maxIntervalSeconds: 3600 },
  });
  await connect(agent.nodeId, timer.nodeId, 'control', 'source-to-target', {
    sourceHandle: 'context',
    targetHandle: 'config',
  });

  const payload = {
    actorNodeId: agent.nodeId,
    expectedRevision: timer.revision,
    intervalSeconds: 120,
    idempotencyKey: 'hardening-concurrent-interval',
  };
  const results = await Promise.all([
    requestJson('POST', `/api/workflow/nodes/${timer.nodeId}/actions/timer.setInterval`, payload),
    requestJson('POST', `/api/workflow/nodes/${timer.nodeId}/actions/timer.setInterval`, payload),
  ]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 200], results.map(details));
  assert.deepEqual(
    results.map(result => result.body.revision || result.body.state?.revision),
    [2, 2],
    results.map(details),
  );

  const snapshot = await composition('workflow-none');
  assert.equal(snapshot.status, 200, details(snapshot));
  assert.equal(snapshot.body.lastTransitions.length, 1, details(snapshot));
  assert.equal(snapshot.body.lastTransitions[0].stateRevision, 2, details(snapshot));
});

test('COMPOSE-HARDEN-C: wakeup read requires explicit ack/consumed state and does not redeliver', async () => {
  const agent = await createAgent();
  const timer = await createNode({
    nodeId: 'event-composition-hardening-wakeup',
    type: 'timer',
    title: 'Hardening Wakeup Timer',
    enabled: false,
    schedule: { mode: 'manual', intervalSeconds: 60 },
  });
  await connect(timer.nodeId, agent.nodeId, 'event', 'source-to-target', {
    sourceHandle: 'event',
    targetHandle: 'event',
  });

  const fired = await requestJson(
    'POST',
    `/api/workflow/nodes/${timer.nodeId}/actions/timer.fire`,
    { actorKind: 'main', idempotencyKey: 'hardening-wakeup-1' },
  );
  assert.equal(fired.status, 200, details(fired));
  const eventId = fired.body.result?.event?.id;
  assert.ok(eventId, details(fired));
  const dispatched = await requestJson(
    'POST',
    `/api/workflow/nodes/${timer.nodeId}/actions/timer.dispatchWakeup`,
    { actorKind: 'main', eventId, idempotencyKey: 'hardening-wakeup-1' },
  );
  assert.equal(dispatched.status, 200, details(dispatched));

  const first = await requestJson(
    'POST',
    `/api/workflow/nodes/${agent.nodeId}/actions/agent.readMessages`,
    { wakeup: true, afterSeq: 0 },
  );
  assert.equal(first.status, 200, details(first));
  assert.equal(first.body.result?.entries?.length, 1, details(first));
  const seq = first.body.result.entries[0].seq;

  // v0.1 requires an explicit pull acknowledgement. `ack:true` is additive
  // to the existing readMessages surface and must produce a durable consumed
  // cursor (not merely return an identical read result).
  const ack = await requestJson(
    'POST',
    `/api/workflow/nodes/${agent.nodeId}/actions/agent.readMessages`,
    { wakeup: true, afterSeq: seq, ack: true, consumedThroughSeq: seq },
  );
  assert.equal(ack.status, 200, details(ack));
  assert.ok(
    ack.body.result?.ack
      || ack.body.result?.consumed === true
      || Number(ack.body.result?.consumedThroughSeq || ack.body.result?.consumedSeq) >= seq,
    `wakeup pull must return explicit ack/consumed evidence: ${details(ack)}`,
  );

  const reread = await requestJson(
    'POST',
    `/api/workflow/nodes/${agent.nodeId}/actions/agent.readMessages`,
    { wakeup: true, afterSeq: 0 },
  );
  assert.equal(reread.status, 200, details(reread));
  assert.deepEqual(reread.body.result?.entries || [], [], details(reread));
});

test('COMPOSE-HARDEN-D: github-trigger cannot masquerade as Timer event or Timer action', async () => {
  const agent = await createAgent();
  const trigger = await createNode({
    nodeId: 'event-composition-hardening-github',
    type: 'github-trigger',
    title: 'Hardening GitHub Trigger',
    experimental: true,
  });

  const fakeEventEdge = await requestJson('POST', '/api/workflow/edges', {
    from: trigger.nodeId,
    to: agent.nodeId,
    relation: 'event',
    direction: 'source-to-target',
    sourceHandle: 'event',
    targetHandle: 'event',
  });
  assert.ok(fakeEventEdge.status >= 400, `github-trigger event edge must be rejected: ${details(fakeEventEdge)}`);

  const fakeTimerAction = await requestJson(
    'POST',
    `/api/workflow/nodes/${trigger.nodeId}/actions/timer.fire`,
    { actorKind: 'main', idempotencyKey: 'hardening-github-fire' },
  );
  assert.ok(fakeTimerAction.status >= 400, `github-trigger must not accept timer.fire: ${details(fakeTimerAction)}`);
});

test('COMPOSE-HARDEN-E: persisted FSM audit survives backend restart without reverting to idle', async () => {
  const agent = await createAgent();
  const timer = await createNode({
    nodeId: 'event-composition-hardening-restart',
    type: 'timer',
    title: 'Hardening Restart Timer',
    enabled: false,
    schedule: { mode: 'manual', intervalSeconds: 60 },
  });
  await connect(timer.nodeId, agent.nodeId, 'event', 'source-to-target', {
    sourceHandle: 'event',
    targetHandle: 'event',
  });
  const fired = await requestJson(
    'POST',
    `/api/workflow/nodes/${timer.nodeId}/actions/timer.fire`,
    { actorKind: 'main', idempotencyKey: 'hardening-restart-fire' },
  );
  assert.equal(fired.status, 200, details(fired));
  const dispatched = await requestJson(
    'POST',
    `/api/workflow/nodes/${timer.nodeId}/actions/timer.dispatchWakeup`,
    { actorKind: 'main', eventId: fired.body.result.event.id, idempotencyKey: 'hardening-restart-fire' },
  );
  assert.equal(dispatched.status, 200, details(dispatched));

  const before = await composition('workflow-none');
  assert.equal(before.status, 200, details(before));
  assert.notEqual(before.body.fsm.state, 'idle', details(before));
  assert.ok(before.body.lastTransitions.length >= 1, details(before));
  const transitionIds = before.body.lastTransitions.map(transition => transition.transitionId);

  await restartBackend();
  const afterRestart = await composition('workflow-none');
  assert.equal(afterRestart.status, 200, details(afterRestart));
  assert.notEqual(afterRestart.body.fsm.state, 'idle', details(afterRestart));
  assert.deepEqual(
    afterRestart.body.lastTransitions.map(transition => transition.transitionId),
    transitionIds,
    details(afterRestart),
  );
});

