import { parseOffsetPaging, buildOffsetListResponse } from '../lib/list-paging.js';
import { getCookie, setCookie } from 'hono/cookie';
import { logger } from '@line-crm/shared/server';
import { resolveFriendFromLineToken, unresolvedResponse } from '../services/affiliate-self-auth.js';
import { resolveMileageSource, getEcMileageBalance, hasHeldMileageRedemption } from '../services/mileage-ec-source.js';
import { customerDownloadEntry } from '../services/download-entrypoints.js';
import { signDownload, validDownload } from '../services/download-capability.js';
import { inputError, inputJsonBoundary } from '../lib/input-errors.js';
import { Hono, type MiddlewareHandler } from 'hono';
import { getAffiliateByFriendId, createAffiliate, createAffiliateLink, listAffiliateLinks, countAffiliateLinks, generateRefSlug, getAffiliateLinkStats, listAffiliateOffers, getCurrentOfferVersion, getOfferCapStatus, enrollAffiliateInOffer, getMileageSummaryForFriend, getMileageHistoryForFriend, getMileageSelfInsights, getMileageEarningOpportunitiesForFriend, listMileageRewards, getMileageRewardRedemptionCounts, reserveMileageRewardRedemption, MileageRewardError, encryptCredential, getAffiliateBankProfile, saveAffiliateBankProfile, listAffiliateStatementsForSelf, getAffiliateStatementDownload, type Affiliate, type AffiliateLink, type AffiliateLinkStat } from '@line-crm/db';
import { fail } from '../lib/fail.js';


import { affiliateBankFields } from '@line-crm/shared';
import { resolveLinkBaseUrl } from '../lib/link-base-url.js';
import { signCrossAccountToken } from '../lib/cross-account-token.js';
import type { Env } from '../worker-env.js';
import { sha256Hex } from '../middleware/auth.js';
import { isValidIdempotencyKey } from '../services/outbound-idempotency.js';
import { deliverMileageReward } from '../features/mileage/mileage-reward-delivery/index.js';

/** LIFF の LINE アクセストークンをサーバーで OAuth2/profile 検証し、その userId の友だちから参加者を解決する。別の人のデータへ触れないよう、クライアントから affiliate_id を受け取らない。/api/liff はスタッフ認証を通らないため、ここで本人確認する。 */
const affiliateSelfRoutes = new Hono<Env>();

// URL の資格情報をログ・キャッシュ・参照元へ漏らさない。
const privateSelfAccess: MiddlewareHandler<Env> = async (c, next) => {
  c.header('Cache-Control', 'private, no-store');
  c.header('Referrer-Policy', 'no-referrer');
  if (new URL(c.req.url).searchParams.has('lineAccessToken')
    && !(/^\/api\/liff\/affiliate\/statements\/[^/]+\/download$/.test(c.req.path)
      && !c.req.header('Authorization') && !c.req.query('signature') && !c.req.query('expires') && c.req.query('issue') !== '1')) {
    return c.json({ success: false, error: 'Use Authorization Bearer' }, 400);
  }
  await next();
};
affiliateSelfRoutes.use('/api/liff/mileage/*', privateSelfAccess);
affiliateSelfRoutes.use('/api/liff/affiliate/*', privateSelfAccess);

/** 自分で発行できるリンクは20本に制限し、21本目は400で拒む。 */
const MAX_SELF_LINKS = 20;

/** リンク別集計は ref_code で対応させる。新規で操作記録がないリンクは0として返す。 */
function serializeLink(
  link: AffiliateLink,
  baseUrl: string,
  stats?: Map<string, AffiliateLinkStat>,
  offerNames?: Map<string, string>,
) {
  const s = stats?.get(link.ref_code);
  return {
    refCode: link.ref_code,
    label: link.label,
    url: `${baseUrl}/${link.ref_code}`,
    clickCount: link.click_count,
    friendAdds: s?.friendAdds ?? 0,
    // 互換性のため、否認されていない承認済み・保留中の合計を conversions とする。
    conversions: s?.conversions ?? 0,
    conversionsPending: s?.conversionsPending ?? 0,
    conversionsApproved: s?.conversionsApproved ?? 0,
    offerId: link.offer_id ?? null,
    offerName: link.offer_id ? (offerNames?.get(link.offer_id) ?? null) : null,
  };
}

/** N+1 を避けて案件名を1回で解決する。発行済みリンクの名前が消えないよう、停止中の案件も含める。 */
async function loadOfferNames(
  db: D1Database,
  lineAccountId: string,
): Promise<Map<string, string>> {
  const offers = await listAffiliateOffers(db, {
    activeOnly: false,
    lineAccountIds: [lineAccountId],
  });
  return new Map(offers.map((o) => [o.id, o.name]));
}

