import { logger } from '@line-crm/shared/server';
import { withStyleSampleMetadata } from '../services/style-sample-metadata.js';
import { readCarouselOptions } from './template-carousel-input.js';
import { publishedInfoOf, versionInfoOf } from './../services/template-display.js';
import { inputError, inputJsonBoundary } from '../lib/input-errors.js';
import { validateTapExtraReferences } from '../services/tap-extras.js';
import { tapExtrasError } from '@line-crm/shared';
import { Hono } from 'hono';
import { bulkDeleteTemplates } from './templates-bulk-delete.js';
import { prepareRichVideoTemplate } from '../services/rich-video-template.js';
import { getTemplatesWithUsageCount, getTemplateSendCounts, getTemplateFolderCounts, getTemplateById, getTemplateUsage, createTemplate, updateTemplate, saveTemplateDraft, publishTemplate, hasTemplateDraft, deleteTemplate, deleteCreatedTemplateDraft, getCarouselTapTotals, getFolderById, listTemplateVersions, revertTemplateToVersion, listBroadcastReferences, listTemplateReferences, getBroadcastDeleteBlockers, getPinnedReminderDeleteBlockers, MediaReferenceAccountError } from '@line-crm/db';
import type { TemplateRow } from '@line-crm/db';
import type { Env } from '../worker-env.js';
import { requireDeliveryAccess } from '../middleware/role-guard.js';
import { buildOffsetListResponse, parseOffsetPaging } from '../lib/list-paging.js';
import { validateCarousel } from '../services/carousel-validation.js';
import { canAccessAllLineAccounts, getVisibleLineAccountScope } from '../services/account-access.js';
import { parseQuestion, type ScenarioQuestion } from '../features/scenarios/scenario-question/index.js';
import { validateTemplateMessage } from '../services/template-message-validation.js';
import { validateFlexContent } from '@line-crm/shared';
import { fail } from '../lib/fail.js';
const templates = new Hono<Env>();

/**
 * 置き場の指定を読む。
 *
 * **3つを分けて扱う。**
 *   来ない（`undefined`）…… いまの置き場のまま
 *   `null` / 空文字      …… 未分類へ戻す
 *   ID                   …… そのフォルダへ入れる
 *
 * 消えたフォルダや、別の用途のフォルダ（タグの分類など）を指されたら断る。
 * **黙って未分類にしない。** 移したつもりが未分類になっていると、
 * 画面では「移せた」ように見えて、次に開くと消えている。
 */
async function readFolderId(
  db: D1Database,
  body: Record<string, unknown>,
  accountId: string | null,
  canSeeUnassigned: boolean,
): Promise<{ ok: true; folderId?: string | null } | { ok: false; error: string }> {
  if (!('folderId' in body)) return { ok: true };
  const raw = body.folderId;
  if (raw === null || raw === '') return { ok: true, folderId: null };
  const id = String(raw);
  const folder = await getFolderById(db, id);
  if (!folder) return { ok: false, error: 'そのフォルダはありません' };
  if (folder.kind !== 'template') {
    return { ok: false, error: 'テンプレートのフォルダではありません' };
  }
  // フォルダはアカウント単位。別アカウントのフォルダへ入れさせない。
  // 未所属のものは一覧・更新と同じく「見えない」扱い——見えない置き場へ
  // 入れると、そのテンプレートはどの絞り込みにも出なくなる。
  if (folder.account_id !== accountId && (folder.account_id !== null || !canSeeUnassigned)) {
    return { ok: false, error: 'そのフォルダはありません' };
  }
  return { ok: true, folderId: id };
}

const QUESTION_BEHAVIORS = new Set([
  'none',
  'url',
  'tel',
  'add_friend',
  'mail',
  'form',
  'scenario',
]);

function readQuestionPayload(body: Record<string, unknown>):
  | { ok: true; question: ScenarioQuestion | null; questionJson?: string | null }
  | { ok: false; error: string } {
  if (!('question' in body)) return { ok: true, question: null };
  if (body.question === null) return { ok: true, question: null, questionJson: null };
  if (!body.question || typeof body.question !== 'object' || Array.isArray(body.question)) {
    return { ok: false, error: '質問の内容を読み取れません' };
  }
  const raw = JSON.stringify(body.question);
  const question = parseQuestion(raw);
  if (!question) return { ok: false, error: '質問文と選択肢を入力してください' };
  if (question.text.length > 160) return { ok: false, error: '質問文は160文字以内で入力してください' };
  if (question.choices.length > 13) return { ok: false, error: '選択肢は13件以内で入力してください' };
  if (question.choices.some((choice) => !choice || typeof choice !== 'object' || typeof choice.label !== 'string')) {
    return { ok: false, error: 'すべての選択肢に文字を入力してください' };
  }
  if (question.choices.some((choice) => !choice.label.trim())) {
    return { ok: false, error: 'すべての選択肢に文字を入力してください' };
  }
  if (question.choices.some((choice) => choice.label.length > 20)) {
    return { ok: false, error: '選択肢の文字は20文字以内で入力してください' };
  }
  if (question.choices.some((choice) => typeof choice.behavior !== 'string' || !QUESTION_BEHAVIORS.has(choice.behavior))) {
    return { ok: false, error: '選択後の動きを確認してください' };
  }
  for (const choice of question.choices) {
    const error = tapExtrasError({ tagIds: choice.addTagIds, scoreChange: choice.scoreChange });
    if (error) return { ok: false, error };
  }
  return { ok: true, question, questionJson: raw };
}

function questionValue(raw: string | null): ScenarioQuestion | null {
  return parseQuestion(raw);
}

/** 編集画面は下書きがあればそれを、なければ公開版を読む。送信側は公開値を使う。下書きの削除可能な項目の NULL は明示削除なので、公開値へ戻さない。 */
function draftMessageTypeOf(t: TemplateRow): string {
  return t.draft_message_type ?? t.message_type;
}

function draftMessageContentOf(t: TemplateRow): string {
  return t.draft_message_content ?? t.message_content;
}

function draftQuestionJsonOf(t: TemplateRow): string | null {
  return hasTemplateDraft(t) ? t.draft_question_json : t.question_json;
}

function draftQuestionStatusOf(t: TemplateRow): 'draft' | 'published' {
  return (hasTemplateDraft(t) ? t.draft_question_status ?? t.question_status : t.question_status);
}

