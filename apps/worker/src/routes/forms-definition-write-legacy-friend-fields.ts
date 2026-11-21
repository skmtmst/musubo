import { logger } from '@line-crm/shared/server';
import { hasDeliveryAccess } from '@line-crm/shared';
import { formatAddressValue, type FormLayout } from '@line-crm/shared';
import { parseFormFields } from './form-field-definition.js';
import { patchFriendMetadata } from '../features/friends/friend-metadata/index.js';
import { writeFormDestinationsOnce } from '../features/forms/form-destination-workflow/index.js';
import { type MiddlewareHandler } from 'hono';
import { getFormAccountIds, getFormSubmissionById, updateFormSubmissionDestinationWriteResult, getFriendById, jstNow } from '@line-crm/db';
import { enrollFriendInScenario } from '@line-crm/db';
import type { Form as DbForm, FormSubmission as DbFormSubmission, FormDestinationWriteResult } from '@line-crm/db';
import { applyMileageRulesForEvent } from '@line-crm/db';
import { fail } from '../lib/fail.js';
import { attachTagAndFireSideEffects } from '../features/friends/friend-tag-attach/index.js';
import { pushViaHarnessProxy } from '../services/line-proxy-send.js';
import { dispatchLineProxyLocally } from '../services/local-line-proxy.js';


import type { Env } from '../worker-env.js';
import { canAccessAllLineAccounts } from '../services/account-access.js';

import { dispatchAutomationEventWithLogging } from '../features/automations/automation-triggers/index.js';
import { applyFormLayoutEffects } from '../features/forms/form-layout-effects/index.js';


import { requireFormManage, resolveFriendAccessToken, displayAnswerValue, ClaimOwnershipLost } from './forms-definition-stopped-public-form-response.js';

export async function writeLegacyFriendFields(
  db: D1Database,
  form: DbForm,
  submissionData: Record<string, unknown>,
  friendId: string,
): Promise<FormDestinationWriteResult> {
  const result: FormDestinationWriteResult = { attempted: 0, succeeded: 0, failed: 0 };
  const targets = parseFormFields(form.fields).filter((field) => field.friendFieldId);
  if (targets.length === 0) return result;
  const { setFriendFieldValue, getFriendFieldById, validateFriendFieldValue } = await import('@line-crm/db');
  for (const field of targets) {
    const answer = submissionData[field.name ?? field.id ?? ''];
    if (answer === undefined) continue;
    result.attempted += 1;
    try {
      const target = await getFriendFieldById(db, field.friendFieldId!);
      if (!target || target.ec_is_master === 1) {
        result.failed += 1;
        continue;
      }
      // 回答を項目の型で検証し、正規化した値を保存する。
      // multi_select の配列回答は配列のまま検証する(先に文字列化すると
      // 正しい選択まで1つの文字列として弾かれる)。型に合わなければ
      // 保存せず失敗に数える。
      const rawForCheck = Array.isArray(answer) && target.type === 'multi_select'
        ? answer
        : answer == null
          ? null
          : Array.isArray(answer)
            ? answer.join(', ')
            : typeof answer === 'object'
              ? formatAddressValue(answer)
              : String(answer);
      const checked = validateFriendFieldValue(target, rawForCheck);
      if (!checked.ok) {
        result.failed += 1;
        logger.error("forms.write_legacy_friend_fields_failed");
        continue;
      }
      await setFriendFieldValue(db, {
        friendId,
        fieldId: field.friendFieldId!,
        value: checked.value,
        updatedBy: 'form',
        field: target,
      });
      result.succeeded += 1;
    } catch (error) {
      result.failed += 1;
      logger.error("forms.write_legacy_friend_fields_failed");
    }
  }
  return result;
}

