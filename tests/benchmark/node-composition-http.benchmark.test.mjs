// Native node-composition benchmark.
//
// These scenarios intentionally use only the public wf-ui HTTP API against
// isolated temporary project roots.  They are executable acceptance probes,
// rather than unit tests: every node, edge, context read, action, and delete
// goes through the same API that a non-UI client would use.
import test, { after, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { makeHarnessTempRoot } from '../support/temp-root.js';
import { SessionRegistry } from '../../src/wf-ui-server/session-registry.mjs';
import { startServer, stopServer } from '../../src/wf-ui-server/server.mjs';

const fixtureDir = path.resolve('tests/fixtures/runtime-092');
const originalPath = process.env.PATH || '';
let root;
let started;
let baseUrl;
let httpCalls;

function requestJson(method, route, body) {
  httpCalls += 1;
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

async function createAgent(objective = 'HTTP composition benchmark agent') {
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

async function connect(from, to, relation, direction, handles = {}) {
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

async function graphSnapshot() {
  const response = await requestJson('GET', '/api/a2a/graph-map');
  assert.equal(response.status, 200, details(response));
  return response.body;
}

async function compositionSnapshot(compositionId = 'workflow-none') {
  const response = await requestJson(
    'GET',
    `/api/workflow/compositions/${encodeURIComponent(compositionId)}`,
  );
  assert.equal(response.status, 200, details(response));
  return response.body;
}

async function deleteNode(nodeId) {
  const response = await requestJson(
    'POST',
    `/api/workflow/nodes/${encodeURIComponent(nodeId)}/actions/node.delete`,
    {},
  );
  assert.equal(response.status, 200, details(response));
  return response.body;
}

function seedActiveTask(taskId = 'task-http-composition-benchmark') {
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
    title: 'HTTP composition benchmark goal',
    nextAction: 'Run native composition scenarios',
    acceptance: [
      { id: 'BENCH-001', status: 'tracked', text: 'Timer wakeup reaches the connected Agent.' },
      { id: 'BENCH-002', status: 'tracked', text: 'Agent can update the linked Goal.' },
    ],
    planItems: [],
    links: { dependsOn: [], blocks: [], related: [] },
  }, null, 2), 'utf8');
  fs.writeFileSync(path.join(taskRoot, 'PLAN.md'), '# HTTP composition benchmark plan\n', 'utf8');
  fs.writeFileSync(path.join(taskRoot, 'PROGRESS.md'), '# HTTP composition benchmark progress\n', 'utf8');
  return `goal-${taskId}`;
}

beforeEach(async () => {
  process.env.PATH = `${fixtureDir}${path.delimiter}${originalPath}`;
  root = makeHarnessTempRoot('node-composition-http-benchmark-');
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
  httpCalls = 0;
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

test('BENCH-A: Timer -> Agent -> Goal completes a native wakeup/control loop', async (t) => {
  const startedAt = performance.now();
  const goalId = seedActiveTask();
  const agent = await createAgent('Timer wakeup and Goal update benchmark');
  const timer = await createNode({
    nodeId: 'event-http-benchmark-timer',
    type: 'timer',
    title: 'HTTP Benchmark Timer',
    enabled: true,
    schedule: { mode: 'manual', intervalSeconds: 60 },
    controlPolicy: {
      agentCanSetInterval: true,
      minIntervalSeconds: 5,
      maxIntervalSeconds: 3600,
    },
  });
  const goalResponse = await requestJson('POST', '/api/workflow/nodes', {
    type: 'goal',
    nodeId: goalId,
    title: 'HTTP Benchmark Goal',
  });
  assert.equal(goalResponse.status, 201, details(goalResponse));
  const goal = goalResponse.body.node;
  assert.equal(goal.nodeId, goalId, details(goalResponse));

  const eventEdge = await connect(timer.nodeId, agent.nodeId, 'event', 'source-to-target', {
    sourceHandle: 'event',
    targetHandle: 'event',
  });
  const controlEdge = await connect(agent.nodeId, timer.nodeId, 'control', 'source-to-target', {
    sourceHandle: 'context',
    targetHandle: 'config',
  });
  const goalEdge = await connect(agent.nodeId, goal.nodeId, 'goal', 'bidirectional', {
    sourceHandle: 'context',
    targetHandle: 'goal:right',
  });
  assert.equal(eventEdge.direction, 'source-to-target');
  assert.equal(controlEdge.relation, 'control');
  assert.equal(goalEdge.relation, 'goal');

  const context = await requestJson('GET', `/api/workflow/context/${agent.nodeId}`);
  assert.equal(context.status, 200, details(context));
  assert.ok(context.body.context.connectedEventRefs.some(ref => ref.nodeId === timer.nodeId), details(context));
  assert.ok(context.body.context.connectedGoalRefs.some(ref => ref.nodeId === goal.nodeId), details(context));

  const interval = await requestJson(
    'POST',
    `/api/workflow/nodes/${timer.nodeId}/actions/timer.setInterval`,
    {
      actorNodeId: agent.nodeId,
      intervalSeconds: 120,
      idempotencyKey: 'benchmark-timer-control-1',
    },
  );
  assert.equal(interval.status, 200, details(interval));
  assert.equal(interval.body.state.schedule.intervalSeconds, 120, details(interval));

  const fired = await requestJson(
    'POST',
    `/api/workflow/nodes/${timer.nodeId}/actions/timer.fire`,
    { actorKind: 'main', idempotencyKey: 'benchmark-timer-fire-1' },
  );
  assert.equal(fired.status, 200, details(fired));
  const eventId = fired.body.result?.event?.id;
  assert.ok(eventId, details(fired));
  const dispatched = await requestJson(
    'POST',
    `/api/workflow/nodes/${timer.nodeId}/actions/timer.dispatchWakeup`,
    { actorKind: 'main', eventId, idempotencyKey: 'benchmark-wakeup-1' },
  );
  assert.equal(dispatched.status, 200, details(dispatched));

  const mailbox = await requestJson(
    'POST',
    `/api/workflow/nodes/${agent.nodeId}/actions/agent.readMessages`,
    { wakeup: true, afterSeq: 0 },
  );
  assert.equal(mailbox.status, 200, details(mailbox));
  assert.equal(mailbox.body.result?.entries?.length, 1, details(mailbox));
  const wakeup = JSON.parse(mailbox.body.result.entries[0].data);
  assert.equal(wakeup.timerNodeId, timer.nodeId);

  const goalUpdate = await requestJson(
    'POST',
    `/api/workflow/nodes/${goal.nodeId}/actions/goal.update`,
    {
      actorNodeId: agent.nodeId,
      title: 'Goal updated by connected Agent',
      nextAction: 'Review wakeup evidence',
    },
  );
  assert.equal(goalUpdate.status, 200, details(goalUpdate));
  assert.equal(goalUpdate.body.result.state.title, 'Goal updated by connected Agent', details(goalUpdate));

  const composition = await compositionSnapshot('workflow-task-http-composition-benchmark');
  assert.equal(composition.compositionId, 'workflow-task-http-composition-benchmark');
  assert.ok(composition.graphVersion >= 1);
  assert.notEqual(composition.fsm.state, 'idle');
  assert.ok(composition.lastTransitions.some(transition => transition.eventId === eventId));

  // Delete the event and Goal through node actions. The remaining Agent must
  // not retain semantic edges to either removed node.
  await deleteNode(timer.nodeId);
  await deleteNode(goal.nodeId);
  const graph = await graphSnapshot();
  assert.equal(graph.nodes.some(node => (node.nodeId || node.id) === timer.nodeId), false, JSON.stringify(graph));
  assert.equal(graph.nodes.some(node => (node.nodeId || node.id) === goal.nodeId), false, JSON.stringify(graph));
  assert.deepEqual(
    graph.edges.filter(edge => [timer.nodeId, goal.nodeId].includes(edge.from) || [timer.nodeId, goal.nodeId].includes(edge.to)),
    [],
    JSON.stringify(graph),
  );
  t.diagnostic(`BENCH-A elapsedMs=${(performance.now() - startedAt).toFixed(1)} httpCalls=${httpCalls}`);
});

test('BENCH-B: Markdown + File + Skill + MCP -> Agent -> Display remains coherent after deletes', async (t) => {
  const startedAt = performance.now();
  fs.writeFileSync(path.join(root, 'benchmark-input.txt'), 'native benchmark input\n', 'utf8');
  const agent = await createAgent('Resource and capability fan-in benchmark');
  const markdown = await createNode({
    nodeId: 'component-http-benchmark-markdown',
    type: 'markdown',
    title: 'HTTP Benchmark Notes',
    markdown: '# Native benchmark context\n',
  });
  const file = await createNode({
    nodeId: 'component-http-benchmark-file',
    type: 'file',
    title: 'benchmark-input.txt',
    file: {
      source: 'workspace',
      path: 'benchmark-input.txt',
      name: 'benchmark-input.txt',
      mime: 'text/plain',
      size: 24,
    },
  });
  const skillGroup = await createNode({
    nodeId: 'capability-http-benchmark-skills',
    type: 'skill-group',
    title: 'HTTP Benchmark Skills',
    sourceGroup: { id: 'benchmark', label: 'Benchmark Capability Pack', kind: 'family' },
    skills: [
      { id: 'skill:benchmark-review', name: 'benchmark-review', title: 'Benchmark Review' },
      { id: 'skill:benchmark-report', name: 'benchmark-report', title: 'Benchmark Report' },
    ],
  });
  const connector = await createNode({
    nodeId: 'capability-http-benchmark-mcp',
    type: 'mcp-connector',
    title: 'HTTP Benchmark MCP',
    server: {
      id: 'benchmark-local',
      name: 'benchmark-local',
      title: 'Benchmark Local MCP',
      transport: 'stdio',
      command: 'echo',
      env: { BENCHMARK_SECRET: 'must-not-leak' },
    },
  });
  const display = await createNode({
    nodeId: 'component-http-benchmark-display',
    type: 'display',
    title: 'HTTP Benchmark Output',
  });

  await connect(markdown.nodeId, agent.nodeId, 'context', 'source-to-target', {
    sourceHandle: 'markdown',
    targetHandle: 'context',
  });
  await connect(file.nodeId, agent.nodeId, 'context', 'source-to-target', {
    sourceHandle: 'file',
    targetHandle: 'context',
  });
  await connect(agent.nodeId, skillGroup.nodeId, 'capability', 'bidirectional', {
    sourceHandle: 'right',
    targetHandle: 'capability:left',
  });
  await connect(agent.nodeId, connector.nodeId, 'capability', 'bidirectional', {
    sourceHandle: 'right',
    targetHandle: 'capability:left',
  });
  await connect(agent.nodeId, display.nodeId, 'output', 'source-to-target', {
    sourceHandle: 'output',
    targetHandle: 'display',
  });

  const contextResponse = await requestJson('GET', `/api/workflow/context/${agent.nodeId}`);
  assert.equal(contextResponse.status, 200, details(contextResponse));
  const context = contextResponse.body.context;
  const resourceIds = new Set((context.connectedResourceRefs || []).map(ref => ref.nodeId));
  assert.ok(resourceIds.has(markdown.nodeId), details(contextResponse));
  assert.ok(resourceIds.has(file.nodeId), details(contextResponse));
  assert.ok(resourceIds.has(display.nodeId), details(contextResponse));
  const capabilityRefs = context.connectedCapabilityNodeRefs || [];
  assert.ok(capabilityRefs.some(ref => ref.nodeId === skillGroup.nodeId && ref.capabilityKind === 'skill-group'), details(contextResponse));
  assert.ok(capabilityRefs.some(ref => ref.nodeId === connector.nodeId && ref.capabilityKind === 'mcp-connector'), details(contextResponse));
  assert.ok(context.effectiveSkills.includes('benchmark-review'), details(contextResponse));
  assert.ok(context.effectiveSkills.includes('benchmark-report'), details(contextResponse));
  assert.equal(JSON.stringify(context).includes('must-not-leak'), false, details(contextResponse));

  const fileWrite = await requestJson(
    'POST',
    `/api/workflow/nodes/${file.nodeId}/actions/file.writeText`,
    { content: 'native benchmark output\n' },
  );
  assert.equal(fileWrite.status, 200, details(fileWrite));
  assert.equal(fileWrite.body.result?.path, 'benchmark-input.txt', details(fileWrite));
  assert.equal(fs.readFileSync(path.join(root, 'benchmark-input.txt'), 'utf8'), 'native benchmark output\n');

  await deleteNode(markdown.nodeId);
  let graph = await graphSnapshot();
  assert.equal(graph.edges.some(edge => edge.from === markdown.nodeId || edge.to === markdown.nodeId), false, JSON.stringify(graph));
  for (const node of [file, skillGroup, connector, display]) await deleteNode(node.nodeId);
  graph = await graphSnapshot();
  assert.deepEqual(graph.edges, [], JSON.stringify(graph));
  assert.deepEqual(
    graph.nodes.map(node => node.nodeId || node.id),
    [agent.nodeId],
    JSON.stringify(graph),
  );
  t.diagnostic(`BENCH-B elapsedMs=${(performance.now() - startedAt).toFixed(1)} httpCalls=${httpCalls}`);
});