function draftCarouselActionsOf(t: TemplateRow): unknown {
  const raw = hasTemplateDraft(t) ? t.draft_carousel_actions_json : t.carousel_actions_json;
  return raw ? JSON.parse(raw) : null;
}

function draftCarouselTapLimitModeOf(t: TemplateRow): string {
  return (hasTemplateDraft(t) ? t.draft_carousel_tap_limit_mode ?? t.carousel_tap_limit_mode : t.carousel_tap_limit_mode)
    ?? 'none';
}

function draftCarouselTapLimitTextOf(t: TemplateRow): string | null {
  return hasTemplateDraft(t) ? t.draft_carousel_tap_limit_text : t.carousel_tap_limit_text;
}

/**
 * カルーセルなら中身を確かめる。
 *
 * 送ってから「400 が返りました」では、どのパネルが悪いのか分からない。
 * 保存の時点で、何枚目の何が問題かを返す。
 */
/**
 * JSONで持つ本文（カード型・カルーセル）の大きさ上限。タグ込みの文字数で見る。
 * テキスト上限5000字の10倍。LINEの上限ではなく、巨大JSONの保存・描画・送信を
 * 防ぐ運用上限。
 */
export const TEMPLATE_STRUCTURED_MAX_CHARACTERS = 50000;

function checkStructuredSize(
  messageType: string | undefined,
  messageContent: string | undefined,
): { ok: true } | { ok: false; error: string } {
  if ((messageType !== 'carousel' && messageType !== 'flex') || !messageContent) return { ok: true };
  if ([...messageContent].length > TEMPLATE_STRUCTURED_MAX_CHARACTERS) {
    return {
      ok: false,
      error: `本文が大きすぎます。${TEMPLATE_STRUCTURED_MAX_CHARACTERS.toLocaleString('ja-JP')}文字までにしてください`,
    };
  }
  return { ok: true };
}

function checkCarousel(
  messageType: string | undefined,
  messageContent: string | undefined,
): { ok: true } | { ok: false; error: string } {
  if (messageType !== 'carousel') return { ok: true };
  if (!messageContent) return { ok: false, error: 'カルーセルの中身がありません' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(messageContent);
  } catch {
    return { ok: false, error: 'カルーセルの中身が読み取れません' };
  }
  // { columns: [...] } でも [...] でも受ける。書き方の違いで弾かない。
  const columns =
    Array.isArray(parsed)
      ? parsed
      : (parsed as { columns?: unknown })?.columns;
  const errors = validateCarousel(columns);
  if (errors.length === 0) return { ok: true };
  return { ok: false, error: errors.map((e) => e.message).join(' / ') };
}

function checkImageTemplate(messageType: string | undefined, messageContent: string | undefined): { ok: true } | { ok: false; error: string } {
  if (messageType !== 'image') return { ok: true };
  if (!messageContent) return { ok: false, error: '画像URLを入力してください' };
  try {
    const value: unknown = JSON.parse(messageContent);
    if (!value || Array.isArray(value) || typeof value !== 'object') return { ok: false, error: '画像の指定が不正です' };
    const image = value as Record<string, unknown>;
    const urls = [image.originalContentUrl, image.previewImageUrl];
    const valid = (value: unknown) => {
      if (typeof value !== 'string') return false;
      try { const url = new URL(value); return url.protocol === 'https:' && Boolean(url.hostname); } catch { return false; }
    };
    if (urls.some((url) => !valid(url))) return { ok: false, error: '画像URLはHTTPSで指定してください' };
    return { ok: true };
  } catch { return { ok: false, error: '画像の指定が読み取れません' }; }
}

