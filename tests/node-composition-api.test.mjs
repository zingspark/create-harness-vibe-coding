// composition-api/v0.1 RED integration contract.
// These tests intentionally drive only the real wf-ui HTTP surface.  They do
// not import node stores, use the UI, or write Harness/a2a state files.
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

function explain(response) {
  return `${response.status}: ${JSON.stringify(response.body)}`;
}

async function createTimer(overrides = {}) {
  const response = await requestJson('POST', '/api/workflow/nodes', {
    type: 'timer',
    nodeId: 'event-composition-api-timer',
    title: 'Composition API Timer',
    enabled: false,
    schedule: { mode: 'interval', intervalSeconds: 60 },
    controlPolicy: {
      agentCanSetInterval: true,
      agentCanSetMode: true,
      agentCanDisable: true,
      minIntervalSeconds: 5,
      maxIntervalSeconds: 3600,
    },
    ...overrides,
  });
  assert.equal(response.status, 201, explain(response));
  return response.body.node;
}

async function createAgent() {
  const response = await requestJson('POST', '/api/sessions', {
    runtime: 'codex',
    agentKind: 'main',
    role: 'Main Agent',
    objective: 'composition-api contract fixture',
    attachGraphNode: true,
    deferPtySpawn: true,
  });
  assert.equal(response.status, 201, explain(response));
  const nodeId = response.body.graphNodeId || response.body.nodeId;
  assert.ok(nodeId, explain(response));
  assert.ok(response.body.sessionId, explain(response));
  return { ...response.body, nodeId };
}

async function connect(from, to, relation, handles = {}) {
  const response = await requestJson('POST', '/api/workflow/edges', {
    from,
    to,
    relation,
    direction: 'source-to-target',
    ...handles,
  });
  assert.equal(response.status, 201, explain(response));
  return response.body.edge;
}

