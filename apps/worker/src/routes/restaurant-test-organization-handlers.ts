import { parseOffsetPaging, buildOffsetListResponse } from '../lib/list-paging.js';
import { logger } from '@line-crm/shared/server';
import { parseReservationFilter } from './restaurant-reservation-filter.js';
import { deriveStoreLineStatuses, isValidTimezone, uniqueStoreConflict } from './restaurant-store-status.js';
import type { RestaurantStoreRow, SelectedRestaurantStore } from './restaurant-context-types.js';
import { processScenarioSourceJobs } from '../features/scenarios/scenario-source-jobs/index.js';
import { processRestaurantEvents } from '../services/restaurant-events.js';
import { inputError } from '../lib/input-errors.js';
import { processVisitStampQueue } from '../services/visit-stamps.js';
import { reconcileRestaurantInventory } from '../services/restaurant-inventory-rules.js';

import { CredentialEncryptionKeyError, createLineAccount, deleteUncommittedLineAccount } from '@line-crm/db';
import type { Env } from '../worker-env.js';

import { assignmentSettingsResponse } from './booking-assignment-settings.js';
import { getVisibleLineAccountScope } from '../services/account-access.js';
import { processBookingWaitlists } from '../services/waitlist-tick.js';
import { dbFor } from '../services/db-router.js';
import { issueRestaurantIntakeAddress, listRestaurantIntakeAddresses, RestaurantIntakeConfigurationError } from '../services/restaurant-email-intake.js';
import { issueLineAccessToken, LineTokenIssueError } from '../services/token-refresh.js';
import { fetchBotProfile } from '../lib/bot-profile.js';
import { restaurantTestEnabled } from '../lib/environment-features.js';
import { applyDueRestaurantMenuPrices, expireRestaurantHolds } from '../services/restaurant-booking.js';
import { restaurantChannelState, restaurantDayBounds } from '../services/restaurant-channels.js';
import { DEFAULT_TENANT_ID } from '../lib/tenant.js';
import { tenantHasFeaturePack } from '../services/tenant-features.js';
import { organizationFor, tenantId, accountId, hasOrganizationSelector, requiredAccount, storeBelongsTo, publicOrganization, selectedRestaurantStore, organizationByTenantId, authenticatedTenantId, RESTAURANT_TERMS_DOCUMENT_KEY, RESTAURANT_TERMS_DOCUMENT_VERSION, ensureOrganizationForAuthenticatedTenant, updateSelectedRestaurantStore, lineConnectionMessage, validateStoreLineAccount } from './restaurant-test-definition.js';
import type { Context, Next } from 'hono';

export const use__api_restaurant_test__1 = async (c: Context<Env, "/api/restaurant-test/*">, next: Next) => {
 await next();
 if(!['POST','PUT','PATCH','DELETE'].includes(c.req.method)||!c.res.ok||c.req.path.endsWith('/closures/preview'))return;
 await processVisitStampQueue(c.env);
 try{await processRestaurantEvents(c.env);await processScenarioSourceJobs(c.env);}catch{logger.error("restaurant_test_organization.dispatch_events_failed");}
 const organization=await organizationFor(c);if(!organization)return;
 const dirty=await dbFor(c.env).prepare(`SELECT q.store_id FROM rt_inventory_rule_queue q JOIN rt_stores s ON s.id=q.store_id
 WHERE s.organization_id=? AND (? IS NULL OR s.id=?) LIMIT 100`).bind(organization.id,organization.scopedStoreId,organization.scopedStoreId).all<{store_id:string}>();
 for(const row of dirty.results)try {await reconcileRestaurantInventory(c.env,row.store_id);}catch {logger.error("restaurant_test_organization.reconcile_inventory_failed");}
};

export const onError_route_2 = (error: Error, c: Context<Env>) => {
  if (/followup_approval_version_conflict|edit_restaurant_followup_in_common_scenario/.test(String(error))) return c.json({success:false,error:'version_conflict',message:'共通シナリオの最新の版を読み直してください'},409);
  if (/departure_requires_visit|undo_departure_first/.test(String(error))) return c.json({success:false,error:'来店・退店の記録を確認してください'},409);
  if (String(error).includes('closure_conflict')) return c.json({ success: false, error: 'closure_conflict', code: 'closure_conflict', reason: '臨時休業・貸切の日時と卓に重なるため受付できません' }, 409);
  if (/RESTAURANT_CAPACITY_CHANGED|(restaurant|customer)_table_conflict/.test(String(error))) return c.json({ success: false, error: '同じ卓に重なる予約または仮押さえがあります' }, 409);
  throw error;
};

export const use___3 = async (c: Context<Env, "*">, next: Next) => {await next();if(!c.req.path.startsWith('/api/restaurant-test/google/')&&!['GET','HEAD','OPTIONS'].includes(c.req.method)&&!c.req.path.endsWith('/closures/preview')&&c.res.status<400&&!(c.req.path.endsWith('/seat-waitlist')&&c.req.method==='POST')){try{const org=await organizationFor(c);if(org){const stores=await dbFor(c.env).prepare('SELECT id,line_account_id FROM rt_stores WHERE organization_id=? AND (? IS NULL OR id=?)').bind(org.id,org.scopedStoreId,org.scopedStoreId).all<{id:string;line_account_id:string|null}>();for(const store of stores.results)await processBookingWaitlists(c.env,store.line_account_id??undefined,store.id);}}catch{logger.error("restaurant_test_organization.reconcile_seat_waitlist_failed");}}};