function serializeAffiliate(aff: Affiliate) {
  return {
    id: aff.id,
    name: aff.name,
    code: aff.code,
    commissionRate: aff.commission_rate,
    isActive: Boolean(aff.is_active),
    friendId: aff.friend_id,
  };
}

/** マイルはアフィリエイト以外の利用でも貯まるため、確認済みの LINE 友だちなら参加者登録なしで残高を読める。 */
affiliateSelfRoutes.get('/api/liff/mileage/me', async (c) => {
  try {
    const token = (/^Bearer (.+)$/.exec(c.req.header('Authorization') ?? '')?.[1]);
    if (!token) {
      return c.json({ success: false, error: 'lineAccessToken is required' }, 400);
    }

    const resolved = await resolveFriendFromLineToken(c.env, token);
    if (resolved.status !== 'ok') return unresolvedResponse(c, resolved);

    const { limit } = parseOffsetPaging({ limit: c.req.query('limit') }, { defaultLimit: 20, limitPolicy: { format: 'integer-prefix', fallback: 'finite', minimum: 1, maximum: 100 } });
    const [mileage, history, insights, rawOpportunities] = await Promise.all([
      getMileageSummaryForFriend(c.env.DB, resolved.friend.id),
      getMileageHistoryForFriend(c.env.DB, resolved.friend.id, { limit }),
      getMileageSelfInsights(c.env.DB, resolved.friend.id),
      getMileageEarningOpportunitiesForFriend(c.env.DB, resolved.friend.id),
    ]);
    const accountId = resolved.friend.line_account_id;
    const source = accountId ? await resolveMileageSource(c.env.DB, accountId) : 'musubo';
    if (source === 'ec' && (!resolved.lineAccountId || resolved.lineAccountId !== accountId)) return fail(c, 404, 'FRIEND_NOT_FOUND');
    const visibleMileage = source === 'ec' && accountId
      ? { ...mileage, available: await getEcMileageBalance(c.env.DB, accountId, resolved.friend.id), balanceSource: 'ec' as const }
      : { ...mileage, balanceSource: 'musubo' as const };
    const browserNonce = getCookie(c, '__Host-lh_cross_account') || crypto.randomUUID();
    setCookie(c, '__Host-lh_cross_account', browserNonce, { httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: 15 * 60 });
    const opportunities = await Promise.all(rawOpportunities.map(async (opportunity) => {
      if (opportunity.type !== 'friend_add'
          || opportunity.completed
          || !opportunity.targetAccountId
          || !resolved.friend.user_id) {
        return opportunity;
      }
      const token = await signCrossAccountToken(c.env.LINE_CHANNEL_SECRET, {
        userId: resolved.friend.user_id,
        targetAccountId: opportunity.targetAccountId,
        browserNonce,
      });
      const separator = opportunity.url.includes('?') ? '&' : '?';
      return { ...opportunity, url: `${opportunity.url}${separator}crossAccountToken=${encodeURIComponent(token)}` };
    }));
    return c.json(buildOffsetListResponse({ success: true, mileage: visibleMileage, history, insights, opportunities, items: history, total: null, paging: { limit, offset: 0 }, sort: [] }));
  } catch (err) {
    throw err;
  }
});

