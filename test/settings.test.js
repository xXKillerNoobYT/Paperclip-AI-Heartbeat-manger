import test from 'node:test';
import assert from 'node:assert/strict';

import { buildPluginSettings, evaluatePoolSpendPolicy, validatePluginSettings } from '../src/settings.js';

test('buildPluginSettings resolves custom file locations relative to config directory', () => {
  const settings = buildPluginSettings({
    enabled: true,
    paperclip: { baseUrl: 'http://localhost:3100/api', companyId: 'company-1' },
    storage: {
      sharedStatePath: './sync/state.json',
      decisionLogPath: './logs/decisions.jsonl',
      idempotencyStorePath: './logs/idempotency.json',
    },
    pools: [{ poolId: 'claude-main', provider: 'claude', subscriptionOnly: true, allowExtraSpend: false }],
    toolDefaults: { enabledToolsets: ['terminal', 'file'], disabledToolsets: ['browser'] },
  }, { configDir: '/tmp/hbm-config' });

  assert.equal(settings.storage.sharedStatePath, '/tmp/hbm-config/sync/state.json');
  assert.equal(settings.storage.decisionLogPath, '/tmp/hbm-config/logs/decisions.jsonl');
  assert.deepEqual(settings.paperclip.companyIds, ['company-1']);
  assert.equal(settings.providerPools[0].subscriptionOnly, true);
  assert.equal(settings.providerPools[0].allowExtraSpend, false);
  assert.deepEqual(settings.toolDefaults.enabledToolsets, ['terminal', 'file']);
  assert.deepEqual(settings.toolDefaults.disabledToolsets, ['browser']);
  assert.equal(settings.validation.ok, true);
});

test('subscription-only provider pools fail closed if extra spending is enabled', () => {
  const pool = { poolId: 'openai-main', provider: 'openai', subscriptionOnly: true, allowExtraSpend: true };

  assert.deepEqual(validatePluginSettings({ pools: [pool] }).errors, [
    'openai-main: subscriptionOnly=true cannot be combined with allowExtraSpend=true',
  ]);
  assert.deepEqual(evaluatePoolSpendPolicy(pool), {
    decision: 'hold',
    reason: 'provider pool is subscription-only but allowExtraSpend=true',
  });
});

test('extra spending requires an explicit cents cap', () => {
  assert.deepEqual(evaluatePoolSpendPolicy({
    poolId: 'paid-overage',
    provider: 'openai',
    subscriptionOnly: false,
    allowExtraSpend: true,
  }), {
    decision: 'hold',
    reason: 'extra spending enabled without extraSpendBudgetCents hard cap',
  });

  assert.deepEqual(evaluatePoolSpendPolicy({
    poolId: 'paid-overage',
    provider: 'openai',
    subscriptionOnly: false,
    allowExtraSpend: true,
    extraSpendBudgetCents: 100,
    estimatedWakeCostCents: 50,
  }), {
    decision: 'allow',
    reason: 'provider spend policy allows scheduler evaluation',
  });
});
