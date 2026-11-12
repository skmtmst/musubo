import { logger } from '@line-crm/shared/server';
import type { FormGateInput, FormAnswers } from './form-gate-types.js';
export type { FormAnswers, FormGateInput } from './form-gate-types.js';
import { writeFormDestinationsOnce } from './form-destination-workflow.js';
import { applyTapExtras } from '../../services/tap-extras.js';
import { runScenarioOp } from '../scenarios/scenario-actions/index.js';
import { researchGateProblem, runResearchAnswerAction, validateResearchActionScope } from '../../services/research-forms.js';
import type { Env } from '../../worker-env.js';
/**
 * 回答フォーム（レイアウト版）の、受け付け判定と送信後の処理。
 *
 * `routes/forms.ts` の送信処理はもともと長い。ここに切り出したのは
 * 次の2つで、どちらも layout を持つフォームだけに効く。
 *
 *   1. 受け付けてよいかの判定（回答期限・1人1回・総数・選択肢の定員）
 *   2. 回答を配る処理（登録先・選択肢ごとの動作・日付リマインダ・回答後の動作）
 *
 * 送信そのものを止めてよいのは 1 だけ。2 は失敗しても回答は保存済みに
 * するので、投げずに握って記録する。タグが1つ付かなかったせいで
 * 「送信できませんでした」と出すのは、利用者にとって嘘になる。
 */

import type { Message } from '@line-crm/line-sdk';
import {
  collectReachableInputs,
  fixedFieldForBlock,
  formatAddressValue,
  formChoiceIsSelected,
  formatAnswerValue,
  hasChoices,
  isCalendarDateString,
  isFormAnswerEmpty,
  validateAnswers,
  type FormAction,
  type FormChoice,
  type FormInputBlock,
  type FormLayout,
} from '@line-crm/shared';


import {
  countChoiceUsage,
  countFormSubmissionsByFriend,
  enrollFriendInReminder,
  getFriendFieldById,
  getFixedFriendField,
  getMessageTemplateById,
  getTemplateById,
  jstNow,
  setFriendFieldValue,
  validateFriendFieldValue,
} from '@line-crm/db';
import { attachTagAndFireSideEffects, detachTagAndFireSideEffects } from '../friends/friend-tag-attach/index.js';
import { buildMessage } from '../../services/line-message.js';

/**
 * 受け付けてよいかを見る。断る理由があれば、利用者に見せる文言を返す。
 *
 * 並びは「安いものから」。日付の比較 → 数の比較 → DBを読む判定、の順に
 * 置いて、断るとわかっている回答でDBを余計に読まないようにしている。
 */
export async function checkFormGates(input: FormGateInput): Promise<string | null> {
  const { db, formId, layout, friendId, submitCount, answers } = input;
  const options = layout.options ?? {};
  const now = input.now ?? new Date();
  if (input.layout.options.researchGate && !input.resumeSavedAnswer) {
    const problem = await researchGateProblem(input.db, input.layout.options.researchGate, input.friendId, now);
    if (problem) return problem;
  }
  const isTest = input.isTest === true;

  // 回答期限
  if (options.deadline?.enabled && options.deadline.endsAt) {
    const endsAt = parseJstDateTime(options.deadline.endsAt);
    if (endsAt && now.getTime() > endsAt.getTime()) {
      return options.deadline.message || 'このフォームの回答期限は終了しました';
    }
  }

  // 全体の受付上限（試しは枠を消費しないので見ない）
  if (!isTest && !input.resumeSavedAnswer && options.totalLimit?.enabled && typeof options.totalLimit.max === 'number') {
    if (submitCount >= options.totalLimit.max) {
      return options.totalLimit.message || 'このフォームは受付を終了しました';
    }
  }

  // 入力そのものの検証（必須・入力制限・選択数）
  const invalid = input.resumeSavedAnswer ? null : validateAnswers(layout, answers);
  if (invalid) return invalid;

  // 1人1回（試しは本物の回答歴に数えず、試し同士でも縛らない）
  if (!isTest && !input.resumeSavedAnswer && options.oncePerFriend?.enabled) {
    const already = await countFormSubmissionsByFriend(db, formId, friendId);
    if (already > 0) {
      return options.oncePerFriend.message || 'このフォームは、お一人さま1回までです';
    }
  }

  // 選択肢の定員（試しは枠を消費しないので見ない）
  if (!isTest && !input.resumeSavedAnswer) {
    const full = await findFullChoice(db, formId, layout, answers);
    if (full) return `「${full}」は定員に達しました`;
  }

  return null;
}

