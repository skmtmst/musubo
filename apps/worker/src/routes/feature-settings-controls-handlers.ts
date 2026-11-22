import { jstCalendar as japanCalendar, expectedRestaurantMenuItemOrder, RESTAURANT_OPTIONAL_ITEM_IDS } from '@line-crm/shared';
import { logger } from '@line-crm/shared/server';
import { inputError } from '../lib/input-errors.js';
import { cleanStringArray } from './feature-settings-definition-collect-feature-impact.js';

import { auditDeviceFamily, auditEventStatement, getAccountSetting, getVersionedAccountSetting, maskAuditIp, setAccountSetting } from '@line-crm/db';
import { DEFAULT_TENANT_ID } from '@line-crm/shared';
import type { Env } from '../worker-env.js';

import { canAccessAllLineAccounts } from '../services/account-access.js';
import { accountFeatureAvailabilityMap } from '../services/feature-enforcement.js';
import { restaurantAccessMode } from '../services/tenant-features.js';
import { getAccountId, loadFeatureVisibility, loadFeatureSettings, PARENT_CHILD_MODE_KEY, SPECIALIZED_CATALOG_KEY, settingIsEnabled, specializedCatalog, isToggleable, effectiveFeatures, offTransitions, buildImpacts, impactFingerprint, OFF_CONFIRM_KEY, OFF_CONFIRM_TTL_MS, OffConfirmation, deleteOffConfirmation, toPublicImpacts, ToggleableFeature, NEN_SPECIALIZED_FEATURES, cleanSidebarOrderStrict, cleanItemOrderStrict, readOffConfirmation, FEATURE_SETTINGS_BUNDLE_KEY } from './feature-settings-definition.js';
import type { Context } from 'hono';

export const get__api_settings_features_visibility_1 = async (c: Context<Env, "/api/settings/features/visibility">) => {
  try {
    const accountId = getAccountId(c);
    if (!accountId) {
      return c.json({
        success: false,
        error: 'account_id が必要です',
        code: 'FEATURE_SETTINGS_ACCOUNT_REQUIRED',
      }, 400);
    }
    if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [accountId])) {
      return c.json({
        success: false,
        error: 'このLINEアカウントの機能表示を確認する権限がありません',
        code: 'FEATURE_SETTINGS_SCOPE_FORBIDDEN',
      }, 403);
    }
    const restaurantMode = await restaurantAccessMode(c, accountId);
    return c.json({
      success: true,
      data: await loadFeatureVisibility(
        c.env.DB,
        accountId,
        restaurantMode !== null,
        restaurantMode === 'account',
      ),
    });
  } catch (err) {
    throw err;
  }
};

export const get__api_settings_features_2 = async (c: Context<Env, "/api/settings/features">) => {
  try {
    const accountId = getAccountId(c);
    if (!accountId) {
      return c.json({
        success: false,
        error: 'account_id が必要です',
        code: 'FEATURE_SETTINGS_ACCOUNT_REQUIRED',
      }, 400);
    }
    if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [accountId])) {
      return c.json({
        success: false,
        error: 'このLINEアカウントの機能設定を表示する権限がありません',
        code: 'FEATURE_SETTINGS_SCOPE_FORBIDDEN',
      }, 403);
    }
    const restaurantMode = await restaurantAccessMode(c, accountId);
    // 親子モード・専用カタログは設定束と独立して読めるため並列で投げる。
    const [state, parentChildRaw, specializedRaw] = await Promise.all([
      loadFeatureSettings(
        c.env.DB,
        accountId,
        restaurantMode !== null,
        restaurantMode === 'account',
      ),
      getAccountSetting(c.env.DB, accountId, PARENT_CHILD_MODE_KEY),
      getAccountSetting(c.env.DB, accountId, SPECIALIZED_CATALOG_KEY),
    ]);
    const featureStates = await accountFeatureAvailabilityMap(
      c.env.DB,
      accountId,
      state.features,
    );

    return c.json({
      success: true,
      data: {
        features: state.features,
        featureStates,
        sidebarOrder: state.sidebarOrder,
        sidebarItemOrder: state.sidebarItemOrder,
        favoriteItemIds: state.favoriteItemIds ?? [],
        restaurantHiddenItemIds: state.restaurantHiddenItemIds ?? [],
        version: state.version,
        parentChildMode: settingIsEnabled(parentChildRaw),
        specializedFeatureKeys: specializedCatalog(specializedRaw),
      },
    });
  } catch (err) {
    throw err;
  }
};

