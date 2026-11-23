import { logger, tracedFetch as fetch } from '@line-crm/shared/server';
import { sqlIdSet } from '@line-crm/db/id-queries';
import { patchFriendMetadata } from '../features/friends/friend-metadata/index.js';
import { type Context } from 'hono';
import { getEntryRouteByRefCode, recordFriendAddAttributionCandidate, addTagToFriend, getTrackedLinkById, getAffiliateLinkByRefCode, getAffiliateOfferById, getAffiliateById, enrollFriendInScenario, findOrCreateGlobalTag, isLineAccountTenantActive } from '@line-crm/db';
import { isStoppedEntryRouteRef } from '../services/entry-route-stop.js';
import { attachTagAndFireSideEffects } from '../features/friends/friend-tag-attach/index.js';
import { pushImmediateFirstStep } from '../services/immediate-first-step.js';
import { notifyAffiliateFriendAdd } from '../services/affiliate-notifier.js';
import { awardActivityMileage } from '../services/activity-mileage.js';
import type { Env } from '../worker-env.js';
import { getVisibleLineAccountScope } from '../services/account-access.js';

export // btoa は Latin-1 だけを受け付けるため、OAuth state は文字コードを変換してから符号化する。
// Multibyte query params must be encoded as UTF-8 bytes to avoid
// InvalidCharacterError. decodeState is byte-compatible with
// states produced by the old plain btoa (ASCII-only payloads).
function encodeState(state: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(state)));
}
export function decodeState(encoded: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(encoded), (ch) => ch.charCodeAt(0)));
}

export const TENANT_UNAVAILABLE_RESPONSE = {
  success: false,
  code: 'TENANT_SUSPENDED',
  error: '現在ご利用いただけません',
} as const;

export async function stoppedLineAccountResponse(
  c: Context<Env>,
  lineAccountId: string | null | undefined,
): Promise<Response | null> {
  if (!lineAccountId) return null;
  return await isLineAccountTenantActive(c.env.DB, lineAccountId)
    ? null
    : c.json(TENANT_UNAVAILABLE_RESPONSE, 503);
}

export /**
 * 呼び出し側の見えるアカウントに絞る WHERE 断片を作る。
 * 友だち(f)だけでなく注文(o)や相関副問合せの友だち(f2)にも
 * 同じ条件を使うため、別名ごとの断片を `for(alias)` で作れるようにした。
 * 既定の where/binds は従来どおり友だち別名 `f` のものを返す。
 */
async function analyticsAccountScope(c: Context<Env>, lineAccountId?: string) {
  const scope = await getVisibleLineAccountScope(c.env.DB, c.get('staff'));
  if (lineAccountId && !scope.allowedAccountIds.includes(lineAccountId)) {
    return null;
  }
  const forAlias = (alias: string) => {
    if (lineAccountId) {
      return { where: `AND ${alias}.line_account_id = ?`, binds: [lineAccountId] };
    }
    const where = scope.allowedAccountIds.length
      ? `AND (${alias}.line_account_id IN (${sqlIdSet(scope.allowedAccountIds).sql})${scope.canSeeUnassigned ? ` OR ${alias}.line_account_id IS NULL` : ''})`
      : scope.canSeeUnassigned
        ? `AND ${alias}.line_account_id IS NULL`
        : 'AND 1 = 0';
    return { where, binds: scope.allowedAccountIds.length ? sqlIdSet(scope.allowedAccountIds).binds : [] };
  };
  return { ...forAlias('f'), for: forAlias };
}

export async function saveFriendAddCandidate(
  db: D1Database,
  input: {
    lineAccountId: string | null;
    friendId: string;
    refCode?: string | null;
    source: 'line_login' | 'liff' | 'short_link';
  },
): Promise<void> {
  const refCode = input.refCode?.trim();
  if (!input.lineAccountId || !refCode || refCode.startsWith('xh:')) return;
  // 停止した流入経路の ref は候補も残さない。入口表示後に停止して
  // LIFF/OAuth直送で届いた場合も、共有 namespace の tracked/affiliate へ
  // 落とさず止める。不存在 ref (Any が null) は従来どおり記録する。
  if (await isStoppedEntryRouteRef(db, refCode)) return;
  try {
    const route = await getEntryRouteByRefCode(db, refCode);
    await recordFriendAddAttributionCandidate(db, {
      lineAccountId: input.lineAccountId,
      friendId: input.friendId,
      refCode,
      entryRouteId: route?.id ?? null,
      source: input.source,
    });
  } catch (err) {
    // 既存のLIFF連携を止めない。台帳だけ監視ログへ残して再調査できるようにする。
    logger.error("friend_add.record_candidate_failed");
  }
}

