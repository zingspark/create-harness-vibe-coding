// Native composition API matrix (black-box HTTP).
// Each scenario runs against an isolated temporary project and a real wf-ui
// server. No UI, node-store imports, or direct Harness/a2a writes are used.
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
    objective: 'composition matrix HTTP fixture',
    attachGraphNode: true,
    deferPtySpawn: true,
  });
  assert.equal(response.status, 201, details(response));
  const nodeId = response.body.graphNodeId || response.body.nodeId;
  assert.ok(nodeId, details(response));
  assert.ok(response.body.sessionId, details(response));
  return { ...response.body, nodeId };
}

async function connect(from, to, relation, direction = 'bidirectional', handles = {}) {
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

async function graphSnapshot() {
  const response = await requestJson('GET', '/api/a2a/graph-map');
  assert.equal(response.status, 200, details(response));
  return response.body;
}

beforeEach(async () => {
  process.env.PATH = `${fixtureDir}${path.delimiter}${originalPath}`;
  root = makeHarnessTempRoot('node-composition-matrix-');
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

test('COMPOSE-MATRIX-A: Markdown + File -> Agent -> Display appear in resource context', async () => {
  const agent = await createAgent();
  const markdown = await createNode({
    nodeId: 'component-composition-matrix-markdown',
    type: 'markdown',
    title: 'Matrix Shared Notes',
    markdown: '# Matrix context\n',
  });
  const file = await createNode({
    nodeId: 'component-composition-matrix-file',
    type: 'file',
    title: 'matrix-input.txt',
    file: {
      source: 'workspace',
      path: 'matrix-input.txt',
      name: 'matrix-input.txt',
      mime: 'text/plain',
      size: 0,
    },
  });
  const display = await createNode({
    nodeId: 'component-composition-matrix-display',
    type: 'display',
    title: 'Matrix Output Display',
  });

  await connect(markdown.nodeId, agent.nodeId, 'context', 'source-to-target', {
    sourceHandle: 'markdown',
    targetHandle: 'context',
  });
  await connect(file.nodeId, agent.nodeId, 'context', 'source-to-target', {
    sourceHandle: 'file',
    targetHandle: 'context',
  });
  await connect(agent.nodeId, display.nodeId, 'output', 'source-to-target', {
    sourceHandle: 'output',
    targetHandle: 'display',
  });

  const response = await requestJson('GET', `/api/workflow/context/${agent.nodeId}`);
  assert.equal(response.status, 200, details(response));
  const refs = response.body.context?.connectedResourceRefs || [];
  assert.deepEqual(
    new Set(refs.map(ref => ref.nodeId)),
    new Set([markdown.nodeId, file.nodeId, display.nodeId]),
    details(response),
  );
  assert.ok(refs.some(ref => ref.nodeId === markdown.nodeId && ref.type === 'markdown'), details(response));
  assert.ok(refs.some(ref => ref.nodeId === file.nodeId && ref.type === 'file'), details(response));
  assert.ok(refs.some(ref => ref.nodeId === display.nodeId && ref.type === 'display'), details(response));
});

test('COMPOSE-MATRIX-B: Skill Group + MCP Connector expose capability context without provider execution', async () => {
  const agent = await createAgent();
  const skillGroup = await createNode({
    nodeId: 'capability-composition-matrix-skills',
    type: 'skill-group',
    title: 'Matrix Skills',
    sourceGroup: { id: 'matrix', label: 'Matrix Capability Pack', kind: 'family' },
    skills: [
      { id: 'skill:matrix-review', name: 'matrix-review', title: 'Matrix Review' },
      { id: 'skill:matrix-report', name: 'matrix-report', title: 'Matrix Report' },
    ],
  });
  const connector = await createNode({
    nodeId: 'capability-composition-matrix-mcp',
    type: 'mcp-connector',
    title: 'Matrix MCP',
    server: {
      id: 'matrix-local',
      name: 'matrix-local',
      title: 'Matrix Local MCP',
      transport: 'stdio',
      command: 'echo',
      env: { MATRIX_TOKEN: 'must-not-be-returned' },
    },
  });
  await connect(agent.nodeId, skillGroup.nodeId, 'capability', 'bidirectional', {
    sourceHandle: 'right',
    targetHandle: 'capability:left',
  });
  await connect(agent.nodeId, connector.nodeId, 'capability', 'bidirectional', {
    sourceHandle: 'right',
    targetHandle: 'capability:left',
  });

  const response = await requestJson('GET', `/api/workflow/context/${agent.nodeId}`);
  assert.equal(response.status, 200, details(response));
  const context = response.body.context;
  const groups = context?.connectedCapabilityNodeRefs || [];
  const groupRef = groups.find(ref => ref.nodeId === skillGroup.nodeId);
  const mcpRef = groups.find(ref => ref.nodeId === connector.nodeId);
  assert.ok(groupRef, details(response));
  assert.equal(groupRef.capabilityKind, 'skill-group', details(response));
  assert.deepEqual(groupRef.skillNames, ['matrix-review', 'matrix-report'], details(response));
  assert.ok(context.effectiveSkills.includes('matrix-review'), details(response));
  assert.ok(context.effectiveSkills.includes('matrix-report'), details(response));
  assert.ok(mcpRef, details(response));
  assert.equal(mcpRef.capabilityKind, 'mcp-connector', details(response));
  assert.equal(mcpRef.serverCount, 1, details(response));
  assert.deepEqual(mcpRef.serverNames, ['matrix-local'], details(response));
  assert.equal(JSON.stringify(context).includes('must-not-be-returned'), false, details(response));
});

test('COMPOSE-MATRIX-C: Agent -> Timer control edge enables policy-gated interval mutation', async () => {
  const agent = await createAgent();
  const timer = await createNode({
    nodeId: 'event-composition-matrix-timer',
    type: 'timer',
    title: 'Matrix Control Timer',
    enabled: false,
    schedule: { mode: 'interval', intervalSeconds: 60 },
    controlPolicy: {
      agentCanSetInterval: true,
      minIntervalSeconds: 5,
      maxIntervalSeconds: 3600,
    },
  });
  const edge = await connect(agent.nodeId, timer.nodeId, 'control', 'source-to-target', {
    sourceHandle: 'context',
    targetHandle: 'config',
  });
  assert.equal(edge.relation, 'control');
  assert.equal(edge.direction, 'source-to-target');
  assert.equal(edge.sourceHandle, 'context');
  assert.equal(edge.targetHandle, 'config');

  const context = await requestJson('GET', `/api/workflow/context/${agent.nodeId}`);
  assert.equal(context.status, 200, details(context));
  const timerRef = context.body.context.connectedEventRefs.find(ref => ref.nodeId === timer.nodeId);
  assert.ok(timerRef, details(context));
  assert.ok(timerRef.allowedActions.includes('timer.setInterval'), details(context));
  assert.equal(timerRef.requiredEdge.sourceHandle, 'context', details(context));
  assert.equal(timerRef.requiredEdge.targetHandle, 'config', details(context));

  const changed = await requestJson(
    'POST',
    `/api/workflow/nodes/${timer.nodeId}/actions/timer.setInterval`,
    { actorNodeId: agent.nodeId, intervalSeconds: 120 },
  );
  assert.equal(changed.status, 200, details(changed));
  assert.equal(changed.body.state.schedule.intervalSeconds, 120, details(changed));
});

test('COMPOSE-MATRIX-D: deleting an edge and then a node leaves no dangling graph edges', async () => {
  const markdown = await createNode({
    nodeId: 'component-composition-matrix-delete-markdown',
    type: 'markdown',
    title: 'Matrix Delete Notes',
    markdown: 'delete me',
  });
  const file = await createNode({
    nodeId: 'component-composition-matrix-delete-file',
    type: 'file',
    title: 'matrix-delete.txt',
    file: {
      source: 'workspace',
      path: 'matrix-delete.txt',
      name: 'matrix-delete.txt',
      mime: 'text/plain',
      size: 0,
    },
  });
  const edgeToFile = await connect(markdown.nodeId, file.nodeId, 'context');

  const removedEdge = await requestJson('DELETE', `/api/workflow/edges/${encodeURIComponent(edgeToFile.id)}`);
  assert.equal(removedEdge.status, 200, details(removedEdge));
  let graph = await graphSnapshot();
  assert.equal((graph.edges || []).some(edge => edge.id === edgeToFile.id), false, JSON.stringify(graph));

  // Reconnect before deleting the node so node deletion must remove a live
  // edge as well as its own typed node record.
  const restoredEdge = await connect(markdown.nodeId, file.nodeId, 'context');
  assert.equal(restoredEdge.id, edgeToFile.id, JSON.stringify(restoredEdge));

  const removedNode = await requestJson(
    'POST',
    `/api/workflow/nodes/${markdown.nodeId}/actions/node.delete`,
    {},
  );
  assert.equal(removedNode.status, 200, details(removedNode));
  graph = await graphSnapshot();
  assert.equal((graph.nodes || []).some(node => (node.nodeId || node.id) === markdown.nodeId), false, JSON.stringify(graph));
  const dangling = (graph.edges || []).filter(edge => (
    edge.from === markdown.nodeId || edge.to === markdown.nodeId
  ));
  assert.deepEqual(dangling, [], JSON.stringify(graph));
});