templates.get('/api/templates', async (c) => {
  try {
    const category = c.req.query('category') ?? undefined;
    const requestedAccountId = c.req.query('account_id');
    const scope = await getVisibleLineAccountScope(c.env.DB, c.get('staff'));
    if (requestedAccountId && !scope.allowedAccountIds.includes(requestedAccountId)) {
      return fail(c, 404, 'TEMPLATE_NOT_FOUND');
    }
    // 共通一覧契約。page/limit を付けたときだけ DB 側で切り出して新形で返す。
    const wantsPaging = c.req.query('page') !== undefined || c.req.query('limit') !== undefined;
    const paging = wantsPaging
      ? parseOffsetPaging({ page: c.req.query('page'), limit: c.req.query('limit') })
      : undefined;
    /*
      PERF-12: 選択画面の絞り込みをサーバーで行う口。検索・フォルダ・
      分類をページに切る前に適用しないと、届いた分だけを絞った
      「見つからない」が起きる。folder_id は指定フォルダと直下の子を
      含め、__none__ は未分類だけを返す。
    */
    const q = c.req.query('q') ?? undefined;
    const messageType = c.req.query('message_type') ?? undefined;
    const textOnlyParam = c.req.query('text_only');
    if (textOnlyParam !== undefined && textOnlyParam !== '0' && textOnlyParam !== '1') {
      return c.json({ success: false, error: 'text_only が正しくありません' }, 400);
    }
    const textOnly = textOnlyParam === '1';
    const quickParam = c.req.query('quick');
    const quick: 'frequent' | 'reservation' | 'ec' | undefined =
      quickParam === 'frequent' || quickParam === 'reservation' || quickParam === 'ec'
        ? quickParam
        : undefined;
    if (quickParam !== undefined && quick === undefined) {
      return c.json({ success: false, error: 'quick が正しくありません' }, 400);
    }
    const folderParam = c.req.query('folder_id');
    let folderIds: string[] | 'none' | undefined;
    if (folderParam === '__none__') {
      folderIds = 'none';
    } else if (folderParam) {
      const childRows = await c.env.DB.prepare(
        `SELECT id FROM folders WHERE (id = ? OR parent_id = ?) AND kind = 'template'`,
      ).bind(folderParam, folderParam).all<{ id: string }>();
      folderIds = (childRows.results ?? []).map((row) => row.id);
      if (!folderIds.includes(folderParam)) folderIds.push(folderParam);
    }
    const filter = (q || messageType || textOnly || quick || folderIds !== undefined)
      ? { q, messageType, textOnly, quick, folderIds }
      : undefined;
    const { items, total } = await getTemplatesWithUsageCount(c.env.DB, category, {
      accountIds: requestedAccountId ? [requestedAccountId] : scope.allowedAccountIds,
      includeUnassigned: requestedAccountId ? false : scope.canSeeUnassigned,
    }, paging ? { limit: paging.limit, offset: paging.offset } : undefined, filter);
    // 押された回数は1回のクエリでまとめて取る。1件ずつ引くと、
    // 20件並べば20回叩くことになる。
    let taps = new Map<string, number>();
    try {
      taps = await getCarouselTapTotals(c.env.DB);
    } catch (err) {
      // 数が出ないだけ。一覧そのものは出す。
      logger.error("templates.list_failed");
    }
    let sends = new Map<string, { thisMonth: number; total: number }>();
    try {
      sends = await getTemplateSendCounts(c.env.DB, items.map((item) => item.id));
    } catch (err) {
      // 集計だけ取れないときも、テンプレートそのものは操作できるようにする。
      logger.error("templates.list_failed");
    }
    /*
     * 一覧の主 messageType/messageContent は公開版だけを返す。
     * 編集中の下書きがあってもここには出さず、実送信の候補選びが
     * 未公開の下書きを掴まないようにする。編集中の内容は編集画面が
     * 詳細口で読む。未公開(版0・公開日時なし)は候補から外す目印付きで返す。
     */
    const serialized = items.map((t) => ({
      id: t.id,
      confirmationRevision: t.confirmation_revision,
      accountId: t.line_account_id,
      name: t.name,
      category: t.category,
      messageType: t.message_type,
      messageContent: t.message_content,
      messageBubbles: t.message_bubbles_json ? JSON.parse(t.message_bubbles_json) : null,
      /*
       * 管理一覧の抜粋・検索が読む最新の下書き。公開版しか無ければ null。
       * 送信の候補選びは `messageContent`（公開版）だけを見る決まりは変えない。
       */
      draftMessageContent: t.draft_message_content ?? null,
      draftMessageBubbles: t.draft_message_bubbles_json ? JSON.parse(t.draft_message_bubbles_json) : null,
      question: questionValue(t.question_json),
      questionStatus: t.question_status,
      folderId: t.folder_id ?? null,
      usageCount: t.usage_count,
      /** 選択肢が押された回数の合計。押される仕掛けが無いものは 0。 */
      tapCount: taps.get(t.id) ?? 0,
      monthlySendCount: sends.get(t.id)?.thisMonth ?? null,
      totalSendCount: sends.get(t.id)?.total ?? null,
      ...versionInfoOf(t),
      createdAt: t.created_at,
      updatedAt: t.updated_at,
    }));
    const withSamples=await withStyleSampleMetadata(c.env.DB,serialized,'template');
    if (wantsPaging && paging) {
      // フォルダ欄の件数を、一覧を全件読まなくても出せるように添える。
      const folderCounts = c.req.query('folder_counts') === '1'
        ? Object.fromEntries(await getTemplateFolderCounts(c.env.DB, {
          accountIds: requestedAccountId ? [requestedAccountId] : scope.allowedAccountIds,
          includeUnassigned: requestedAccountId ? false : scope.canSeeUnassigned,
        }, messageType, textOnly))
        : undefined;
      return c.json({
        success: true,
        data: {
          ...buildOffsetListResponse({
            items: withSamples,
            total,
            paging,
            sort: [
              { field: 'created_at', direction: 'desc' },
              { field: 'id', direction: 'asc' },
            ],
          }),
          ...(folderCounts ? { folderCounts } : {}),
        },
      });
    }
    return c.json({ success: true, data: withSamples });
  } catch (err) {
    throw err;
  }
});

/**
 * F5 テンプレートの見本4件。DBへの書き込み・送信はしない。
 * 固定routeは `/:id` より前に置く。`examples` をID扱いして404にしない。
 */
export const TEMPLATE_EXAMPLES = [
  {
    id: 'template-example-business-hours',
    messageType: 'text',
    name: '営業時間のご案内',
    body: 'いつもご利用ありがとうございます。営業時間のご案内です。平日 10:00〜19:00、土日祝 10:00〜18:00です。ご来店をお待ちしております。',
    imageSlot: '/images/template-examples/business-hours.png',
  },
  {
    id: 'template-example-campaign',
    messageType: 'rich_message',
    name: 'キャンペーンのお知らせ',
    body: '期間限定キャンペーンのお知らせです。対象商品が10%お得になります。この機会にぜひご利用ください。',
    imageSlot: '/images/template-examples/campaign.png',
  },
  {
    id: 'template-example-booking',
    messageType: 'text',
    name: '予約の受付',
    body: 'ご予約を受け付けました。日時が近づきましたらご案内をお送りします。変更・キャンセルはお早めにご連絡ください。',
    imageSlot: '/images/template-examples/booking.png',
  },
  {
    id: 'template-example-thanks-coupon',
    messageType: 'coupon',
    name: '来店のお礼とクーポン',
    body: 'ご来店ありがとうございました。次回使えるクーポンをお送りします。またのご利用をお待ちしております。',
    imageSlot: '/images/template-examples/thanks-coupon.png',
  },
] as const;

templates.get('/api/templates/examples', async (c) => {
  return c.json({ success: true, data: TEMPLATE_EXAMPLES.map((item) => ({ ...item })) });
});

templates.get('/api/templates/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const item = await getTemplateById(c.env.DB, id);
    if (!item || !await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [item.line_account_id])) {
      return fail(c, 404, 'TEMPLATE_NOT_FOUND');
    }
    const usedBy = await usageWithVersions(c.env.DB, id, item.line_account_id);
    // 一斉配信の参照は参照表から足す（送った時の版のまま）。
    const broadcasts = await listBroadcastReferences(c.env.DB, id);
    // 旧公開版に固定された送信待ち・取消ずみの登録も使用先に出す。
    const reminderEnrollments = await getPinnedReminderDeleteBlockers(
      c.env.DB, id, item.line_account_id,
    );
    return c.json({
      success: true,
      data: {
        ...(await withStyleSampleMetadata(c.env.DB,[{id:item.id}],'template'))[0],
        id: item.id,
        accountId: item.line_account_id,
        name: item.name,
        category: item.category,
        messageType: draftMessageTypeOf(item),
        messageContent: draftMessageContentOf(item),
        messageBubbles: (hasTemplateDraft(item) ? item.draft_message_bubbles_json : item.message_bubbles_json) ? JSON.parse((hasTemplateDraft(item) ? item.draft_message_bubbles_json : item.message_bubbles_json)!) : null,
        question: questionValue(draftQuestionJsonOf(item)),
        questionStatus: draftQuestionStatusOf(item),
        folderId: item.folder_id ?? null,
        carouselActions: draftCarouselActionsOf(item),
        carouselTapLimitMode: draftCarouselTapLimitModeOf(item),
        carouselTapLimitText: draftCarouselTapLimitTextOf(item),
        ...versionInfoOf(item),
        usedBy: { ...usedBy, broadcasts, reminderEnrollments },
        createdAt: item.created_at,
        updatedAt: item.updated_at,
      },
    });
  } catch (err) {
    throw err;
  }
});