/** 確認済みの友だちに公開済みの利用先を返す。未知の数字は null のまま保つ。 */
affiliateSelfRoutes.get('/api/liff/mileage/rewards', async (c) => {
  try {
    const token = (/^Bearer (.+)$/.exec(c.req.header('Authorization') ?? '')?.[1]);
    if (!token) return c.json({ success: false, error: 'lineAccessToken is required' }, 400);
    const resolved = await resolveFriendFromLineToken(c.env, token);
    if (resolved.status !== 'ok') return unresolvedResponse(c, resolved);
    // 紹介機能のlegacy fallbackは維持するが、残高を動かすマイル交換では
    // トークンのLINE Loginチャネルと友だちの所属が一致しない限り閉じる。
    if (!resolved.lineAccountId || resolved.friend.line_account_id !== resolved.lineAccountId) {
      return fail(c, 404, 'FRIEND_NOT_FOUND');
    }
    const source = await resolveMileageSource(c.env.DB, resolved.lineAccountId);
    if (source === 'ec') {
      const [availableMiles, hasHeldRedemption] = await Promise.all([
        getEcMileageBalance(c.env.DB, resolved.lineAccountId, resolved.friend.id),
        hasHeldMileageRedemption(c.env.DB, resolved.lineAccountId, resolved.friend.id),
      ]);
      return c.json({ success: true, balanceSource: 'ec', availableMiles, hasHeldRedemption, rewards: [] });
    }
    const [rewards, mileage, redemptionCounts] = await Promise.all([
      listMileageRewards(c.env.DB, {
        lineAccountId: resolved.lineAccountId,
        customerVisible: true,
      }),
      getMileageSummaryForFriend(c.env.DB, resolved.friend.id),
      getMileageRewardRedemptionCounts(c.env.DB, {
        lineAccountId: resolved.lineAccountId,
        friendId: resolved.friend.id,
      }),
    ]);
    return c.json({
      success: true,
      balanceSource: 'musubo',
      availableMiles: mileage.available,
      rewards: rewards.map((reward) => {
        const version = reward.currentVersion;
        const outOfCodes = reward.rewardKind === 'coupon' && reward.availableCodeCount === 0;
        const enoughMileage = version ? mileage.available >= version.requiredMiles : false;
        const friendLimitReached = Boolean(
          version?.perFriendLimit
          && (redemptionCounts.byRewardId.get(reward.id) ?? 0) >= version.perFriendLimit,
        );
        const stockLimitReached = Boolean(
          version?.stockLimit != null
          && (redemptionCounts.byVersionId.get(version.id) ?? 0) >= version.stockLimit,
        );
        return {
          ...reward,
          canRedeem: Boolean(version) && enoughMileage && !outOfCodes
            && !friendLimitReached && !stockLimitReached,
          unavailableReason: !version
            ? '交換条件を確認できません'
            : !enoughMileage
              ? '必要なマイルが足りません'
              : outOfCodes
                ? '在庫切れです'
                : friendLimitReached
                  ? 'この使い道の交換上限に達しています'
                  : stockLimitReached
                    ? '在庫切れです'
                    : null,
        };
      }),
    });
  } catch (error) {
    throw error;
  }
});

affiliateSelfRoutes.post('/api/liff/mileage/rewards/:id/redeem', inputJsonBoundary(), async (c) => {
  try {
    const body = await c.req.json<{ lineAccessToken?: unknown }>()
      .catch((): { lineAccessToken?: unknown } => ({}));
    const token = typeof body.lineAccessToken === 'string' ? body.lineAccessToken : '';
    if (!token) return inputError(c, { success: false, error: 'lineAccessToken is required' }, 400, ["lineAccessToken"]);
    const idempotencyKey = c.req.header('Idempotency-Key')?.trim();
    if (!isValidIdempotencyKey(idempotencyKey)) {
      return inputError(c, { success: false, error: '有効なIdempotency-Keyが必要です' }, 400, ["accountId","expectedVersion"]);
    }
    const resolved = await resolveFriendFromLineToken(c.env, token);
    if (resolved.status !== 'ok') return unresolvedResponse(c, resolved);
    if (!resolved.lineAccountId || resolved.friend.line_account_id !== resolved.lineAccountId) {
      return fail(c, 404, 'FRIEND_NOT_FOUND');
    }
    let source: 'ec' | 'musubo';
    try { source = await resolveMileageSource(c.env.DB, resolved.lineAccountId); }
    catch { return fail(c, 503, 'MILEAGE_SOURCE_UNAVAILABLE', { code: 'MILEAGE_SOURCE_UNAVAILABLE', error: 'マイルの管理元を確認できませんでした' }); }
    if (source === 'ec') return fail(c, 409, 'MILEAGE_MANAGED_BY_EC', { code: 'MILEAGE_MANAGED_BY_EC', error: 'マイルはECで管理しています' });
    const rewardId = c.req.param('id');
    const requestFingerprint = await sha256Hex(
      `${resolved.lineAccountId}\n${resolved.friend.id}\n${rewardId}`,
    );
    const reserved = await reserveMileageRewardRedemption(c.env.DB, {
      lineAccountId: resolved.lineAccountId,
      friendId: resolved.friend.id,
      rewardId,
      idempotencyKey,
      requestFingerprint,
    });
    const delivery = await deliverMileageReward(c.env.DB, reserved.redemption.id, {
      credentialEncryptionKey: c.env.LINE_CREDENTIAL_ENCRYPTION_KEY,
    });
    return c.json({
      success: delivery.status === 'succeeded' || delivery.status === 'pending',
      replayed: reserved.kind === 'existing',
      redemptionId: reserved.redemption.id,
      ...delivery,
    }, delivery.status === 'succeeded' ? 200 : 202);
  } catch (error) {
    if (error instanceof MileageRewardError) {
      return inputError(c, { success: false, error: error.message, code: error.code }, error.status as 400, []);
    }
    throw error;
  }
});

