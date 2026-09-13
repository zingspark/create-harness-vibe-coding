import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.cwd());
const clientPath = path.join(root, 'src/ui/src/components/workflow/nodeRuntimeClient.ts');
const routePath = path.join(root, 'src/ui/src/components/WorkflowRoute.tsx');
const client = fs.readFileSync(clientPath, 'utf8');
const route = fs.readFileSync(routePath, 'utf8');

function compositionSnapshotDeclaration() {
  const start = client.indexOf('WorkflowCompositionSnapshot');
  return start < 0 ? '' : client.slice(start, start + 5000);
}

function compositionFetcherDeclaration() {
  const start = client.indexOf('export async function fetchWorkflowComposition');
  return start < 0 ? '' : client.slice(start, start + 3000);
}

test('FRONTEND-BOUNDARY-01: nodeRuntimeClient exposes a typed composition snapshot fetch', () => {
  assert.match(
    client,
    /export\s+(?:interface|type)\s+WorkflowCompositionSnapshot\b/,
    'nodeRuntimeClient must publish the backend composition snapshot type',
  );
  assert.match(
    client,
    /export\s+(?:async\s+)?function\s+fetchWorkflowComposition\s*\(/,
    'nodeRuntimeClient must expose fetchWorkflowComposition()',
  );
  assert.match(
    compositionFetcherDeclaration(),
    /Promise\s*<[^>]*WorkflowCompositionSnapshot/,
    'fetchWorkflowComposition() must return the typed snapshot rather than unknown JSON',
  );
});

test('FRONTEND-BOUNDARY-02: composition snapshots are read-only and cache by compositionId plus graphVersion', () => {
  const snapshot = compositionSnapshotDeclaration();
  assert.ok(snapshot, 'missing WorkflowCompositionSnapshot declaration');
  assert.match(snapshot, /\breadonly\b|Readonly\s*</, 'composition snapshot must be immutable at the client boundary');
  assert.match(snapshot, /\bcompositionId\b/, 'snapshot must carry its canonical composition id');
  assert.match(snapshot, /\bgraphVersion\b/, 'snapshot must carry the graph revision used for caching');

  const fetcher = compositionFetcherDeclaration();
  assert.ok(fetcher, 'missing fetchWorkflowComposition() declaration');
  assert.match(fetcher, /apiJson/, 'composition fetch must use the typed HTTP API helper');
  assert.match(fetcher, /(?:cache|Map)/i, 'composition fetch must have a client cache');
  assert.match(
    fetcher,
    /compositionId[\s\S]{0,180}graphVersion|graphVersion[\s\S]{0,180}compositionId/,
    'cache key must include both compositionId and graphVersion',
  );
  assert.doesNotMatch(
    fetcher,
    /method\s*:\s*['"](?:POST|PUT|PATCH|DELETE)['"]/i,
    'composition snapshot fetch must be read-only HTTP',
  );
});

test('FRONTEND-BOUNDARY-03: WorkflowRoute reads composition and context through the typed client', () => {
  const importBlock = route.slice(Math.max(0, route.indexOf("from './workflow/nodeRuntimeClient'" ) - 1600), route.indexOf("from './workflow/nodeRuntimeClient'") + 80);
  assert.match(importBlock, /\bfetchWorkflowComposition\b/, 'WorkflowRoute must consume the typed composition client');
  assert.match(route, /\bfetchWorkflowComposition\s*\(/, 'WorkflowRoute must request composition data from the backend');
  assert.match(
    route,
    /\b(?:compositionSnapshot|workflowComposition|composition)\s*(?:\?\.|\.)\s*(?:fsm|timer|agents|edges|context|lastTransitions)\b/,
    'composition business fields must be read from the backend snapshot/context',
  );
});

test('FRONTEND-BOUNDARY-04: WorkflowRoute does not derive capsule FSM/timer business semantics locally', () => {
  assert.doesNotMatch(
    route,
    /const\s+mode\s*=\s*hasGoal\s*&&\s*hasTimer\s*&&\s*hasAgent/,
    'capsule mode is a backend composition field, not a UI-derived FSM',
  );
  assert.doesNotMatch(
    route,
    /const\s+protocolSteps\s*=\s*mode\s*===/,
    'protocol steps are backend composition data, not timer/edge calculation in the route',
  );
  assert.doesNotMatch(
    route,
    /function\s+buildWorkflowCapsuleSummaries\s*\(/,
    'WorkflowRoute must not own composition business aggregation',
  );
});