function templateUsageCount(usage: Awaited<ReturnType<typeof getTemplateUsage>>): number {
  return Object.values(usage).reduce((total, items) => total + items.length, 0);
}

/**
 * 利用先の行に「使っている版」を載せる。参照表にない古い参照は
 * 空のままにし、無い版番号をでっち上げない（画面では「—」）。
 */
async function usageWithVersions(
  db: D1Database,
  templateId: string,
  accountId: string | null | undefined,
) {
  const usage = await getTemplateUsage(db, templateId, accountId);
  const refs = await listTemplateReferences(db, templateId);
  const versionOf = (kind: string, consumerId: string): number | null => {
    const hit = refs.find((row) => row.consumer_kind === kind && row.consumer_id === consumerId);
    return hit ? hit.template_version_number : null;
  };
  return {
    ...usage,
    autoReplies: usage.autoReplies.map((row) => ({
      ...row,
      templateVersion: versionOf('auto_reply', row.id),
    })),
    scenarioSteps: usage.scenarioSteps.map((row) => ({
      ...row,
      templateVersion: versionOf('scenario', row.scenarioId),
    })),
  };
}

// GET /api/templates/:id/usages — 現行 templates.id を参照する設定をまとめて返す
templates.get('/api/templates/:id/usages', async (c) => {
  try {
    const templateId = c.req.param('id');

    const tpl = await getTemplateById(c.env.DB, templateId);
    if (!tpl || !await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [tpl.line_account_id])) {
      return fail(c, 404, 'TEMPLATE_NOT_FOUND');
    }

    // 一斉配信の参照は参照表から足す（送った時の版のまま）。
    const usage = await usageWithVersions(c.env.DB, templateId, tpl.line_account_id);
    const broadcasts = await listBroadcastReferences(c.env.DB, templateId);
    // 旧公開版に固定された送信待ち・取消ずみの登録も使用先に出す。
    const reminderEnrollments = await getPinnedReminderDeleteBlockers(
      c.env.DB, templateId, tpl.line_account_id,
    );
    return c.json({ success: true, data: { ...usage, broadcasts, reminderEnrollments } });
  } catch (err) {
    throw err;
  }
});

/**
 * 空でない文字列か。口を直接叩かれても、空白だけの名前や本文は
 * 通さない。空欄のまま保存されると一覧に名前の無い行が残り、中身の無い
 * テンプレートが配信の候補に並ぶ。
 */
function isBlankText(value: unknown): boolean {
  return typeof value !== 'string' || !value.trim();
}

templates.post('/api/templates', requireDeliveryAccess('templates'), inputJsonBoundary({"accountId":["string"],"name":["string"],"category":["string"],"messageType":["string"],"messageContent":["string"],"questionStatus":["string"],"folderId":["null","string"]}), async (c) => {
  try {
    const body = await c.req.json<{
      accountId?: string;
      name: string;
      category?: string;
      messageType: string;
      messageContent: string;
      question?: unknown;
      questionStatus?: 'draft' | 'published';
      folderId?: string | null;
    }>();
    if (!body.accountId) {
      return inputError(c, { success: false, error: 'account_id_required' }, 400, ["accountId"]);
    }
    if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [body.accountId])) {
      return fail(c, 404, 'TEMPLATE_NOT_FOUND');
    }
    // 空白だけの値も「無い」と同じに扱う。
    if (isBlankText(body.name) || isBlankText(body.messageType) || isBlankText(body.messageContent)) {
      return inputError(c, { success: false, error: 'name, messageType, messageContent are required' }, 400, ["name","messageType","messageContent"]);
    }
    try { body.messageContent = await prepareRichVideoTemplate(c.env, body.messageType, body.messageContent, body.accountId, c.env.WORKER_URL || new URL(c.req.url).origin); }
    catch (err) { return inputError(c, {success:false,error:err instanceof Error ? err.message : '動画を準備できませんでした'}, 422, ["messageContent"]); }
    const message = validateTemplateMessage(body.messageType, body.messageContent, false);
    if (!message.ok) {
      const { ok: _ok, ...failure } = message;
      return inputError(c, { success: false, ...failure }, 422, ["messageContent"]);
    }
    const carousel = checkCarousel(body.messageType, body.messageContent);
    if (!carousel.ok) return inputError(c, { success: false, error: carousel.error }, 422, ["messageContent"]);
    const image = checkImageTemplate(body.messageType, body.messageContent);
    if (!image.ok) return inputError(c, { success: false, error: image.error }, 422, ["messageContent"]);
    const structured = checkStructuredSize(body.messageType, body.messageContent);
    if (!structured.ok) return inputError(c, { success: false, error: structured.error }, 422, ["messageContent"]);
    const options = readCarouselOptions(body as unknown as Record<string, unknown>);
    if (!options.ok) return inputError(c, { success: false, error: options.error }, 400, ["carouselActions","carouselTapLimitMode","carouselTapLimitText"]);
    const question = readQuestionPayload(body as unknown as Record<string, unknown>);
    if (!question.ok) return inputError(c, { success: false, error: question.error }, 422, ["messageContent"]);
    /*
     * カード型はバブルかカルーセルのJSONでないと保存しない。
     * 通常文・壊れたJSON・型なしJSONのまま保存できると「作れた」と
     * 誤認し、送信時に落ちる。質問付きは質問文をテキストとして
     * 保存するので、カードの中身は見ない。
     */
    if (!question.question) {
      const flexError = validateFlexContent(body.messageType, body.messageContent);
      if (flexError) return inputError(c, { success: false, error: flexError }, 422, ["messageContent"]);
    }
    if (body.questionStatus && body.questionStatus !== 'draft' && body.questionStatus !== 'published') {
      return inputError(c, { success: false, error: '質問の保存状態を確認してください' }, 400, ["questionStatus"]);
    }
    const folderScope = await getVisibleLineAccountScope(c.env.DB, c.get('staff'));
    const folder = await readFolderId(c.env.DB, body as unknown as Record<string, unknown>, body.accountId, folderScope.canSeeUnassigned);
    if (!folder.ok) return inputError(c, { success: false, error: folder.error }, 422, ["folderId"]);
    const extraTree = { question: question.question?.choices.map(choice => ({ tapExtras: { tagIds: choice.addTagIds, scoreChange: choice.scoreChange } })), content: !question.question && body.messageType !== 'text' && body.messageContent ? JSON.parse(body.messageContent) : null };
    const extrasError = await validateTapExtraReferences(c.env.DB, extraTree, body.accountId ?? null);
    if (extrasError) return c.json({ success: false, error: extrasError, code: 'TAP_EXTRA_INVALID', field: 'tapExtras', fieldErrors: { tapExtras: extrasError } }, 422);
    const item = await createTemplate(c.env.DB, {
      ...body,
      folderId: folder.folderId ?? null,
      lineAccountId: body.accountId,
      ...options.value,
      questionJson: question.questionJson,
      questionStatus: body.questionStatus,
      // 質問を扱わない利用先で選ばれても、壊れたFlexを送らず質問文を送る。
      ...(question.question
        ? { messageType: 'text', messageContent: question.question.intro?.trim() || question.question.text }
        : {}),
    });
    // 作成の返しも更新と同じ形にする。将来使うときにハマらないため。
    // 作った直後は未公開(版0・公開日時なし・下書きあり)。
    return c.json({ success: true, data: { id: item.id, name: item.name, category: item.category, messageType: item.message_type, messageContent: item.message_content, question: questionValue(item.question_json), questionStatus: item.question_status, folderId: item.folder_id ?? null, hasDraft: true, publishedVersion: 0, publishedAt: null, draftRevision: 1, createdAt: item.created_at, updatedAt: item.updated_at } }, 201);
  } catch (err) {
    if (err instanceof MediaReferenceAccountError) {
      return inputError(c, { success: false, error: '別のLINEアカウントのメディアは使用できません' }, 422, ["messageContent"]);
    }
    throw err;
  }
});