export /** 本文の解析より前に保管・保管解除の管理権限を確認する。 */
const requireArchiveManage: MiddlewareHandler<Env> = async (c, next) => {
  if (!hasDeliveryAccess(c.get('staff'), 'forms', 'archive')) return c.json({ success: false, error: '保管には管理者権限が必要です' }, 403);
  try {
    if (!c.req.query('account_id')?.trim()) return fail(c, 400, 'ACCOUNT_ID_REQUIRED', {}, ['account_id']);
    const accountIds = await getFormAccountIds(c.env.DB, c.req.param('id')!);
    const gate = await requireFormManage(c, accountIds);
    if (gate) return gate;
    if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [c.req.query('account_id')!.trim()])) {
      return fail(c, 404, 'NOT_FOUND');
    }
    if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), accountIds)) {
      return c.json({ success: false, error: 'すべての利用先を確認する権限がありません' }, 403);
    }
    await next();
  } catch (error) {
    logger.error("forms.require_archive_manage_failed");
    return c.json({ success: false, error: '回答フォームの権限を確認できませんでした' }, 503);
  }
};

export /**
 * 予約(claim)への工程記録の窓口。
 *
 * 送信処理と管理画面からの再実行で同じ約束をする:
 *   done        … 記録済みの工程か(再開・再実行で飛ばす判定)
 *   checkpoint  … 工程を記録する。所有者を失ったら ClaimOwnershipLost
 *   recordLayoutEffect … layout の効果ごとの集計を残し、その工程を記録する
 *   settle      … 予約の締め。未完の工程名を返す
 */
interface FormSubmitClaimHandle {
  done(step: string): boolean;
  checkpoint(step: string): Promise<void>;
  readLayoutStats(): Promise<Record<string, { attempted: number; succeeded: number; failed: number }>>;
  recordLayoutEffect(
    effectId: string,
    merged: { attempted: number; succeeded: number; failed: number },
  ): Promise<void>;
  settle(required: string[]): Promise<string[]>;
}

export /**
 * 回答の保存後に進める後処理一式。
 *
 * 送信受付(POST /submit)と、管理画面からの失敗分だけの再実行
 * (POST /submissions/:sid/retry-effects)が同じ道を通る。予約の工程記録に
 * ある工程は飛ばすので、完了済みの工程を二重実行しない。
 * 未完の工程名を返す(空なら全部終わった)。
 */