/** 全体上限・選択肢定員のうち、原子的に確保すべき1枠。 */
export interface FormCapacitySlot {
  /** `form_capacity_claims.slot_key`。全体は固定値、選択肢は `choice:ブロック名:ラベル`。 */
  key: string;
  limit: number;
  choice?: { fieldName: string; label: string; isOther: boolean; labels: string[] };
  /** 確保できなかったときに利用者へ見せる文言。 */
  message: string;
}

/** 全体上限のキー。他のフォーム内容と衝突しない固定値。 */
export const FORM_TOTAL_LIMIT_SLOT_KEY = '__total__';

/**
 * この回答が原子的に確保すべき枠を列挙する。
 *
 * `checkFormGates` の全体上限・選択肢定員の判定は「数えてから比べる」
 * だけで、同時に来た別の回答との間に隙間がある。ここで列挙した枠を
 * `claimFormCapacitySlot` で1つずつ条件付き INSERT すれば、同時に来ても
 * 定員ぶんしか勝てない。
 *
 * `checkFormGates` と同じ判定条件(enabled・limit の型)を使う。
 * 対象が無ければ空配列を返す(ほとんどの回答はここに来ない)。
 */
export function collectCapacitySlots(layout: FormLayout, answers: FormAnswers): FormCapacitySlot[] {
  const slots: FormCapacitySlot[] = [];
  const options = layout.options ?? {};

  if (options.totalLimit?.enabled && typeof options.totalLimit.max === 'number') {
    slots.push({
      key: FORM_TOTAL_LIMIT_SLOT_KEY,
      limit: options.totalLimit.max,
      message: options.totalLimit.message || 'このフォームは受付を終了しました',
    });
  }

  for (const block of collectReachableInputs(layout, answers)) {
    if (!hasChoices(block)) continue;
    const limited = (block.choices ?? []).filter(
      (c) => c.capacity?.enabled && typeof c.capacity.limit === 'number',
    );
    if (limited.length === 0) continue;

    const selected = toLabels(answers[block.name]);
    for (const choice of limited) {
      if (!formChoiceIsSelected(block, choice, selected)) continue;
      slots.push({
        key: `choice:${block.name}:${choice.label}`,
        limit: choice.capacity!.limit!,
        choice: { fieldName: block.name, label: choice.label, isOther: !!choice.isOther, labels: (block.choices ?? []).map(c => c.label) },
        message: `「${choice.label}」は定員に達しました`,
      });
    }
  }

  return slots;
}

/**
 * 期限の文字列を、日本時間として読む。
 *
 * 管理画面の日時入力は `2026-08-31T23:59` の形で、時差を持たない。これを
 * そのまま `new Date` に渡すと、動いている場所の時差で解釈される。
 * Workers は UTC で動くので、日本時間のつもりで入れた期限が9時間ずれて、
 * 締め切ったはずのフォームが翌朝まで開いたままになる。
 *
 * 時差が書いてある文字列（`Z` や `+09:00`）は、そのまま信じる。
 */
export function parseJstDateTime(value: string): Date | null {
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(value);
  const normalized = hasZone ? value : `${value.length === 16 ? value : value.slice(0, 16)}:00+09:00`;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** 定員が埋まっている選択肢が選ばれていれば、そのラベルを返す。 */
async function findFullChoice(
  db: D1Database,
  formId: string,
  layout: FormLayout,
  answers: FormAnswers,
): Promise<string | null> {
  for (const block of collectReachableInputs(layout, answers)) {
    if (!hasChoices(block)) continue;
    const limited = (block.choices ?? []).filter(
      (c) => c.capacity?.enabled && typeof c.capacity.limit === 'number',
    );
    if (limited.length === 0) continue;

    const selected = toLabels(answers[block.name]);
    const target = limited.filter((c) => formChoiceIsSelected(block, c, selected));
    if (target.length === 0) continue;

    const usage = await countChoiceUsage(db, formId, block.name);
    for (const choice of target) {
      const used = usage.get(choice.label) ?? 0;
      if (used >= (choice.capacity?.limit ?? 0)) return choice.label;
    }
  }
  return null;
}

function toLabels(value: unknown): string[] {
  if (value === undefined || value === null || value === '') return [];
  return Array.isArray(value) ? value.map(String) : [String(value)];
}

/** 回答を1つの文字列にする。情報欄も本名も、入るのは文字列1本なので。 */
function toText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return value.map(String).join(', ');
  return String(value);
}