/** 登録の再送は既存の参加者とリンクを返す。初回だけリンクを1本作り、二重登録を防ぐ。 */
affiliateSelfRoutes.post('/api/liff/affiliate/register', inputJsonBoundary(), async (c) => {
  try {
    const body = await c.req
      .json<{ lineAccessToken?: string }>()
      .catch((): { lineAccessToken?: string } => ({}));
    const token = body.lineAccessToken;
    if (!token) {
      return inputError(c, { success: false, error: 'lineAccessToken is required' }, 400, ["lineAccessToken"]);
    }

    const db = c.env.DB;
    const resolved = await resolveFriendFromLineToken(c.env, token);
    if (resolved.status !== 'ok') {
      return unresolvedResponse(c, resolved);
    }
    const friend = resolved.friend;
    if (!resolved.lineAccountId || friend.line_account_id !== resolved.lineAccountId) {
      return fail(c, 404, 'FRIEND_NOT_FOUND');
    }

    const existing = await getAffiliateByFriendId(db, friend.id, resolved.lineAccountId);
    if (existing) {
      const links = await listAffiliateLinks(db, existing.id, {
        lineAccountId: resolved.lineAccountId,
      });
      const baseUrl = await resolveLinkBaseUrl(db, c.env);
      const stats = await getAffiliateLinkStats(db, existing.id, resolved.lineAccountId);
      const offerNames = await loadOfferNames(db, resolved.lineAccountId);
      return c.json({
        affiliate: serializeAffiliate(existing),
        links: links.map((l) => serializeLink(l, baseUrl, stats, offerNames)),
      });
    }

    let affiliate: Affiliate;
    try {
      affiliate = await createAffiliate(db, {
        name: friend.display_name || 'Affiliate',
        code: generateRefSlug(),
        friendId: friend.id,
        tenantId: resolved.tenantId,
        lineAccountId: resolved.lineAccountId,
      });
    } catch (createErr) {
      // 同時登録で UNIQUE(friend_id) に負けても、勝者の行を取得して同じ登録として返す。想定した一意制約以外の例外は握り潰さない。
      const raced = await getAffiliateByFriendId(db, friend.id, resolved.lineAccountId);
      if (!raced) throw createErr;
      const links = await listAffiliateLinks(db, raced.id, {
        lineAccountId: resolved.lineAccountId,
      });
      const baseUrl = await resolveLinkBaseUrl(db, c.env);
      const stats = await getAffiliateLinkStats(db, raced.id, resolved.lineAccountId);
      const offerNames = await loadOfferNames(db, resolved.lineAccountId);
      return c.json({
        affiliate: serializeAffiliate(raced),
        links: links.map((l) => serializeLink(l, baseUrl, stats, offerNames)),
      });
    }

    const firstLink = await createAffiliateLink(db, {
      affiliateId: affiliate.id,
      lineAccountId: resolved.lineAccountId,
    });
    const baseUrl = await resolveLinkBaseUrl(db, c.env);
    return c.json({
      affiliate: serializeAffiliate(affiliate),
      links: [serializeLink(firstLink, baseUrl)],
    });
  } catch (err) {
    throw err;
  }
});

/** LINE の友だちでも未登録なら404とし、本人の参加者情報とリンクだけを返す。 */
affiliateSelfRoutes.get('/api/liff/affiliate/me', async (c) => {
  try {
    const token = (/^Bearer (.+)$/.exec(c.req.header('Authorization') ?? '')?.[1]);
    if (!token) {
      return c.json({ success: false, error: 'lineAccessToken is required' }, 400);
    }

    const db = c.env.DB;
    const resolved = await resolveFriendFromLineToken(c.env, token);
    if (resolved.status !== 'ok') {
      return unresolvedResponse(c, resolved);
    }
    const friend = resolved.friend;
    if (!resolved.lineAccountId || friend.line_account_id !== resolved.lineAccountId) {
      return fail(c, 404, 'FRIEND_NOT_FOUND');
    }

    const affiliate = await getAffiliateByFriendId(db, friend.id, resolved.lineAccountId);
    if (!affiliate) {
      return c.json({ success: false, error: 'Not registered as an affiliate' }, 404);
    }

    const links = await listAffiliateLinks(db, affiliate.id, {
      lineAccountId: resolved.lineAccountId,
    });
    const baseUrl = await resolveLinkBaseUrl(db, c.env);
    const stats = await getAffiliateLinkStats(db, affiliate.id, resolved.lineAccountId);
    const offerNames = await loadOfferNames(db, resolved.lineAccountId);
    return c.json({
      affiliate: serializeAffiliate(affiliate),
      links: links.map((l) => serializeLink(l, baseUrl, stats, offerNames)),
    });
  } catch (err) {
    throw err;
  }
});