export const use__api_restaurant_test__4 = async (c: Context<Env, "/api/restaurant-test/*">, next: Next) => {
  // Google の各ルートは専用の旗・ログイン・統括・アカウントの guard で守る。
  if (c.req.path.startsWith('/api/restaurant-test/google/')) return next();
  if (!restaurantTestEnabled(c.env)) {
    return c.json({ success: false, error: 'Not found' }, 404);
  }

  const staffTenant = c.get('staff')?.tenantId ?? DEFAULT_TENANT_ID;
  // 統括に飲食店機能パックが付いていない場合、環境が無効な場合と同じ404で
  // 返す。機能の存在自体を、権限が無い呼び出し元に漏らさないため。
  if (!(await tenantHasFeaturePack(dbFor(c.env), staffTenant, 'restaurant'))) {
    return c.json({ success: false, error: 'Not found' }, 404);
  }

  const requestedTenant = tenantId(c);
  if (requestedTenant && requestedTenant !== staffTenant) {
    return c.json({ success: false, error: 'この統括を操作する権限がありません' }, 403);
  }

  // 既存の account_id の可視範囲検査を維持する。
  const selectedAccount = accountId(c);
  if (!selectedAccount) return next();
  const scope = await getVisibleLineAccountScope(dbFor(c.env), c.get('staff'));
  if (!scope.ids.includes(selectedAccount)) {
    return c.json({ success: false, error: 'このLINEアカウントを操作する権限がありません' }, 403);
  }
  return next();
};

export const get__api_restaurant_test_assignment_settings_5 = async (c: Context<Env, "/api/restaurant-test/assignment-settings">) => {
  if (!hasOrganizationSelector(c)) return requiredAccount(c);
  const organization = await organizationFor(c), id = c.req.query('storeId');
  if (!organization || !id || !await storeBelongsTo(c, organization.id, id)) return c.json({ success: false, error: 'store_not_found' }, 404);
  return assignmentSettingsResponse(c, dbFor(c.env, id), { kind: 'table', id });
};

export const put__api_restaurant_test_assignment_settings_6 = async (c: Context<Env, "/api/restaurant-test/assignment-settings">) => {
  if (!hasOrganizationSelector(c)) return requiredAccount(c);
  const organization = await organizationFor(c), id = c.req.query('storeId');
  if (!organization || !id || !await storeBelongsTo(c, organization.id, id)) return c.json({ success: false, error: 'store_not_found' }, 404);
  return assignmentSettingsResponse(c, dbFor(c.env, id), { kind: 'table', id });
};

export const get__api_restaurant_test_stores_7 = async (c: Context<Env, "/api/restaurant-test/stores">) => {
  if (!hasOrganizationSelector(c)) return requiredAccount(c);
  const organization = await organizationFor(c, { ignoreSession: true });
  if (!organization) {
    return c.json({ success: true, data: { organization: null, stores: [] } });
  }
  const stores = await dbFor(c.env).prepare(`SELECT
      s.*, la.name AS line_account_name,
      CASE WHEN s.line_account_id IS NULL THEN NULL ELSE (
        SELECT COUNT(*) FROM friends f
        WHERE f.line_account_id = s.line_account_id AND f.is_following = 1
      ) END AS friend_count
    FROM rt_stores s
    LEFT JOIN line_accounts la ON la.id = s.line_account_id
    WHERE s.organization_id = ?
    ORDER BY s.name COLLATE NOCASE ASC, s.id ASC`).bind(organization.id)
    .all<RestaurantStoreRow>();
  const withStatuses = await deriveStoreLineStatuses(c, stores.results);
  return c.json({
    success: true,
    data: { organization: publicOrganization(organization), stores: withStatuses },
  });
};

export const get__api_restaurant_test_store_context_8 = async (c: Context<Env, "/api/restaurant-test/store-context">) => {
  if (!hasOrganizationSelector(c)) return requiredAccount(c);
  const organization = await organizationFor(c, { ignoreSession: true });
  if (!organization) {
    return c.json({ success: true, data: { selectedStore: null } });
  }
  const selectedStore = await selectedRestaurantStore(c, organization.id);
  return c.json({
    success: true,
    data: { selectedStore: selectedStore ? { id: selectedStore.id, name: selectedStore.name } : null },
  });
};

