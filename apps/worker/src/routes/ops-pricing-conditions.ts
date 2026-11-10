import { Hono } from 'hono';
import {
  activateMusuboPricingCondition, createMusuboPricingCondition, disableMusuboPricingCondition,
  getMusuboPricingCondition, listMusuboPricingConditions, musuboPricingConditionDefinition,
  nextMusuboPricingConditionVersion, recordPlatformAudit,
} from '@line-crm/db';
import { validateMusuboCondition, type MusuboConditionDefinition } from '@line-crm/shared';
import type { Env } from '../worker-env.js';
import { requirePlatformAdmin, requirePlatformAdminWrite } from '../middleware/platform-admin.js';
import { inputJsonBoundary } from '../lib/input-errors.js';
import { dbFor } from '../services/db-router.js';
import { clientIp } from '../services/admin-session.js';

export const opsPricingConditions = new Hono<Env>();
opsPricingConditions.use('/api/ops/pricing-conditions/*', requirePlatformAdmin());
opsPricingConditions.use('/api/ops/pricing-conditions', requirePlatformAdmin());

function parseDefinition(value: unknown): Omit<MusuboConditionDefinition, 'id' | 'version'> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (!raw.trialPeriod || typeof raw.trialPeriod !== 'object'
    || !raw.schedule || typeof raw.schedule !== 'object') return null;
  const definition = { ...raw, id: 'validation', version: 1 } as unknown as MusuboConditionDefinition;
  try { validateMusuboCondition(definition); }
  catch { return null; }
  return definition;
}

function publicCondition(row: Awaited<ReturnType<typeof getMusuboPricingCondition>>) {
  if (!row) return null;
  return { ...musuboPricingConditionDefinition(row), conditionKey: row.condition_key,
    createdAt: row.created_at, activatedAt: row.activated_at, hasCode: row.code_digest !== null };
}

opsPricingConditions.get('/api/ops/pricing-conditions', async (c) => {
  const rows = await listMusuboPricingConditions(dbFor(c.env));
  return c.json({ success: true, data: rows.map(publicCondition) });
});

opsPricingConditions.post('/api/ops/pricing-conditions', requirePlatformAdminWrite(), inputJsonBoundary(), async (c) => {
  const body = await c.req.json<unknown>().catch(() => null);
  const definition = parseDefinition(body);
  if (!definition) return c.json({ success: false, error: '利用条件の入力を確認してください' }, 400);
  const staff = c.get('staff');
  const db = dbFor(c.env);
  const id = crypto.randomUUID();
  const conditionKey = crypto.randomUUID();
  const created = await createMusuboPricingCondition(db, {
    conditionKey, definition: { ...definition, id, version: 1 },
    codeDigest: null, validFrom: null, createdBy: staff.id,
  });
  if (!created) return c.json({ success: false, error: '利用条件を保存できませんでした' }, 409);
  if (definition.status === 'active' && !await activateMusuboPricingCondition(db, id)) {
    return c.json({ success: false, error: '利用条件の状態が変わりました。読み直してください' }, 409);
  }
  await recordPlatformAudit(db, { staffId: staff.id, staffName: staff.name,
    action: 'pricing_condition.create', detail: { conditionId: id, version: 1 },
    ip: clientIp(c), visibleToTenant: false });
  return c.json({ success: true, data: publicCondition(await getMusuboPricingCondition(db, id)) }, 201);
});

opsPricingConditions.put('/api/ops/pricing-conditions/:id', requirePlatformAdminWrite(), inputJsonBoundary(), async (c) => {
  const body = await c.req.json<unknown>().catch(() => null);
  const definition = parseDefinition(body);
  if (!definition) return c.json({ success: false, error: '利用条件の入力を確認してください' }, 400);
  const staff = c.get('staff');
  const db = dbFor(c.env);
  const current = await getMusuboPricingCondition(db, c.req.param('id'));
  if (!current) return c.json({ success: false, error: '利用条件が見つかりません' }, 404);
  if (current.condition_key === 'normal' && definition.status !== 'active') {
    return c.json({ success: false, error: '通常条件は無効にできません' }, 400);
  }
  const nextVersion = await nextMusuboPricingConditionVersion(db, current.condition_key);
  if (current.version !== nextVersion - 1) {
    return c.json({ success: false, error: '別の変更が保存されました。読み直してください' }, 409);
  }
  const id = crypto.randomUUID();
  const created = await createMusuboPricingCondition(db, {
    conditionKey: current.condition_key, definition: { ...definition, id, version: nextVersion },
    codeDigest: current.code_digest, validFrom: current.valid_from, createdBy: staff.id,
  });
  if (!created) return c.json({ success: false, error: '別の変更が保存されました。読み直してください' }, 409);
  if (definition.status === 'active') {
    if (!await activateMusuboPricingCondition(db, id)) {
      return c.json({ success: false, error: '利用条件の状態が変わりました。読み直してください' }, 409);
    }
  } else {
    await disableMusuboPricingCondition(db, current.condition_key);
  }
  await recordPlatformAudit(db, { staffId: staff.id, staffName: staff.name,
    action: 'pricing_condition.revise', detail: { conditionId: id,
      previousConditionId: current.id, version: nextVersion },
    ip: clientIp(c), visibleToTenant: false });
  return c.json({ success: true, data: publicCondition(await getMusuboPricingCondition(db, id)) });
});