/** 本人の振込先。口座番号は復号せず、末尾4桁だけを返す。 */
affiliateSelfRoutes.get('/api/liff/affiliate/bank', async (c) => {
  try {
    const token = (/^Bearer (.+)$/.exec(c.req.header('Authorization') ?? '')?.[1]);
    if (!token) return c.json({ success: false, error: 'lineAccessToken is required' }, 400);
    const resolved = await resolveFriendFromLineToken(c.env, token);
    if (resolved.status !== 'ok') return unresolvedResponse(c, resolved);
    if (!resolved.lineAccountId || resolved.friend.line_account_id !== resolved.lineAccountId) {
      return fail(c, 404, 'FRIEND_NOT_FOUND');
    }
    const affiliate = await getAffiliateByFriendId(c.env.DB, resolved.friend.id, resolved.lineAccountId);
    if (!affiliate) return c.json({ success: false, error: 'Not registered as an affiliate' }, 404);
    const data = await getAffiliateBankProfile(c.env.DB, {
      tenantId: resolved.tenantId, lineAccountId: resolved.lineAccountId, affiliateId: affiliate.id,
    });
    return c.json({ success: true, data });
  } catch (error) {
    throw error;
  }
});

/** LINEへtokenを再照合した本人だけが振込先を登録・変更できる。 */
affiliateSelfRoutes.put('/api/liff/affiliate/bank', inputJsonBoundary(), async (c) => {
  try {
    const key = c.req.header('Idempotency-Key')?.trim() ?? '';
    type BankBody = {
      lineAccessToken?: unknown; bankCode?: unknown; bankName?: unknown;
      branchCode?: unknown; branchName?: unknown; accountType?: unknown;
      accountNumber?: unknown; accountHolderName?: unknown; expectedVersion?: unknown;
    };
    const body = await c.req.json<BankBody>().catch((): BankBody => ({}));
    const fields = affiliateBankFields(body);
    if (Object.keys(fields).length) {
      return c.json({ success: false, error: '振込先を確認してください', fields }, 400);
    }
    if (!isValidIdempotencyKey(key) || typeof body.lineAccessToken !== 'string'
      || !Number.isInteger(body.expectedVersion) || Number(body.expectedVersion) < 0) {
      return inputError(c, { success: false, error: '版、再実行キーを確認してください' }, 400, ['expectedVersion']);
    }
    // 欄の検証後に型を固定する。秘密値は応答・ログに含めない。
    const bank = body as BankBody & { bankCode: string; bankName: string; branchCode: string;
      branchName: string; accountNumber: string; accountHolderName: string };
    const resolved = await resolveFriendFromLineToken(c.env, body.lineAccessToken);
    if (resolved.status !== 'ok') return unresolvedResponse(c, resolved);
    if (!resolved.lineAccountId || resolved.friend.line_account_id !== resolved.lineAccountId) {
      return fail(c, 404, 'FRIEND_NOT_FOUND');
    }
    const affiliate = await getAffiliateByFriendId(c.env.DB, resolved.friend.id, resolved.lineAccountId);
    if (!affiliate) return c.json({ success: false, error: 'Not registered as an affiliate' }, 404);
    const canonical = {
      bankCode: bank.bankCode, bankName: bank.bankName.trim(), branchCode: bank.branchCode,
      branchName: bank.branchName.trim(), accountType: body.accountType as 'ordinary' | 'checking',
      accountNumber: bank.accountNumber, accountHolderName: bank.accountHolderName.trim(),
      expectedVersion: Number(body.expectedVersion),
    };
    const result = await saveAffiliateBankProfile(c.env.DB, {
      tenantId: resolved.tenantId, lineAccountId: resolved.lineAccountId,
      affiliateId: affiliate.id, ...canonical,
      encryptedAccountNumber: await encryptCredential(bank.accountNumber, c.env.LINE_CREDENTIAL_ENCRYPTION_KEY),
      accountLast4: bank.accountNumber.slice(-4),
      accountFingerprint: await sha256Hex(bank.accountNumber),
      idempotencyKey: key,
      requestFingerprint: await sha256Hex(JSON.stringify(canonical)),
    });
    if (result.kind === 'changed') {
      return c.json({ success: false, error: '振込先が更新されています', code: 'VERSION_CONFLICT' }, 409);
    }
    if (result.kind === 'idempotency_conflict') {
      return c.json({ success: false, error: '同じ再実行キーが別の入力に使われています', code: 'IDEMPOTENCY_CONFLICT' }, 409);
    }
    logger.log("routes_affiliate_self_log");
    return c.json({ success: true, data: result.profile }, result.kind === 'created' ? 201 : 200);
  } catch (error) {
    throw error;
  }
});