export // 連携済みでも LIFF の各入口から ig_igsid を保存する。保存後に同じ IGSID と結び付いている場合だけ true を返し、metadata が実際の結び付けと矛盾しないようにする。IGSID 未指定は競合の根拠がないため true とする。
async function linkIgIgsid(
  c: Context<Env>,
  friendId: string,
  igParam: string,
): Promise<boolean> {
  if (!igParam) return true;

  // LINE 側が指定 IGSID に結び付いていることを先に確認し、その場合だけ IG 側へ通知する。別の IG 指定で再訪したとき、2つの DB が別の相手を指すのを防ぐ。
  let linked = false;
  try {
    const result = await c.env.DB
      .prepare('UPDATE friends SET ig_igsid = ? WHERE id = ? AND (ig_igsid IS NULL OR ig_igsid = ?)')
      .bind(igParam, friendId, igParam)
      .run();
    if (result.meta?.changes && result.meta.changes > 0) {
      linked = true;
    } else {
      const row = await c.env.DB
        .prepare('SELECT ig_igsid FROM friends WHERE id = ?')
        .bind(friendId)
        .first<{ ig_igsid: string | null }>();
      linked = row?.ig_igsid === igParam;
    }
  } catch (err) {
    logger.error("liff.link_ig_igsid_failed");
    return false;
  }

  if (!linked) {
    logger.warn("liff_definition.link_ig_igsid_failed");
    return false;
  }

  // IG から LINE へ戻った操作を記録する。同じ識別子を使い、繰り返し訪問しても重複しないようにする。
  await awardActivityMileage(c.env.DB, {
    eventType: 'instagram_line_returned',
    source: 'instagram',
    sourceEventId: `${friendId}:${igParam}`,
    friendId,
    subjectKey: igParam,
    metadata: { igsid: igParam },
  });

  if (c.env.IG_HARNESS_URL && c.env.IG_HARNESS_LINK_SECRET) {
    c.executionCtx.waitUntil(
      fetch(`${c.env.IG_HARNESS_URL}/api/followers/link-line`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-LINE-HARNESS-LINK-SECRET': c.env.IG_HARNESS_LINK_SECRET,
        },
        body: JSON.stringify({ igsid: igParam, line_friend_uuid: friendId }),
      })
        .then(async (res) => {
          if (!res.ok) {
            logger.error("liff.link_ig_igsid_failed");
          }
          await res.body?.cancel().catch(() => undefined);
        })
        .catch((err) => logger.error("liff.link_ig_igsid_failed")),
    );
  }
  return true;
}

export /** 複数 IG アカウントから流入しても初回の帰属を保つ。ig_account_id/ig_account_username は metadata に保存し、管理画面の流入表示に使う。 */
async function saveIgAccountMeta(
  db: D1Database,
  friendId: string,
  igAccountId: string,
  igAccountUsername: string,
): Promise<void> {
  if (!igAccountId && !igAccountUsername) return;
  try {
    const patch: Record<string,string> = {};
    if (igAccountId) patch.ig_account_id = igAccountId;
    if (igAccountUsername) patch.ig_account_username = igAccountUsername.replace(/^@/, '');
    await patchFriendMetadata(db, friendId, patch, { firstTouchKeys: ['ig_account_id','ig_account_username'] });
  } catch (err) {
    logger.error("liff.save_ig_account_meta_failed");
  }
}