templates.put('/api/templates/:id', requireDeliveryAccess('templates'), inputJsonBoundary({"name":["string"],"category":["string"],"messageType":["string"],"messageContent":["string"],"questionStatus":["string"],"folderId":["null","string"]}), async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json<{
      name?: string;
      category?: string;
      messageType?: string;
      messageContent?: string;
      question?: unknown;
      questionStatus?: 'draft' | 'published';
      folderId?: string | null;
      expectedVersion?: number;
      expectedDraftRevision?: number;
    }>();
    const existing = await getTemplateById(c.env.DB, id);
    if (!existing || !await canAccessAllLineAccounts(
      c.env.DB, c.get('staff'), [existing.line_account_id],
    )) {
      return c.json({ success: false, error: 'Not found' }, 404);
    }
    if(existing.message_bubbles_json || existing.draft_message_bubbles_json) return c.json({success:false,code:'MULTIPLE_MESSAGES_REQUIRE_EDITOR',error:'複数通のテンプレートは統括の編集から保存してください'},409);
    /*
     * 部分更新なので「来なかった項目」はいまのまま残すが、
     * 来た項目が空・空白だけなら断る。画面側は保存前に止めているが、
     * 口を直接叩かれたときに空の名前・空の本文へ書き換わるのを防ぐ。
     */
    if (body.name !== undefined && isBlankText(body.name)) {
      return inputError(c, { success: false, error: '名前を入力してください' }, 400, ["name"]);
    }
    if (body.messageType !== undefined && isBlankText(body.messageType)) {
      return inputError(c, { success: false, error: 'テンプレートの種別を確認してください' }, 400, ["messageType"]);
    }
    if (body.messageContent !== undefined && isBlankText(body.messageContent)) {
      return inputError(c, { success: false, error: '本文を入力してください' }, 400, ["messageContent"]);
    }
    /*
     * 保存は2系統。名前・置き場の整理は live 列へ即時反映し、
     * 送信文(種別・本文・カルーセル・質問)は下書きへだけ書く。
     * 公開版は POST /:id/publish を通らないと変わらない。
     */
    const changesMessage = body.messageType !== undefined || body.messageContent !== undefined;
    const touchesCarousel = 'carouselActions' in body
      || 'carouselTapLimitMode' in body
      || 'carouselTapLimitText' in body;
    const touchesQuestion = 'question' in body || body.questionStatus !== undefined;
    const hasContentEdit = changesMessage || touchesCarousel || touchesQuestion;
    // 種別・本文の土台は「編集中の下書きがあればそれ、なければ公開版」。
    // 本文だけ直す場合や、2回目の保存で1回目の下書きへ足す場合がある。
    const baseMessageType = body.messageType
      ?? existing.draft_message_type
      ?? existing.message_type;
    let baseMessageContent = body.messageContent
      ?? existing.draft_message_content
      ?? existing.message_content;
    if (changesMessage) {
      try { baseMessageContent = await prepareRichVideoTemplate(c.env, baseMessageType, baseMessageContent, existing.line_account_id, c.env.WORKER_URL || new URL(c.req.url).origin); }
      catch (err) { return inputError(c, {success:false,error:err instanceof Error ? err.message : '動画を準備できませんでした'}, 422, ["messageContent"]); }
    }
    const message = changesMessage
      ? validateTemplateMessage(baseMessageType, baseMessageContent, false)
      : { ok: true as const };
    if (!message.ok) {
      const { ok: _ok, ...failure } = message;
      return inputError(c, { success: false, ...failure }, 422, ["messageContent"]);
    }
    const carousel = checkCarousel(baseMessageType, baseMessageContent);
    if (!carousel.ok) return inputError(c, { success: false, error: carousel.error }, 422, ["messageContent"]);
    const image = checkImageTemplate(baseMessageType, baseMessageContent);
    if (!image.ok) return inputError(c, { success: false, error: image.error }, 422, ["messageContent"]);
    const structured = checkStructuredSize(baseMessageType, baseMessageContent);
    if (!structured.ok) return inputError(c, { success: false, error: structured.error }, 422, ["messageContent"]);
    const options = readCarouselOptions(body as unknown as Record<string, unknown>);
    if (!options.ok) return inputError(c, { success: false, error: options.error }, 400, ["carouselActions","carouselTapLimitMode","carouselTapLimitText"]);
    const question = readQuestionPayload(body as unknown as Record<string, unknown>);
    if (!question.ok) return inputError(c, { success: false, error: question.error }, 422, ["messageContent"]);
    // 作成口と同じく、質問で上書きしないカード型だけ中身を見る。
    if (changesMessage && !question.question) {
      const flexError = validateFlexContent(baseMessageType, baseMessageContent);
      if (flexError) return inputError(c, { success: false, error: flexError }, 422, ["messageContent"]);
    }
    if (body.questionStatus && body.questionStatus !== 'draft' && body.questionStatus !== 'published') {
      return inputError(c, { success: false, error: '質問の保存状態を確認してください' }, 400, ["questionStatus"]);
    }
    const folderScope = await getVisibleLineAccountScope(c.env.DB, c.get('staff'));
    const folder = await readFolderId(c.env.DB, body as unknown as Record<string, unknown>, existing.line_account_id, folderScope.canSeeUnassigned);
    if (!folder.ok) return inputError(c, { success: false, error: folder.error }, 422, ["folderId"]);
    if (hasContentEdit) {
      const savedQuestion = 'question' in body ? question.question : questionValue(draftQuestionJsonOf(existing));
      const extraTree: unknown[] = (savedQuestion?.choices ?? []).map(choice => ({ tapExtras: { tagIds: choice.addTagIds, scoreChange: choice.scoreChange } }));
      if (baseMessageType !== 'text') { try { extraTree.push(JSON.parse(baseMessageContent)); } catch { /* 既存の本文検査で扱う */ } }
      const extrasError = await validateTapExtraReferences(c.env.DB, extraTree, existing.line_account_id);
      if (extrasError) return c.json({ success: false, error: extrasError, code: 'TAP_EXTRA_INVALID', fieldErrors: { tapExtras: extrasError } }, 422);
    }
    if (hasContentEdit && (!Number.isInteger(body.expectedVersion) || (body.expectedVersion ?? -1) < 0
      || !Number.isInteger(body.expectedDraftRevision) || (body.expectedDraftRevision ?? -1) < 0)) {
      return c.json({ success: false, code: 'TEMPLATE_DRAFT_CONFLICT', error: '編集した版を確認できません。入力を控えてから読み直してください' }, 409);
    }
    if (hasContentEdit && (body.expectedVersion !== Number(existing.published_version ?? 0)
      || body.expectedDraftRevision !== Number(existing.draft_revision ?? 0))) {
      return c.json({ success: false, code: 'TEMPLATE_DRAFT_CONFLICT', error: 'ほかの編集が保存されています。変更内容を確認してから読み直してください' }, 409);
    }
    const metadataUpdates: {
      name?: string;
      category?: string;
      folderId?: string | null;
    } = {};
    if (body.name !== undefined) metadataUpdates.name = body.name;
    if (body.category !== undefined) metadataUpdates.category = body.category;
    if (folder.folderId !== undefined) metadataUpdates.folderId = folder.folderId;
    if (!hasContentEdit && Object.keys(metadataUpdates).length > 0) {
      await updateTemplate(c.env.DB, id, metadataUpdates);
    }
    let savedDraft;
    if (hasContentEdit) {
      savedDraft = await saveTemplateDraft(c.env.DB, id, {
        ...metadataUpdates,
        expectedVersion: body.expectedVersion,
        expectedDraftRevision: body.expectedDraftRevision,
        ...(changesMessage
          ? {
              messageType: baseMessageType,
              messageContent: baseMessageContent,
              // 質問を扱わない利用先で選ばれても、壊れたFlexを送らず質問文を送る。
              ...(question.question
                ? { messageType: 'text' as const, messageContent: question.question.intro?.trim() || question.question.text }
                : {}),
            }
          : {}),
        ...options.value,
        questionJson: question.questionJson,
        questionStatus: body.questionStatus,
      });
    }
    const updated = hasContentEdit ? savedDraft : await getTemplateById(c.env.DB, id);
    if (!updated) return c.json({ success: false, error: 'Not found' }, 404);
    return c.json({
      success: true,
      data: {
        id: updated.id,
        accountId: updated.line_account_id,
        name: updated.name,
        category: updated.category,
        messageType: draftMessageTypeOf(updated),
        messageContent: draftMessageContentOf(updated),
        question: questionValue(draftQuestionJsonOf(updated)),
        questionStatus: draftQuestionStatusOf(updated),
        folderId: updated.folder_id ?? null,
        carouselActions: draftCarouselActionsOf(updated),
        carouselTapLimitMode: draftCarouselTapLimitModeOf(updated),
        carouselTapLimitText: draftCarouselTapLimitTextOf(updated),
        ...versionInfoOf(updated),
        createdAt: updated.created_at,
        updatedAt: updated.updated_at,
      },
    });
  } catch (err) {
    if (err instanceof MediaReferenceAccountError) {
      return inputError(c, { success: false, error: '別のLINEアカウントのメディアは使用できません' }, 422, ["messageContent"]);
    }
    if (err instanceof Error && err.message === 'TEMPLATE_DRAFT_CONFLICT') {
      return c.json({ success: false, code: 'TEMPLATE_DRAFT_CONFLICT', error: 'ほかの編集が保存されています。変更内容を確認してから読み直してください' }, 409);
    }
    throw err;
  }
});

