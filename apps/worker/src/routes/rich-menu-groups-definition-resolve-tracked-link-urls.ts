import { UnexpectedRouteError } from '../lib/unhandled-error.js';
import { tracedFetch as fetch } from '@line-crm/shared/server';
import { inputError } from '../lib/input-errors.js';
import { assembleRichMenuGroupInput, richMenuLiveToSnapshot } from '../features/rich-menus/rich-menu-group-input/index.js';
import { type Context } from 'hono';
import { getRichMenuGroupWithPages, acquirePublishLease, releasePublishLease, renewPublishLease, isPublishLeaseHeld, setPageRichMenuId, markRichMenuGroupPublished, getLineAccountById, getTrackedLinkById, createRichMenuManualPublishRequestAtomic, getRichMenuManualPublishRequest, getRichMenuManualPublishShells, claimRichMenuManualPublishRequest, markRichMenuManualPublishFailed, markRichMenuManualPublishSucceeded, recordRichMenuManualPublishShells, restartRichMenuManualPublishRequest, ensureRichMenuVersion, markRichMenuVersionPublished, findRichMenuDeviceConfirmation, ensureRichMenuPublishRun, markRichMenuPublishRun, ensureRichMenuPublishRunPages, markRichMenuPublishRunPageStep, jstNow, type RichMenuGroupWithPages } from '@line-crm/db';
import { fail } from '../lib/fail.js';
import type { Env } from '../worker-env.js';
import { canAccessAllLineAccounts } from '../services/account-access.js';
import { createRichMenuShells, switchRichMenuLive, deleteRichMenuShells, resolveSwitcherActions, validateRichMenuGroupForPublish, validateRichMenuPagesWithLine, PublishLeaseLostError, RichMenuValidationError, buildAliasId, type LineRichMenuClient, type R2Like, type GroupInput } from '../lib/rich-menu-publisher.js';
import { manualPublishFingerprint, serializeGroupWithPages, recoverManualPublishShellsFromLine, manualPublishShellName } from './rich-menu-groups-definition-serialize-group-with-pages.js';

export // ----- Publish -----

/**
 * 「URLを開く」で計測リンクを選んだボタンの、実際の飛び先を引く。
 *
 * 計測リンクは押された回数を数え、設定されていればタグ付けやシナリオ開始まで
 * やってくれる。リッチメニュー側で同じ仕組みを作り直さず、そのまま乗せる。
 */
async function resolveTrackedLinkUrls(
  db: D1Database,
  resolveBaseUrl: () => Promise<string>,
  group: RichMenuGroupWithPages,
): Promise<Map<string, string>> {
  const ids = new Set<string>();
  for (const page of group.pages) {
    for (const area of page.areas) {
      if (area.tracked_link_id) ids.add(area.tracked_link_id);
    }
  }
  const urls = new Map<string, string>();
  // 計測リンクを使うボタンが1つも無ければ、ベースURLを引く必要もない。
  if (ids.size === 0) return urls;
  const baseUrl = await resolveBaseUrl();
  for (const id of ids) {
    const link = await getTrackedLinkById(db, id);
    if (!link) continue;
    // 短縮コードがあればそちらを使う (baseUrl が独自の短縮ドメインのことがある)。
    urls.set(id, `${baseUrl}/t/${link.short_code ?? link.id}`);
  }
  return urls;
}