export const post__api_settings_features_impact_3 = async (c: Context<Env, "/api/settings/features/impact">) => {
  try {
    const accountId = getAccountId(c);
    if (!accountId) return inputError(c, { success: false, error: 'account_id が必要です' }, 400, ["accountId"]);
    if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [accountId])) {
      return c.json({ success: false, error: 'Forbidden' }, 403);
    }

    const body = await c.req.json<{
      features?: Record<string, unknown>;
      expectedVersion?: unknown;
    }>();

    if (body.features !== undefined && (typeof body.features !== 'object' || body.features === null || Array.isArray(body.features))) {
      return inputError(c, { success: false, error: 'features はオブジェクトで指定してください' }, 400, ["features"]);
    }
    const unknownKeys = Object.keys(body.features ?? {}).filter((k) => !isToggleable(k));
    if (unknownKeys.length > 0) {
      return inputError(c, { success: false, error: `知らない機能です: ${unknownKeys.join(', ')}` }, 400, ["features"]);
    }
    const invalidFeature = Object.entries(body.features ?? {})
      .find(([, value]) => typeof value !== 'boolean');
    if (invalidFeature) {
      return inputError(c, {
        success: false,
        error: `${invalidFeature[0]} はtrueまたはfalseで指定してください`,
      }, 400, ["features"]);
    }
    if (body.expectedVersion !== undefined
      && (!Number.isInteger(body.expectedVersion) || Number(body.expectedVersion) < 0)) {
      return inputError(c, {
        success: false,
        error: 'expectedVersion は0以上の整数で指定してください',
      }, 400, ["expectedVersion"]);
    }

    const restaurantMode = await restaurantAccessMode(c, accountId);
    const restaurantEnabled = restaurantMode !== null;
    const current = await loadFeatureSettings(c.env.DB, accountId, restaurantEnabled, restaurantMode === 'account');
    if (body.expectedVersion !== undefined && Number(body.expectedVersion) !== current.version) {
      return c.json({
        success: false,
        error: '別の管理者が先に変更しました。最新の設定を読み直してください。',
        data: { currentVersion: current.version },
      }, 409);
    }

    const next = effectiveFeatures(current.features, body.features, restaurantEnabled);
    const offs = offTransitions(current.features, next);
    const impacts = await buildImpacts(c.env.DB, accountId, offs);
    const requiresConfirmation = impacts.some((impact) => impact.blocking);

    let impactToken: string | null = null;
    if (requiresConfirmation) {
      impactToken = crypto.randomUUID();
      const impactHash = await impactFingerprint({
        accountId,
        version: current.version,
        features: next,
        impacts,
      });
      await setAccountSetting(
        c.env.DB,
        accountId,
        OFF_CONFIRM_KEY,
        JSON.stringify({
          token: impactToken,
          impactHash,
          version: current.version,
          expiresAt: Date.now() + OFF_CONFIRM_TTL_MS,
        } satisfies OffConfirmation),
      );
    } else if (offs.length > 0) {
      await deleteOffConfirmation(c.env.DB, accountId);
    }

    return c.json({
      success: true,
      data: {
        version: current.version,
        impacts: toPublicImpacts(impacts),
        requiresConfirmation,
        impactToken,
      },
    });
  } catch (err) {
    throw err;
  }
};

