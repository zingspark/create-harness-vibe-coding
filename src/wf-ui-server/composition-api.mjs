import fs from 'node:fs';
import path from 'node:path';
import { readActiveTaskId, parseTaskCapsule } from './task-parser.mjs';
import { getEventNode, listEventNodes } from './workflow-event-node-store.mjs';
import { getGoalNode, listGoalNodes } from './workflow-goal-node-store.mjs';

// Composition API state is an audit/read model only. Canonical graph, node,
// and bridge state remains owned by their existing stores.
const MAX_TRANSITIONS = 100;
const MAX_IDEMPOTENCY = 100;
const NEUTRAL_PROTOCOL_STEPS = ['observe'];

function auditPath(projectRoot) {
  return path.join(projectRoot, 'Harness', 'a2a', 'composition-transitions.jsonl');
}

function readAudit(projectRoot) {
  try {
    return fs.readFileSync(auditPath(projectRoot), 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map(line => JSON.parse(line))
      .filter(record => record && typeof record === 'object');
  } catch {
    return [];
  }
}

function appendAudit(projectRoot, record) {
  try {
    const records = [...readAudit(projectRoot), record].slice(-(MAX_TRANSITIONS + MAX_IDEMPOTENCY));
    fs.mkdirSync(path.dirname(auditPath(projectRoot)), { recursive: true });
    fs.writeFileSync(auditPath(projectRoot), `${records.map(item => JSON.stringify(item)).join('\n')}\n`, 'utf8');
  } catch {
    // Audit persistence is best effort; the returned action envelope remains
    // authoritative for the request that produced it.
  }
}

export function compositionIdFor(projectRoot) {
  try {
    const taskId = readActiveTaskId(projectRoot);
    if (taskId) {
      const task = parseTaskCapsule(path.join(projectRoot, 'Harness', 'tasks', taskId));
      if (task?.resumeRequired && task.taskId) return `workflow-${task.taskId}`;
    }
  } catch {
    // Projects without a valid active task use the stable no-workflow id.
  }
  return 'workflow-none';
}

export function assertCanonicalCompositionId(projectRoot, requestedId) {
  const canonical = compositionIdFor(projectRoot);
  const requested = String(requestedId || '').trim();
  if (requested !== canonical) {
    const error = new Error(`Workflow composition not found: ${requested}`);
    error.statusCode = 404;
    error.code = 'COMPOSITION_NOT_FOUND';
    error.details = { compositionId: canonical };
    throw error;
  }
  return canonical;
}

function idempotencyRecordKey({ nodeId, action, idempotencyKey }) {
  const key = String(idempotencyKey || '').trim();
  if (!key) return '';
  return `${String(nodeId || '').trim()}|${String(action || '').trim()}|${key}`;
}

export function getIdempotentResult(projectRoot, input = {}) {
  const key = idempotencyRecordKey(input);
  if (!key) return null;
  const record = readAudit(projectRoot).reverse().find(item => item.type === 'idempotency' && item.key === key);
  return record?.result || null;
}

export function rememberIdempotentResult(projectRoot, input = {}, result) {
  const key = idempotencyRecordKey(input);
  if (!key) return;
  appendAudit(projectRoot, {
    type: 'idempotency',
    key,
    nodeId: String(input.nodeId || ''),
    action: String(input.action || ''),
    result,
    at: new Date().toISOString(),
  });
}

export function recordCompositionTransition(projectRoot, transition = {}) {
  const canonicalCompositionId = compositionIdFor(projectRoot);
  const prior = readAudit(projectRoot)
    .filter(item => item.type === 'transition' && String(item.compositionId || '') === canonicalCompositionId);
  const priorVersion = prior.reduce((max, item) => Math.max(
    max,
    Number(item.compositionVersion || item.stateVersion || 0) || 0,
  ), 0);
  // Legacy audit entries predate the explicit version fields. Their count is
  // still a durable ordering signal, so continue after it rather than
  // restarting at version 1 after an upgrade.
  const nextVersion = Math.max(priorVersion, prior.length) + 1;
  const normalized = {
    ...transition,
    transitionId: String(transition.transitionId || `transition-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`),
    compositionId: canonicalCompositionId,
    at: String(transition.at || new Date().toISOString()),
    compositionVersion: Number(transition.compositionVersion || nextVersion),
    stateVersion: Number(transition.stateVersion || transition.compositionVersion || nextVersion),
  };
  appendAudit(projectRoot, { type: 'transition', ...normalized });
  return normalized;
}

export function listCompositionTransitions(projectRoot, limit = MAX_TRANSITIONS) {
  const max = Math.max(1, Math.min(MAX_TRANSITIONS, Number(limit) || MAX_TRANSITIONS));
  const canonicalCompositionId = compositionIdFor(projectRoot);
  return readAudit(projectRoot)
    .filter(item => item.type === 'transition' && String(item.compositionId || '') === canonicalCompositionId)
    .slice(-max)
    .map(({ type: _type, ...transition }) => transition);
}

function text(value, fallback = '') {
  const result = String(value ?? '').trim();
  return result || fallback;
}

function finitePositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function durationLabel(value) {
  const seconds = Math.floor(finitePositive(value));
  if (!seconds) return '';
  if (seconds % 86400 === 0) return `${seconds / 86400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

function timerStatus(state = {}) {
  if (state.heartbeat?.watchdog?.enabled) return text(state.heartbeat.watchdog.state, 'watchdog');
  return state.enabled ? 'enabled' : 'paused';
}

function goalStatus(state = {}) {
  return text(state.status, 'unknown');
}

function agentStatus(agent = {}) {
  return text(agent.status, 'unknown');
}

function statusLabel(role, state = {}) {
  if (role === 'timer') {
    if (state.heartbeat?.watchdog?.enabled) return 'Timer check';
    const status = timerStatus(state);
    if (status === 'enabled') return 'Timer on';
    if (status === 'paused') return 'Timer paused';
    if (status === 'stopped') return 'Timer stopped';
    if (status === 'watchdog') return 'Timer check';
    return `Timer ${status}`;
  }
  if (role === 'goal') {
    const status = goalStatus(state).toLowerCase();
    if (status === 'active') return 'Goal active';
    if (status === 'completed' || status === 'done') return 'Goal done';
    if (status === 'blocked') return 'Goal blocked';
    return `Goal ${status}`;
  }
  const status = agentStatus(state).toLowerCase();
  if (status === 'running') return 'Agent running';
  if (status === 'stopped' || status === 'exited' || status === 'complete') return 'Agent stopped';
  return `Agent ${status}`;
}

function timerSequenceLabel(state = {}) {
  const sequence = state.schedule?.cadence?.sequenceSeconds;
  if (!Array.isArray(sequence)) return '';
  const labels = sequence
    .map(durationLabel)
    .filter(Boolean)
    .slice(0, 4);
  return labels.length ? `${labels.join(' -> ')}${sequence.length > labels.length ? '...' : ''}` : '';
}

function capsuleRole(node = {}) {
  const type = text(node.type || node.kind).toLowerCase();
  if (type === 'goal' || type === 'goal-node') return 'goal';
  if (type === 'timer') return 'timer';
  if (node.sessionId || type === 'agent' || type === 'agent-node') return 'agent';
  return '';
}

function nodeStatus(role, record = {}) {
  if (role === 'timer') return timerStatus(record.state || record);
  if (role === 'goal') return goalStatus(record.state || record);
  return agentStatus(record.state || record);
}

function nodeTitle(role, record = {}) {
  const source = record || {};
  const state = source.state || {};
  if (role === 'agent') {
    return text(source.title || source.displayName || source.label || source.role || state.title || source.ui?.labels?.title, canonicalNodeId(source));
  }
  return text(source.title || state.title || source.label || source.ui?.labels?.title, canonicalNodeId(source));
}

function canonicalNodeId(record = {}) {
  const source = record || {};
  return text(source.nodeId || source.id || (source.sessionId ? `session-${source.sessionId}` : ''));
}

function edgeEndpoint(edge, side) {
  return text(edge?.[side] || edge?.[side === 'source' ? 'from' : 'to']);
}

function edgeDirection(edge) {
  return text(edge?.direction, 'bidirectional');
}

function capsuleLinksForNode(nodeId, role, nodesById, edges) {
  const links = { goals: [], timers: [], agents: [] };
  for (const edge of edges) {
    const source = edgeEndpoint(edge, 'source');
    const target = edgeEndpoint(edge, 'target');
    if (!source || !target || (source !== nodeId && target !== nodeId)) continue;
    const peerId = source === nodeId ? target : source;
    const peer = nodesById.get(peerId);
    if (!peer || peer.id === nodeId || !peer.role || peer.role === role) continue;
    const localHandle = source === nodeId ? edge.sourceHandle : edge.targetHandle;
    const link = {
      nodeId: peer.id,
      title: peer.title,
      role: peer.role,
      relation: text(edge.relation, 'wf-bridge'),
      direction: edgeDirection(edge),
      status: peer.status,
      edgeId: text(edge.id),
      handle: text(localHandle),
    };
    if (peer.role === 'goal') links.goals.push(link);
    if (peer.role === 'timer') links.timers.push(link);
    if (peer.role === 'agent') links.agents.push(link);
  }
  for (const key of Object.keys(links)) {
    links[key].sort((left, right) => (
      left.title.localeCompare(right.title)
      || left.nodeId.localeCompare(right.nodeId)
      || left.edgeId.localeCompare(right.edgeId)
    ));
  }
  return links;
}

// UI-only magnetic dock projection. Keep this separate from `goals/timers/
// agents`: dock links describe layout/topology and are never treated as a
// semantic workflow edge by the composition read model.
function capsuleUiLinksForNode(nodeId, dockLinks) {
  return (Array.isArray(dockLinks) ? dockLinks : [])
    .filter(link => Array.isArray(link?.nodeIds) && link.nodeIds.map(String).includes(String(nodeId)))
    .map(link => ({
      linkId: text(link.id || link.linkId, `dock:${String(link.nodeIds.join('::'))}`),
      nodeIds: link.nodeIds.map(value => String(value || '').trim()).filter(Boolean),
      anchorId: text(link.anchorId),
      draggedId: text(link.draggedId),
      uiOnly: true,
    }))
    .sort((left, right) => left.linkId.localeCompare(right.linkId));
}

function capsuleMode(role, links) {
  const roles = new Set([
    ...(role ? [role] : []),
    ...(links.goals.length ? ['goal'] : []),
    ...(links.timers.length ? ['timer'] : []),
    ...(links.agents.length ? ['agent'] : []),
  ]);
  if (roles.has('goal') && roles.has('timer') && roles.has('agent')) return 'goal-loop';
  if (roles.has('goal') && roles.has('timer')) return 'goal-timer';
  if (roles.has('goal') && roles.has('agent')) return 'goal-agent';
  if (roles.has('timer') && roles.has('agent')) return 'timer-agent';
  return 'standalone';
}

function capsuleProjectionFor(node, links, nodesById, dockLinks = []) {
  const ownState = node.state || node;
  const timer = node.role === 'timer'
    ? node
    : links.timers.map(link => nodesById.get(link.nodeId)).find(Boolean);
  const goal = node.role === 'goal'
    ? node
    : links.goals.map(link => nodesById.get(link.nodeId)).find(Boolean);
  const timerState = timer?.state || {};
  const wdtState = timerState.heartbeat?.watchdog?.enabled
    ? text(timerState.heartbeat.watchdog.state, 'watchdog')
    : '';
  const sequenceLabel = timerSequenceLabel(timerState);
  const nextLabel = node.role === 'goal'
    ? text(ownState.nextAction, 'Review Goal')
    : node.role === 'timer'
      ? (timerState.enabled ? 'Next wakeup' : 'Enable Timer')
      : (timer ? (timerState.enabled ? 'Read next wakeup' : 'Enable Timer') : 'Backend composition');
  const protocolSteps = [];
  if (timer) protocolSteps.push('timer.fire', 'timer.dispatchWakeup');
  if (links.agents.length || node.role === 'agent') protocolSteps.push('agent.readMessages');
  if (goal || node.role === 'goal') protocolSteps.push('goal.read');
  if (protocolSteps.length === 0) protocolSteps.push(...NEUTRAL_PROTOCOL_STEPS);
  return {
    nodeId: node.id,
    mode: capsuleMode(node.role, links),
    goals: links.goals,
    timers: links.timers,
    agents: links.agents,
    stateLabel: statusLabel(node.role, ownState),
    nextLabel,
    protocolSteps: [...new Set(protocolSteps)],
    sequenceLabel,
    wdtState,
    docked: dockLinks.length > 0,
    capsuleUiLinks: dockLinks,
  };
}

function buildCapsuleProjection(projectRoot, graph, timers, agents) {
  const deleted = new Set((Array.isArray(graph?.deletedNodes) ? graph.deletedNodes : [])
    .map(node => canonicalNodeId(node)).filter(Boolean));
  const records = new Map();
  const addRecord = (role, raw) => {
    const id = canonicalNodeId(raw);
    if (!id || deleted.has(id)) return;
    const previous = records.get(id);
    const nextTitle = nodeTitle(role, raw);
    const nextStatus = nodeStatus(role, raw);
    records.set(id, {
      ...previous,
      id,
      role,
      title: nextTitle !== id ? nextTitle : (previous?.title || id),
      status: nextStatus !== 'unknown' ? nextStatus : (previous?.status || 'unknown'),
      state: raw?.state || previous?.state || raw || {},
    });
  };
  for (const timer of Array.isArray(timers) ? timers : []) {
    const timerType = text(timer.type || timer.kind || timer.state?.type).toLowerCase();
    if (timerType === 'timer') addRecord('timer', timer);
  }
  // Prefer the typed event store when the caller did not already provide a
  // timer projection. This keeps the read model backend-owned even when it is
  // used directly outside the HTTP route.
  try {
    for (const eventNode of listEventNodes(projectRoot) || []) {
      if (text(eventNode.type).toLowerCase() !== 'timer') continue;
      const current = getEventNode(projectRoot, eventNode.nodeId);
      addRecord('timer', { ...current.node, state: current.state });
    }
  } catch {
    // Projects with no event store simply expose the caller-supplied timers.
  }
  for (const agent of Array.isArray(agents) ? agents : []) addRecord('agent', agent);
  try {
    for (const goal of listGoalNodes(projectRoot) || []) {
      const current = getGoalNode(projectRoot, goal.nodeId);
      addRecord('goal', { ...current.node, state: current.state });
    }
  } catch {
    // A project without an active task has no typed Goal projection.
  }
  // Agent graph records are canonical and enrich the server's compact agent list.
  for (const graphNode of Array.isArray(graph?.nodes) ? graph.nodes : []) {
    if (graphNode?.sessionId) addRecord('agent', graphNode);
  }
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  const nodesById = new Map();
  for (const record of records.values()) {
    nodesById.set(record.id, record);
    if (record.role === 'agent') {
      const agent = (agents || []).find(item => canonicalNodeId(item) === record.id || item.sessionId === record.id);
      if (agent?.sessionId) nodesById.set(`session-${agent.sessionId}`, record);
      if (agent?.sessionId) nodesById.set(agent.sessionId, record);
    }
  }
  for (const graphNode of Array.isArray(graph?.nodes) ? graph.nodes : []) {
    if (!graphNode?.sessionId) continue;
    const record = records.get(canonicalNodeId(graphNode));
    if (!record) continue;
    nodesById.set(`session-${graphNode.sessionId}`, record);
    nodesById.set(String(graphNode.sessionId), record);
  }
  const projection = {};
  const dockLinks = Array.isArray(graph?.capsuleDockLinks) ? graph.capsuleDockLinks : [];
  for (const node of records.values()) {
    projection[node.id] = capsuleProjectionFor(
      node,
      capsuleLinksForNode(node.id, node.role, nodesById, edges),
      nodesById,
      capsuleUiLinksForNode(node.id, dockLinks),
    );
  }
  return projection;
}

export function buildCompositionSnapshot(projectRoot, {
  compositionId = compositionIdFor(projectRoot),
  graph = {},
  timers = [],
  agents = [],
} = {}) {
  const lastTransitions = listCompositionTransitions(projectRoot);
  const canonicalId = compositionIdFor(projectRoot);
  const compositionVersion = lastTransitions.reduce((max, item) => Math.max(
    max,
    Number(item.compositionVersion || item.stateVersion || 0) || 0,
  ), 0);
  const fsmState = lastTransitions.at(-1)?.to || 'idle';
  return {
    schemaVersion: 1,
    compositionId: canonicalId,
    graphVersion: Number(graph.version || graph.graphVersion || 1),
    compositionVersion,
    stateVersion: compositionVersion,
    fsm: {
      state: fsmState,
      transitions: lastTransitions,
    },
    timer: { nodes: timers, count: timers.length },
    agents,
    edges: Array.isArray(graph.edges) ? graph.edges : [],
    lastTransitions,
    capsules: buildCapsuleProjection(projectRoot, graph, timers, agents),
  };
}