// ---------------------------------------------------------------------------
// 送信後の処理
// ---------------------------------------------------------------------------

/**
 * メッセージを送る手段。route 側から渡す。テストでは差し替える。
 * stableSuffix は再開時の再送でも同じ値になる送信の識別子で、LINE の
 * 再送キーに使い分ける(連番にすると再開時にずれて二重送信になる)。
 */
export type PushText = (text: string, stableSuffix: string) => Promise<void>;
/** 組み立て済みのメッセージ(Flex等)を送る手段。pushText と同じ再送キー規則。 */
export type PushMessage = (message: Message, stableSuffix: string) => Promise<void>;

export interface FormEffectInput {
  db: D1Database;
  layout: FormLayout;
  friendId: string;
  answers: FormAnswers;
  /** 解決失敗の台帳に残す出所（フォームID）。無いときは回答IDを使う */
  formId?: string;
  env?: Env['Bindings'];
  /** タグ付与に伴うシナリオの即時配信で使う */
  push?: { defaultAccessToken: string; workerUrl?: string };
  /** テキスト送信・テンプレート送信で使う。無ければその動作は飛ばす */
  pushText?: PushText;
  /**
   * Flex などテキスト以外のメッセージ送信で使う。send_template で
   * 非テキストのテンプレートが選ばれたとき、ここが無いと「送れない」を
   * 失敗として記録する(黙って素通りしない)。
   */
  pushMessage?: PushMessage;
  /**
   * 回答送信の再開時に二重登録を避ける接頭辞。例: `form-submit:<answerId>`。
   * 付けるとリマインダ登録に安定した sourceEventId を付けて重複を避ける。
   */
  idempotencyPrefix?: string;
  /**
   * 効果の実行前–完了の掛け金。再開時は終わった効果を飛ばし、終わった
   * 効果だけを記録する(部分失敗の補完)。返さない・投げない hook は
   * 効果を未完のままにしないこと。hook が投げた失敗は握らず、そのまま
   * 呼び出し元へ返す(予約の所有者を失った合図など)。
   */
  skipEffect?: (effectId: string) => boolean;
  onEffectComplete?: (
    effectId: string,
    stats: { attempted: number; succeeded: number; failed: number },
  ) => Promise<void>;
}

export interface FormDestinationWriteStats {
  attempted: number;
  succeeded: number;
  failed: number;
}

export interface FormEffectResult {
  destinationWrites: FormDestinationWriteStats;
  /**
   * 失敗して欠落した工程の名前。空ならすべて完了。
   * route は空でないとき工程完了にせず、同じ送信の再送で補完する。
   */
  failedEffects: string[];
}

/**
 * 回答を配る。
 *
 * 途中で失敗しても後ろを続ける。1つの動作の失敗が、他の動作を巻き込んで
 * 全部落とすのが一番困る（タグは付いたのにシナリオが動かない、が
 * 分からなくなる）。失敗した工程の名前は failedEffects に残す。
 */