function validPublishKey(value: string | null | undefined): value is string {
  return Boolean(value && value.length >= 8 && value.length <= 200 && /^[A-Za-z0-9._:-]+$/.test(value));
}

/**
 * 下書きを公開版へ写す。送信側が読む live 列はここでしか変わらない。
 * 同じ確認キーでの再試行は成功済みの結果をそのまま返し(下書きなしの成功も記録)、
 * 別の下書きを公開しない。公開版・下書き版の両方を確認できる(自動応答の
 * POST /api/auto-replies/:id/publish より厳しい約束)。
 */
templates.post('/api/templates/:id/publish', requireDeliveryAccess('templates'), inputJsonBoundary(), async (c) => {
  try {
    const id = c.req.param('id');
    const requestKey = c.req.header('Idempotency-Key');
    if (!validPublishKey(requestKey)) {
      return inputError(c, { success: false, error: '公開操作の確認キーが必要です' }, 400, []);
    }
    const existing = await getTemplateById(c.env.DB, id);
    if (!existing || !await canAccessAllLineAccounts(
      c.env.DB, c.get('staff'), [existing.line_account_id],
    )) {
      return fail(c, 404, 'TEMPLATE_NOT_FOUND');
    }
    // 版の確認は任意にしない。確認なしの公開は受け付けない。
    // 詳細口が返す publishedVersion・draftRevision をそのまま送る。
    const body: { expectedVersion?: unknown; expectedDraftRevision?: unknown; effectiveFrom?: unknown } =
      await c.req.json().catch(() => ({}));
    const expectedVersion = body.expectedVersion === undefined || body.expectedVersion === null
      ? undefined
      : Number(body.expectedVersion);
    if (expectedVersion === undefined || !Number.isInteger(expectedVersion)) {
      return inputError(c, { success: false, error: '版の番号を確認してください' }, 400, ["expectedVersion"]);
    }
    const expectedDraftRevision = body.expectedDraftRevision === undefined || body.expectedDraftRevision === null
      ? undefined
      : Number(body.expectedDraftRevision);
    if (expectedDraftRevision === undefined || !Number.isInteger(expectedDraftRevision)) {
      return inputError(c, { success: false, error: '下書きの版を確認してください' }, 400, ["expectedDraftRevision"]);
    }
    // 使い始めの日時は持てるだけ（予約の札で見せる）。来たら日付か確かめる。
    let effectiveFrom: string | undefined;
    if (body.effectiveFrom !== undefined && body.effectiveFrom !== null) {
      if (typeof body.effectiveFrom !== 'string' || !Number.isFinite(Date.parse(body.effectiveFrom))) {
        return inputError(c, { success: false, error: '使い始めの日時を確認してください' }, 400, ["effectiveFrom"]);
      }
      effectiveFrom = body.effectiveFrom;
    }
    // 公開する版も保存時と同じ検査を通す。下書きは保存時に検査済みだが、
    // 検査基準が変わった後に残った下書きをそのまま出さないため。
    const draftType = existing.draft_message_type ?? existing.message_type;
    const draftContent = existing.draft_message_content ?? existing.message_content;
    if (hasTemplateDraft(existing)) {
      const message = validateTemplateMessage(draftType, draftContent, false);
      if (!message.ok) {
        const { ok: _ok, ...failure } = message;
        return inputError(c, { success: false, ...failure }, 422, ["messageContent"]);
      }
      const carousel = checkCarousel(draftType, draftContent);
      if (!carousel.ok) return inputError(c, { success: false, error: carousel.error }, 422, ["messageContent"]);
      const image = checkImageTemplate(draftType, draftContent);
      if (!image.ok) return inputError(c, { success: false, error: image.error }, 422, ["messageContent"]);
      // 検査基準が変わる前に残った壊れたカードの下書きを出さない。
      const flexError = validateFlexContent(draftType, draftContent);
      if (flexError) return inputError(c, { success: false, error: flexError }, 422, ["messageContent"]);
      const structured = checkStructuredSize(draftType, draftContent);
      if (!structured.ok) return inputError(c, { success: false, error: structured.error }, 422, ["messageContent"]);
    }
    const staff = c.get('staff') as unknown as { id?: string };
    const result = await publishTemplate(c.env.DB, id, {
      expectedVersion,
      expectedDraftRevision,
      idempotencyKey: requestKey,
      effectiveFrom,
      createdByStaffId: staff?.id ?? null,
    });
    const row = result.row;
    return c.json({
      success: true,
      data: {
        id: row.id,
        accountId: row.line_account_id,
        messageType: row.message_type,
        messageContent: row.message_content,
        publishedVersion: Number(row.published_version),
        publishedAt: row.published_at,
        published: result.published,
        replayed: result.replayed,
        hasDraft: hasTemplateDraft(row),
        draftRevision: Number(row.draft_revision ?? 0),
      },
    });
  } catch (err) {
    const code = err instanceof Error ? err.message : '';
    if (code === 'TEMPLATE_VERSION_CONFLICT') {
      return c.json({ success: false, error: 'ほかの人が先に公開しました。開き直して確認してください' }, 409);
    }
    if (code === 'TEMPLATE_DRAFT_CONFLICT') {
      return c.json({ success: false, error: '下書きが書き換わっています。開き直して確認してください' }, 409);
    }
    if (code === 'TEMPLATE_PUBLISH_KEY_CONFLICT') {
      return c.json({ success: false, error: '同じ確認キーが別の公開操作で使われています' }, 409);
    }
    if (err instanceof MediaReferenceAccountError) {
      return inputError(c, { success: false, error: '別のLINEアカウントのメディアは使用できません' }, 422, ["messageContent"]);
    }
    throw err;
  }
});

