import { expect, it } from 'vitest';
import { inspectCatalog, parseCatalogDefinition } from './catalog.js';

it('手渡し景品のひな形は断り、店の手渡し景品を別の種類で上書きしない', () => {
  expect(() => parseCatalogDefinition('mileage_reward', { schemaVersion: 1, settings: { name: '景品', rewardKind: 'handgift', requiredMiles: 30 } })).toThrow();
  const definition = parseCatalogDefinition('mileage_reward', { schemaVersion: 1, settings: { name: '景品', rewardKind: 'coupon', requiredMiles: 30 } });
  const snapshot = JSON.stringify({ handgiftIds: ['r'], targets: [{ id: 'r', name: '景品', status: 'draft', archived_at: null, current_published_version_id: null }], versions: [], usage: [], tags: [], scenarios: [], actions: [], actionVersions: [], programs: [{ id: 'default', status: 'active' }] });
  expect(inspectCatalog(definition, snapshot, 'mileage_reward')[0].allowedModes).toEqual(['alias']);
});