export // ref は経路、計測リンクの順で解決し、タグとシナリオへ適用する。遅延0のクリック配信は再訪でも送り、購読の通番は新規登録時だけ進める。新規 OAuth と既存 LIFF の両方で使う。follow 前でも誤った Bot から送らないよう、解決済み accountChannelId を優先する。
async function applyRefAttribution(
  c: Context<Env>,
  ref: string,
  friend: { id: string; line_account_id?: string | null },
  lineUserId: string,
  options?: { accountChannelId?: string | null; isNewFriend?: boolean },
): Promise<void> {
  if (!ref || ref.startsWith('xh:')) return;
  const db = c.env.DB;

  // 停止した流入経路の ref は、入口表示後の LIFF/OAuth 直送でも
  // tracked/affiliate fallback・タグ/シナリオ開始をすべて止める。
  // 不存在 ref は共有 namespace の正規フローのため従来どおり進める。
  if (await isStoppedEntryRouteRef(db, ref)) return;

  const route = await getEntryRouteByRefCode(db, ref);
  let trackedLink: Awaited<ReturnType<typeof getTrackedLinkById>> = null;
  if (!route) {
    const tl = await getTrackedLinkById(db, ref);
    if (tl?.is_active) trackedLink = tl;
  }

  // 経路・計測リンクに当たらない ref は案件付きアフィリエイトリンクを調べ、同じタグ・シナリオ処理へつなぐ。案件なしの汎用リンクは自動付与しない。
  let offer: Awaited<ReturnType<typeof getAffiliateOfferById>> = null;
  if (!route && !trackedLink) {
    const affiliateLink = await getAffiliateLinkByRefCode(db, ref);
    if (affiliateLink) {
      // 通知過多を防ぐため、アフィリエイト経由の新規友だちだけを通知し、再訪と自己クリックは除く。汎用リンクも対象とし、通知失敗で帰属処理は止めない。
      if (options?.isNewFriend) {
        try {
          const affiliate = await getAffiliateById(db, affiliateLink.affiliate_id);
          if (affiliate && affiliate.friend_id !== friend.id) {
            let offerName: string | null = null;
            if (affiliateLink.offer_id) {
              const linkOffer = await getAffiliateOfferById(db, affiliateLink.offer_id);
              offerName = linkOffer?.name ?? null;
            }
            await notifyAffiliateFriendAdd(db, c.env, affiliate.id, offerName);
          }
        } catch (err) {
          logger.error("liff.apply_ref_attribution_failed");
        }
      }

      if (affiliateLink.offer_id) {
        const fetchedOffer = await getAffiliateOfferById(db, affiliateLink.offer_id);
        // 停止中の案件はタグ・シナリオを始めない。これより前のクリックと初回流入の記録は保つ。
        if (fetchedOffer?.is_active) {
          offer = fetchedOffer;
        }
      }
    }
  }

  const effectiveTagId = route?.tag_id ?? trackedLink?.tag_id ?? offer?.tag_id ?? null;
  const effectiveScenarioId =
    route?.scenario_id ?? trackedLink?.scenario_id ?? offer?.scenario_id ?? null;

  if (effectiveTagId) {
    // 同じタグを持つリンクへ何度入ってもタグ起点のシナリオが重複しないよう、新規付与時だけ副作用を動かす。毎クリック配信は明示的な scenario_id の処理へ分ける。
    await attachTagAndFireSideEffects(db, friend.id, effectiveTagId, {
      defaultAccessToken: c.env.LINE_CHANNEL_ACCESS_TOKEN,
      workerUrl: c.env.WORKER_URL,
      accountChannelId: options?.accountChannelId ?? null,
    });
  }
  if (effectiveScenarioId) {
    try {
      await pushImmediateFirstStep(
        db,
        friend.id,
        effectiveScenarioId,
        {
          defaultAccessToken: c.env.LINE_CHANNEL_ACCESS_TOKEN,
          workerUrl: c.env.WORKER_URL,
          accountChannelId: options?.accountChannelId ?? null,
        },
        // 毎クリック配信はクールダウンを確認し、再訪でも送る。通番は新規・遅れた購読だけ進め、宛先は検証済みトークンの lineUserId を使う。
        { mode: 'every-click', targetLineUserId: lineUserId },
      );
    } catch (err) {
      logger.error("liff.apply_ref_attribution_failed");
    }
  }
}