export async function applyFormLayoutEffects(input: FormEffectInput): Promise<FormEffectResult> {
  const { db, layout, friendId, answers } = input;
  const destinationWrites: FormDestinationWriteStats = { attempted: 0, succeeded: 0, failed: 0 };
  const failedEffects: string[] = [];

  for (const block of collectReachableInputs(layout, answers)) {
    const value = answers[block.name];
    if (value === undefined) continue;

    await runEffectStep(input, failedEffects, destinationWrites, `destinations:${block.id}`, () => {
      if ((!block.destinations && !fixedFieldForBlock(block)) || isFormAnswerEmpty(value)) return Promise.resolve();
      return writeFormDestinationsOnce({
      db, friendId, sourceKey: input.idempotencyPrefix, blockId: block.id, stats: destinationWrites,
      write: (ownedDb, stats) => writeDestinations(ownedDb, block, value, friendId, stats, input.formId),
      });
    });

    if (hasChoices(block)) {
      await runEffectStep(input, failedEffects, destinationWrites, `choices:${block.id}`, () =>
        runChoiceEffects(input, block, value, destinationWrites, failedEffects));
    }

    if (block.type === 'date' && block.reminder?.reminderId) {
      await runEffectStep(input, failedEffects, destinationWrites, `reminder:${block.id}`, () => {
        // 未回答・暦に無い日付では予定を作らない。失敗ではなく「何もしない」
        // で工程を終える(空のまま登録予定を作っても、届くものが無いため)。
        const dateText = toText(value);
        if (!isCalendarDateString(dateText)) return Promise.resolve();
        // 同じリマインダを別の日付欄にも割り当てた場合、欄ごとに別の予定と
        // して扱う(記録キーにブロックIDを含める)。欄をまたいだ重複除去はしない。
        return enrollFormReminderOnce(input, block.reminder!.reminderId, dateText, `reminder:${block.id}`);
      });
    }
  }

  const afterActions = layout.options?.afterActions ?? [];
  for (let index = 0; index < afterActions.length; index += 1) {
    const action = afterActions[index];
    await runEffectStep(input, failedEffects, destinationWrites, `afterAction:${index}`, () =>
      runFormAction(input, action, destinationWrites, index, `afterAction:${index}`));
    if (action.kind === 'research_action' && action.onFailure === 'stop' && failedEffects.includes(`afterAction:${index}`)) break;
  }

  return { destinationWrites, failedEffects };
}

/**
 * layout の後処理が進める内側の工程 id の一覧。
 *
 * `applyFormLayoutEffects` は工程ごとに `layout:<id>` という記録を残す。
 * 回答とレイアウトから「あるべき工程」をここで組み立て、予約(claim)の
 * 記録に無いものが未完=失敗/中断の工程になる。実際に進める順番と同じ
 * 順で返す。
 */
export function layoutEffectStepIds(layout: FormLayout, answers: FormAnswers): string[] {
  const ids: string[] = [];
  for (const block of collectReachableInputs(layout, answers)) {
    if (answers[block.name] === undefined) continue;
    ids.push(`destinations:${block.id}`);
    if (hasChoices(block)) ids.push(`choices:${block.id}`);
    if (block.type === 'date' && block.reminder?.reminderId) {
      ids.push(`reminder:${block.id}`);
    }
  }
  (layout.options?.afterActions ?? []).forEach((_, index) => ids.push(`afterAction:${index}`));
  return ids;
}

/**
 * 効果を1件実行する。再開時は終わった効果を飛ばし、終わった効果の集計
 * だけを hook へ渡す。内側で握られた失敗(選択肢ごとの動作など)も、この
 * 効果の未完として扱い、再送で補完できるようにする。hook の失敗だけは
 * 握らず呼び出し元へ返す。
 */
async function runEffectStep(
  input: FormEffectInput,
  failed: string[],
  stats: FormDestinationWriteStats,
  effectId: string,
  run: () => Promise<unknown>,
): Promise<void> {
  if (input.skipEffect?.(effectId)) return;
  const beforeFailed = stats.failed;
  const beforeInnerFailed = failed.length;
  const before = { attempted: stats.attempted, succeeded: stats.succeeded, failed: stats.failed };
  try {
    await run();
  } catch (err) {
    failed.push(effectId);
    logger.error("services_form_layout_effects_failed");
    return;
  }
  if (failed.length > beforeInnerFailed || stats.failed > beforeFailed) {
    // 内側の動作が欠けたまま終わった。再開時に補完するため未完に残す。
    if (!failed.includes(effectId)) failed.push(effectId);
    logger.error("services_form_layout_effects_failed");
    return;
  }
  await input.onEffectComplete?.(effectId, {
    attempted: stats.attempted - before.attempted,
    succeeded: stats.succeeded - before.succeeded,
    failed: stats.failed - before.failed,
  });
}