export function createLineClient(channelAccessToken: string): LineRichMenuClient {
  const auth = `Bearer ${channelAccessToken}`;
  return {
    async createRichMenu(payload) {
      const res = await fetch('https://api.line.me/v2/bot/richmenu', {
        method: 'POST',
        headers: { Authorization: auth, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`LINE createRichMenu failed: ${res.status} ${await res.text()}`);
      return res.json() as Promise<{ richMenuId: string }>;
    },
    // O(公開前の確認): POST /v2/bot/richmenu/validate。作らずに形だけ見る。
    // LINE が 400 を返したときだけ下書きの不備（公開前の検査で直す）。
    // 通信障害・5xx はそのまま投げて 500 にする（下書きは悪くない）。
    async validateRichMenu(payload) {
      const res = await fetch('https://api.line.me/v2/bot/richmenu/validate', {
        method: 'POST',
        headers: { Authorization: auth, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.ok) return;
      const detail = `LINE validateRichMenu failed: ${res.status} ${await res.text()}`;
      if (res.status === 400) throw new RichMenuValidationError(detail);
      throw new Error(detail);
    },
    async listRichMenus() {
      const res = await fetch('https://api.line.me/v2/bot/richmenu/list', {
        headers: { Authorization: auth },
      });
      if (!res.ok) throw new Error(`LINE listRichMenus failed: ${res.status} ${await res.text()}`);
      const body = await res.json() as { richmenus?: Array<{ richMenuId?: string; name?: string }> };
      return (body.richmenus ?? []).flatMap((menu) => (
        typeof menu.richMenuId === 'string'
          ? [{ richMenuId: menu.richMenuId, name: typeof menu.name === 'string' ? menu.name : null }]
          : []
      ));
    },
    async uploadRichMenuImage(richMenuId, image, contentType) {
      const res = await fetch(`https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`, {
        method: 'POST',
        headers: { Authorization: auth, 'Content-Type': contentType },
        body: image,
      });
      if (!res.ok) throw new Error(`LINE uploadRichMenuImage failed: ${res.status} ${await res.text()}`);
    },
    async deleteRichMenuAlias(aliasId) {
      const res = await fetch(`https://api.line.me/v2/bot/richmenu/alias/${aliasId}`, {
        method: 'DELETE',
        headers: { Authorization: auth },
      });
      if (!res.ok && res.status !== 404) {
        throw new Error(`LINE deleteRichMenuAlias failed: ${res.status} ${await res.text()}`);
      }
    },
    async createRichMenuAlias(aliasId, richMenuId) {
      const res = await fetch('https://api.line.me/v2/bot/richmenu/alias', {
        method: 'POST',
        headers: { Authorization: auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ richMenuAliasId: aliasId, richMenuId }),
      });
      if (!res.ok) throw new Error(`LINE createRichMenuAlias failed: ${res.status} ${await res.text()}`);
    },
    async upsertRichMenuAlias(aliasId, richMenuId) {
      const res = await fetch(`https://api.line.me/v2/bot/richmenu/alias/${aliasId}`, {
        method: 'POST',
        headers: { Authorization: auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ richMenuId }),
      });
      if (res.ok) return;
      if (res.status === 404) {
        const createRes = await fetch('https://api.line.me/v2/bot/richmenu/alias', {
          method: 'POST',
          headers: { Authorization: auth, 'Content-Type': 'application/json' },
          body: JSON.stringify({ richMenuAliasId: aliasId, richMenuId }),
        });
        if (createRes.ok) return;
        throw new Error(`LINE createRichMenuAlias failed: ${createRes.status} ${await createRes.text()}`);
      }
      throw new Error(`LINE updateRichMenuAlias failed: ${res.status} ${await res.text()}`);
    },
    async deleteRichMenu(richMenuId) {
      const res = await fetch(`https://api.line.me/v2/bot/richmenu/${richMenuId}`, {
        method: 'DELETE',
        headers: { Authorization: auth },
      });
      if (!res.ok && res.status !== 404) {
        throw new Error(`LINE deleteRichMenu failed: ${res.status} ${await res.text()}`);
      }
    },
    async setDefaultRichMenu(richMenuId) {
      const res = await fetch(`https://api.line.me/v2/bot/user/all/richmenu/${richMenuId}`, {
        method: 'POST',
        headers: { Authorization: auth },
      });
      if (!res.ok) throw new Error(`LINE setDefaultRichMenu failed: ${res.status} ${await res.text()}`);
    },
    async clearDefaultRichMenu() {
      // 既存 default を解除。default 未設定でも LINE は 200 を返すので冪等。
      const res = await fetch('https://api.line.me/v2/bot/user/all/richmenu', {
        method: 'DELETE',
        headers: { Authorization: auth },
      });
      if (!res.ok && res.status !== 404) {
        throw new Error(`LINE clearDefaultRichMenu failed: ${res.status} ${await res.text()}`);
      }
    },
    async getCurrentDefaultRichMenuId() {
      const res = await fetch('https://api.line.me/v2/bot/user/all/richmenu', {
        method: 'GET',
        headers: { Authorization: auth },
      });
      // 設定なしは 404 が返る — null として返す。
      if (res.status === 404) return null;
      if (!res.ok) {
        throw new Error(`LINE getCurrentDefaultRichMenu failed: ${res.status} ${await res.text()}`);
      }
      const body = (await res.json()) as { richMenuId?: string };
      return body.richMenuId ?? null;
    },
    async linkRichMenuBulk(richMenuId, userIds) {
      // POST /v2/bot/richmenu/bulk/link  — 1 リクエスト最大 500 ユーザー
      const res = await fetch('https://api.line.me/v2/bot/richmenu/bulk/link', {
        method: 'POST',
        headers: { Authorization: auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ richMenuId, userIds }),
      });
      if (!res.ok) {
        throw new Error(`LINE linkRichMenuBulk failed: ${res.status} ${await res.text()}`);
      }
    },
    // ----- : 本人LINEへのテスト適用で使う個人宛て操作 -----
    async linkRichMenuToUser(userId, richMenuId) {
      const res = await fetch(
        `https://api.line.me/v2/bot/user/${encodeURIComponent(userId)}/richmenu/${encodeURIComponent(richMenuId)}`,
        { method: 'POST', headers: { Authorization: auth } },
      );
      if (!res.ok) {
        throw new Error(`LINE linkRichMenuToUser failed: ${res.status} ${await res.text()}`);
      }
    },
    async unlinkRichMenuFromUser(userId) {
      const res = await fetch(
        `https://api.line.me/v2/bot/user/${encodeURIComponent(userId)}/richmenu`,
        { method: 'DELETE', headers: { Authorization: auth } },
      );
      if (!res.ok && res.status !== 404) {
        throw new Error(`LINE unlinkRichMenuFromUser failed: ${res.status} ${await res.text()}`);
      }
    },
    async getRichMenuIdOfUser(userId) {
      const res = await fetch(
        `https://api.line.me/v2/bot/user/${encodeURIComponent(userId)}/richmenu`,
        { headers: { Authorization: auth } },
      );
      if (res.status === 404) return null;
      if (!res.ok) {
        throw new Error(`LINE getRichMenuIdOfUser failed: ${res.status} ${await res.text()}`);
      }
      const body = (await res.json()) as { richMenuId?: string };
      return body.richMenuId ?? null;
    },
    async listRichMenuAliases() {
      const res = await fetch('https://api.line.me/v2/bot/richmenu/alias/list', {
        headers: { Authorization: auth },
      });
      if (!res.ok) {
        throw new Error(`LINE listRichMenuAliases failed: ${res.status} ${await res.text()}`);
      }
      const body = (await res.json()) as {
        aliases?: Array<{ richMenuAliasId?: string; richMenuId?: string }>;
      };
      return (body.aliases ?? []).flatMap((alias) =>
        typeof alias.richMenuAliasId === 'string' && typeof alias.richMenuId === 'string'
          ? [{ richMenuAliasId: alias.richMenuAliasId, richMenuId: alias.richMenuId }]
          : [],
      );
    },
  };
}

export /** 公開・検査で使う GroupInput を下書きから組み立てる。 */
async function buildPublishGroupInput(
  c: Context<Env>,
  latestGroup: RichMenuGroupWithPages,
  account: { liff_id?: string | null },
): Promise<GroupInput> {
  return assembleRichMenuGroupInput(
    c.env.DB,
    richMenuLiveToSnapshot(latestGroup),
    account,
    {
      fallbackGroupId: latestGroup.id,
      workerBaseUrl: c.env.WORKER_URL || new URL(c.req.url).origin,
      liffUrl: c.env.LIFF_URL,
    },
  );
}

export /** 「公開の進み」の段の名前。設計 K-1 の4段。 */
const PUBLISH_PROGRESS_STEPS = [
  { key: 'image', label: '画像をLINEに上げる' },
  { key: 'menu', label: 'メニューを作る' },
  { key: 'assign', label: '友だちに割り当てる' },
  { key: 'cleanup', label: '前のメニューを片付ける' },
] as const;

export /** 台帳の符号を、運用者の言葉へ戻す。 */
function publishRunMessage(code: string | null): string | null {
  switch (code) {
    case 'device_confirm_missing':
      return '実機で見た確認が無いため、公開を始められませんでした。前のメニューのままです。';
    case 'validation_failed':
      return '公開前の検査で不備が見つかり、公開を止めました。前のメニューのままです。';
    case 'lease_lost':
      return '公開の担当が切り替わり、途中で止めました。前のメニューのままです。';
    case 'publish_failed':
      return '割り当てに失敗したので、作ったメニューをLINEから消し、前のメニューのままにしました。もう一度公開できます。';
    default:
      return code ? '公開の途中で失敗したため、前のメニューのままにしました。もう一度公開できます。' : null;
  }
}

export /**
 * 手動公開の本体。`/publish` と失敗run再試行 `/publish-runs/:requestId/retry` の
 * 両方がここへ来る。request の存在確定・lease・journal・LINE切替はこの中で行う。
 */
async function handleManualPublish(
  c: Context<Env>,
  groupId: string,
  idempotencyKey: string,
  expected?:{version:number;generation:number;pages:Array<{orderIndex:number;imageR2Key:string|null;imageContentType:string|null}>},
) {
  const group = await getRichMenuGroupWithPages(c.env.DB, groupId);
  if (!group || !await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [group.account_id])) {
    return fail(c, 404, 'NOT_FOUND');
  }
  const matches=(current:RichMenuGroupWithPages,leased=false)=>{
    if(!expected)return true;
    const pages=new Map(expected.pages.map(page=>[page.orderIndex,JSON.stringify([page.imageR2Key,page.imageContentType])]));
    return current.version===expected.version&&(current.publishing_generation??0)===expected.generation+Number(leased)&&current.pages.length===pages.size&&current.pages.every(page=>pages.get(page.order_index)===JSON.stringify([page.image_r2_key,page.image_content_type]));
  };
  const conflict=async(partial=false)=>{
    const current=await getRichMenuGroupWithPages(c.env.DB,groupId);
    return c.json({success:false,code:partial?'RICH_MENU_PUBLISH_CHANGED_AFTER_START':'RICH_MENU_PUBLISH_CHANGED',error:partial?'公開内容が変わりました。公開処理の一部が進んだ可能性があります。最新の状態を確認してください':'公開内容が変わりました。最新の状態を確認してください',data:current?{version:current.version,publishingGeneration:current.publishing_generation??0,pages:current.pages.map(page=>({orderIndex:page.order_index,imageR2Key:page.image_r2_key,imageContentType:page.image_content_type}))}:null},409);
  };
  if(expected&&!matches(group))return conflict();
  const fingerprint = manualPublishFingerprint(group);
  const requestResult = await createRichMenuManualPublishRequestAtomic(c.env.DB, {
    id: crypto.randomUUID(),
    groupId,
    accountId: group.account_id,
    definitionSnapshot: JSON.stringify(serializeGroupWithPages(group)),
    requestFingerprint: fingerprint,
    idempotencyKey,
    requestedByStaffId: c.get('staff').id,
    now: jstNow(),
  });
  if (requestResult.outcome === 'conflict') {
    return c.json({ success: false, error: 'Idempotency-Key is already used with different content' }, 409);
  }
  let request = requestResult.request;
  if (request.status === 'succeeded') {
    try {
      return c.json({ success: true, data: JSON.parse(request.result_json ?? '') }, 200, {
        'Idempotency-Replayed': 'true',
      });
    } catch {
      // 成功済み行の壊れた応答を直すためにLINEを再実行してはいけない。
      throw new UnexpectedRouteError(c, { success: false, error: '公開結果を再取得できません。最新状態を確認してください。' });
    }
  }
  if (request.status === 'failed') await restartRichMenuManualPublishRequest(c.env.DB, request.id);

  // 有効なlease保持中だけ409。ここで止まった同keyは、lease解放後に同じjournalから再開できる。
  if (await isPublishLeaseHeld(c.env.DB, groupId, new Date().toISOString())) {
    return c.json({ success: false, error: 'already publishing' }, 409);
  }
  const account = await getLineAccountById(c.env.DB, group.account_id);
  if (!account) return fail(c, 500, 'LINE_ACCOUNT_NOT_FOUND');

  const publishOwner = `manual-${request.id}`;
  const publishGeneration = await acquirePublishLease(c.env.DB, groupId, publishOwner, new Date().toISOString(),undefined,undefined,expected);
  if (publishGeneration === null) return expected?conflict():c.json({ success: false, error: 'failed to acquire publish lock' }, 409);
  const publishFence = { owner: publishOwner, generation: publishGeneration };
  const executionToken = crypto.randomUUID();

  // 台帳の行。try の外で持つ（catch から失敗を残すため）。
  let publishRunId: string | null = null;
  let publishVersionId: string | null = null;
  let publishRunPageIds: string[] = [];
  let publishPhase: 'validating' | 'creating' | 'switching' | 'cleanup' = 'validating';

  try {
    // 別要求が「running」を読んだ直後に先行要求が成功・lease解放した場合でも、
    // lease取得後に必ず再読する。古いstatusのままLINE切替をもう一度実行しない。
    const latestRequest = await getRichMenuManualPublishRequest(c.env.DB, group.account_id, idempotencyKey);
    if (!latestRequest) throw new Error('manual publish request disappeared');
    request = latestRequest;
    if (request.status === 'succeeded') {
      try {
        const data = JSON.parse(request.result_json ?? '');
        await releasePublishLease(c.env.DB, groupId, publishFence);
        return c.json({ success: true, data }, 200, { 'Idempotency-Replayed': 'true' });
      } catch {
        throw new Error('manual publish result is invalid');
      }
    }
    if (!await claimRichMenuManualPublishRequest(c.env.DB, request.id, executionToken)) {
      await releasePublishLease(c.env.DB, groupId, publishFence);
      return c.json({ success: false, error: '公開処理の担当が切り替わりました。最新の状態を確認してください。' }, 409);
    }
    // lease取得前後の下書き更新を必ず拒否する。古い版を作成・切替しない。
    const latestGroup = await getRichMenuGroupWithPages(c.env.DB, groupId);
    if (!latestGroup || manualPublishFingerprint(latestGroup) !== fingerprint || !matches(latestGroup,true)) {
      await markRichMenuManualPublishFailed(c.env.DB, request.id, executionToken, 'manual publish target changed');
      await releasePublishLease(c.env.DB, groupId, publishFence);
      if(expected)return conflict();
      return c.json({ success: false, error: '公開対象が更新されました。画面を更新してからもう一度お試しください。' }, 409);
    }
    // 公開する版を凍結し、実行行とページ行を確保する。
    // 同じ下書き・同じ鍵なら使い回す（再試行は同じ「進み」に寄せる）。
    const staffId = c.get('staff').id;
    const version = await ensureRichMenuVersion(c.env.DB, {
      id: crypto.randomUUID(),
      groupId,
      snapshot: JSON.stringify(serializeGroupWithPages(latestGroup)),
      fingerprint,
      staffId,
      now: jstNow(),
    });
    publishVersionId = version.id;
    const publishRun = await ensureRichMenuPublishRun(c.env.DB, {
      id: crypto.randomUUID(),
      groupId,
      versionId: version.id,
      idempotencyKey,
      mode: 'publish',
      staffId,
      now: jstNow(),
    });
    publishRunId = publishRun.id;
    if (publishRun.status === 'failed') {
      await markRichMenuPublishRun(c.env.DB, publishRun.id, { status: 'running' });
    }
    publishRunPageIds = latestGroup.pages.map((page) => page.id);
    await ensureRichMenuPublishRunPages(
      c.env.DB,
      publishRun.id,
      latestGroup.pages.map((page) => ({
        id: crypto.randomUUID(),
        pageId: page.id,
        orderIndex: page.order_index,
        aliasId: buildAliasId(groupId, page.order_index),
        oldLineRichMenuId: page.line_richmenu_id,
      })),
    );
    const line = createLineClient(account.channel_access_token);
    const r2Adapter: R2Like = {
      async get(key) {
        const obj = await c.env.IMAGES.get(key);
        if (!obj) return null;
        return { body: obj.body as ReadableStream };
      },
    };
    const groupInput = await buildPublishGroupInput(c, latestGroup, account);
    // LINEの一覧照合より先に、下書きの不備を止める。無効な定義で外部APIを読む必要はない。
    validateRichMenuGroupForPublish({
      ...groupInput,
      pages: resolveSwitcherActions(groupInput.pages, groupInput.id),
    });
    // 実機で見た確認が今の下書きに無ければ公開しない。
    // 自前検査の後ろに置く（不備は 400 のまま返す）。下書きが変わると
    // fingerprint が変わり、確認は無効になる。
    const deviceConfirmation = await findRichMenuDeviceConfirmation(c.env.DB, groupId, fingerprint);
    if (!deviceConfirmation) {
      await markRichMenuManualPublishFailed(c.env.DB, request.id, executionToken, 'device_confirm_missing');
      await markRichMenuPublishRun(c.env.DB, publishRun.id, {
        status: 'failed',
        errorCode: 'device_confirm_missing',
      });
      await releasePublishLease(c.env.DB, groupId, publishFence);
      return c.json({
        success: false,
        error: 'まだ実機で見た確認がありません。スマートフォンのLINEでメニューを見て「実機で見た」を押してから、もう一度公開してください。',
      }, 409);
    }
    // 自前検査のあと、公開する形のまま LINE の検査 API に通す。
    const heartbeat = async () => {
      const alive = await renewPublishLease(c.env.DB, groupId, publishFence, new Date().toISOString());
      if (!alive) throw new PublishLeaseLostError();
      if(expected){const latest=await getRichMenuGroupWithPages(c.env.DB,groupId);if(!latest||!matches(latest,true)||manualPublishFingerprint(latest)!==fingerprint)throw new PublishLeaseLostError();}
    };
    await heartbeat();
    await validateRichMenuPagesWithLine(groupInput, line);

    let shells = await getRichMenuManualPublishShells(c.env.DB, request.id);
    const oldByPage = new Map(latestGroup.pages.map((page) => [page.id, page.line_richmenu_id]));
    // create成功後、D1書込前にWorkerが止まっても、決定名のLINE menuを先に回収する。
    // 既にjournal済みの同pageとIDが食い違う場合は別requestを混ぜず停止する。
    const recovered = await recoverManualPublishShellsFromLine(line, request.id, latestGroup.pages);
    const journalByPage = new Map(shells.map((shell) => [shell.page_id, shell]));
    for (const shell of recovered) {
      const journaled = journalByPage.get(shell.pageId);
      if (journaled && journaled.new_richmenu_id !== shell.newRichMenuId) {
        throw new Error('manual publish shell recovery conflicts with journal');
      }
    }
    const recoveredUnjournaled = recovered.filter((shell) => !journalByPage.has(shell.pageId));
    if (recoveredUnjournaled.length > 0) {
      await recordRichMenuManualPublishShells(c.env.DB, request.id, recoveredUnjournaled.map((shell) => ({
        ...shell,
        oldRichMenuId: oldByPage.get(shell.pageId) ?? null,
      })));
      shells = await getRichMenuManualPublishShells(c.env.DB, request.id);
    }
    publishPhase = 'creating';
    await createRichMenuShells(groupInput, line, r2Adapter, heartbeat, {
      existingShells: shells.map((shell) => ({
        pageId: shell.page_id,
        orderIndex: shell.order_index,
        newRichMenuId: shell.new_richmenu_id,
      })),
      shellName: (page) => manualPublishShellName(request.id, page.id),
      onShellCreated: async (shell) => {
        await recordRichMenuManualPublishShells(c.env.DB, request.id, [{
          ...shell,
          oldRichMenuId: oldByPage.get(shell.pageId) ?? null,
        }]);
      },
    });
    shells = await getRichMenuManualPublishShells(c.env.DB, request.id);
    if (shells.length !== latestGroup.pages.length || shells.some((shell) => !latestGroup.pages.some((page) => page.id === shell.page_id))) {
      throw new Error('manual publish shell journal does not match the requested version');
    }
    // 段1・2（画像を上げる・メニューを作る）が済んだページを残す。
    if (publishRunId) {
      for (const shell of shells) {
        await markRichMenuPublishRunPageStep(c.env.DB, publishRunId, shell.page_id, 'create_status', 'succeeded', {
          newLineRichMenuId: shell.new_richmenu_id,
        });
        await markRichMenuPublishRunPageStep(c.env.DB, publishRunId, shell.page_id, 'image_status', 'succeeded', {
          newLineRichMenuId: shell.new_richmenu_id,
        });
      }
    }
    publishPhase = 'switching';
    await switchRichMenuLive(line, groupInput, shells.map((shell) => ({
      pageId: shell.page_id, orderIndex: shell.order_index, newRichMenuId: shell.new_richmenu_id,
    })), heartbeat);
    // switch完了後も、D1の確定に入る直前にleaseを延長・照合する。ここで別keyの
    // 実行に引き継がれていたら、古い実行結果を確定/返却してはいけない。
    await heartbeat();
    for (const shell of shells) {
      if (!(await setPageRichMenuId(c.env.DB, shell.page_id, shell.new_richmenu_id, publishFence))) {
        throw new PublishLeaseLostError();
      }
    }
    // 段3（友だちに割り当てる＝aliasの付け替え）が済んだページを残す。
    if (publishRunId) {
      for (const shell of shells) {
        await markRichMenuPublishRunPageStep(c.env.DB, publishRunId, shell.page_id, 'alias_status', 'succeeded', {
          newLineRichMenuId: shell.new_richmenu_id,
        });
      }
    }
    await heartbeat();
    if (!(await markRichMenuGroupPublished(c.env.DB, groupId, publishFence))) throw new PublishLeaseLostError();
    // 最初の版で控えた旧IDだけを消す。再開時に現在page行の新IDを旧IDと誤認しない。
    publishPhase = 'cleanup';
    await deleteRichMenuShells(line, shells.flatMap((shell) => shell.old_richmenu_id ? [shell.old_richmenu_id] : []));
    // 段4（前のメニューを片付ける）。旧メニューが無かったページは「しない」。
    if (publishRunId) {
      for (const shell of shells) {
        await markRichMenuPublishRunPageStep(
          c.env.DB,
          publishRunId,
          shell.page_id,
          'cleanup_status',
          shell.old_richmenu_id ? 'succeeded' : 'skipped',
          { newLineRichMenuId: shell.new_richmenu_id },
        );
      }
    }
    const result = { pages: shells.map((shell) => ({ pageId: shell.page_id, newRichMenuId: shell.new_richmenu_id })) };
    // 成功recordは、leaseを最後に延長した直後の同一fenceでのみ確定する。外部切替後に
    // 期限切れ・別keyへの引継ぎが起きた古い実行が、自分の古いpagesを成功応答へ固定しない。
    await heartbeat();
    if (!await markRichMenuManualPublishSucceeded(c.env.DB, request.id, executionToken, JSON.stringify(result), {
      groupId,
      owner: publishFence.owner,
      generation: publishFence.generation,
      nowIso: new Date().toISOString(),
    })) {
      throw new PublishLeaseLostError();
    }
    // 台帳の実行を成功にし、凍結した版を公開版にする。
    if (publishRunId) {
      await markRichMenuPublishRun(c.env.DB, publishRunId, { status: 'succeeded' });
    }
    if (publishVersionId) {
      await markRichMenuVersionPublished(c.env.DB, publishVersionId);
    }
    await releasePublishLease(c.env.DB, groupId, publishFence);
    return c.json({ success: true, data: result });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await markRichMenuManualPublishFailed(c.env.DB, request.id, executionToken, message, {
      groupId,
      owner: publishFence.owner,
      generation: publishFence.generation,
      nowIso: new Date().toISOString(),
    });
    // 台帳の実行を失敗にし、止まった段のページを「失敗」に残す。
    // まだ手を付けていない段は pending のまま（画面は「しない」と出す）。
    if (publishRunId) {
      const errorCode = e instanceof RichMenuValidationError
        ? 'validation_failed'
        : e instanceof PublishLeaseLostError
          ? 'lease_lost'
          : 'publish_failed';
      await markRichMenuPublishRun(c.env.DB, publishRunId, { status: 'failed', errorCode });
      const failedSteps = publishPhase === 'creating'
        ? ['create_status', 'image_status'] as const
        : publishPhase === 'switching'
          ? ['alias_status'] as const
          : publishPhase === 'cleanup'
            ? ['cleanup_status'] as const
            : [];
      for (const pageId of publishRunPageIds) {
        for (const step of failedSteps) {
          await markRichMenuPublishRunPageStep(c.env.DB, publishRunId, pageId, step, 'failed', { errorCode });
        }
      }
    }
    await releasePublishLease(c.env.DB, groupId, publishFence);
    if (e instanceof PublishLeaseLostError) {
      if(expected)return conflict(true);
      return c.json({ success: false, error: '公開の担当が別の処理へ移りました。最新の状態を確認して、もう一度お試しください。' }, 409);
    }
    if (e instanceof RichMenuValidationError) return inputError(c, { success: false, error: message }, 400, ["pages"]);
    throw e;
  }
}

export // ----- : 本人LINEへのテスト適用 -----

function serializeTestApply(row: {
  id: string; status: string; previous_richmenu_id: string | null;
  previous_captured?: number | null;
  applied_richmenu_id: string | null; last_error_code: string | null;
  created_at: string; updated_at: string;
}) {
  return {
    id: row.id,
    status: row.status,
    previousRichMenuId: row.previous_richmenu_id,
    /*
     * 適用前の表示を記録できたか。0 のまま失敗した apply は本人のメニューを
     * 一度も変えていないので、画面は「元に戻す」を出さず、revert も本人の
     * メニューには触れない。
     */
    previousCaptured: row.previous_captured === 1,
    appliedRichMenuId: row.applied_richmenu_id,
    lastErrorCode: row.last_error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