async function runFormPostEffects(input: {
  db: D1Database;
  formId: string;
  form: {
    name: string;
    fields: string | null;
    save_to_metadata: number;
    on_submit_tag_id: string | null;
    on_submit_scenario_id: string | null;
    on_submit_message_type: 'text' | 'flex' | null;
    on_submit_message_content: string | null;
    on_submit_webhook_url: string | null;
  };
  expectedLineAccountId: string;
  layout: FormLayout | null;
  friendId: string;
  submissionData: Record<string, unknown>;
  submission: DbFormSubmission;
  webhookData: Record<string, unknown> | null;
  trackedLinkId: string | null;
  claim: FormSubmitClaimHandle | null;
  /** LINE 送信の再送キー。工程名から安定した UUID を作る。 */
  lineRetryKey: (step: string) => Promise<string>;
  origin: string;
  defaultAccessToken: string;
  workerUrl: string | undefined;
  env: Env['Bindings'];
  executionCtx: ExecutionContext | undefined;
}): Promise<string[]> {
  const { db, form, layout, friendId, submissionData, submission, webhookData } = input;
  const claim = input.claim;
  const now = jstNow();
  const done = (step: string) => claim?.done(step) ?? false;
  let registrationsReady = true;

  if (!done('mileage')) {
    // 付与の呼び出しは失敗を握らない。DB が落ちていれば投げて、
    // 工程未完のまま回答は返し、同じキーでの再送・再実行で付け直す。
    // (台帳は program+key の一意性で二重付与しない)
    let awarded = false;
    try {
      await applyMileageRulesForEvent(db, {
        eventType: 'form_submitted',
        source: 'form',
        sourceEventId: submission.id,
        friendId,
        subjectKey: input.formId,
        metadata: { formId: input.formId, formName: form.name },
        occurredAt: submission.created_at,
      });
      awarded = true;
    } catch (error) {
      logger.error("forms.run_form_post_effects_failed");
    }
    if (awarded && claim) await claim.checkpoint('mileage');
  }

  // キャンペーン別の報酬を使うため、回答の trackedLinkId を初回流入より優先する。未指定なら friends.first_tracked_link_id へ戻し、通常の回答後メッセージを上書きする。URL 変更による重複請求防止はここで追加せず、上流の参加条件判定に委ねる。
  let rewardTemplate: import('@line-crm/db').MessageTemplate | null = null;
  {
    const { getFriendById, getTrackedLinkById, getMessageTemplateById } = await import('@line-crm/db');
    const { resolveRewardTemplate } = await import('../services/reward-resolver.js');
    const { trackedLinkReferralMatchesAccount } = await import('../services/tracked-link-identity.js');
    rewardTemplate = await resolveRewardTemplate(
      db,
      {
        friendId,
        requestedTrackedLinkId: input.trackedLinkId,
        expectedLineAccountId: input.expectedLineAccountId,
      },
      { getFriendById, getTrackedLinkById, getMessageTemplateById, trackedLinkReferralMatchesAccount },
    );
  }

  // 副作用は工程つきで実行する。キーありの再開時は終わった工程を飛ばし、
  // 未完の工程だけを補完する。キーなし送信は従来どおりすべて実行する。
  const effectRuns: Array<{ step: string; run: () => Promise<unknown> }> = [];
  let destinationWriteResult: FormDestinationWriteResult = {
    attempted: 0,
    succeeded: 0,
    failed: 0,
  };

  // 既存の友だち情報を失わないよう、回答を metadata に結合する。
  if (form.save_to_metadata) {
    effectRuns.push({
      step: 'metadata',
      run: async () => {
        const friend = await getFriendById(db, friendId);
        if (!friend) return;
        if (!await patchFriendMetadata(db, friendId, submissionData)) throw new Error('friend_metadata_unavailable');
      },
    });
  }

  // layout を持つフォームは、こちらで回答を配る。
  //
  // 登録先（情報欄・本名・システム表示名・メモ）、選択肢ごとの
  // タグ／情報欄／動作、日付から動かすリマインダ、回答後の動作までを
  // まとめて実行する。失敗しても送信は成功のまま（保存は済んでいる）。
  if (layout) {
    // layout の効果ごとの集計。再開時は残した集計に足して合計するので、
    // 実行した分だけを数えても重ならない。
    let layoutStats: Record<string, { attempted: number; succeeded: number; failed: number }> = {};
    if (claim) layoutStats = await claim.readLayoutStats();
    const completedThisRun = { attempted: 0, succeeded: 0, failed: 0 };
    effectRuns.push({
      step: 'layout_effects',
      run: () => applyFormLayoutEffects({
        db,
        env: input.env,
        layout,
        friendId,
        answers: submissionData,
        formId: input.formId,
        formVersionId: submission.form_version_id,
        idempotencyPrefix: `form-submit:${submission.id}`,
        push: {
          defaultAccessToken: input.defaultAccessToken,
          workerUrl: input.workerUrl,
        },
        // 終わった効果は飛ばし、終わった効果だけを記録する。再開時は
        // 未完の効果だけを補完する(粗い完了扱いで欠落を固定しない)。
        skipEffect: (effectId) => done(`layout:${effectId}`),
        onEffectComplete: async (effectId, delta) => {
          if (!claim) return;
          for (const key of ['attempted','succeeded','failed'] as const) completedThisRun[key] += delta[key];
          const prev = layoutStats[effectId] ?? { attempted: 0, succeeded: 0, failed: 0 };
          const merged = {
            attempted: prev.attempted + delta.attempted,
            succeeded: prev.succeeded + delta.succeeded,
            failed: prev.failed + delta.failed,
          };
          layoutStats[effectId] = merged;
          await claim.recordLayoutEffect(effectId, merged);
        },
        pushText: async (text: string, stableSuffix: string) => {
          const target = await getFriendById(db, friendId);
          if (!target?.line_user_id) return;
          const accessToken = await resolveFriendAccessToken(
            db,
            target,
            input.defaultAccessToken,
            'forms.layout-text-send',
          );
          await pushViaHarnessProxy(
            input.origin,
            accessToken,
            target.line_user_id,
            [{ type: 'text', text }],
            await input.lineRetryKey(`layout:${stableSuffix}`),
            (request) => dispatchLineProxyLocally(request, input.env, input.executionCtx),
          );
        },
        // Flex などテキスト以外のテンプレート送信。組み立ては
        // 呼び出し側(buildMessage)が済ませてあり、ここは送信だけを受け持つ。
        pushMessage: async (message, stableSuffix) => {
          const target = await getFriendById(db, friendId);
          if (!target?.line_user_id) return;
          const accessToken = await resolveFriendAccessToken(
            db,
            target,
            input.defaultAccessToken,
            'forms.layout-message-send',
          );
          await pushViaHarnessProxy(
            input.origin,
            accessToken,
            target.line_user_id,
            [message],
            await input.lineRetryKey(`layout:${stableSuffix}`),
            (request) => dispatchLineProxyLocally(request, input.env, input.executionCtx),
          );
        },
      }).then((result) => {
        // 効果ごとの集計の合計を配分結果にする。再開時は残した集計を
        // 含むので、合計が正しくなる。
        const totals = { attempted: 0, succeeded: 0, failed: 0 };
        for (const stats of Object.values(layoutStats)) {
          totals.attempted += stats.attempted;
          totals.succeeded += stats.succeeded;
          totals.failed += stats.failed;
        }
        for (const key of ['attempted','succeeded','failed'] as const) {
          totals[key] += result.destinationWrites[key] - completedThisRun[key];
        }
        destinationWriteResult = totals;
        // 欠落した工程があれば完了にせず、再送・再実行で補完する。
        if (result.failedEffects.length > 0) {
          throw new Error(`form layout effects partial failure: ${result.failedEffects.join(',')}`);
        }
      }),
    });
  }

  // 回答を友だち情報欄へ書く。
  //
  // フォームの項目に friendFieldId を持たせておくと、その項目の回答が
  // 友だち情報欄に入る。ここが「フォーム → 情報欄 → 友だち詳細 →
  // テンプレートの差し込み」の線をつなぐ一点。
  //
  // metadata への保存とは別に持つ。metadata は形が決まっていない
  // 置き場で、情報欄は型と差し込み名を持つ。両方に入れておけば、
  // 既存の {{metadata.KEY}} を使っているテンプレートも壊れない。
  if (!layout) {
    effectRuns.push({
      step: 'legacy_fields',
      run: async () => {
        if(!parseFormFields(form.fields).some(field=>field.friendFieldId&&submissionData[field.name??field.id??'']!==undefined))return;
        await writeFormDestinationsOnce({ db, friendId, sourceKey: `form-submit:${submission.id}`, blockId: 'legacy',
          stats: destinationWriteResult,
          write: async (ownedDb, stats) => { Object.assign(stats, await writeLegacyFriendFields(ownedDb, form as DbForm, submissionData, friendId)); },
        });
      },
    });
  }

  // 顧客登録がすべて成功してから条件を評価する。再送と担当者の再試行が同じチェックポイントから回復できるようにする。
  effectRuns.push({
    step: 'automation',
    run: async () => {
      if (!registrationsReady) throw new Error('form_registration_incomplete');
      await dispatchAutomationEventWithLogging(db, {
        lineAccountId: input.expectedLineAccountId, eventType: 'form_submitted',
        sourceEventId: submission.id, friendId,
        eventData: { formId: input.formId, submissionId: submission.id },
      });
    },
  });

  // 初回付与でだけタグ起点のシナリオを動かし、重複回答で再発火しないよう共有の付与処理を通す。
  if (form.on_submit_tag_id) {
    effectRuns.push({
      step: 'tag',
      run: () => attachTagAndFireSideEffects(db, friendId, form.on_submit_tag_id!, {
        defaultAccessToken: input.defaultAccessToken,
        workerUrl: input.workerUrl,
      }),
    });
  }


  if (form.on_submit_scenario_id) {
    effectRuns.push({
      step: 'scenario',
      run: () => enrollFriendInScenario(db, friendId, form.on_submit_scenario_id!),
    });
  }

  // 参加 URL が返った場合、利用者が開けるよう Flex ボタンで案内する。
  if (webhookData?.join_url) {
    effectRuns.push({
      step: 'meet_link',
      run: async () => {
        const friend = await getFriendById(db, friendId);
        if (!friend?.line_user_id) return;
        const accessToken = await resolveFriendAccessToken(
          db,
          friend,
          input.defaultAccessToken,
          'forms.meet-link-send',
        );
        const joinUrl = String(webhookData!.join_url);
        const meetFlex = {
          type: 'bubble',
          header: {
            type: 'box', layout: 'vertical',
            contents: [
              { type: 'text', text: 'ヒアリングの準備ができました', size: 'md', weight: 'bold', color: '#1e293b' },
            ],
            paddingAll: '20px', backgroundColor: '#f0f9ff',
          },
          body: {
            type: 'box', layout: 'vertical',
            contents: [
              { type: 'text', text: 'アンケートありがとうございます。続けて短いヒアリングにご協力ください。', size: 'sm', color: '#475569', wrap: true },
            ],
            paddingAll: '20px',
          },
          footer: {
            type: 'box', layout: 'vertical',
            contents: [
              {
                type: 'button', style: 'primary', color: '#4CAF50',
                action: { type: 'uri', label: 'ヒアリングを始める', uri: joinUrl },
              },
            ],
            paddingAll: '16px',
          },
        };
        await pushViaHarnessProxy(
          input.origin,
          accessToken,
          friend.line_user_id,
          [{ type: 'flex', altText: 'ヒアリングの準備ができました', contents: meetFlex }],
          await input.lineRetryKey('meet-link'),
          (request) => dispatchLineProxyLocally(request, input.env, input.executionCtx),
        );
      },
    });
  }


  effectRuns.push({
    step: 'reply',
    run: async () => {
      // 運用ログに内部ID（friendId）は残さない。開始の事実だけ出す。
      logger.log("Form_reply_starting");
      const friend = await getFriendById(db, friendId);
      if (!friend?.line_user_id) { logger.log("Form_reply_no_LINE_recipient"); return; }
      logger.log("Form_reply_sending");
      const accessToken = await resolveFriendAccessToken(
        db,
        friend,
        input.defaultAccessToken,
        'forms.reply-send',
      );
      const { buildMessage, expandVariables } = await import('../services/step-delivery.js');
      const apiOrigin = input.origin;
      const { resolveMetadata } = await import('../services/step-delivery.js');
      const resolvedMeta = await resolveMetadata(db, friend);
      const friendData = {
        id: friend.id,
        display_name: friend.display_name,
        user_id: (friend as unknown as Record<string, string | null>).user_id,
        ref_code: (friend as unknown as Record<string, string | null>).ref_code,
        metadata: resolvedMeta,
      };


      const entries = Object.entries(submissionData as Record<string, unknown>);
      const answerRows = entries.map(([key, value]) => {
        const field = form.fields ? (JSON.parse(form.fields) as Array<{ name: string; label: string }>).find((f: { name: string }) => f.name === key) : null;
        const label = field?.label || key;
        const val = displayAnswerValue(value);
        return {
          type: 'box' as const, layout: 'vertical' as const, margin: 'md' as const,
          contents: [
            { type: 'text' as const, text: label, size: 'xxs' as const, color: '#64748b' },
            { type: 'text' as const, text: val, size: 'sm' as const, color: '#1e293b', weight: 'bold' as const, wrap: true },
          ],
        };
      });

      const resultFlex = {
        type: 'bubble', size: 'giga',
        header: {
          type: 'box', layout: 'vertical',
          contents: [
            { type: 'text', text: '診断結果', size: 'lg', weight: 'bold', color: '#1e293b' },
            { type: 'text', text: `${friend.display_name || ''}さんの回答`, size: 'xs', color: '#64748b', margin: 'sm' },
          ],
          paddingAll: '20px', backgroundColor: '#f0fdf4',
        },
        body: {
          type: 'box', layout: 'vertical',
          contents: [
            ...answerRows,
            { type: 'separator', margin: 'lg' },
            { type: 'text', text: '他社サービスでは、フォームの回答内容に合わせたリアルタイム返信はできません。musuboだからこそ可能な体験です。', size: 'xs', color: '#06C755', weight: 'bold', wrap: true, margin: 'lg' },
          ],
          paddingAll: '20px',
        },
      };

      const messages: ReturnType<typeof buildMessage>[] = [];

      const { buildRewardMessage } = await import('../services/reward-message.js');
      const rewardFromTrackedLink = buildRewardMessage(rewardTemplate, friend.display_name);

      if (rewardFromTrackedLink) {
        // キャンペーンの報酬テンプレートを、ほかの回答後メッセージより優先する。
        messages.push(rewardFromTrackedLink as ReturnType<typeof buildMessage>);
      } else if (form.on_submit_message_type && form.on_submit_message_content) {
        // 個別指定のメッセージがあれば、既定の診断結果より優先する。
        const { resolveSendInterpolationExtra } = await import('../services/interpolation-context.js');
        const extra = await resolveSendInterpolationExtra(
          db, friend.id, form.on_submit_message_content,
          { kind: 'form_reply', id: input.formId }, undefined,
          submission.form_version_id ? { kind: 'form', versionId: submission.form_version_id } : undefined,
        );
        const expanded = expandVariables(form.on_submit_message_content, friendData, apiOrigin, form.on_submit_message_type, extra);
        // 1:1 push → /t リンクに f=<friendId> を焼き込み (LIFF 識別ホップ回避)
        const { appendFriendToTrackedLinks } = await import('../services/auto-track.js');
        const decorated = await appendFriendToTrackedLinks(db, expanded, apiOrigin, friend.id);
        messages.push(buildMessage(form.on_submit_message_type, decorated));
      } else {

        messages.push(buildMessage('flex', JSON.stringify(resultFlex)));
      }

      // プロキシへ出す前に、固定元の停止と期限を再確認する。
      if (!rewardFromTrackedLink && submission.form_version_id && form.on_submit_message_type && form.on_submit_message_content) {
        const { resolveSendInterpolationExtra } = await import('../services/interpolation-context.js');
        await resolveSendInterpolationExtra(db, friend.id, form.on_submit_message_content,
          { kind: 'form_reply', id: input.formId }, undefined, { kind: 'form', versionId: submission.form_version_id });
      }
      // プロキシが LINE 送信と messages_log 記録を一体で行う。
      await pushViaHarnessProxy(
        input.origin,
        accessToken,
        friend.line_user_id,
        messages,
        await input.lineRetryKey('reply'),
        (request) => dispatchLineProxyLocally(request, input.env, input.executionCtx),
      );
    },
  });

  // 1件ずつ記録しながら進め、未完だけを残す。再開・再実行時は終わった工程を
  // 飛ばす。layout_effects だけは粗い完了で飛ばさず、内側の効果ごとの記録で
  // 補完する(粗い完了扱いでは部分失敗が再開できない)。
  for (const effect of effectRuns) {
    if (effect.step !== 'layout_effects' && done(effect.step)) continue;
    try {
      await effect.run();
    } catch (error) {
      if (error instanceof ClaimOwnershipLost) throw error;
      if (['metadata','layout_effects','legacy_fields'].includes(effect.step)) registrationsReady = false;
      logger.error("forms.run_form_post_effects_failed");
      continue;
    }
    if (claim) await claim.checkpoint(effect.step);
  }

  // 配分結果の記録。再開時に記録済みなら上書きせず、集計値を残す。
  const recordDestinationWrite = async (): Promise<void> => {
    if (claim?.done('destination_status')) {
      const current = await getFormSubmissionById(db, submission.id);
      if (current && ['succeeded','not_requested'].includes(current.destination_write_status)) return;
    }
    try {
      const status = await updateFormSubmissionDestinationWriteResult(db, submission.id, destinationWriteResult);
      submission.destination_write_status = status;
      submission.destination_write_attempted = destinationWriteResult.attempted;
      submission.destination_write_succeeded = destinationWriteResult.succeeded;
      submission.destination_write_failed = destinationWriteResult.failed;
    } catch (error) {
      // 回答自体は保存済み。記録失敗を回答失敗へ見せず、再開・再実行時に残す。
      logger.error("forms.record_destination_write_failed");
      return;
    }
    if (claim) await claim.checkpoint('destination_status');
  };
  await recordDestinationWrite();

  const required = [
    ...(form.on_submit_webhook_url ? ['webhook'] : []),
    'answer',
    'submit_count',
    'mileage',
    ...effectRuns.map((effect) => effect.step),
    'destination_status',
  ];
  return claim ? claim.settle(required) : [];
}