export const get__api_restaurant_test_terms_agreement_9 = async (c: Context<Env, "/api/restaurant-test/terms-agreement">) => {
  const organization = hasOrganizationSelector(c)
    ? await organizationFor(c, { ignoreSession: true })
    : await organizationByTenantId(c, authenticatedTenantId(c));
  if (!organization) {
    return c.json({
      success: true,
      data: {
        documentKey: RESTAURANT_TERMS_DOCUMENT_KEY,
        agreedVersion: null,
        agreedAt: null,
      },
    });
  }
  const agreement = await dbFor(c.env).prepare(`SELECT document_version, agreed_at
    FROM rt_organization_agreements
    WHERE organization_id = ? AND document_key = ?
    ORDER BY (document_version = ?) DESC, agreed_at DESC
    LIMIT 1`).bind(
      organization.id,
      RESTAURANT_TERMS_DOCUMENT_KEY,
      RESTAURANT_TERMS_DOCUMENT_VERSION,
    ).first<{ document_version: string; agreed_at: string }>();
  return c.json({
    success: true,
    data: {
      documentKey: RESTAURANT_TERMS_DOCUMENT_KEY,
      agreedVersion: agreement?.document_version ?? null,
      agreedAt: agreement?.agreed_at ?? null,
    },
  });
};

export const post__api_restaurant_test_terms_agreement_10 = async (c: Context<Env, "/api/restaurant-test/terms-agreement">) => {
  const body: { documentKey?: unknown; version?: unknown } = (await c.req.json().catch(() => null)) || {};
  if (
    body.documentKey !== RESTAURANT_TERMS_DOCUMENT_KEY
    || body.version !== RESTAURANT_TERMS_DOCUMENT_VERSION
  ) {
    return inputError(c, { success: false, error: '現在の利用規約バージョンと一致しません' }, 400, ["documentKey","version"]);
  }
  const organization = await ensureOrganizationForAuthenticatedTenant(c);
  if (!organization) return c.json({ success: false, error: '統括情報を確認できません' }, 404);
  const staffId = c.get('staff')?.id ?? null;
  await dbFor(c.env).prepare(`INSERT OR IGNORE INTO rt_organization_agreements
    (id, organization_id, document_key, document_version, agreed_by_staff_id)
    VALUES (?, ?, ?, ?, ?)`).bind(
      crypto.randomUUID(),
      organization.id,
      RESTAURANT_TERMS_DOCUMENT_KEY,
      RESTAURANT_TERMS_DOCUMENT_VERSION,
      staffId,
    ).run();
  const agreement = await dbFor(c.env).prepare(`SELECT agreed_at
    FROM rt_organization_agreements
    WHERE organization_id = ? AND document_key = ? AND document_version = ?
    LIMIT 1`).bind(
      organization.id,
      RESTAURANT_TERMS_DOCUMENT_KEY,
      RESTAURANT_TERMS_DOCUMENT_VERSION,
    ).first<{ agreed_at: string }>();
  return c.json({
    success: true,
    data: {
      documentKey: RESTAURANT_TERMS_DOCUMENT_KEY,
      agreedVersion: RESTAURANT_TERMS_DOCUMENT_VERSION,
      agreedAt: agreement?.agreed_at ?? null,
    },
  });
};

export const post__api_restaurant_test_stores_id_select_11 = async (c: Context<Env, "/api/restaurant-test/stores/:id/select">) => {
  if (!hasOrganizationSelector(c)) return requiredAccount(c);
  const organization = await organizationFor(c, { ignoreSession: true });
  if (!organization) return c.json({ success: false, error: '飲食店テスト組織がありません' }, 404);
  const storeId = c.req.param('id');
  const store = await dbFor(c.env, storeId).prepare(
    'SELECT id, organization_id, name, status FROM rt_stores WHERE id = ? LIMIT 1',
  ).bind(storeId).first<SelectedRestaurantStore & { status: string }>();
  if (!store || store.organization_id !== organization.id) {
    return c.json({ success: false, error: 'この店舗を表示することはできません' }, 403);
  }
  if (store.status === 'archived') {
    return c.json({ success: false, error: 'アーカイブ済みの店舗は表示できません' }, 409);
  }
  if (!await updateSelectedRestaurantStore(c, store.id)) {
    return c.json({ success: false, error: '店舗切り替えには管理画面への再ログインが必要です' }, 409);
  }
  return c.json({ success: true, data: { selectedStore: { id: store.id, name: store.name } } });
};

export const post__api_restaurant_test_stores_selection_clear_12 = async (c: Context<Env, "/api/restaurant-test/stores/selection/clear">) => {
  if (!hasOrganizationSelector(c)) return requiredAccount(c);
  if (!await updateSelectedRestaurantStore(c, null)) {
    return c.json({ success: false, error: '統括表示へ戻すには管理画面への再ログインが必要です' }, 409);
  }
  return c.json({ success: true, data: { selectedStore: null } });
};

