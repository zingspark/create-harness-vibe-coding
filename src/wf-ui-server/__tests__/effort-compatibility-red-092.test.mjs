import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeHarnessTempRoot } from '../../../tests/support/temp-root.js';
import {
  assertModelCapability,
  parseOpenCodeVerboseCatalog,
  resolveOpenCodeModelCapability,
  readHarnessRuntimeCapabilities,
} from '../model-capability.mjs';
import { resolveRuntimeLaunchArgs } from '../runtime-detector.mjs';
import { resolveSpawnArgs } from '../pty-adapter.mjs';

const VERBOSE_CATALOG = [
  'opencode/provider/model-a',
  JSON.stringify({
    id: 'model-a',
    providerID: 'provider',
    variants: {
      xhigh: { effort: 'xhigh' },
      max: { effort: 'max' },
    },
  }, null, 2),
  'opencode/provider/model-b',
  JSON.stringify({
    id: 'model-b',
    providerID: 'provider',
    variants: {
      high: { effort: 'high' },
    },
  }, null, 2),
].join('\n');

describe('bounded cross-runtime effort compatibility', () => {
  test('RED: explicit effort reaches each runtime native launch argv', () => {
    assert.deepEqual(
      resolveRuntimeLaunchArgs('codex', { model: 'gpt-6-astra', effort: 'xhigh' }),
      ['--model', 'gpt-6-astra', '-c', 'model_reasoning_effort=xhigh'],
    );
    assert.deepEqual(
      resolveRuntimeLaunchArgs('claude', { model: 'claude-opus-4-7', effort: 'xhigh' }),
      ['--model', 'claude-opus-4-7', '--effort', 'xhigh'],
    );
    assert.deepEqual(
      resolveRuntimeLaunchArgs('opencode', {
        model: 'provider/model-a',
        effort: 'xhigh',
        effortVariant: 'xhigh',
      }),
      ['--model', 'provider/model-a', '--variant', 'xhigh'],
    );
  });

  test('RED: PTY adapter preserves effort and trusted variant into its launch argv', () => {
    assert.deepEqual(
      resolveSpawnArgs('codex', { model: 'gpt-6-astra', effort: 'xhigh' }),
      ['--model', 'gpt-6-astra', '-c', 'model_reasoning_effort=xhigh'],
    );
    assert.deepEqual(
      resolveSpawnArgs('claude', { model: 'claude-opus-4-7', effort: 'xhigh' }),
      ['--model', 'claude-opus-4-7', '--effort', 'xhigh'],
    );
    assert.deepEqual(
      resolveSpawnArgs('opencode', { model: 'provider/model-a', effort: 'xhigh', effortVariant: 'xhigh' }),
      ['--model', 'provider/model-a', '--variant', 'xhigh'],
    );
    assert.deepEqual(resolveSpawnArgs('codex', { model: 'gpt-6-astra' }), ['--model', 'gpt-6-astra']);
    assert.deepEqual(resolveSpawnArgs('claude', { model: 'claude-opus-4-7' }), ['--model', 'claude-opus-4-7']);
    assert.deepEqual(resolveSpawnArgs('opencode', { model: 'provider/model-a' }), ['--model', 'provider/model-a']);
  });

  test('RED: verbose OpenCode metadata binds effort to the selected model only', () => {
    const catalog = parseOpenCodeVerboseCatalog(VERBOSE_CATALOG);
    assert.equal(catalog.length, 2);
    assert.deepEqual(catalog[0].supportedEfforts, ['xhigh', 'max']);
    assert.deepEqual(catalog[1].supportedEfforts, ['high']);

    const supported = resolveOpenCodeModelCapability(catalog, 'provider/model-a', 'xhigh');
    assert.equal(supported.status, 'supported');
    assert.equal(supported.effortVariant, 'xhigh');

    const rejected = resolveOpenCodeModelCapability(catalog, 'provider/model-b', 'xhigh');
    assert.equal(rejected.status, 'unsupported');
    assert.equal(rejected.reason.code, 'MODEL_EFFORT_NOT_SUPPORTED');
    assert.equal(rejected.effortVariant, undefined);
    assert.throws(
      () => assertModelCapability(rejected, { model: 'provider/model-b', effort: 'xhigh' }),
      error => error.code === 'UNSUPPORTED',
    );
  });

  test('RED: name-only OpenCode entries do not fabricate effort metadata', () => {
    const catalog = parseOpenCodeVerboseCatalog('provider/model-name-only');
    const result = resolveOpenCodeModelCapability(catalog, 'provider/model-name-only', 'xhigh');
    assert.equal(result.status, 'supported');
    assert.equal(result.supportedEfforts, undefined);
    assert.throws(
      () => assertModelCapability(result, { model: 'provider/model-name-only', effort: 'xhigh' }),
      error => error.code === 'UNVERIFIED' && error.details.reason.code === 'MODEL_EFFORT_METADATA_UNAVAILABLE',
    );
  });

  test('RED: OpenCode bare model ids never select a provider implicitly', () => {
    const catalog = parseOpenCodeVerboseCatalog([
      'opencode/gpt-5.6-luna',
      JSON.stringify({
        id: 'gpt-5.6-luna',
        providerID: 'opencode',
        variants: { xhigh: { effort: 'xhigh' } },
      }),
      'opencode-go/gpt-5.6-luna',
      JSON.stringify({
        id: 'gpt-5.6-luna',
        providerID: 'opencode-go',
        variants: { xhigh: { effort: 'xhigh' } },
      }),
    ].join('\n'));

    const bare = resolveOpenCodeModelCapability(catalog, 'gpt-5.6-luna', 'xhigh');
    assert.equal(bare.status, 'unsupported');
    assert.equal(bare.reason.code, 'MODEL_PROVIDER_REQUIRED');
    assert.equal(bare.catalogModelId, undefined);

    const qualified = resolveOpenCodeModelCapability(catalog, 'opencode-go/gpt-5.6-luna', 'xhigh');
    assert.equal(qualified.status, 'supported');
    assert.equal(qualified.catalogModelId, 'opencode-go/gpt-5.6-luna');
    assert.equal(qualified.effortVariant, 'xhigh');
  });

  test('RED: Harness operator capabilities are exact declarations, separate from vendor config', () => {
    const projectRoot = makeHarnessTempRoot('effort-config-');
    fs.mkdirSync(path.join(projectRoot, 'Harness'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'Harness', 'settings.json'), JSON.stringify({
      schema: 'harness-settings@1',
      runtimeCapabilities: {
        claude: {
          models: {
            'gateway/claude-luna': { supportedEfforts: ['low', 'high', 'xhigh'] },
          },
        },
      },
    }));

    const configured = readHarnessRuntimeCapabilities(projectRoot, 'claude');
    assert.equal(configured.sourceKind, 'harness-operator-runtime-capabilities');
    assert.equal(configured.verificationLevel, 'operator-configured');
    assert.equal(configured.models['gateway/claude-luna'].supportedEfforts.includes('xhigh'), true);
    assert.equal(configured.models['gateway/claude-luna'].providerVerified, undefined);
  });
});