async function runTracked(failed: string[], label: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (err) {
    failed.push(label);
    logger.error("services_form_layout_effects_failed");
  }
}

/**
 * リマインダの登録。二重登録を避けるため、接頭辞があるときは安定した
 * 登録元idを付けて既存を確認してから登録する(再開時の再実行に備える)。
 */
async function enrollFormReminderOnce(
  input: FormEffectInput,
  reminderId: string,
  targetDate: string,
  keySuffix?: string,
): Promise<void> {
  const { db, friendId } = input;
  const sourceEventId = input.idempotencyPrefix
    ? `${input.idempotencyPrefix}:${keySuffix ?? `reminder:${reminderId}`}`
    : null;
  if (sourceEventId) {
    const existing = await db
      .prepare(
        `SELECT 1 AS found FROM friend_reminders
         WHERE friend_id = ? AND reminder_id = ? AND source_event_id = ? LIMIT 1`,
      )
      .bind(friendId, reminderId, sourceEventId)
      .first<{ found: number }>();
    if (existing?.found) return;
  }
  await enrollFriendInReminder(db, {
    friendId,
    reminderId,
    targetDate,
    sourceEventId,
  }).then(() => undefined);
}

/**
 * 回答の登録先へ書く。
 *
 * ECが正の情報欄には書かない。フォームの回答で上書きしても、次のEC同期で
 * 戻り、入れたはずの値が消えたように見えるため。
 */
async function writeDestinations(
  db: D1Database,
  block: FormInputBlock,
  value: unknown,
  friendId: string,
  stats: FormDestinationWriteStats,
  formId?: string,
): Promise<void> {
  const dest = block.destinations;
  const fixedKey = fixedFieldForBlock(block);
  if (!dest && !fixedKey) return;
  // 未回答（空文字・空白だけ・空の選択肢）は「更新しない」。
  // 空欄を登録先へ流すと空文字での上書き＝既存の登録を消してしまうため、
  // 書き込みを始める前にここで止める。明示的に消す操作は設けない。
  if (isFormAnswerEmpty(value)) return;
  const text = formatAnswerValue(block, value);

  if (fixedKey) {
    await trackDestinationWrite(stats, 1, async () => {
      const target = await getFixedFriendField(db, fixedKey);
      if (!target) throw new Error('fixed friend field mapping missing');
      const fixedValue = fixedKey === 'address' ? formatAddressValue(value) : fixedKey === 'allergy' && Array.isArray(value) ? JSON.stringify(value) : text;
      await setFriendFieldValue(db, {
        friendId, fieldId: target.id, value: fixedValue, updatedBy: 'form',
        field: target, ...(formId ? { sourceType: 'form', sourceId: formId } : {}),
      });
      return true;
    });
  }

  for (const fieldId of dest?.friendFieldIds ?? []) {
    // 書けない相手(EC正・削除済み)は数えない。数えると「失敗」になり、
    // 再送しても直らない工程が未完のまま残る。
    const target = await getFriendFieldById(db, fieldId);
    if (!target || target.ec_is_master === 1) continue;
    await trackDestinationWrite(stats, 1, async () => {
      // 生の回答を項目の型で検証し、正規化した値を保存する。
      // toText で先に文字列化すると、multi_select の正しい選択まで
      // 1つの文字列として弾かれるので、配列のまま検証する。
      const rawForCheck = Array.isArray(value) && target.type === 'multi_select' ? value : text;
      const checked = validateFriendFieldValue(target, rawForCheck);
      if (!checked.ok) throw new Error(`invalid friend field value: ${checked.error}`);
      await setFriendFieldValue(db, {
        friendId,
        fieldId,
        value: checked.value,
        updatedBy: 'form',
        field: target,
        ...(formId ? { sourceType: 'form', sourceId: formId } : {}),
      });
      return true;
    });
  }

  const columns: string[] = [];
  const values: string[] = [];
  if (dest?.realName && fixedKey !== 'name') {
    columns.push('real_name = ?');
    values.push(text);
  }
  if (dest?.displayName) {
    columns.push('system_display_name = ?');
    values.push(text);
  }
  if (dest?.note && text !== '') {
    // 受信箱の既存メモを残して回答を追記する。担当・対応状況・受信日時は動かさない。
    await trackDestinationWrite(stats, 1, async () => {
      const now = jstNow();
      await db.prepare(`INSERT INTO chats (id, friend_id, notes, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(friend_id) DO UPDATE SET
          notes = CASE WHEN COALESCE(TRIM(chats.notes), '') = '' THEN excluded.notes
            ELSE chats.notes || char(10) || excluded.notes END,
          updated_at = excluded.updated_at, revision = chats.revision + 1`)
        .bind(crypto.randomUUID(), friendId, text, now, now).run();
      return true;
    });
  }
  if (columns.length === 0 || text === '') return;

  await trackDestinationWrite(stats, columns.length, async () => {
    await db
      .prepare(`UPDATE friends SET ${columns.join(', ')}, updated_at = ? WHERE id = ?`)
      .bind(...values, jstNow(), friendId)
      .run();
    return true;
  });
}