export const get__api_restaurant_test_snapshot_13 = async (c: Context<Env, "/api/restaurant-test/snapshot">) => {
  if (!hasOrganizationSelector(c)) return requiredAccount(c);
  const organization = await organizationFor(c);
  if (!organization) {
    return c.json({
      success: true,
      data: {
        environment: 'staging_test',
        integrationPolicy: 'inbound_only',
        organization: null,
        stores: [], memberships: [], approvals: [], reservations: [], reservationTotal: 0, tables: [],
        inventory: [], menuItems: [], connectors: [], reviews: [], posts: [], lineFlows: [],
      },
    });
  }

  await expireRestaurantHolds(dbFor(c.env), undefined, organization.scopedStoreId ?? undefined, organization.id);
  await applyDueRestaurantMenuPrices(dbFor(c.env), organization.id, organization.scopedStoreId ?? undefined);
  const orgId = organization.id;
  const scopedStoreId = organization.scopedStoreId;
  // 予約台帳の絞り込み（期間・状態）とページ切替。既定は従来どおり先頭300件。
  const reservationFilter = parseReservationFilter(c, orgId, scopedStoreId);
  if (!reservationFilter.ok) return c.json({ success: false, error: reservationFilter.error }, 400);
  const [stores, memberships, approvals, reservationTotal, reservations, tables, inventory, menuItems, connectors, reviews, posts, lineFlows] = await Promise.all([
    dbFor(c.env).prepare(`SELECT s.*, la.name AS line_account_name
      FROM rt_stores s
      LEFT JOIN line_accounts la ON la.id = s.line_account_id
      WHERE s.organization_id = ? AND (? IS NULL OR s.id = ?)
      ORDER BY s.code`).bind(orgId, scopedStoreId, scopedStoreId).all<RestaurantStoreRow>(),
    dbFor(c.env).prepare(`SELECT m.*, sm.name AS loginName, sm.role AS loginRole, sm.access_level AS loginAccessLevel,
      sm.is_active AS loginActive, sm.policy_version AS loginPolicyVersion, sm.account_scope AS loginAccountScope,
      (SELECT json_group_array(line_account_id) FROM staff_account_scopes WHERE staff_id=m.staff_id) AS loginAccountIdsJson
      FROM rt_memberships m LEFT JOIN staff_members sm ON sm.id=m.staff_id
      WHERE m.organization_id = ? AND (? IS NULL OR m.store_id = ?)
      ORDER BY m.role, m.staff_name`).bind(orgId, scopedStoreId, scopedStoreId).all(),
    dbFor(c.env).prepare(`SELECT * FROM rt_approval_requests
      WHERE organization_id = ? AND (? IS NULL OR store_id = ?)
      ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'returned' THEN 1 ELSE 2 END,
        created_at DESC LIMIT 100`).bind(orgId, scopedStoreId, scopedStoreId).all(),
    dbFor(c.env).prepare(`SELECT COUNT(*) AS total FROM rt_reservations r
      JOIN rt_stores s ON s.id = r.store_id
      WHERE ${reservationFilter.where}`).bind(...reservationFilter.params).first<{ total: number }>(),
    dbFor(c.env).prepare(`SELECT r.*, (SELECT marked_at FROM rt_seat_visit_marks WHERE reservation_id=r.id AND kind='visited' AND undone_at IS NULL ORDER BY marked_at DESC LIMIT 1) AS arrived_at, (SELECT json_group_array(table_id) FROM rt_reservation_table_links WHERE reservation_id=r.id) AS table_ids_json, s.name AS store_name, t.label AS table_label, m.name AS course_name
      FROM rt_reservations r
      JOIN rt_stores s ON s.id = r.store_id
      LEFT JOIN rt_tables t ON t.id = r.table_id
      LEFT JOIN rt_menu_items m ON m.id = r.course_id
      WHERE ${reservationFilter.where}
      ORDER BY r.starts_at ASC LIMIT ? OFFSET ?`).bind(...reservationFilter.params, reservationFilter.limit, reservationFilter.offset).all(),
    dbFor(c.env).prepare(`SELECT t.*, (SELECT version FROM rt_floors f WHERE f.id=t.floor_id) floor_version FROM rt_tables t JOIN rt_stores s ON s.id = t.store_id
      WHERE s.organization_id = ? AND (? IS NULL OR s.id = ?)
      ORDER BY t.store_id, t.code`).bind(orgId, scopedStoreId, scopedStoreId).all(),
    dbFor(c.env).prepare(`SELECT i.* FROM rt_inventory_slots i JOIN rt_stores s ON s.id = i.store_id
      WHERE s.organization_id = ? AND (? IS NULL OR s.id = ?)
      ORDER BY i.starts_at LIMIT 300`).bind(orgId, scopedStoreId, scopedStoreId).all(),
    dbFor(c.env).prepare(`SELECT m.*, (SELECT after_price FROM rt_menu_change_requests r WHERE r.menu_id = m.id AND r.status IN ('pending','approved')) AS pendingPrice, (SELECT effective_at FROM rt_menu_change_requests r WHERE r.menu_id=m.id AND r.status IN ('pending','approved')) AS pendingEffectiveAt, (SELECT status FROM rt_menu_change_requests r WHERE r.menu_id=m.id AND r.status IN ('pending','approved')) AS priceChangeStatus FROM rt_menu_items m JOIN rt_stores s ON s.id = m.store_id
      WHERE s.organization_id = ? AND (? IS NULL OR s.id = ?)
      ORDER BY m.kind, m.name`).bind(orgId, scopedStoreId, scopedStoreId).all(),
    dbFor(c.env).prepare(`SELECT x.* FROM rt_connector_status x JOIN rt_stores s ON s.id = x.store_id
      WHERE s.organization_id = ? AND (? IS NULL OR s.id = ?)
      ORDER BY x.store_id, x.provider`).bind(orgId, scopedStoreId, scopedStoreId).all(),
    dbFor(c.env).prepare(`SELECT g.* FROM rt_gbp_reviews g JOIN rt_stores s ON s.id = g.store_id
      WHERE s.organization_id = ? AND (? IS NULL OR s.id = ?)
      ORDER BY g.reviewed_at DESC LIMIT 100`).bind(orgId, scopedStoreId, scopedStoreId).all(),
    dbFor(c.env).prepare(`SELECT p.* FROM rt_gbp_posts p JOIN rt_stores s ON s.id = p.store_id
      WHERE s.organization_id = ? AND (? IS NULL OR s.id = ?)
      ORDER BY p.created_at DESC LIMIT 100`).bind(orgId, scopedStoreId, scopedStoreId).all(),
    dbFor(c.env).prepare(`SELECT * FROM rt_line_flows
      WHERE organization_id = ? AND (? IS NULL OR store_id = ?)
      ORDER BY flow_type`).bind(orgId, scopedStoreId, scopedStoreId).all(),
  ]);
  const storesWithLineStatus = await deriveStoreLineStatuses(c, stores.results);

  return c.json({
    success: true,
    data: buildOffsetListResponse({
      environment: 'staging_test',
      integrationPolicy: 'inbound_only',
      organization: publicOrganization(organization),
      stores: storesWithLineStatus,
      memberships: memberships.results,
      approvals: approvals.results,
      reservations: reservations.results,
      reservationTotal: reservationTotal?.total ?? 0,
      tables: tables.results,
      inventory: inventory.results.map((slot) => ({ ...slot, total_capacity: tables.results
        .filter((table) => table.store_id === slot.store_id && table.is_active === 1)
        .reduce((total, table) => total + Number(table.max_capacity), 0) })),
      menuItems: menuItems.results,
      connectors: connectors.results,
      reviews: reviews.results,
      posts: posts.results,
      lineFlows: lineFlows.results,
      items: reservations.results, total: reservationTotal?.total ?? 0, paging: reservationFilter, sort: [{ field: 'starts_at', direction: 'asc' }],
    }),
  });
};