/** 本人の支払明細一覧。 */
affiliateSelfRoutes.get('/api/liff/affiliate/statements', async (c) => {
  try {
    c.header('Cache-Control', 'private, no-store');
    c.header('Referrer-Policy', 'no-referrer');
    const token = /^Bearer (.+)$/.exec(c.req.header('Authorization') ?? '')?.[1];
    if (!token) return c.json({ success: false, error: 'lineAccessToken is required' }, 400);
    const resolved = await resolveFriendFromLineToken(c.env, token);
    if (resolved.status !== 'ok') return unresolvedResponse(c, resolved);
    if (!resolved.lineAccountId || resolved.friend.line_account_id !== resolved.lineAccountId) {
      return fail(c, 404, 'FRIEND_NOT_FOUND');
    }
    const affiliate = await getAffiliateByFriendId(c.env.DB, resolved.friend.id, resolved.lineAccountId);
    if (!affiliate) return c.json({ success: false, error: 'Not registered as an affiliate' }, 404);
    const data = await listAffiliateStatementsForSelf(c.env.DB, {
      tenantId: resolved.tenantId, lineAccountId: resolved.lineAccountId, affiliateId: affiliate.id,
    });
    return c.json({ success: true, data: data.map(statement => ({ ...statement,
      renewalUrl: customerDownloadEntry(c.env.WORKER_PUBLIC_URL || c.env.WORKER_URL || new URL(c.req.url).origin, 'statements', statement.id),
    })) });
  } catch (error) {
    throw error;
  }
});