// GET /api/templates/:id/versions — 版の履歴。新しい版から返す。
templates.get('/api/templates/:id/versions', async (c) => {
  try {
    const id = c.req.param('id');
    const item = await getTemplateById(c.env.DB, id);
    if (!item || !await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [item.line_account_id])) {
      return fail(c, 404, 'TEMPLATE_NOT_FOUND');
    }
    const versions = await listTemplateVersions(c.env.DB, id);
    return c.json({
      success: true,
      data: versions.map((v) => ({
        versionNumber: v.version_number,
        status: v.status,
        messageType: v.message_type,
        messageContent: v.message_content,
        messageBubbles: v.message_bubbles_json ? JSON.parse(v.message_bubbles_json) : null,
        carouselActions: v.carousel_actions_json ? JSON.parse(v.carousel_actions_json) : null,
        carouselTapLimitMode: v.carousel_tap_limit_mode,
        carouselTapLimitText: v.carousel_tap_limit_text,
        question: v.question_json ? questionValue(v.question_json) : null,
        questionStatus: v.question_status,
        effectiveFrom: v.effective_from,
        createdAt: v.created_at,
        createdByStaffId: v.created_by_staff_id,
        creatorName: v.creator_name ?? null,
        creatorNameSource: v.creator_name ? 'current_staff_profile' : null,
      })),
    });
  } catch (err) {
    throw err;
  }
});

/**
 * この版に戻す。過去の版は変えず、その中身で新しい版を作る
 * （下書きへ写して公開する）。公開口と同じ確認キーと版確認を使う。
 */