export const post__api_restaurant_test_stores_connect_14 = async (c: Context<Env, "/api/restaurant-test/stores/connect">) => {
  const body: {
    name?: unknown;
    alias?: unknown;
    channelId?: unknown;
    channelSecret?: unknown;
  } = (await c.req.json().catch(() => null)) || {};
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const alias = typeof body.alias === 'string' ? body.alias.trim() : '';
  const channelId = typeof body.channelId === 'string' ? body.channelId.trim() : '';
  const channelSecret = typeof body.channelSecret === 'string' ? body.channelSecret.trim() : '';
  if (!name) return inputError(c, { success: false, error: '店舗名を入力してください' }, 400, ["name"]);
  if (!channelId) return inputError(c, { success: false, error: 'チャネルIDを入力してください' }, 400, ["channelId"]);
  if (!channelSecret) return inputError(c, { success: false, error: 'チャネルシークレットを入力してください' }, 400, ["channelSecret"]);

  const organization = await ensureOrganizationForAuthenticatedTenant(c);
  if (!organization) return c.json({ success: false, error: '統括情報を確認できません' }, 404);

  const code = alias || name;
  const [sameCode, sameChannel] = await Promise.all([
    dbFor(c.env).prepare(
      'SELECT 1 AS found FROM rt_stores WHERE organization_id = ? AND code = ? LIMIT 1',
    ).bind(organization.id, code).first<{ found: number }>(),
    dbFor(c.env).prepare(
      'SELECT 1 AS found FROM line_accounts WHERE channel_id = ? LIMIT 1',
    ).bind(channelId).first<{ found: number }>(),
  ]);
  if (sameCode) return c.json({ success: false, error: '同じ店舗の略称が既に使用されています' }, 409);
  if (sameChannel) return c.json({ success: false, error: 'このLINE公式アカウントは既に登録されています' }, 409);

  let createdLineAccountId: string | null = null;
  try {
    const token = await issueLineAccessToken(channelId, channelSecret);
    const profile = await fetchBotProfile(token.access_token);
    if (!profile.displayName?.trim()) {
      return inputError(c, {
        success: false,
        error: 'LINE公式アカウントの情報を取得できませんでした。Messaging APIが有効になっているか確認してください。',
      }, 400, ["channelId","channelSecret"]);
    }

    const lineAccount = await createLineAccount(dbFor(c.env), {
      channelId,
      name: profile.displayName.trim(),
      channelAccessToken: token.access_token,
      channelSecret,
      tenantId: organization.tenant_id ?? DEFAULT_TENANT_ID,
    }, c.env.LINE_CREDENTIAL_ENCRYPTION_KEY);
    createdLineAccountId = lineAccount.id;
    const storeId = crypto.randomUUID();
    await dbFor(c.env, storeId).prepare(`INSERT INTO rt_stores
      (id, organization_id, name, code, capacity, timezone, line_account_id)
      VALUES (?, ?, ?, ?, 0, 'Asia/Tokyo', ?)`).bind(
        storeId,
        organization.id,
        name,
        code,
        lineAccount.id,
      ).run();
    return c.json({
      success: true,
      data: { store: { id: storeId, name }, lineAccountName: profile.displayName.trim() },
    }, 201);
  } catch (error) {
    if (createdLineAccountId) {
      try {
        await deleteUncommittedLineAccount(dbFor(c.env), createdLineAccountId);
      } catch {
        logger.error("restaurant_test_organization.rollback_store_wizard_failed");
      }
    }
    if (error instanceof LineTokenIssueError) {
      return inputError(c, { success: false, error: lineConnectionMessage(error.reason) }, 400, []);
    }
    if (error instanceof CredentialEncryptionKeyError) {
      return c.json({ success: false, error: 'LINE資格情報の暗号鍵が未設定です' }, 503);
    }
    const conflict = uniqueStoreConflict(error);
    if (conflict === 'line_account') {
      return c.json({ success: false, error: 'このLINE公式アカウントは別の店舗で使用されています' }, 409);
    }
    if (conflict === 'code') {
      return c.json({ success: false, error: '同じ店舗の略称が既に使用されています' }, 409);
    }
    const message = error instanceof Error ? error.message : '';
    if (/UNIQUE constraint failed.*line_accounts\.channel_id/i.test(message)) {
      return c.json({ success: false, error: 'このLINE公式アカウントは既に登録されています' }, 409);
    }
    throw error;
  }
};

