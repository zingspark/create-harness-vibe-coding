// Composition consistency hardening checks. These are black-box tests against
// the real wf-ui HTTP server and its real timer scheduler. Task fixtures are
// created only inside an isolated temporary project; no production
// Harness/a2a state is touched and no UI or provider is invoked.
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

function requestJson(method, route, body, extraHeaders = {}) {
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
        ...extraHeaders,
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

async function createAgent(objective = 'composition consistency hardening fixture') {
  const response = await requestJson('POST', '/api/sessions', {
    runtime: 'codex',
    agentKind: 'main',
    role: 'Main Agent',
    objective,
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
  assert.ok(response.body.edge?.id, details(response));
  return response.body.edge;
}

async function composition(id) {
  return requestJson('GET', `/api/workflow/compositions/${encodeURIComponent(id)}`);
}

async function graphSnapshot() {
  const response = await requestJson('GET', '/api/a2a/graph-map');
  assert.equal(response.status, 200, details(response));
  return response.body;
}

async function fireAndDispatch(timerNodeId, idempotencyKey) {
  const fired = await requestJson(
    'POST',
    `/api/workflow/nodes/${encodeURIComponent(timerNodeId)}/actions/timer.fire`,
    { actorKind: 'main', idempotencyKey: `${idempotencyKey}-fire` },
  );
  assert.equal(fired.status, 200, details(fired));
  const eventId = fired.body.result?.event?.id;
  assert.ok(eventId, details(fired));
  const dispatched = await requestJson(
    'POST',
    `/api/workflow/nodes/${encodeURIComponent(timerNodeId)}/actions/timer.dispatchWakeup`,
    { actorKind: 'main', eventId, idempotencyKey: `${idempotencyKey}-dispatch` },
  );
  assert.equal(dispatched.status, 200, details(dispatched));
  return { fired, dispatched, eventId };
}

// The composition id is derived from the active task pointer. These files are
// fixture setup under the temp root only, not writes to the real project.
function seedActiveTask(taskId) {
  const taskRoot = path.join(root, 'Harness', 'tasks', taskId);
  fs.mkdirSync(taskRoot, { recursive: true });
  fs.writeFileSync(path.join(root, 'Harness', 'PROGRESS.md'), [
    '# Progress',
    '',
    '## Active Task',
    '',
    `- ${taskId}`,
    '',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(taskRoot, 'STATE.json'), JSON.stringify({
    schemaVersion: 1,
    taskId,
    status: 'active',
    mode: 'wf',
    phase: 'implement',
    gate: 'TEST-GATE',
    acceptance: [],
    links: { dependsOn: [], blocks: [], related: [] },
  }, null, 2), 'utf8');
  fs.writeFileSync(path.join(taskRoot, 'PLAN.md'), '# consistency fixture\n', 'utf8');
  fs.writeFileSync(path.join(taskRoot, 'PROGRESS.md'), '# consistency fixture\n', 'utf8');
  return `workflow-${taskId}`;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

beforeEach(async () => {
  process.env.PATH = `${fixtureDir}${path.delimiter}${originalPath}`;
  root = makeHarnessTempRoot('node-composition-consistency-');
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

test('CONSISTENCY-01: timer.fire makes the next composition snapshot fresh', async () => {
  const timer = await createNode({
    nodeId: 'event-consistency-freshness-timer',
    type: 'timer',
    title: 'Freshness Timer',
    enabled: false,
    schedule: { mode: 'manual', intervalSeconds: 60 },
  });
  const before = await composition('workflow-none');
  assert.equal(before.status, 200, details(before));

  const fired = await requestJson(
    'POST',
    `/api/workflow/nodes/${timer.nodeId}/actions/timer.fire`,
    { actorKind: 'main', idempotencyKey: 'consistency-freshness-fire' },
  );
  assert.equal(fired.status, 200, details(fired));

  const afterFire = await composition('workflow-none');
  assert.equal(afterFire.status, 200, details(afterFire));
  assert.ok(
    Number(afterFire.body.graphVersion) > Number(before.body.graphVersion)
      || JSON.stringify(afterFire.body.lastTransitions) !== JSON.stringify(before.body.lastTransitions),
    `timer.fire must invalidate composition freshness: before=${details(before)} after=${details(afterFire)}`,
  );
});

test('CONSISTENCY-02: graph-map PUT cannot bypass Timer/GitHub event-control ontology', async () => {
  const agent = await createAgent();
  const timer = await createNode({
    nodeId: 'event-consistency-graph-timer',
    type: 'timer',
    title: 'Graph Validation Timer',
    enabled: false,
    schedule: { mode: 'manual', intervalSeconds: 60 },
  });
  const github = await createNode({
    nodeId: 'event-consistency-graph-github',
    type: 'github-trigger',
    title: 'Graph Validation GitHub Trigger',
    experimental: true,
  });
  const graph = await graphSnapshot();

  const invalidTimerEvent = await requestJson(
    'PUT',
    '/api/a2a/graph-map',
    {
      ...graph,
      edges: [...(graph.edges || []), {
        id: 'invalid-timer-event-direction',
        from: timer.nodeId,
        to: agent.nodeId,
        relation: 'event',
        direction: 'bidirectional',
        sourceHandle: 'event',
        targetHandle: 'event',
      }],
    },
    { 'If-Match': String(graph.version) },
  );
  assert.ok(invalidTimerEvent.status >= 400, `graph-map PUT accepted invalid Timer event: ${details(invalidTimerEvent)}`);

  const invalidGithubControl = await requestJson(
    'PUT',
    '/api/a2a/graph-map',
    {
      ...graph,
      edges: [...(graph.edges || []), {
        id: 'invalid-github-control',
        from: github.nodeId,
        to: agent.nodeId,
        relation: 'control',
        direction: 'source-to-target',
        sourceHandle: 'event',
        targetHandle: 'event',
      }],
    },
    { 'If-Match': String(graph.version) },
  );
  assert.ok(invalidGithubControl.status >= 400, `graph-map PUT accepted invalid GitHub control: ${details(invalidGithubControl)}`);
});

test('CONSISTENCY-03: per-bridge mailbox cursors do not consume another Timer wakeup', async () => {
  const agent = await createAgent();
  const timerA = await createNode({
    nodeId: 'event-consistency-bridge-a',
    type: 'timer',
    title: 'Bridge Timer A',
    enabled: false,
    schedule: { mode: 'manual', intervalSeconds: 60 },
  });
  const timerB = await createNode({
    nodeId: 'event-consistency-bridge-b',
    type: 'timer',
    title: 'Bridge Timer B',
    enabled: false,
    schedule: { mode: 'manual', intervalSeconds: 60 },
  });
  await connect(timerA.nodeId, agent.nodeId, 'event', 'source-to-target', { sourceHandle: 'event', targetHandle: 'event' });
  await connect(timerB.nodeId, agent.nodeId, 'event', 'source-to-target', { sourceHandle: 'event', targetHandle: 'event' });
  await fireAndDispatch(timerA.nodeId, 'consistency-bridge-a');
  await fireAndDispatch(timerB.nodeId, 'consistency-bridge-b');

  const firstRead = await requestJson(
    'POST',
    `/api/workflow/nodes/${agent.nodeId}/actions/agent.readMessages`,
    { wakeup: true, afterSeq: 0 },
  );
  assert.equal(firstRead.status, 200, details(firstRead));
  const entries = firstRead.body.result?.entries || [];
  const entryA = entries.find(entry => JSON.parse(entry.data).timerNodeId === timerA.nodeId);
  const entryB = entries.find(entry => JSON.parse(entry.data).timerNodeId === timerB.nodeId);
  assert.ok(entryA && entryB, details(firstRead));
  assert.equal(entryA.seq, 1, details(firstRead));
  assert.equal(entryB.seq, 1, details(firstRead));
  assert.notEqual(entryA.bridgeId, entryB.bridgeId, details(firstRead));

  const ackA = await requestJson(
    'POST',
    `/api/workflow/nodes/${agent.nodeId}/actions/agent.readMessages`,
    {
      wakeup: true,
      bridgeId: entryA.bridgeId,
      afterSeq: entryA.seq,
      ack: true,
      consumedThroughSeq: entryA.seq,
    },
  );
  assert.equal(ackA.status, 200, details(ackA));
  assert.ok(ackA.body.result?.ack || ackA.body.result?.consumed, details(ackA));

  const secondRead = await requestJson(
    'POST',
    `/api/workflow/nodes/${agent.nodeId}/actions/agent.readMessages`,
    { wakeup: true, bridgeId: entryB.bridgeId, afterSeq: 0 },
  );
  assert.equal(secondRead.status, 200, details(secondRead));
  assert.ok(
    (secondRead.body.result?.entries || []).some(entry => entry.bridgeId === entryB.bridgeId),
    `acknowledging bridge A must not consume bridge B: ${details(secondRead)}`,
  );
});

test('CONSISTENCY-04: composition audit transitions are isolated after active-task switch', async () => {
  const compositionA = seedActiveTask('task-consistency-a');
  const agent = await createAgent('composition audit isolation agent');
  const timer = await createNode({
    nodeId: 'event-consistency-audit-timer',
    type: 'timer',
    title: 'Audit Isolation Timer',
    enabled: false,
    schedule: { mode: 'manual', intervalSeconds: 60 },
  });
  await connect(timer.nodeId, agent.nodeId, 'event', 'source-to-target', { sourceHandle: 'event', targetHandle: 'event' });
  const { eventId } = await fireAndDispatch(timer.nodeId, 'consistency-audit');
  const beforeSwitch = await composition(compositionA);
  assert.equal(beforeSwitch.status, 200, details(beforeSwitch));
  assert.ok(beforeSwitch.body.lastTransitions.some(transition => transition.eventId === eventId), details(beforeSwitch));

  const compositionB = seedActiveTask('task-consistency-b');
  const afterSwitch = await composition(compositionB);
  assert.equal(afterSwitch.status, 200, details(afterSwitch));
  assert.equal(afterSwitch.body.compositionId, compositionB, details(afterSwitch));
  assert.equal(
    afterSwitch.body.lastTransitions.some(transition => transition.compositionId === compositionA),
    false,
    `new composition must not expose old audit transitions: ${details(afterSwitch)}`,
  );
});

test('CONSISTENCY-05: ordinary Timer -> Agent -> Goal wakeup carries goalNodeId', async () => {
  const taskId = 'task-consistency-goal';
  const goalId = seedActiveTask(taskId);
  const agent = await createAgent('composition goal wakeup agent');
  const timer = await createNode({
    nodeId: 'event-consistency-goal-timer',
    type: 'timer',
    title: 'Goal Wakeup Timer',
    enabled: false,
    schedule: { mode: 'manual', intervalSeconds: 60 },
  });
  const goalResponse = await requestJson('POST', '/api/workflow/nodes', {
    type: 'goal',
    nodeId: goalId,
    title: 'Consistency Goal',
  });
  assert.equal(goalResponse.status, 201, details(goalResponse));
  const goal = goalResponse.body.node;
  await connect(timer.nodeId, agent.nodeId, 'event', 'source-to-target', { sourceHandle: 'event', targetHandle: 'event' });
  await connect(agent.nodeId, goal.nodeId, 'goal', 'bidirectional', { sourceHandle: 'context', targetHandle: 'goal:right' });
  await fireAndDispatch(timer.nodeId, 'consistency-goal');

  const mailbox = await requestJson(
    'POST',
    `/api/workflow/nodes/${agent.nodeId}/actions/agent.readMessages`,
    { wakeup: true, afterSeq: 0 },
  );
  assert.equal(mailbox.status, 200, details(mailbox));
  assert.equal(mailbox.body.result?.entries?.length, 1, details(mailbox));
  const envelope = JSON.parse(mailbox.body.result.entries[0].data);
  assert.equal(envelope.goalNodeId, goal.nodeId, `wakeup must identify ordinary graph Goal edge: ${details(mailbox)}`);
});

test('CONSISTENCY-06: enabled short-interval Timer automatically wakes its Agent', async () => {
  const agent = await createAgent('automatic scheduler consistency agent');
  const timer = await createNode({
    nodeId: 'event-consistency-scheduler-timer',
    type: 'timer',
    title: 'Automatic Scheduler Timer',
    enabled: true,
    schedule: { mode: 'interval', intervalSeconds: 1 },
    heartbeat: { base: { enabled: true, intervalSeconds: 1 } },
    controlPolicy: { minIntervalSeconds: 1, maxIntervalSeconds: 60 },
  });
  await connect(timer.nodeId, agent.nodeId, 'event', 'source-to-target', { sourceHandle: 'event', targetHandle: 'event' });

  const deadline = Date.now() + 5000;
  let mailbox = null;
  while (Date.now() < deadline) {
    mailbox = await requestJson(
      'POST',
      `/api/workflow/nodes/${agent.nodeId}/actions/agent.readMessages`,
      { wakeup: true, afterSeq: 0, limit: 10 },
    );
    assert.equal(mailbox.status, 200, details(mailbox));
    if ((mailbox.body.result?.entries || []).some(entry => JSON.parse(entry.data).timerNodeId === timer.nodeId)) break;
    await delay(200);
  }
  assert.ok(
    (mailbox?.body.result?.entries || []).some(entry => JSON.parse(entry.data).timerNodeId === timer.nodeId),
    `scheduler must produce a wakeup without timer.fire HTTP action: ${details(mailbox || { status: 0, body: {} })}`,
  );
});