export const put__api_settings_features_4 = async (c: Context<Env, "/api/settings/features">) => {
  try {
    const accountId = getAccountId(c);
    if (!accountId) return inputError(c, { success: false, error: 'account_id が必要です' }, 400, ["accountId"]);
    if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [accountId])) {
      return c.json({ success: false, error: 'Forbidden' }, 403);
    }
    const restaurantMode = await restaurantAccessMode(c, accountId);
    const restaurantEnabled = restaurantMode !== null;
    const accountStyle = await c.env.DB.prepare('SELECT style FROM account_styles WHERE line_account_id=?')
      .bind(accountId).first<{ style: string }>();
    const restaurantStyle = accountStyle?.style === 'restaurant';

    const body = await c.req.json<{
      features?: Record<string, unknown>;
      sidebarOrder?: unknown;
      sidebarItemOrder?: unknown;
      favoriteItemIds?: unknown;
      restaurantHiddenItemIds?: unknown;
      catalog?: unknown;
      expectedVersion?: unknown;
      impactToken?: unknown;
      reason?: unknown;
    }>();

    let catalog: ToggleableFeature[] | undefined;
    if (body.catalog !== undefined) {
      const staff = c.get('staff');
      // 運営ロール未導入の現行契約では、既定統括の owner だけが変更できる。
      if (staff?.role !== 'owner' || staff.readOnly
        || (staff.tenantId ?? DEFAULT_TENANT_ID) !== DEFAULT_TENANT_ID) {
        return c.json({ success: false, error: 'この操作には運営権限が必要です' }, 403);
      }
      if (!Array.isArray(body.catalog)) {
        return inputError(c, { success: false, error: 'catalog は配列で指定してください' }, 400, ["catalog"]);
      }
      if (body.catalog.some((key) => typeof key !== 'string'
        || !NEN_SPECIALIZED_FEATURES.includes(key as ToggleableFeature))) {
        return inputError(c, { success: false, error: 'catalog に知らない専用機能が含まれています' }, 400, ["catalog"]);
      }
      catalog = body.catalog.filter(
        (key): key is ToggleableFeature => typeof key === 'string'
          && NEN_SPECIALIZED_FEATURES.includes(key as ToggleableFeature),
      );
    }

    const unknownKeys = Object.keys(body.features ?? {}).filter((k) => !isToggleable(k));
    if (unknownKeys.length > 0) {
      return inputError(c, { success: false, error: `知らない機能です: ${unknownKeys.join(', ')}` }, 400, ["features"]);
    }
    const invalidFeature = Object.entries(body.features ?? {})
      .find(([, value]) => typeof value !== 'boolean');
    if (invalidFeature) {
      return inputError(c, {
        success: false,
        error: `${invalidFeature[0]} はtrueまたはfalseで指定してください`,
      }, 400, ["features"]);
    }

    let sidebarOrder: string[] | null | undefined;
    if (restaurantStyle && (body.features?.restaurant_test === false || body.features?.visit_stamps === false)) {
      return inputError(c, { success: false, error: 'メインの予約台帳と来店スタンプはオフにできません' }, 400, ["features"]);
    }
    if (body.sidebarOrder !== undefined) {
      sidebarOrder = cleanSidebarOrderStrict(body.sidebarOrder, restaurantStyle);
      if (!sidebarOrder) {
        return inputError(c, {
          success: false,
          error: 'sidebarOrder はすべての区分を過不足なく並べた配列で指定してください',
        }, 400, ["sidebarOrder"]);
      }
    }

    let sidebarItemOrder: Record<string, string[]> | null | undefined;
    if (body.sidebarItemOrder !== undefined) {
      /*
       * 正解の顔ぶれはアカウントごとの専用カタログで変わる。
       * 同じ要求でカタログも変わるなら保存後の姿（新しいカタログ）を
       * 正解にする。画面が現在の表示から組み立てた完全な並びと
       * 一致するものだけを受け付ける。
       */
      const specializedKeys = catalog !== undefined
        ? new Set<string>(catalog)
        : new Set(specializedCatalog(
            await getAccountSetting(c.env.DB, accountId, SPECIALIZED_CATALOG_KEY),
          ));
      sidebarItemOrder = cleanItemOrderStrict(body.sidebarItemOrder, specializedKeys, restaurantStyle);
      if (!sidebarItemOrder) {
        return inputError(c, {
          success: false,
          error: 'sidebarItemOrder は各区分の項目を過不足なく並べたオブジェクトで指定してください',
        }, 400, ["sidebarItemOrder"]);
      }
    }

    let favoriteItemIds: string[] | undefined;
    if (body.favoriteItemIds !== undefined) {
      const favorites = cleanStringArray(body.favoriteItemIds);
      const allowed = expectedRestaurantMenuItemOrder(new Set(specializedCatalog(
        await getAccountSetting(c.env.DB, accountId, SPECIALIZED_CATALOG_KEY),
      )));
      const knownIds = new Set(Object.values(allowed).flat());
      if (!restaurantStyle || !favorites || new Set(favorites).size !== favorites.length
        || favorites.some((id) => !knownIds.has(id))) {
        return inputError(c, { success: false, error: 'お気に入りに指定できない項目があります' }, 400, ["favoriteItemIds"]);
      }
      favoriteItemIds = favorites;
    }
    let restaurantHiddenItemIds: string[] | undefined;
    if (body.restaurantHiddenItemIds !== undefined) {
      const hidden = cleanStringArray(body.restaurantHiddenItemIds);
      if (!restaurantStyle || !hidden || hidden.some((id) => !(RESTAURANT_OPTIONAL_ITEM_IDS as readonly string[]).includes(id))) {
        return inputError(c, { success: false, error: '飲食店メニューに指定できない項目があります' }, 400, ["restaurantHiddenItemIds"]);
      }
      restaurantHiddenItemIds = hidden;
    }

    const hasBundleUpdate = body.features !== undefined
      || body.sidebarOrder !== undefined
      || body.sidebarItemOrder !== undefined
      || body.favoriteItemIds !== undefined
      || body.restaurantHiddenItemIds !== undefined;

    /*
     * 変更理由の必須化。あとから「なぜ変えたか」を追えるよう、
     * 保存する要求は全部、空白ではない理由を持つこと。
     */
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if ((hasBundleUpdate || catalog !== undefined) && reason.length === 0) {
      return inputError(c, {
        success: false,
        error: '変更理由を入力してください',
        code: 'FEATURE_SETTINGS_REASON_REQUIRED',
      }, 400, ["features","sidebarOrder","sidebarItemOrder","reason"]);
    }
    /*
     * 機能・順序の保存は版なしでは受け付けない。版なし逐次保存は
     * 途中失敗で部分反映になり、版付きGETとの不整合を起こすため。
     *
     * ただし断るだけでは呼び出し側が次に何を送ればよいか分からない。
     * 機械可読な code と、そのまま送り返せる現在の版を必ず添えて、
     * 1往復で正しい保存へ進めるようにする。
     */
    if (hasBundleUpdate && body.expectedVersion === undefined) {
      const current = await loadFeatureSettings(
        c.env.DB,
        accountId,
        restaurantEnabled,
        restaurantMode === 'account',
      );
      return inputError(c, {
        success: false,
        error: 'expectedVersion が必要です。最新の設定を読み直してください。',
        code: 'EXPECTED_VERSION_REQUIRED',
        data: { currentVersion: current.version },
      }, 400, ["features","sidebarOrder","sidebarItemOrder","expectedVersion"]);
    }
    if (body.expectedVersion !== undefined
      && (!Number.isInteger(body.expectedVersion) || Number(body.expectedVersion) < 0)) {
      return inputError(c, {
        success: false,
        error: 'expectedVersion は0以上の整数で指定してください',
      }, 400, ["expectedVersion"]);
    }
    if (body.impactToken !== undefined && typeof body.impactToken !== 'string') {
      return inputError(c, {
        success: false,
        error: 'impactToken は文字列で指定してください',
      }, 400, ["impactToken"]);
    }

    /**
     * オフ前の影響確認。有効→無効に変わる機能に止まる仕事が
     * あるのに、有効な確認トークンが無ければ保存しない。直接PUTでの
     * 迂回もここで止める。影響が無ければ通常保存する。
     */
    const restaurantEnabledForImpact = restaurantEnabled;
    let presentedToken: string | null = null;
    /** 監査へ残す影響確認の結果。確認が要らない変更は要らなかったと記録する。 */
    let impactAudit: { offCount: number; blocking: boolean; confirmed: boolean } | null = null;
    if (body.features !== undefined) {
      const impactCurrent = await loadFeatureSettings(
        c.env.DB,
        accountId,
        restaurantEnabledForImpact,
        restaurantMode === 'account',
      );
      const impactNext = effectiveFeatures(
        impactCurrent.features,
        body.features,
        restaurantEnabledForImpact,
      );
      const impactOffs = offTransitions(impactCurrent.features, impactNext);
      if (impactOffs.length > 0) {
        const impacts = await buildImpacts(c.env.DB, accountId, impactOffs);
        const blocking = impacts.some((impact) => impact.blocking);
        impactAudit = { offCount: impactOffs.length, blocking, confirmed: false };
        if (blocking) {
          const fingerprint = await impactFingerprint({
            accountId,
            version: impactCurrent.version,
            features: impactNext,
            impacts,
          });
          const saved = await readOffConfirmation(c.env.DB, accountId);
          if (typeof body.impactToken !== 'string'
            || !saved
            || saved.token !== body.impactToken
            || saved.impactHash !== fingerprint
            || saved.version !== impactCurrent.version) {
            return c.json({
              success: false,
              error: 'オフにしようとしている機能に、公開中・予約中・依存中のものがあります。内容を確認してから保存してください。',
              code: 'IMPACT_CONFIRMATION_REQUIRED',
              data: { impacts: toPublicImpacts(impacts), currentVersion: impactCurrent.version },
            }, 409);
          }
          presentedToken = body.impactToken;
          impactAudit = { offCount: impactOffs.length, blocking: true, confirmed: true };
        }
      }
    }

    let savedVersion: number | null = null;
    let auditSaved = false;

    /**
     * 一括保存。一括設定・専用カタログ・確認トークン消費を
     * 単一batch(本番D1では1トランザクション)で書き、途中失敗の
     * 部分反映を起こさない。失敗時は例外か409で、版も実効値も
     * 変わらない。
     */
    if (hasBundleUpdate) {
      const current = await loadFeatureSettings(
        c.env.DB,
        accountId,
        restaurantEnabled,
        restaurantMode === 'account',
      );
      if (Number(body.expectedVersion) !== current.version) {
        return c.json({
          success: false,
          error: '別の管理者が先に変更しました。最新の設定を読み直してください。',
          data: { currentVersion: current.version },
        }, 409);
      }
      const incomingFeatures = { ...(body.features ?? {}) } as Record<string, boolean>;
      if (!restaurantEnabled && 'restaurant_test' in incomingFeatures) {
        incomingFeatures.restaurant_test = false;
      }
      const nextVersion = current.version + 1;
      const bundleValue = JSON.stringify({
        version: nextVersion,
        data: {
          features: { ...current.features, ...incomingFeatures },
          sidebarOrder: sidebarOrder === undefined ? current.sidebarOrder : sidebarOrder,
          sidebarItemOrder: sidebarItemOrder === undefined
            ? current.sidebarItemOrder
            : sidebarItemOrder,
          favoriteItemIds: favoriteItemIds === undefined ? current.favoriteItemIds ?? [] : favoriteItemIds,
          restaurantHiddenItemIds: restaurantHiddenItemIds === undefined ? current.restaurantHiddenItemIds ?? [] : restaurantHiddenItemIds,
        },
      });
      const now = japanCalendar()
        .toISOString()
        .replace('Z', '+09:00');
      const bundleExists = await getVersionedAccountSetting(
        c.env.DB,
        accountId,
        FEATURE_SETTINGS_BUNDLE_KEY,
      ) !== null;
      /*
       * 同時保存の敗者は1行も書かない。
       *
       * 一括設定のCASだけを条件にすると、負けた側でも専用カタログの
       * 上書きと確認トークンの削除だけが残り、409を返しながら別の
       * 変更が効いてしまう。そこで同じ版の判定式を全statementに付け、
       * 版が動いていれば「どれも0行」にする。判定式は一括設定の行しか
       * 見ないので、最後に置いた一括設定の更新までは同じ結果になる。
       */
      const versionGuard = bundleExists
        ? `EXISTS (SELECT 1 FROM account_settings guard
             WHERE guard.line_account_id = ? AND guard.key = ?
               AND json_valid(guard.value)
               AND CAST(json_extract(guard.value, '$.version') AS INTEGER) = ?)`
        : `NOT EXISTS (SELECT 1 FROM account_settings guard
             WHERE guard.line_account_id = ? AND guard.key = ?)`;
      const guardParams = bundleExists
        ? [accountId, FEATURE_SETTINGS_BUNDLE_KEY, current.version]
        : [accountId, FEATURE_SETTINGS_BUNDLE_KEY];
      const statements: D1PreparedStatement[] = [];
      if (catalog !== undefined) {
        statements.push(c.env.DB.prepare(
          `INSERT INTO account_settings (id, line_account_id, key, value, created_at, updated_at)
           SELECT ?, ?, ?, ?, ?, ? WHERE ${versionGuard}
           ON CONFLICT (line_account_id, key)
             DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        ).bind(
          crypto.randomUUID(),
          accountId,
          SPECIALIZED_CATALOG_KEY,
          JSON.stringify(catalog),
          now,
          now,
          ...guardParams,
        ));
      }
      if (presentedToken !== null) {
        statements.push(c.env.DB.prepare(
          `DELETE FROM account_settings
            WHERE line_account_id = ? AND key = ? AND ${versionGuard}`,
        ).bind(accountId, OFF_CONFIRM_KEY, ...guardParams));
      }
      /*
       * 保存の監査も同じbatch・同じ判定式で書く。
       * CASに負けたときは監査行も0行になり、「保存されていない成功」や
       * 「前後versionが混ざった監査」は残らない。
       */
      const staff = c.get('staff');
      const auditData = {
        features: { ...current.features, ...incomingFeatures },
        sidebarOrder: sidebarOrder === undefined ? current.sidebarOrder : sidebarOrder,
        sidebarItemOrder: sidebarItemOrder === undefined
          ? current.sidebarItemOrder
          : sidebarItemOrder,
        favoriteItemIds: favoriteItemIds === undefined ? current.favoriteItemIds ?? [] : favoriteItemIds,
        restaurantHiddenItemIds: restaurantHiddenItemIds === undefined ? current.restaurantHiddenItemIds ?? [] : restaurantHiddenItemIds,
      };
      statements.push(auditEventStatement(
        c.env.DB,
        {
          sourceKind: 'feature_settings',
          tenantId: staff?.tenantId,
          lineAccountId: accountId,
          category: 'business',
          actorPrincipalId: staff?.id,
          actorRole: staff?.role,
          action: 'feature_settings.save',
          targetKind: 'feature_settings',
          targetId: accountId,
          result: 'success',
          before: { ...current },
          after: {
            version: nextVersion,
            ...auditData,
            catalog: catalog ?? null,
            impact: impactAudit,
          },
          reason,
          requestTraceId: c.req.header('cf-ray') ?? c.req.header('x-request-id') ?? null,
          ipPrefix: maskAuditIp(c.req.header('cf-connecting-ip')),
          deviceFamily: auditDeviceFamily(c.req.header('user-agent')),
        },
        { sql: versionGuard, params: guardParams },
      ));
      // 一括設定の更新は最後に置く。先に置くと後続の判定式が
      // 「新しい版」を見てしまい、同じ前提で揃わなくなる。
      const casIndex = statements.length;
      statements.push(bundleExists
        ? c.env.DB.prepare(
          `UPDATE account_settings
              SET value = ?, updated_at = ?
            WHERE line_account_id = ? AND key = ?
              AND json_valid(value)
              AND CAST(json_extract(value, '$.version') AS INTEGER) = ?`,
        ).bind(bundleValue, now, accountId, FEATURE_SETTINGS_BUNDLE_KEY, current.version)
        : c.env.DB.prepare(
          `INSERT OR IGNORE INTO account_settings
            (id, line_account_id, key, value, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).bind(
          crypto.randomUUID(),
          accountId,
          FEATURE_SETTINGS_BUNDLE_KEY,
          bundleValue,
          now,
          now,
        ));
      const results = await c.env.DB.batch(statements);
      const changed = (index: number): number =>
        Number((results[index] as D1Result | undefined)?.meta?.changes ?? 0);
      if (changed(casIndex) !== 1) {
        // 判定式を共有しているので、負けたときは他のstatementも0行のはず。
        // 万一残っていれば契約が壊れているため、監視できるよう記録する。
        const leaked = results
          .map((_, index) => index)
          .filter((index) => index !== casIndex && changed(index) > 0);
        if (leaked.length > 0) {
          logger.error("feature_settings.settings_features_put_failed");
        }
        const reread = await loadFeatureSettings(
          c.env.DB,
          accountId,
          restaurantEnabled,
          restaurantMode === 'account',
        );
        return c.json({
          success: false,
          error: '別の管理者が先に変更しました。最新の設定を読み直してください。',
          data: { currentVersion: reread.version },
        }, 409);
      }
      savedVersion = nextVersion;
      auditSaved = true;
    } else if (catalog !== undefined) {
      /*
       * 専用カタログだけの変更は単独1行の保存で部分反映は起きないが、
       * 監査も同じbatchに入れて「保存だけ残る」「監査だけ残る」の
       * どちらも起こさない。
       */
      const staff = c.get('staff');
      const now = japanCalendar()
        .toISOString()
        .replace('Z', '+09:00');
      const catalogValue = JSON.stringify(catalog);
      const previousRaw = await getAccountSetting(c.env.DB, accountId, SPECIALIZED_CATALOG_KEY);
      await c.env.DB.batch([
        c.env.DB.prepare(
          `INSERT INTO account_settings (id, line_account_id, key, value, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (line_account_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        ).bind(crypto.randomUUID(), accountId, SPECIALIZED_CATALOG_KEY, catalogValue, now, now),
        auditEventStatement(c.env.DB, {
          sourceKind: 'feature_settings',
          tenantId: staff?.tenantId,
          lineAccountId: accountId,
          category: 'business',
          actorPrincipalId: staff?.id,
          actorRole: staff?.role,
          action: 'feature_settings.save',
          targetKind: 'feature_settings',
          targetId: accountId,
          result: 'success',
          before: { catalog: previousRaw ? specializedCatalog(previousRaw) : null },
          after: { catalog },
          reason,
          requestTraceId: c.req.header('cf-ray') ?? c.req.header('x-request-id') ?? null,
          ipPrefix: maskAuditIp(c.req.header('cf-connecting-ip')),
          deviceFamily: auditDeviceFamily(c.req.header('user-agent')),
        }),
      ]);
      auditSaved = true;
    }

    if (auditSaved) {
      // 詳しい監査は保存と同じbatchで書いた。共通middlewareの
      // 素の記録（api.put…）と二重にしない。
      c.set('auditRecorded', true);
    }

    // 確認トークンの使い切り消費は保存と同じbatchに含めた。
    // batchが失敗したら版も実効値もトークンも変わらない。
    return c.json({
      success: true,
      data: savedVersion === null ? null : { version: savedVersion },
    });
  } catch (err) {
    throw err;
  }
};