export const post__api_restaurant_test_stores_15 = async (c: Context<Env, "/api/restaurant-test/stores">) => {
  if (!hasOrganizationSelector(c)) return requiredAccount(c);
  const organization = await organizationFor(c);
  if (!organization) return c.json({ success: false, error: '飲食店テスト組織がありません' }, 404);
  const body: {
    name?: unknown;
    code?: unknown;
    area?: unknown;
    capacity?: unknown;
    timezone?: unknown;
    lineAccountId?: unknown;
  } = (await c.req.json().catch(() => null)) || {};
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const code = typeof body.code === 'string' ? body.code.trim() : '';
  const area = typeof body.area === 'string' ? body.area.trim() || null : null;
  const capacity = Number(body.capacity);
  const timezone = typeof body.timezone === 'string' && body.timezone.trim()
    ? body.timezone.trim()
    : 'Asia/Tokyo';
  const lineAccountId = typeof body.lineAccountId === 'string'
    ? body.lineAccountId.trim()
    : '';
  if (!name || !code || !Number.isInteger(capacity) || capacity < 0 || !isValidTimezone(timezone)) {
    return inputError(c, { success: false, error: '店舗の入力内容が正しくありません' }, 400, ["name","code","capacity","timezone"]);
  }
  if (!lineAccountId) {
    return inputError(c, { success: false, error: 'LINEアカウントを選択してください' }, 400, ["lineAccountId"]);
  }
  if (!await validateStoreLineAccount(c, lineAccountId)) {
    return inputError(c, { success: false, error: 'LINEアカウントが正しくありません' }, 400, ["lineAccountId"]);
  }

  const id = crypto.randomUUID();
  try {
    await dbFor(c.env, id).prepare(`INSERT INTO rt_stores
      (id, organization_id, name, code, area, capacity, timezone, line_account_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(
        id, organization.id, name, code, area, capacity, timezone, lineAccountId,
      ).run();
  } catch (error) {
    const conflict = uniqueStoreConflict(error);
    if (conflict === 'line_account') {
      return c.json({ success: false, error: 'このLINEアカウントは別の店舗で使用されています' }, 409);
    }
    if (conflict === 'code') {
      return c.json({ success: false, error: '同じ店舗コードが既に使用されています' }, 409);
    }
    throw error;
  }
  return c.json({ success: true, data: { id } }, 201);
};

export const patch__api_restaurant_test_stores_id_16 = async (c: Context<Env, "/api/restaurant-test/stores/:id">) => {
  if (!hasOrganizationSelector(c)) return requiredAccount(c);
  const organization = await organizationFor(c);
  if (!organization) return c.json({ success: false, error: '飲食店テスト組織がありません' }, 404);
  const storeId = c.req.param('id');
  if (!await storeBelongsTo(c, organization.id, storeId)) {
    return inputError(c, { success: false, error: '店舗が正しくありません' }, 400, ["storeId"]);
  }
  const current = await dbFor(c.env, storeId).prepare(
    'SELECT line_account_id FROM rt_stores WHERE id = ? LIMIT 1',
  ).bind(storeId).first<{ line_account_id: string | null }>();
  const body: Record<string, unknown> = (await c.req.json().catch(() => null)) || {};
  const fields: string[] = [];
  const values: unknown[] = [];
  const has = (key: string) => Object.prototype.hasOwnProperty.call(body, key);

  if (has('name')) {
    const value = typeof body.name === 'string' ? body.name.trim() : '';
    if (!value) return inputError(c, { success: false, error: '店舗名が正しくありません' }, 400, ["name"]);
    fields.push('name = ?');
    values.push(value);
  }
  if (has('code')) {
    const value = typeof body.code === 'string' ? body.code.trim() : '';
    if (!value) return inputError(c, { success: false, error: '店舗コードが正しくありません' }, 400, ["code"]);
    fields.push('code = ?');
    values.push(value);
  }
  if (has('area')) {
    const value = typeof body.area === 'string' ? body.area.trim() || null : null;
    fields.push('area = ?');
    values.push(value);
  }
  if (has('capacity')) {
    const value = Number(body.capacity);
    if (!Number.isInteger(value) || value < 0) {
      return inputError(c, { success: false, error: '収容人数が正しくありません' }, 400, ["capacity"]);
    }
    fields.push('capacity = ?');
    values.push(value);
  }
  if (has('status')) {
    const value = typeof body.status === 'string' ? body.status : '';
    if (!['active', 'paused', 'archived'].includes(value)) {
      return inputError(c, { success: false, error: '店舗状態が正しくありません' }, 400, ["status"]);
    }
    fields.push('status = ?');
    values.push(value);
  }

  let nextLineAccountId = current?.line_account_id || '';
  if (has('lineAccountId')) {
    nextLineAccountId = typeof body.lineAccountId === 'string'
      ? body.lineAccountId.trim()
      : '';
    if (!nextLineAccountId) {
      return inputError(c, { success: false, error: 'LINEアカウントを選択してください' }, 400, ["lineAccountId"]);
    }
    if (!await validateStoreLineAccount(c, nextLineAccountId)) {
      return inputError(c, { success: false, error: 'LINEアカウントが正しくありません' }, 400, ["lineAccountId"]);
    }
    fields.push('line_account_id = ?');
    values.push(nextLineAccountId);
  }
  if (!nextLineAccountId) {
    return inputError(c, { success: false, error: 'LINEアカウントを選択してください' }, 400, ["lineAccountId"]);
  }
  if (fields.length === 0) {
    return inputError(c, { success: false, error: '変更内容がありません' }, 400, []);
  }

  fields.push("updated_at = datetime('now')");
  try {
    await dbFor(c.env, storeId).prepare(
      `UPDATE rt_stores SET ${fields.join(', ')} WHERE id = ? AND organization_id = ?`,
    ).bind(...values, storeId, organization.id).run();
  } catch (error) {
    const conflict = uniqueStoreConflict(error);
    if (conflict === 'line_account') {
      return c.json({ success: false, error: 'このLINEアカウントは別の店舗で使用されています' }, 409);
    }
    if (conflict === 'code') {
      return c.json({ success: false, error: '同じ店舗コードが既に使用されています' }, 409);
    }
    throw error;
  }
  return c.json({ success: true, data: { id: storeId } });
};

export const get__api_restaurant_test_intake_addresses_17 = async (c: Context<Env, "/api/restaurant-test/intake-addresses">) => {
  if (!hasOrganizationSelector(c)) return requiredAccount(c);
  const organization = await organizationFor(c);
  if (!organization) return c.json({ success: false, error: '飲食店テスト組織がありません' }, 404);
  const storeId = c.req.query('storeId') || '';
  if (!storeId || !await storeBelongsTo(c, organization.id, storeId)) {
    return c.json({ success: false, error: '店舗が正しくありません' }, 400);
  }
  try {
    const addresses = await listRestaurantIntakeAddresses(c.env, storeId);
    return c.json({ success: true, data: addresses });
  } catch (error) {
    if (error instanceof RestaurantIntakeConfigurationError) {
      return c.json({ success: false, error: '予約メール取り込み用ドメインが設定されていません' }, 503);
    }
    throw error;
  }
};

export const post__api_restaurant_test_intake_addresses_18 = async (c: Context<Env, "/api/restaurant-test/intake-addresses">) => {
  if (!hasOrganizationSelector(c)) return requiredAccount(c);
  const organization = await organizationFor(c);
  if (!organization) return c.json({ success: false, error: '飲食店テスト組織がありません' }, 404);
  const body: { storeId?: string } = await c.req.json<{ storeId?: string }>().catch(() => ({}));
  if (!body.storeId || !await storeBelongsTo(c, organization.id, body.storeId)) {
    return inputError(c, { success: false, error: '店舗が正しくありません' }, 400, ["storeId"]);
  }
  try {
    const issued = await issueRestaurantIntakeAddress(c.env, body.storeId);
    return c.json({ success: true, data: issued }, 201);
  } catch (error) {
    if (error instanceof RestaurantIntakeConfigurationError) {
      return c.json({ success: false, error: '予約メール取り込み用ドメインが設定されていません' }, 503);
    }
    throw error;
  }
};

export const get__api_restaurant_test_channels_19 = async (c: Context<Env, "/api/restaurant-test/channels">) => {
  if (!hasOrganizationSelector(c)) return requiredAccount(c);
  const organization = await organizationFor(c);
  if (!organization) return c.json({ success: false, error: '飲食店テスト組織がありません' }, 404);
  const storeId = c.req.query('storeId') || organization.scopedStoreId;
  if (!storeId || (organization.scopedStoreId && organization.scopedStoreId !== storeId) || !await storeBelongsTo(c, organization.id, storeId)) return c.json({ success: false, code: 'restaurant_store_mismatch', error: '店舗が正しくありません' }, 400);
  const db = dbFor(c.env, storeId);
  const store = await db.prepare('SELECT timezone FROM rt_stores WHERE id = ?').bind(storeId).first<{ timezone: string }>();
  const [from, to] = restaurantDayBounds(store!.timezone);
  const media = await db.prepare(`SELECT m.id, m.code, m.name, m.is_active,
    (SELECT COUNT(*) FROM rt_inbound_emails e WHERE e.store_id = ? AND e.media_id = m.id AND datetime(e.received_at) >= datetime(?) AND datetime(e.received_at) < datetime(?)) AS todayCount,
    (SELECT MAX(received_at) FROM rt_inbound_emails e WHERE e.store_id = ? AND e.media_id = m.id) AS lastReceivedAt,
    (SELECT COUNT(*) FROM rt_inbound_emails e WHERE e.store_id = ? AND e.media_id = m.id AND e.status = 'quarantined') AS unreadableCount
    FROM rt_media m ORDER BY m.code`).bind(storeId, from, to, storeId, storeId)
    .all<{ id: string; code: string; name: string; is_active: number; todayCount: number; lastReceivedAt: string | null; unreadableCount: number }>();
  const data = media.results.map(({ is_active, ...row }) => ({ ...row, receiveMethod: 'email_forward', ...restaurantChannelState(row.lastReceivedAt, is_active === 1) }));
  for (const [code, name] of [['restaurant_board', 'レストランボード'], ['reszaiko', 'レス在庫']] as const) {
    const row = await db.prepare(`SELECT COUNT(CASE WHEN datetime(received_at) >= datetime(?) AND datetime(received_at) < datetime(?) THEN 1 END) AS todayCount,
      MAX(received_at) AS lastReceivedAt, COUNT(CASE WHEN status = 'failed' THEN 1 END) AS unreadableCount
      FROM rt_sync_events WHERE store_id = ? AND provider = ?`).bind(from, to, storeId, code)
      .first<{ todayCount: number; lastReceivedAt: string | null; unreadableCount: number }>();
    data.push({ id: code, code, name, ...row!, receiveMethod: 'direct', ...restaurantChannelState(row!.lastReceivedAt, true) });
  }
  const manual = await db.prepare(`SELECT COUNT(CASE WHEN datetime(created_at) >= datetime(?) AND datetime(created_at) < datetime(?) THEN 1 END) AS todayCount,
    MAX(created_at) AS lastReceivedAt FROM rt_reservations WHERE store_id = ? AND source IN ('manual', 'phone', 'line') AND inbound_email_id IS NULL`)
    .bind(from, to, storeId).first<{ todayCount: number; lastReceivedAt: string | null }>();
  data.push({ id: 'manual', code: 'manual', name: '手入力・電話・LINE', ...manual!, unreadableCount: 0, receiveMethod: 'manual', ...restaurantChannelState(manual!.lastReceivedAt, true) });
  return c.json({ success: true, data });
};

export const get__api_restaurant_test_inbound_emails_20 = async (c: Context<Env, "/api/restaurant-test/inbound-emails">) => {
  if (!hasOrganizationSelector(c)) return requiredAccount(c);
  const organization = await organizationFor(c);
  if (!organization) return c.json({ success: false, error: '飲食店テスト組織がありません' }, 404);
  const storeId = c.req.query('storeId') || organization.scopedStoreId;
  if (!storeId || (organization.scopedStoreId && organization.scopedStoreId !== storeId) || !await storeBelongsTo(c, organization.id, storeId)) return c.json({ success: false, error: '店舗が正しくありません' }, 400);
  if ((c.req.query('status') || 'quarantined') !== 'quarantined') return c.json({ success: false, error: 'status は quarantined を指定してください' }, 400);
  const { limit, offset } = parseOffsetPaging({ limit: c.req.query('limit') || undefined, offset: c.req.query('offset') || undefined }, { defaultLimit: 100, limitPolicy: { format: 'integer-prefix', fallback: 'falsy', minimum: 1, maximum: 200 }, offsetPolicy: { format: 'integer-prefix', fallback: 'falsy', minimum: 0 } });
  const rows = await dbFor(c.env, storeId).prepare(`SELECT e.id, e.store_id AS storeId, e.received_at AS receivedAt,
    e.status, e.quarantine_reason AS reason, m.code AS mediaCode, m.name AS mediaName
    FROM rt_inbound_emails e LEFT JOIN rt_media m ON m.id = e.media_id
    WHERE e.store_id = ? AND e.status = 'quarantined' ORDER BY e.received_at DESC, e.id LIMIT ? OFFSET ?`)
    .bind(storeId, limit, offset).all();
  const count = await dbFor(c.env, storeId).prepare("SELECT COUNT(*) AS total FROM rt_inbound_emails WHERE store_id = ? AND status = 'quarantined'").bind(storeId).first<{ total: number }>();
  const responseItems = rows.results;
  return c.json(buildOffsetListResponse({ success: true, data: responseItems, total: count!.total, items: responseItems, paging: { limit, offset }, sort: [{ field: 'received_at', direction: 'desc' }, { field: 'id', direction: 'asc' }] }));
};