templates.post('/api/templates/:id/revert', requireDeliveryAccess('templates'), inputJsonBoundary(), async (c) => {
  try {
    const id = c.req.param('id');
    const requestKey = c.req.header('Idempotency-Key');
    if (!validPublishKey(requestKey)) {
      return inputError(c, { success: false, error: '公開操作の確認キーが必要です' }, 400, []);
    }
    const existing = await getTemplateById(c.env.DB, id);
    if (!existing || !await canAccessAllLineAccounts(
      c.env.DB, c.get('staff'), [existing.line_account_id],
    )) {
      return fail(c, 404, 'TEMPLATE_NOT_FOUND');
    }
    const body: { versionNumber?: unknown; expectedVersion?: unknown } =
      await c.req.json().catch(() => ({}));
    const versionNumber = body.versionNumber === undefined || body.versionNumber === null
      ? undefined
      : Number(body.versionNumber);
    if (versionNumber === undefined || !Number.isInteger(versionNumber) || versionNumber < 1) {
      return inputError(c, { success: false, error: '戻す版を確認してください' }, 400, ["versionNumber"]);
    }
    const expectedVersion = body.expectedVersion === undefined || body.expectedVersion === null
      ? undefined
      : Number(body.expectedVersion);
    if (expectedVersion === undefined || !Number.isInteger(expectedVersion)) {
      return inputError(c, { success: false, error: '版の番号を確認してください' }, 400, ["expectedVersion"]);
    }
    const staff = c.get('staff') as unknown as { id?: string };
    const result = await revertTemplateToVersion(c.env.DB, id, versionNumber, {
      expectedVersion,
      idempotencyKey: requestKey,
      staffId: staff?.id ?? null,
    });
    return c.json({
      success: true,
      data: {
        id: result.row!.id,
        publishedVersion: result.publishedVersion,
        hasDraft: hasTemplateDraft(result.row!),
      },
    });
  } catch (err) {
    const code = err instanceof Error ? err.message : '';
    if (code === 'TEMPLATE_NOT_FOUND') {
      return fail(c, 404, 'TEMPLATE_NOT_FOUND');
    }
    if (code === 'TEMPLATE_VERSION_NOT_FOUND') {
      return c.json({ success: false, error: 'その版はありません。開き直して確認してください' }, 404);
    }
    if (code === 'TEMPLATE_VERSION_CONFLICT') {
      return c.json({ success: false, error: 'ほかの人が先に公開しました。開き直して確認してください' }, 409);
    }
    if (code === 'TEMPLATE_DRAFT_CONFLICT') {
      return c.json({ success: false, error: '下書きが書き換わっています。開き直して確認してください' }, 409);
    }
    if (code === 'TEMPLATE_PUBLISH_KEY_CONFLICT') {
      return c.json({ success: false, error: '同じ確認キーが別の公開操作で使われています' }, 409);
    }
    throw err;
  }
});

templates.post('/api/templates/bulk-delete', requireDeliveryAccess('templates'), inputJsonBoundary(), bulkDeleteTemplates);

templates.delete('/api/templates/:id', requireDeliveryAccess('templates'), async (c) => {
  try {
    const id = c.req.param('id');
    const existing = await getTemplateById(c.env.DB, id);
    if (!existing || !await canAccessAllLineAccounts(
      c.env.DB, c.get('staff'), [existing.line_account_id],
    )) {
      return c.json({ success: false, error: 'Not found' }, 404);
    }
    const expectedDraftRevision = c.req.query('expectedDraftRevision');
    if (expectedDraftRevision !== undefined && (!/^\d+$/.test(expectedDraftRevision) || !Number.isSafeInteger(Number(expectedDraftRevision)))) {
      return inputError(c, { success: false, error: '下書きの版が正しくありません' }, 400, ['expectedDraftRevision']);
    }
    if (expectedDraftRevision !== undefined && (Number(existing.published_version ?? 0) !== 0 || Number(existing.draft_revision ?? 0) !== Number(expectedDraftRevision))) {
      return c.json({ success: false, error: '下書きの状態が変わったため消せません。読み直して確認してください。', code: 'DRAFT_CHANGED' }, 409);
    }
    // ON DELETE SET NULL や本文の控えがあっても、参照中の設定を運用者に知らせず
    // 切ることはしない。すべての利用先を先に差し替えてもらう。
    const usage = await usageWithVersions(c.env.DB, id, existing.line_account_id);
    const usageCount = templateUsageCount(usage);
    // 予約済み・送信中の配信で使っているものは消せない。
    // 送った配信は送った時の版のまま残り、下書きは本文の写しで作り直せる。
    const blockers = await getBroadcastDeleteBlockers(c.env.DB, id);
    const broadcasts = await listBroadcastReferences(c.env.DB, id);
    // 旧公開版に固定された送信待ち・取消ずみ（再開できる）の登録が
    // 使っているものも消せない。消すと固定した版の本文が控えに変わる。
    const reminderBlockers = await getPinnedReminderDeleteBlockers(
      c.env.DB, id, existing.line_account_id,
    );
    if (usageCount > 0 || blockers.length > 0 || reminderBlockers.length > 0) {
      const named = blockers.slice(0, 3).map((b) => `「${b.title}」`).join('、');
      const rest = blockers.length > 3 ? `ほか${blockers.length - 3}件` : '';
      const reminderNames = [...new Set(reminderBlockers.map((b) => b.reminderName))];
      const reminderNamed = reminderNames.slice(0, 3).map((name) => `「${name}」`).join('、');
      const reminderRest = reminderNames.length > 3 ? `ほか${reminderNames.length - 3}件` : '';
      const reasons: string[] = [];
      if (blockers.length > 0) {
        reasons.push(`予約済み・送信中の配信${blockers.length}件（${named}${rest}）で使われています`);
      }
      if (reminderBlockers.length > 0) {
        reasons.push(`送信待ちの通知${reminderBlockers.length}件（${reminderNamed}${reminderRest}）が使っています`);
      }
      if (usageCount > 0) {
        reasons.push(`${usageCount}件の設定で使用中です`);
      }
      return c.json({
        success: false,
        code: 'IN_USE',
        usageCount: usageCount + blockers.length + reminderBlockers.length,
        error: `${reasons.join('。')}。先に使用先を差し替えてください。`,
        usedBy: { ...usage, broadcasts },
        blockers,
      }, 409);
    }
    if (expectedDraftRevision !== undefined) {
      if (!await deleteCreatedTemplateDraft(c.env.DB, id, Number(expectedDraftRevision))) return c.json({ success: false, error: '下書きの状態が変わったため消せません。読み直して確認してください。', code: 'DRAFT_CHANGED' }, 409);
    } else await deleteTemplate(c.env.DB, id);
    return c.json({ success: true, data: null });
  } catch (err) {
    throw err;
  }
});

export { templates };