async function trackDestinationWrite(
  stats: FormDestinationWriteStats,
  count: number,
  write: () => Promise<boolean>,
): Promise<void> {
  stats.attempted += count;
  try {
    if (await write()) stats.succeeded += count;
    else stats.failed += count;
  } catch (error) {
    stats.failed += count;
    logger.error("services_form_layout_effects_failed");
  }
}

/** 選ばれた選択肢の動作を実行する。 */
async function runChoiceEffects(
  input: FormEffectInput,
  block: FormInputBlock,
  value: unknown,
  stats: FormDestinationWriteStats,
  failed: string[],
): Promise<void> {
  const selected = toLabels(value);
  if (selected.length === 0) return;

  const chosen = (block.choices ?? []).filter((c) => formChoiceIsSelected(block, c, selected));
  for (const choice of chosen) {
    if (input.layout.options.researchGate && choice.tapExtras) {
      if (!input.idempotencyPrefix) throw new Error('回答の受付番号を確認できませんでした');
      const friend = await input.db.prepare('SELECT line_account_id FROM friends WHERE id=?').bind(input.friendId).first<{line_account_id: string | null}>();
      if (!friend?.line_account_id) throw new Error('回答者のアカウントを確認できませんでした');
      await applyTapExtras(input.db, input.friendId, friend.line_account_id, choice.tapExtras, `${input.idempotencyPrefix}:research:${block.id}:${choice.id}`);
    }
    switch (block.choiceMode) {
      case 'tag':
        await applyChoiceTag(input, choice);
        break;
      case 'friendField':
        await applyChoiceFriendField(input, block, choice, stats);
        break;
      case 'action': {
        const actions = choice.actions ?? [];
        for (let actionIndex = 0; actionIndex < actions.length; actionIndex += 1) {
          const action = actions[actionIndex];
          const actionLabel = `choiceAction:${block.id}:${choice.id}:${actionIndex}`;
          await runTracked(failed, actionLabel, () =>
            runFormAction(input, action, stats, undefined, actionLabel));
        }
        break;
      }
      default:
        // 動作を決めていない選択肢は、回答として残すだけ
        break;
    }
  }
}

async function applyChoiceTag(input: FormEffectInput, choice: FormChoice): Promise<void> {
  if (!choice.tagId) return;
  await attachTagAndFireSideEffects(
    input.db,
    input.friendId,
    choice.tagId,
    input.push
      ? { defaultAccessToken: input.push.defaultAccessToken, workerUrl: input.push.workerUrl }
      : undefined,
  );
}

async function applyChoiceFriendField(
  input: FormEffectInput,
  block: FormInputBlock,
  choice: FormChoice,
  stats: FormDestinationWriteStats,
): Promise<void> {
  const fieldId = block.choiceFriendFieldId;
  if (!fieldId) return;
  // 書けない相手は数えない(再送しても直らない未完にしない)。
  const target = await getFriendFieldById(input.db, fieldId);
  if (!target || target.ec_is_master === 1) return;
  await trackDestinationWrite(stats, 1, async () => {
    // 値を書いていない選択肢は、ラベルをそのまま入れる
    const value = choice.value && choice.value !== '' ? choice.value : choice.label;
    // 選択肢の値も項目の型で検証する。合わなければ保存せず
    // 失敗に数える(設定側の直しが必要なため、黙って通さない)。
    const checked = validateFriendFieldValue(target, value);
    if (!checked.ok) throw new Error(`invalid friend field value: ${checked.error}`);
    await setFriendFieldValue(input.db, {
      friendId: input.friendId,
      fieldId,
      value: checked.value,
      updatedBy: 'form',
      field: target,
    });
    return true;
  });
}