/** 本人の有効な明細だけをR2から返す。 */
affiliateSelfRoutes.get('/api/liff/affiliate/statements/:id/download', async (c) => {
  try {
    c.header('Cache-Control', 'private, no-store');
    c.header('Referrer-Policy', 'no-referrer');
    // 保存済みのメール・LINE のリンクは LIFF へ案内し、トークンやクエリを複製しない。
    if (!c.req.header('Authorization') && !c.req.query('signature') && !c.req.query('expires') && c.req.query('issue') !== '1') {
      return c.redirect(customerDownloadEntry(c.env.WORKER_PUBLIC_URL || c.env.WORKER_URL || new URL(c.req.url).origin, 'statements', c.req.param('id')), 303);
    }
    const token = /^Bearer (.+)$/.exec(c.req.header('Authorization') ?? '')?.[1];
    if (!token) return c.json({ success: false, error: 'lineAccessToken is required' }, 400);
    const resolved = await resolveFriendFromLineToken(c.env, token);
    if (resolved.status !== 'ok') return unresolvedResponse(c, resolved);
    if (!resolved.lineAccountId || resolved.friend.line_account_id !== resolved.lineAccountId) {
      return fail(c, 404, 'FRIEND_NOT_FOUND');
    }
    const affiliate = await getAffiliateByFriendId(c.env.DB, resolved.friend.id, resolved.lineAccountId);
    if (!affiliate) return c.json({ success: false, error: 'Not registered as an affiliate' }, 404);
    const file = await getAffiliateStatementDownload(c.env.DB, {
      tenantId: resolved.tenantId, lineAccountId: resolved.lineAccountId,
      affiliateId: affiliate.id, statementId: c.req.param('id'),
    });
    if (!file) return c.json({ success: false, error: '支払明細が見つからないか期限切れです' }, 404);
    if (!c.env.API_KEY) return c.json({ success: false, error: '取得用の鍵が未設定です' }, 503);
    const binding = JSON.stringify([resolved.tenantId, resolved.lineAccountId, affiliate.id, resolved.friend.id]);
    if (c.req.query('issue') === '1') {
      if (!await c.env.IMAGES.head(file.objectKey)) return c.json({ success: false, error: '支払明細が見つかりません' }, 404);
      const url = await signDownload(new URL(c.req.url), c.env.API_KEY, 'affiliate-statement', file.statement.id, binding,
        file.statement.expiresAt ? Date.parse(file.statement.expiresAt) : undefined);
      return c.json({ success: true, data: { url, expiresAt: new Date(Number(new URL(url).searchParams.get('expires')) * 1000).toISOString() } });
    }
    if (!await validDownload(new URL(c.req.url), c.env.API_KEY, 'affiliate-statement', file.statement.id, binding)) {
      return c.json({ success: false, error: '取得用URLが無効か期限切れです' }, 403);
    }
    const object = await c.env.IMAGES.get(file.objectKey);
    if (!object) return c.json({ success: false, error: '支払明細が見つかりません' }, 404);
    logger.log("routes_affiliate_self_log");
    return new Response(object.body, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="affiliate-statement-${file.statement.id}.pdf"`,
        'Cache-Control': 'private, no-store',
        'Referrer-Policy': 'no-referrer',
      },
    });
  } catch (error) {
    throw error;
  }
});

/** 自己発行は20本までとする。offerId があれば稼働中かつ参加済みの案件だけに発行し、案件の line_account_id を継承して帰属をそろえる。未指定は汎用リンクとして扱う。 */
affiliateSelfRoutes.post('/api/liff/affiliate/links', inputJsonBoundary(), async (c) => {
  try {
    const body = await c.req
      .json<{ lineAccessToken?: string; label?: string | null; offerId?: string | null }>()
      .catch((): { lineAccessToken?: string; label?: string | null; offerId?: string | null } => ({}));
    const token = body.lineAccessToken;
    if (!token) {
      return inputError(c, { success: false, error: 'lineAccessToken is required' }, 400, ["lineAccessToken"]);
    }

    const db = c.env.DB;
    const resolved = await resolveFriendFromLineToken(c.env, token);
    if (resolved.status !== 'ok') {
      return unresolvedResponse(c, resolved);
    }
    const friend = resolved.friend;
    if (!resolved.lineAccountId || friend.line_account_id !== resolved.lineAccountId) {
      return fail(c, 404, 'FRIEND_NOT_FOUND');
    }

    const affiliate = await getAffiliateByFriendId(db, friend.id, resolved.lineAccountId);
    if (!affiliate) {
      return c.json({ success: false, error: 'Not registered as an affiliate' }, 404);
    }

    const count = await countAffiliateLinks(db, affiliate.id);
    if (count >= MAX_SELF_LINKS) {
      return inputError(c, { success: false, error: `Link limit reached (max ${MAX_SELF_LINKS})` }, 400, ["lineAccessToken"]);
    }

    // 非表示・未参加の案件へリンクを作らせないよう、offerId 指定時は有効状態と参加を検証する。
    const offerId = typeof body.offerId === 'string' && body.offerId ? body.offerId : null;
    let offerLineAccountId: string | null = null;
    if (offerId) {
      const activeOffers = await listAffiliateOffers(db, {
        activeOnly: true,
        lineAccountIds: [resolved.lineAccountId],
      });
      const offer = activeOffers.find((o) => o.id === offerId);
      if (!offer) {
        return fail(c, 404, 'OFFER_NOT_FOUND');
      }
      const existingLinks = await listAffiliateLinks(db, affiliate.id, {
        lineAccountId: resolved.lineAccountId,
      });
      const enrolled = existingLinks.some((l) => l.offer_id === offerId);
      if (!enrolled) {
        return inputError(c, { success: false, error: '先に案件に参加してください' }, 400, ["offerId","lineAccessToken"]);
      }
      offerLineAccountId = offer.line_account_id ?? null;
    }

    const label = typeof body.label === 'string' ? body.label : null;
    const link = await createAffiliateLink(db, {
      affiliateId: affiliate.id,
      label,
      offerId,
      lineAccountId: offerLineAccountId,
    });
    const baseUrl = await resolveLinkBaseUrl(db, c.env);
    const offerNames = offerId
      ? await loadOfferNames(db, resolved.lineAccountId)
      : undefined;
    return c.json({ link: serializeLink(link, baseUrl, undefined, offerNames) });
  } catch (err) {
    throw err;
  }
});

/** 案件のリンクを本人へ結び付ける必要があるため、登録済み参加者だけに稼働中の案件と参加状態を返す。 */
affiliateSelfRoutes.get('/api/liff/affiliate/offers', async (c) => {
  try {
    const token = (/^Bearer (.+)$/.exec(c.req.header('Authorization') ?? '')?.[1]);
    if (!token) {
      return c.json({ success: false, error: 'lineAccessToken is required' }, 400);
    }

    const db = c.env.DB;
    const resolved = await resolveFriendFromLineToken(c.env, token);
    if (resolved.status !== 'ok') {
      return unresolvedResponse(c, resolved);
    }
    const friend = resolved.friend;
    if (!resolved.lineAccountId || friend.line_account_id !== resolved.lineAccountId) {
      return fail(c, 404, 'FRIEND_NOT_FOUND');
    }

    const affiliate = await getAffiliateByFriendId(db, friend.id, resolved.lineAccountId);
    if (!affiliate) {
      return c.json({ success: false, error: 'Not registered as an affiliate' }, 404);
    }

    const offers = await listAffiliateOffers(db, {
      activeOnly: true,
      lineAccountIds: [resolved.lineAccountId],
    });
    const links = await listAffiliateLinks(db, affiliate.id, {
      lineAccountId: resolved.lineAccountId,
    });
    const baseUrl = await resolveLinkBaseUrl(db, c.env);

    // 再参加でも同じリンクを返すため、新しい順の一覧を逆から読み、案件ごとに最初の発行を採用する。
    const linkByOffer = new Map<string, AffiliateLink>();
    for (let i = links.length - 1; i >= 0; i--) {
      const l = links[i];
      if (l.offer_id) linkByOffer.set(l.offer_id, l);
    }

    // 案件の決まり(今の版)と上限の残りを添える。上限に達した受付の
    // 自動停止は、紹介した人の画面にも出す。
    const data = [];
    for (const o of offers) {
      const link = linkByOffer.get(o.id);
      const version = await getCurrentOfferVersion(db, o.id);
      const status = await getOfferCapStatus(db, o.id, { affiliateId: affiliate.id });
      data.push({
        id: o.id,
        name: o.name,
        description: o.description,
        rewardAmount: version?.reward_amount ?? o.reward_amount,
        rewardMiles: version?.reward_miles ?? o.reward_miles ?? 0,
        windowDays: version?.window_days ?? 30,
        receptionFrom: version?.reception_from ?? null,
        receptionTo: version?.reception_to ?? null,
        halted: status.capped,
        totalRemaining: status.totalRemaining,
        monthlyRemaining: status.monthlyRemaining,
        enrolled: Boolean(link),
        refCode: link ? link.ref_code : null,
        url: link ? `${baseUrl}/${link.ref_code}` : null,
      });
    }

    return c.json({ offers: data });
  } catch (err) {
    throw err;
  }
});

/** 再参加でもリンクを増やさず同じ参加者・案件の最初のリンクを返す。無効・未知の案件は404とする。 */
affiliateSelfRoutes.post('/api/liff/affiliate/offers/:id/enroll', inputJsonBoundary(), async (c) => {
  try {
    const body = await c.req
      .json<{ lineAccessToken?: string }>()
      .catch((): { lineAccessToken?: string } => ({}));
    const token = body.lineAccessToken;
    if (!token) {
      return inputError(c, { success: false, error: 'lineAccessToken is required' }, 400, ["lineAccessToken"]);
    }

    const db = c.env.DB;
    const resolved = await resolveFriendFromLineToken(c.env, token);
    if (resolved.status !== 'ok') {
      return unresolvedResponse(c, resolved);
    }
    const friend = resolved.friend;
    if (!resolved.lineAccountId || friend.line_account_id !== resolved.lineAccountId) {
      return fail(c, 404, 'FRIEND_NOT_FOUND');
    }

    const affiliate = await getAffiliateByFriendId(db, friend.id, resolved.lineAccountId);
    if (!affiliate) {
      return c.json({ success: false, error: 'Not registered as an affiliate' }, 404);
    }

    // 非表示・停止中の案件へ参加できないよう、有効な案件一覧で絞る。
    const activeOffers = await listAffiliateOffers(db, {
      activeOnly: true,
      lineAccountIds: [resolved.lineAccountId],
    });
    const offer = activeOffers.find((o) => o.id === c.req.param('id'));
    if (!offer) {
      return fail(c, 404, 'OFFER_NOT_FOUND');
    }

    // 上限に達した案件の受付は自動で止める。参加済みの人の紹介リンクは
    // 残るが、新しい参加と成果の付与は止まる。
    const capStatus = await getOfferCapStatus(db, offer.id, { affiliateId: affiliate.id });
    if (capStatus.capped) {
      return c.json({ success: false, error: 'この案件の受付は上限に達したため終了しました' }, 409);
    }

    const { link } = await enrollAffiliateInOffer(db, {
      affiliateId: affiliate.id,
      offerId: offer.id,
    });
    const baseUrl = await resolveLinkBaseUrl(db, c.env);
    const offerNames = new Map([[offer.id, offer.name]]);
    return c.json({
      offerId: offer.id,
      link: serializeLink(link, baseUrl, undefined, offerNames),
    });
  } catch (err) {
    throw err;
  }
});

export { affiliateSelfRoutes };