export // ─── HTML Templates ─────────────────────────────────────────────

function authLandingPage(liffUrl: string, oauthUrl: string): string {
  // Extract LIFF ID from URL like https://liff.line.me/{LIFF_ID}?ref=test
  const liffIdMatch = liffUrl.match(/liff\.line\.me\/([^?]+)/);
  const liffId = liffIdMatch ? liffIdMatch[1] : '';

  const qsIndex = liffUrl.indexOf('?');
  const liffQs = qsIndex >= 0 ? liffUrl.slice(qsIndex) : '';

  // LIFF を LINE アプリで開くため、line: の形式へ変換する。
  const lineSchemeUrl = `https://line.me/R/app/${liffId}${liffQs}`;

  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>LINE で開く</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Hiragino Sans', system-ui, sans-serif; background: #06C755; display: flex; justify-content: center; align-items: center; min-height: 100vh; }
    .card { background: #fff; border-radius: 16px; padding: 40px 24px; box-shadow: 0 4px 16px rgba(0,0,0,0.15); text-align: center; max-width: 400px; width: 90%; }
    .line-icon { font-size: 48px; margin-bottom: 16px; }
    h2 { font-size: 20px; color: #333; margin-bottom: 8px; }
    .sub { font-size: 14px; color: #999; margin-bottom: 24px; }
    .btn { display: block; width: 100%; padding: 16px; border: none; border-radius: 8px; font-size: 16px; font-weight: 700; text-decoration: none; text-align: center; cursor: pointer; transition: opacity 0.15s; font-family: inherit; }
    .btn:active { opacity: 0.85; }
    .btn-line { background: #06C755; color: #fff; margin-bottom: 12px; }
    .btn-web { background: #f5f5f5; color: #666; font-size: 13px; padding: 12px; }
    .loading { margin-top: 16px; font-size: 13px; color: #999; }
    .hidden { display: none; }
  </style>
</head>
<body>
  <div class="card" id="card">
    <div class="line-icon">💬</div>
    <h2>LINEで開く</h2>
    <p class="sub">LINEアプリが起動します</p>
    <a href="${escapeHtml(lineSchemeUrl)}" class="btn btn-line" id="openBtn">LINEアプリで開く</a>
    <a href="${escapeHtml(oauthUrl)}" class="btn btn-web" id="pcBtn">PCの方・LINEが開かない方</a>
    <p class="loading hidden" id="loading">LINEアプリを起動中...</p>
  </div>
  <script>
    var lineUrl = '${escapeHtml(lineSchemeUrl)}';
    var ua = navigator.userAgent.toLowerCase();
    var isMobile = /iphone|ipad|android/.test(ua);
    var isLine = /line\\//.test(ua);
    var isIOS = /iphone|ipad/.test(ua);
    var isAndroid = /android/.test(ua);

    if (isLine) {
      // Already in LINE — go to LIFF directly
      window.location.href = '${escapeHtml(liffUrl)}';
    } else if (isMobile) {
      // Mobile browser — try to open LINE app
      document.getElementById('loading').classList.remove('hidden');
      document.getElementById('openBtn').classList.add('hidden');

      // Use line.me/R/app/ which is a Universal Link (iOS) / App Link (Android)
      // This opens LINE app directly without showing browser login
      setTimeout(function() {
        window.location.href = lineUrl;
      }, 100);

      // Fallback: if LINE app doesn't open within 2s, show the button
      setTimeout(function() {
        document.getElementById('loading').classList.add('hidden');
        document.getElementById('openBtn').classList.remove('hidden');
        document.getElementById('openBtn').textContent = 'もう一度試す';
      }, 2500);
    }
  </script>
</body>
</html>`;
}

export function completionPage(displayName: string, pictureUrl: string | null, ref: string): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>登録完了</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Hiragino Sans', system-ui, sans-serif; background: #f5f5f5; display: flex; justify-content: center; align-items: center; min-height: 100vh; }
    .card { background: #fff; border-radius: 16px; padding: 40px 24px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); text-align: center; max-width: 400px; width: 90%; }
    .check { width: 64px; height: 64px; border-radius: 50%; background: #06C755; color: #fff; font-size: 32px; line-height: 64px; margin: 0 auto 16px; }
    h2 { font-size: 20px; color: #06C755; margin-bottom: 16px; }
    .profile { display: flex; align-items: center; justify-content: center; gap: 12px; margin: 16px 0; }
    .profile img { width: 48px; height: 48px; border-radius: 50%; }
    .profile .name { font-size: 16px; font-weight: 600; }
    .message { font-size: 14px; color: #666; line-height: 1.6; margin-top: 12px; }
    .ref { display: inline-block; margin-top: 12px; padding: 4px 12px; background: #f0f0f0; border-radius: 12px; font-size: 11px; color: #999; }
  </style>
</head>
<body>
  <div class="card">
    <div class="check">✓</div>
    <h2>登録完了！</h2>
    <div class="profile">
      ${pictureUrl ? `<img src="${pictureUrl}" alt="">` : ''}
      <p class="name">${escapeHtml(displayName)} さん</p>
    </div>
    <p class="message">ありがとうございます！<br>これからお役立ち情報をお届けします。<br>このページは閉じて大丈夫です。</p>
    ${ref ? `<p class="ref">${escapeHtml(ref)}</p>` : ''}
  </div>
</body>
</html>`;
}

export function errorPage(message: string): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>エラー</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Hiragino Sans', system-ui, sans-serif; background: #f5f5f5; display: flex; justify-content: center; align-items: center; min-height: 100vh; }
    .card { background: #fff; border-radius: 16px; padding: 40px 24px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); text-align: center; max-width: 400px; width: 90%; }
    h2 { font-size: 18px; color: #e53e3e; margin-bottom: 12px; }
    p { font-size: 14px; color: #666; }
  </style>
</head>
<body>
  <div class="card">
    <h2>エラー</h2>
    <p>${escapeHtml(message)}</p>
  </div>
</body>
</html>`;
}

export function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export // ─── X Harness Token Resolution ─────────────────────────────────

/** タグ・シナリオの失敗は記録し、利用者の連携フロー全体は止めない。 */
async function applyXHarnessActions(
  db: D1Database,
  friendId: string,
  result: XHarnessTokenResult,
): Promise<void> {

  if (result.tag) {
    try {
      const tagRow = await findOrCreateGlobalTag(db, { name: result.tag });
      if (tagRow) {
        const { addTagToFriend } = await import('@line-crm/db');
        await addTagToFriend(db, friendId, tagRow.id);
        logger.log("routes_liff_log");
      }
    } catch (err) {
      logger.error("liff.apply_xharness_actions_failed");
    }
  }


  if (result.scenarioId) {
    try {
      const { enrollFriendInScenario } = await import('@line-crm/db');
      await enrollFriendInScenario(db, friendId, result.scenarioId);
      logger.log("routes_liff_log");
    } catch (err) {
      logger.error("liff.apply_xharness_actions_failed");
    }
  }
}

export interface XHarnessTokenResult {
  xUsername: string | null;
  tag: string | null;
  scenarioId: string | null;
}

export /** X の利用者名と条件設定はトークンで解決する。トークン自体が秘密のため、この入口では別の Bearer を要求しない。 */
async function resolveXHarnessToken(
  token: string,
  env: { X_HARNESS_URL?: string },
): Promise<XHarnessTokenResult | null> {
  if (!env.X_HARNESS_URL) return null;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000); // ログインを止め続けないよう、5秒で打ち切る。
    try {
      const res = await fetch(`${env.X_HARNESS_URL}/api/tokens/${token}/resolve`, {
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
      });
      if (!res.ok) return null;
      const body = await res.json() as { success: boolean; data?: XHarnessTokenResult };
      if (!body.success || !body.data) return null;
      return { xUsername: body.data.xUsername, tag: body.data.tag ?? null, scenarioId: body.data.scenarioId ?? null };
    } finally {
      clearTimeout(timeoutId);
    }
  } catch {
    return null;
  }
}