/**
 * 1つの動作を実行する。pushSuffix は送信の安定した識別子で、再開時の
 * 再送でも同じ値になるものを呼ぶ側が渡す(省略時は動作の種類で代用する)。
 */
export async function runFormAction(
  input: FormEffectInput,
  action: FormAction,
  destinationWrites?: FormDestinationWriteStats,
  actionIndex?: number,
  pushSuffix?: string,
): Promise<void> {
  const { db, friendId } = input;

  switch (action.kind) {
    case 'research_action': {
      const friend = await db.prepare('SELECT line_account_id FROM friends WHERE id=?').bind(friendId).first<{ line_account_id: string | null }>();
      if (!friend?.line_account_id) throw new Error('回答者のアカウントを確認できませんでした');
      await validateResearchActionScope(db, action, friend.line_account_id);
      if (action.actionType === 'tag') {
        const ids = Array.isArray(action.config.tagIds) ? action.config.tagIds.map(String) : [];
        if (action.config.folderId) {
          const rows = await db.prepare("SELECT id FROM tags WHERE folder_id=? AND (line_account_id=? OR line_account_id IS NULL) AND status='active'").bind(action.config.folderId,friend.line_account_id).all<{id:string}>();
          ids.push(...rows.results.map(row => row.id));
        }
        await runFormAction(input, {kind:'tag',op:action.config.op==='remove'?'remove':'add',tagIds:[...new Set(ids)]},destinationWrites,actionIndex,pushSuffix);
        return;
      }
      if (action.actionType === 'send_message' || action.actionType === 'send_template' || action.actionType === 'reminder') {
        if (action.actionType !== 'reminder' && !input.pushText) throw new Error('回答後の送信を利用できません');
        if (action.actionType === 'send_template') {
          const template = await getTemplateById(db, String(action.config.templateId));
          if(template?.message_bubbles_json) throw new Error('MULTIPLE_MESSAGES_REQUIRE_BUNDLE_SENDER');
          if (!template || !template.published_version) throw new Error('公開済みのテンプレートを選んでください');
          const { expandSendCommonVars } = await import('../../services/interpolation-context.js');
          const content = await expandSendCommonVars(db, template.message_content, { kind: 'form_reply', id: input.formId ?? friendId }, { friendId, messageType: template.message_type });
          if (template.message_type === 'text') await input.pushText!(content, pushSuffix ?? `research-template:${template.id}`);
          else {
            if (!input.pushMessage) throw new Error('回答後の送信を利用できません');
            await input.pushMessage(buildMessage(template.message_type, content, template.name), pushSuffix ?? `research-template:${template.id}`);
          }
          return;
        }
        const mapped: FormAction = action.actionType === 'send_message' ? { kind: 'send_text', text: String(action.config.content ?? '') }

          : { kind: 'reminder', reminderId: String(action.config.reminderId ?? '') };
        await runFormAction(input, mapped, destinationWrites, actionIndex, pushSuffix);
        return;
      }
      await runResearchAnswerAction(input.db, action, input.friendId, `${input.idempotencyPrefix ?? input.formId}:${pushSuffix ?? actionIndex}`, input.env);
      return;
    }
    case 'send_text':
      if (input.pushText && action.text) {
        const { expandSendCommonVars } = await import('../../services/interpolation-context.js');
        const text = await expandSendCommonVars(
          db, action.text,
          { kind: 'form_reply', id: input.formId ?? input.idempotencyPrefix ?? friendId },
          { friendId },
        );
        await input.pushText(text, pushSuffix ?? `send_text:${action.text}`);
      }
      return;

    case 'send_template': {
      if (!input.pushText || !action.templateId) return;
      const template = await getMessageTemplateById(db, action.templateId);
      if (!template) return;
      // テキストは従来どおり本文をそのまま送る。Flex などそれ以外は
      // 配信側と同じ組み立て(buildMessage)を通して実際に送る。
      // 選んだ非テキストのテンプレートも配信対象なので、組み立てて送信する。
      // テンプレートが顧客にも運用にも見えず届かなかった。
      // {{var.*}} の共通情報は消えていれば fail-closed で止め、
      // 解決できるものは送信時点の値へ置き換える。
      const { expandSendCommonVars } = await import('../../services/interpolation-context.js');
      const content = await expandSendCommonVars(
        db, template.message_content,
        { kind: 'form_reply', id: input.formId ?? input.idempotencyPrefix ?? friendId },
        { friendId, messageType: template.message_type },
      );
      if (template.message_type === 'text') {
        if (content) {
          await input.pushText(content, pushSuffix ?? `send_template:${action.templateId}`);
        }
        return;
      }
      if (!input.pushMessage) {
        // 送信経路が無いのに黙って終わると、届かないことが誰にも分からない。
        // 工程の失敗として記録し、再実行で補完できるようにする。
        throw new Error(`form send_template: no push channel for ${template.message_type} template`);
      }
      await input.pushMessage(
        buildMessage(template.message_type, content, template.name),
        pushSuffix ?? `send_template:${action.templateId}`,
      );
      return;
    }

    case 'tag':
      for (const tagId of action.tagIds ?? []) {
        if (action.op === 'remove') {
          await detachTagAndFireSideEffects(db, friendId, tagId, input.idempotencyPrefix ? `${input.idempotencyPrefix}:${pushSuffix ?? actionIndex}:remove:${tagId}` : undefined);
        } else {
          await attachTagAndFireSideEffects(
            db,
            friendId,
            tagId,
            input.push
              ? { defaultAccessToken: input.push.defaultAccessToken, workerUrl: input.push.workerUrl }
              : undefined,
          );
        }
      }
      return;

    case 'friend_field': {
      if (!action.fieldId) return;
      // 書けない相手は数えない(再送しても直らない未完にしない)。
      const target = await getFriendFieldById(db, action.fieldId);
      if (!target || target.ec_is_master === 1) return;
      const write = async () => {
        // 動作の値も項目の型で検証する。合わなければ保存しない。
        const checked = validateFriendFieldValue(target, action.value ?? '');
        if (!checked.ok) throw new Error(`invalid friend field value: ${checked.error}`);
        await setFriendFieldValue(db, {
          friendId,
          fieldId: action.fieldId!,
          value: checked.value,
          updatedBy: 'form',
          field: target,
        });
        return true;
      };
      if (destinationWrites) await trackDestinationWrite(destinationWrites, 1, write);
      else await write();
      return;
    }

    case 'scenario':
      if (!action.scenarioId) return;
      if (action.op === 'stop') {
        // 止め方はシナリオ側の動作と同じにそろえる（'paused'）。ここだけ
        // 別の値を書くと、再開の導線から外れて戻せなくなる。
        await db
          .prepare(
            `UPDATE friend_scenarios SET confirmation_revision = confirmation_revision + 1, status = 'paused', updated_at = ?
             WHERE friend_id = ? AND scenario_id = ? AND status IN ('active','delivering')`,
          )
          .bind(jstNow(), friendId, action.scenarioId)
          .run();
        return;
      }
      await runScenarioOp(db, friendId, '', { op: 'start', scenarioId: action.scenarioId }, input.idempotencyPrefix ? `${input.idempotencyPrefix}:${pushSuffix ?? actionIndex}` : undefined);
      return;

    case 'reminder': {
      if (!action.reminderId) return;
      const reminderLabel = actionIndex === undefined
        ? `reminder:action:${action.reminderId}`
        : `reminder:afterAction:${actionIndex}`;
      // 起点の日付を持たない動作なので、今日から動かす
      await enrollFormReminderOnce(
        input,
        action.reminderId,
        jstNow().slice(0, 10),
        reminderLabel,
      );
      return;
    }

    default:
      return;
  }
}
