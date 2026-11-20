import { jstCalendar as japanCalendar } from '@line-crm/shared';
import { stripTapExtras } from '@line-crm/shared';
/*
 * シナリオのテスト送信。
 *
 * 1通ぶん、または全通を、指定した友だちへ実際に送る。**購読の状態は一切
 * 触らない**。テストのつもりが本番の進行を動かしてしまうと、受け取る人の
 * 途中から次が届かなくなる。
 *
 * 送る中身は配信本番と同じ組み立てを通す。ここで別の組み立てを書くと、
 * テストでは出るのに本番で出ない（またはその逆）が起きる。
 */
import { getFriendById, resolveStepContent, jstNow, getLineAccountById } from '@line-crm/db'
import type { ScenarioStep } from '@line-crm/db'
import { LineClient } from '@line-crm/line-sdk'
import type { Message } from '@line-crm/line-sdk'
import { expandVariables, resolveMetadata, buildMessage } from '../../services/step-delivery.js'
import { resolveSendInterpolationExtra } from '../../services/interpolation-context.js'
import { parseQuestion, buildQuestionMessages } from './scenario-question.js'

export interface TestSendResult {
  ok: boolean
  error?: string
  /** 実際に送った通の数。 */
  sent: number
  /** 送信先単位の間隔制限で控えたとき true。 */
  deduped?: boolean
}

/**
 * 同じ送信先へのテスト送信を短い間隔で繰り返させない上限。
 *
 * 連打・複数タブ・同時リクエストで実送信が重なるのを防ぐためのもので、
 * 通常の「確認→修正→再送」の間隔（分単位）は邪魔しない。
 */
export const TEST_SEND_DEBOUNCE_MS = 60_000

/**
 * 送信先（友だち）× 送る対象で claim を取る。取れれば true。
 *
 * scenario_test_send_claims（433）へ INSERT … ON CONFLICT で1文だけ実行し、
 * 前回の claim から debounce 窓が過ぎているときだけ claimed_at を更新する。
 * 同時リクエストは UNIQUE 制約で片方しか通らない。
 */
async function claimScenarioTestSend(
  db: D1Database,
  friendId: string,
  dedupeKey: string,
): Promise<boolean> {
  const now = japanCalendar()
  const cutoff = new Date(now.getTime() - TEST_SEND_DEBOUNCE_MS)
  const fmt = (d: Date) => d.toISOString().slice(0, -1) + '+09:00'
  const result = await db
    .prepare(
      `INSERT INTO scenario_test_send_claims (claim_key, claimed_at)
       VALUES (?, ?)
       ON CONFLICT(claim_key) DO UPDATE
         SET claimed_at = excluded.claimed_at
         WHERE scenario_test_send_claims.claimed_at < ?`,
    )
    .bind(`${friendId}:${dedupeKey}`, fmt(now), fmt(cutoff))
    .run()
  return (result.meta.changes ?? 0) > 0
}

/**
 * プレビューにも使えるよう、組み立てだけを行い送信しない。
 * 送信元アカウントを必須とし、未公開・別アカウントの参照は step の控えへ戻す。
 */
export async function buildStepMessages(
  db: D1Database,
  step: ScenarioStep,
  friendId: string,
  // 省略不可。null のときは持ち主不明として控えに落とす(fail-close)。
  lineAccountId: string | null,
  workerUrl?: string,
): Promise<Message[]> {
  const friend = await getFriendById(db, friendId)
  if (!friend) throw new Error('friend not found')

  const resolved = await resolveStepContent(db, step, lineAccountId)
  const meta = await resolveMetadata(db, friend)
  const friendWithMeta = { ...friend, metadata: meta } as Parameters<typeof expandVariables>[1]
  // 質問の前文・選択肢文にも差し込みが効くので、スキャンは本文と
  // 質問JSONを合わせた全体で行う。
  const extra = await resolveSendInterpolationExtra(
    db, friend.id,
    `${resolved.messageContent}\n${resolved.questionJson ?? ''}`,
    { kind: 'test_send', id: step.id }, undefined, { kind: 'scenarioDraft', liveStepId: step.id },
  )

  const question = parseQuestion(resolved.questionJson)
  if (question) {
    return stripTapExtras(buildQuestionMessages(
      {
        ...question,
        intro: question.intro
          ? expandVariables(question.intro, friendWithMeta, workerUrl, 'text', extra)
          : question.intro,
        text: expandVariables(question.text, friendWithMeta, workerUrl, 'text', extra),
      },
      step.id,
    )) as Message[]
  }

  const expanded = expandVariables(
    resolved.messageContent,
    friendWithMeta,
    workerUrl,
    resolved.messageType,
    extra,
  )
  const testContent = resolved.messageType !== 'text' && expanded.includes('\"tapExtras\"') ? JSON.stringify(stripTapExtras(JSON.parse(expanded))) : expanded
  return [buildMessage(resolved.messageType, testContent)]
}

/**
 * テスト送信する。
 *
 * URL の自動計測（auto-track）は通さない。テストのクリックが本番の集計に
 * 混ざると、あとから見分けられない。
 */
export async function testSendSteps(
  db: D1Database,
  fallbackClient: LineClient,
  steps: ScenarioStep[],
  friendId: string,
  scenarioAccountId: string | null,
  workerUrl?: string,
  /**
   * 送信先単位のデバウンス用キー。呼び出し側は
   * 「シナリオ+通」単位のキーを渡す。省略時は従来どおり制限しない
   * （非routeの利用箇所向け後方互換）。
   */
  options?: { dedupeKey?: string },
): Promise<TestSendResult> {
  const friend = await getFriendById(db, friendId)
  if (!friend) return { ok: false, error: '送り先の友だちが見つかりません。', sent: 0 }
  if (!friend.is_following) {
    return { ok: false, error: 'この友だちはブロック中のため送れません。', sent: 0 }
  }

  // 送信前に claim を取る。取れなければ実送信も記録もしない。
  if (options?.dedupeKey) {
    const claimed = await claimScenarioTestSend(db, friendId, options.dedupeKey)
    if (!claimed) {
      return {
        ok: false,
        error: '同じ送信先へのテスト送信は、しばらく間をあけてから実行してください。',
        sent: 0,
        deduped: true,
      }
    }
  }

  // 別アカウントから送らないよう、宛先の所有者ではなく入口で確定した送信元だけを使う。
  if (!scenarioAccountId) {
    return { ok: false, error: 'シナリオのLINEアカウントが未設定のため、テスト送信できません。', sent: 0 }
  }
  const accountId = scenarioAccountId
  const account = await getLineAccountById(db, accountId)
  if (!account) return { ok: false, error: 'LINEアカウントの設定が見つかりません。', sent: 0 }
  const client = new LineClient(account.channel_access_token)

  let sent = 0
  for (const step of steps) {
    const messages = await buildStepMessages(db, step, friendId, accountId, workerUrl)
    await client.pushMessage(friend.line_user_id, messages)
    sent += messages.length

    // テスト送信も記録に残す。残さないと「送ったはずだが届いていない」の
    // 切り分けができない。source で本番と区別できるようにしておく。
    for (const message of messages) {
      const { messageToLogPayload } = await import('../../services/step-delivery.js')
      const payload = messageToLogPayload(message)
      await db
        .prepare(
          `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, source, line_account_id, created_at)
           VALUES (?, ?, 'outgoing', ?, ?, NULL, ?, 'scenario_test', ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          friend.id,
          payload.messageType,
          payload.content,
          step.id,
          accountId ?? null,
          jstNow(),
        )
        .run()
    }
  }

  return { ok: true, sent }
}