beforeEach(async () => {
  process.env.PATH = `${fixtureDir}${path.delimiter}${originalPath}`;
  root = makeHarnessTempRoot('node-composition-api-');
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

test('COMPOSE-AC-01: event/control ports and direction are enforced by the edge API', async () => {
  const agent = await createAgent();
  const timer = await createTimer();

  const eventEdge = await connect(timer.nodeId, agent.nodeId, 'event', {
    sourceHandle: 'event',
    targetHandle: 'event',
  });
  assert.equal(eventEdge.relation, 'event');
  assert.equal(eventEdge.direction, 'source-to-target');
  assert.equal(eventEdge.sourceHandle, 'event');

  const controlEdge = await connect(agent.nodeId, timer.nodeId, 'control', {
    sourceHandle: 'context',
    targetHandle: 'config',
  });
  assert.equal(controlEdge.relation, 'control');
  assert.equal(controlEdge.direction, 'source-to-target');
  assert.equal(controlEdge.sourceHandle, 'context');
  assert.equal(controlEdge.targetHandle, 'config');

  // Contract requires the reverse Timer -> Agent control relation to be
  // rejected. Current implementation accepts arbitrary semantic edges.
  const reverse = await requestJson('POST', '/api/workflow/edges', {
    from: timer.nodeId,
    to: agent.nodeId,
    relation: 'control',
    direction: 'source-to-target',
    sourceHandle: 'config',
    targetHandle: 'context',
  });
  assert.ok(reverse.status >= 400, `reverse control must be rejected: ${explain(reverse)}`);
});

test('COMPOSE-AC-02: timer action rejects a stale expected revision', async () => {
  const agent = await createAgent();
  const timer = await createTimer();
  await connect(agent.nodeId, timer.nodeId, 'control', {
    sourceHandle: 'context',
    targetHandle: 'config',
  });

  const first = await requestJson(
    'POST',
    `/api/workflow/nodes/${timer.nodeId}/actions/timer.setInterval`,
    {
      actorNodeId: agent.nodeId,
      expectedRevision: timer.revision,
      intervalSeconds: 120,
      idempotencyKey: 'compose-interval-1',
    },
  );
  assert.equal(first.status, 200, explain(first));
  const firstRevision = first.body.revision || first.body.state?.revision;
  assert.ok(firstRevision > timer.revision, explain(first));

  const stale = await requestJson(
    'POST',
    `/api/workflow/nodes/${timer.nodeId}/actions/timer.setInterval`,
    {
      actorNodeId: agent.nodeId,
      expectedRevision: timer.revision,
      intervalSeconds: 180,
      idempotencyKey: 'compose-interval-stale',
    },
  );
  assert.equal(stale.status, 409, explain(stale));
  assert.equal(stale.body.error?.code, 'STALE_REVISION');
});

test('COMPOSE-AC-02: repeated timer action idempotency key returns one transition', async () => {
  const agent = await createAgent();
  const timer = await createTimer();
  await connect(agent.nodeId, timer.nodeId, 'control', {
    sourceHandle: 'context',
    targetHandle: 'config',
  });

  const first = await requestJson(
    'POST',
    `/api/workflow/nodes/${timer.nodeId}/actions/timer.setInterval`,
    {
      actorNodeId: agent.nodeId,
      expectedRevision: timer.revision,
      intervalSeconds: 120,
      idempotencyKey: 'compose-interval-idem',
    },
  );
  assert.equal(first.status, 200, explain(first));
  const firstRevision = first.body.revision || first.body.state?.revision;
  assert.ok(firstRevision > timer.revision, explain(first));

  const duplicate = await requestJson(
    'POST',
    `/api/workflow/nodes/${timer.nodeId}/actions/timer.setInterval`,
    {
      actorNodeId: agent.nodeId,
      expectedRevision: timer.revision,
      intervalSeconds: 120,
      idempotencyKey: 'compose-interval-idem',
    },
  );
  assert.equal(duplicate.status, 200, explain(duplicate));
  assert.equal(duplicate.body.revision || duplicate.body.state?.revision, firstRevision,
    'same idempotency key must return the original transition without another revision');
});

test('COMPOSE-AC-03: timer fire dispatches one wakeup that Agent pulls without PTY input', async () => {
  const agent = await createAgent();
  const timer = await createTimer({ enabled: true });
  await connect(timer.nodeId, agent.nodeId, 'event', {
    sourceHandle: 'event',
    targetHandle: 'event',
  });

  const fired = await requestJson(
    'POST',
    `/api/workflow/nodes/${timer.nodeId}/actions/timer.fire`,
    { actorKind: 'main', idempotencyKey: 'compose-fire-1' },
  );
  assert.equal(fired.status, 200, explain(fired));
  assert.ok(fired.body.result?.event?.id, explain(fired));

  const dispatched = await requestJson(
    'POST',
    `/api/workflow/nodes/${timer.nodeId}/actions/timer.dispatchWakeup`,
    {
      actorKind: 'main',
      idempotencyKey: 'compose-fire-1',
      eventId: fired.body.result.event.id,
    },
  );
  assert.equal(dispatched.status, 200, explain(dispatched));
  assert.equal(dispatched.body.result?.envelope?.timerNodeId, timer.nodeId, explain(dispatched));
  assert.ok(dispatched.body.result?.envelope?.transitionId, 'wakeup envelope needs an FSM transition id');

  const mailbox = await requestJson(
    'POST',
    `/api/workflow/nodes/${agent.nodeId}/actions/agent.readMessages`,
    { wakeup: true, afterSeq: 0 },
  );
  assert.equal(mailbox.status, 200, explain(mailbox));
  assert.equal(mailbox.body.result?.entries?.length, 1, explain(mailbox));
  const wakeup = JSON.parse(mailbox.body.result.entries[0].data);
  assert.equal(wakeup.timerNodeId, timer.nodeId);
  assert.equal(mailbox.body.result.entries[0].deliveryMode, 'wakeup');
  assert.equal(mailbox.body.result.entries[0].ptyInjected, undefined,
    'timer wakeup is a bridge message, never PTY input');
});

test('COMPOSE-AC-04: control policy and edge are required before Agent timer mutation', async () => {
  const agent = await createAgent();
  const timer = await createTimer({
    controlPolicy: { agentCanSetInterval: false, minIntervalSeconds: 5, maxIntervalSeconds: 3600 },
  });

  const missingEdge = await requestJson(
    'POST',
    `/api/workflow/nodes/${timer.nodeId}/actions/timer.setInterval`,
    { actorNodeId: agent.nodeId, intervalSeconds: 120 },
  );
  assert.equal(missingEdge.status, 403, explain(missingEdge));
  assert.equal(missingEdge.body.error?.code, 'CONTROL_EDGE_REQUIRED');

  await connect(agent.nodeId, timer.nodeId, 'control', {
    sourceHandle: 'context',
    targetHandle: 'config',
  });
  const denied = await requestJson(
    'POST',
    `/api/workflow/nodes/${timer.nodeId}/actions/timer.setInterval`,
    { actorNodeId: agent.nodeId, intervalSeconds: 120 },
  );
  assert.equal(denied.status, 403, explain(denied));
  assert.equal(denied.body.error?.code, 'CONTROL_DENIED');
});

test('COMPOSE-AC-05: context is rebuilt from graph and composition aggregation is read-only', async () => {
  const agent = await createAgent();
  const timer = await createTimer();
  await connect(timer.nodeId, agent.nodeId, 'event', {
    sourceHandle: 'event',
    targetHandle: 'event',
  });
  await connect(agent.nodeId, timer.nodeId, 'control', {
    sourceHandle: 'context',
    targetHandle: 'config',
  });

  const context = await requestJson('GET', `/api/workflow/context/${agent.nodeId}`);
  assert.equal(context.status, 200, explain(context));
  const eventRef = context.body.context?.connectedEventRefs?.find(ref => ref.nodeId === timer.nodeId);
  assert.ok(eventRef, explain(context));
  assert.ok(eventRef.connections?.some(connection => connection.relation === 'event'), explain(context));
  assert.ok(eventRef.connections?.some(connection => (
    connection.relation === 'control'
      && connection.direction === 'source-to-target'
      && connection.sourceHandle === 'context'
      && connection.targetHandle === 'config'
  )), explain(context));
  assert.ok(eventRef.allowedActions?.includes('timer.setInterval'), explain(context));
  assert.ok(Number.isInteger(context.body.context.graphVersion), explain(context));

  // Composition snapshot is an additive, read-only aggregation endpoint in
  // composition-api/v0.1. It must exist independently of the UI.
  const composition = await requestJson('GET', '/api/workflow/compositions/workflow-none');
  assert.equal(composition.status, 200, explain(composition));
  for (const field of ['schemaVersion', 'compositionId', 'graphVersion', 'fsm', 'timer', 'agents', 'edges', 'lastTransitions']) {
    assert.ok(Object.hasOwn(composition.body, field), `composition snapshot missing ${field}: ${explain(composition)}`);
  }
  assert.equal(composition.body.compositionId, 'workflow-none');
});
