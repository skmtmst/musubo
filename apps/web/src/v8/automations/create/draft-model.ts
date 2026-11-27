import { isoToJstDatetimeLocal } from '@/components/automations/automation-datetime'
import { isEmptyCondition, type SegmentCondition } from '@/components/shared/condition-builder'
import { type AutomationDraftAction, type AutomationDraftDetail } from '@/lib/api'
import { requiredText } from '@/lib/form-requirement'
import { formatTime } from '@/lib/format'
import { AUTOMATION_DRAFT_TRIGGER_OPTIONS } from '@line-crm/shared'
import type { ActionDraft } from './action-draft'
import { conditionPayload, storedConditionToForm } from './draft-conditions'
import { EVENTS } from './draft-options'
import { StoredDraft } from './draft-storage'
import { friendNamesOf, normalizeFriendIds, normalizeWeekdays } from './trigger-helpers'

export const b244Requirements = {
  name: requiredText("ルール名を入力してください"),
  row_message: requiredText("送る文面を入力してください"),
}

export let actionKeySeed = 0

export const newActionDraft = (): ActionDraft => ({
  key: ++actionKeySeed,
  type: 'add_tag',
  tagId: '',
  message: '',
  scenarioId: '',
  commonActionId: '',
})

/**
 * 「この新規作成の操作」を識別する鍵（DETAIL-13）。
 *
 * 1回の作成操作に1つだけ振り、同じ操作の再試行（ダブルクリック・保存の
 * やり直し・通信の再送）だけが同じ鍵を使う。Worker はこの鍵から下書きの
 * id を決めるので、別の新規作成は必ず別の鍵＝別の下書きになる。
 * 前の下書きへ勝手に戻る道を、画面とサーバーの両方で塞ぐ。
 */
export const newOperationKey = (): string =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 18)}`

/**
 * 中身をそのまま表す文字列（N-358）。
 *
 * 鍵の並び順を固定するので、**同じ中身なら必ず同じ文字列**になる。
 */
export const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value === undefined ? null : value)
}

/**
 * 1人テストで実際に動く部分の指紋（N-358）。
 *
 * **版の番号だけでは「確認したときと同じ中身か」を判定できない。**
 * `apps/worker/src/services/automation-drafts.ts` の `updateAutomationDraft` は
 * `automation_versions` の**同じ行を書き換える**ので、下書きを何度更新しても
 * `draftVersionId` は変わらない。別のタブで書き換えられた後でも、古い確認画面が
 * 持っている版の番号はそのまま通ってしまい、`runAutomationTest` はそのとき
 * DBにある新しい中身を送る。だから中身そのものを指紋にして確認へ結びつける。
 *
 * 名前と説明は送信結果を変えないので入れない。
 */
export const draftFingerprint = (
  draft: Pick<AutomationDraftDetail, 'eventType' | 'triggerConfig' | 'conditions' | 'actions'>,
): string => canonicalJson({
  eventType: draft.eventType,
  triggerConfig: draft.triggerConfig,
  conditions: draft.conditions,
  actions: draft.actions,
})

/**
 * 画面に入力されている内容の一式（DETAIL-14）。
 *
 * **入力はアカウントに結び付ける。** 店を切り替えても前の店の文面が
 * 残ったままだと、切り替え先の店の下書きとしてA店の内容を保存できて
 * しまう。切り替え時に前のアカウント分を控え（`formStashRef`）へ退け、
 * 切り替え先の控え（なければ初期値）を読み直す。
 */
export interface FormSnapshot {
  name: string
  eventType: string
  keyword: string
  /**
   * 「だれに」の条件。保存・人数・要約の3か所が同じこれを見る
   * （AUTOMATION-02/04）。形は worker の SegmentCondition と同じ。
   */
  condition: SegmentCondition | null
  /** 読んだ下書きの条件が古い形で読めなかったとき true。付け直すまで保存しない。 */
  conditionUnreadable: boolean
  triggerConfig: Record<string, unknown>
  actions: ActionDraft[]
  testFriendId: string
  /** このアカウントに結び付いた下書き。無ければ次の保存は新規作成。 */
  savedDraft: StoredDraft | null
  /* DETAIL-15: 保存の状態は控えごと持ち、切り替えても正しく戻る。 */
  savedAt: number | null
  savedFingerprint: string | null
  /*
   * R491: 公開まで済んだら 'published' で控える。戻ったときに未公開の
   * 下書きと受け取って作り直し、稼働ルールを2件にしないため。
   */
  saveOutcome: 'idle' | 'saved' | 'failed' | 'published'
  /** 公開済みのときだけ、元のルールの番号。 */
  publishedDefinitionId: string | null
  previewCount: number | null
  /* AUTOMATION-03: 人数の確認は保存とは別の成否。失敗したことだけ控える。 */
  previewFailed: boolean
  /** R488: 受け付けた1人テストの実行。戻ったときは要求IDで読み直す。 */
  testRun: TestRunRecord | null
}

export const blankFormSnapshot = (): FormSnapshot => ({
  name: '',
  eventType: EVENTS[0].value,
  keyword: '',
  condition: null,
  conditionUnreadable: false,
  triggerConfig: {},
  actions: [newActionDraft()],
  testFriendId: '',
  savedDraft: null,
  savedAt: null,
  savedFingerprint: null,
  saveOutcome: 'idle',
  publishedDefinitionId: null,
  previewCount: null,
  previewFailed: false,
  testRun: null,
})

/** 何か入力されているか。空のまま切り替えただけなら控えを残さない。 */
export const formSnapshotHasContent = (snapshot: FormSnapshot): boolean =>
  Boolean(
    snapshot.name.trim()
      || snapshot.keyword.trim()
      || !isEmptyCondition(snapshot.condition)
      || snapshot.conditionUnreadable
      || snapshot.testFriendId.trim()
      || snapshot.eventType !== EVENTS[0].value
      || Object.keys(snapshot.triggerConfig).length > 0
      || snapshot.actions.length > 1
      || snapshot.actions.some(
        (row) => row.type !== 'add_tag' || row.tagId || row.message.trim() || row.scenarioId || row.commonActionId,
      ),
  )

/** 「すること」1行を、保存で送る形へ直す。指紋とも同じ形を使う。 */
export const actionDraftToPayload = (row: ActionDraft, index: number, rows?: ActionDraft[]): AutomationDraftAction => {
  let id = row.sourceId ?? `step-${index + 1}`
  if (!row.sourceId && rows) {
    const used = new Set(rows.map(item => item.sourceId).filter(Boolean))
    for (let position = 0; position <= index; position += 1) {
      if (rows[position]?.sourceId) continue
      let number = position + 1
      while (used.has(`step-${number}`)) number += 1
      id = `step-${number}`
      used.add(id)
    }
  }
  return (
  row.type === 'wait'
    ? { id, type: 'wait', params: { ...(row.kept ?? { durationMinutes: 5 }) }, onFailure: 'stop' }
    : row.type === 'notify_staff'
    /* 担当へ知らせる：読んだときの知らせのルール・文面をそのまま戻す（口は F-14 で受け付ける）。 */
    ? ({ id, type: 'notify_staff', params: { ...(row.kept ?? {}) }, onFailure: 'stop' } as unknown as AutomationDraftAction)
    : row.type === 'add_tag'
    ? { id, type: 'add_tag' as const, params: { tagId: row.tagId }, onFailure: 'stop' as const }
    : row.type === 'start_scenario'
      ? { id, type: 'start_scenario' as const, params: { scenarioId: row.scenarioId }, onFailure: 'stop' as const }
      : row.type === 'common_action'
        ? { id, type: 'common_action' as const, params: { commonActionId: row.commonActionId }, onFailure: 'stop' as const }
        : {
            id,
            type: 'send_message' as const,
            params: { messageType: 'text', content: row.message.trim() },
            onFailure: 'stop' as const,
          }
  )
}

/**
 * きっかけの詳しい設定を、保存で送る形へ直す。 */
export const normalizeTriggerConfigFor = (
  eventType: AutomationDraftDetail['eventType'],
  triggerConfig: Record<string, unknown>,
  keyword: string,
): Record<string, unknown> => {
  const plain = Object.fromEntries(Object.entries(triggerConfig).filter(([key]) => key !== 'friendNames'))
  const managed = new Set(AUTOMATION_DRAFT_TRIGGER_OPTIONS.find(option => option.value === eventType)?.configKeys ?? [])
  const kept = Object.fromEntries(Object.entries(plain).filter(([key]) => !managed.has(key)))
  if (eventType === 'message_received') return { ...kept, ...(keyword.trim() ? { keyword: keyword.trim() } : {}) }
  if (eventType === 'tag_change') return {
    ...kept,
    tagId: String(triggerConfig.tagId ?? ''),
    action: triggerConfig.action === 'remove' ? 'remove' : 'add',
  }
  if (eventType === 'datetime') {
    const local = String(triggerConfig.at ?? '')
    return { ...kept, at: local ? new Date(`${local}:00+09:00`).toISOString() : '', friendIds: normalizeFriendIds(triggerConfig.friendIds) }
  }
  if (eventType === 'daily' || eventType === 'weekly') return {
    ...kept,
    time: String(triggerConfig.time ?? ''),
    friendIds: normalizeFriendIds(triggerConfig.friendIds),
    ...(eventType === 'weekly' ? { weekdays: normalizeWeekdays(triggerConfig.weekdays) } : {}),
  }
  if (eventType === 'link_clicked') {
    const trackedLinkId = String(triggerConfig.trackedLinkId ?? '').trim()
    return { ...kept, ...(trackedLinkId ? { trackedLinkId } : {}) }
  }
  if (eventType === 'calendar_booked') {
    const bookingType = String(triggerConfig.bookingType ?? '')
    const menuId = String(triggerConfig.menuId ?? '').trim()
    const eventId = String(triggerConfig.eventId ?? '').trim()
    return {
      ...kept,
      ...(bookingType === 'salon' || bookingType === 'event' ? { bookingType } : {}),
      ...(menuId ? { menuId } : {}),
      ...(eventId ? { eventId } : {}),
    }
  }
  return plain
}

/**
 * 保存ボタンで送る中身そのものの指紋（DETAIL-15）。
 *
 * 「保存したあとに変えたか」は版の番号ではなく、送る中身の一致で見る。
 * 読み込んだ下書き・保存に成功した内容と同じ形で作るので、画面を往復しても
 * 値が同じなら「変更あり」とは出ない。
 */
export const draftPayloadFingerprint = (form: {
  name: string
  eventType: string
  keyword: string
  condition: SegmentCondition | null
  triggerConfig: Record<string, unknown>
  actions: ActionDraft[]
}): string => canonicalJson({
  name: form.name.trim(),
  eventType: form.eventType,
  triggerConfig: normalizeTriggerConfigFor(
    form.eventType as AutomationDraftDetail['eventType'], form.triggerConfig, form.keyword,
  ),
  conditions: conditionPayload(form.condition),
  actions: form.actions.map(actionDraftToPayload),
})

/** ISOの日時を、画面の datetime-local（日本時間）の文字へ戻す。実体は共有（R482）。 */
export const isoToDatetimeLocal = isoToJstDatetimeLocal

/**
 * 保存済みの下書きを、この画面の入力の形へ戻す（DETAIL-13の再開）。
 *
 * 番号だけを戻すのは**しない**。以前はそれで空の画面から上書きしていた。
 * 再開では名前・きっかけ・条件・することまで全部戻し、保存は読み終わってから。
 */
export const draftDetailToForm = (detail: AutomationDraftDetail): {
  name: string
  eventType: string
  keyword: string
  condition: SegmentCondition | null
  conditionUnreadable: boolean
  triggerConfig: Record<string, unknown>
  actions: ActionDraft[]
} => {
  const storedCondition = storedConditionToForm(detail.conditions)
  const config = detail.triggerConfig ?? {}
  /* R21・R22: 曜日と対象の友だちは配列で持つ。古い文字列の控えも正規化する。 */
  const friendNames = friendNamesOf(config as Record<string, unknown>)
  const triggerConfig = ((): Record<string, unknown> => {
    switch (detail.eventType) {
      case 'tag_change':
        return {
          ...config,
          tagId: String(config.tagId ?? ''),
          action: config.action === 'remove' ? 'remove' : 'add',
        }
      case 'form_submitted':
        return { ...config, formId: String(config.formId ?? '') }
      case 'link_clicked':
        return { ...config, trackedLinkId: String(config.trackedLinkId ?? '') }
      case 'calendar_booked':
        return {
          ...config,
          bookingType: String(config.bookingType ?? ''),
          menuId: String(config.menuId ?? ''),
          eventId: String(config.eventId ?? ''),
        }
      case 'datetime':
        return { ...config, at: isoToDatetimeLocal(String(config.at ?? '')), friendIds: normalizeFriendIds(config.friendIds), friendNames }
      case 'daily':
        return { ...config, time: String(config.time ?? ''), friendIds: normalizeFriendIds(config.friendIds), friendNames }
      case 'weekly':
        return {
          ...config,
          time: String(config.time ?? ''),
          friendIds: normalizeFriendIds(config.friendIds),
          friendNames,
          weekdays: normalizeWeekdays(config.weekdays),
        }
      default:
        return { ...config }
    }
  })()
  const actions: ActionDraft[] = detail.actions.length === 0
    ? [newActionDraft()]
    : detail.actions.map((step) => ({
        key: ++actionKeySeed,
        sourceId: step.id,
        type: step.type,
        tagId: String(step.params.tagId ?? ''),
        message: String(step.params.content ?? ''),
        scenarioId: String(step.params.scenarioId ?? ''),
        commonActionId: String(step.params.commonActionId ?? ''),
        kept: step.type === 'notify_staff' || step.type === 'wait' ? { ...step.params } : undefined,
      }))
  return {
    name: detail.name,
    eventType: detail.eventType,
    keyword: detail.eventType === 'message_received' ? String(config.keyword ?? '') : '',
    condition: storedCondition.condition,
    conditionUnreadable: storedCondition.unreadable,
    triggerConfig,
    actions,
  }
}

/** 保存した時刻の表示（DETAIL-15）。分まであれば「いつ保存したか」は読める。 */
export const formatClock = (time: number): string =>
  formatTime(time)

/**
 * 「この内容で送る」と押したときに送る中身を、押す前に固めた控え（N-358）。
 *
 * 画面の状態ではなく**この控えだけ**を送信に使う。送る直前にサーバーの
 * いまの中身と突き合わせ、1文字でも違えば送らずに 409 として扱う。
 */
export interface TestConfirmation {
  accountId: string
  draftId: string
  draftVersionId: string
  fingerprint: string
  /** 画面の入力とのずれを出すためだけの、すること部分の指紋。 */
  actionsFingerprint: string
  friendId: string
  contents: string[]
  effects: string[]
  /**
   * R487: 確認画面で出した共通アクションの版の一式。実行要求に添え、
   * Worker が確認後の利用版切り替えを 409 で止める照合に使う。
   */
  commonActionExpectations: Array<{ stepId: string; commonActionId: string; versionId: string }>
  /**
   * R484: この確認だけの要求キー。応答が失われたあとの再試行も同じ鍵で
   * 呼び、Worker は2件目の実行を作らず初回を返す。確認を開くたびに振る。
   */
  operationKey: string
}

/**
 * R488: 受け付けた1人テストの実行。状態は日本語で出し、同じ実行の
 * 結果へ飛べるように実行IDを持つ。新規実行と結果確認を混同させない。
 */
export interface TestRunRecord {
  runId: string
  /** Worker が返したままの状態（queued/waiting/success/...）。 */
  status: string
  accountId: string
  at: number
}

/** 1人テストの実行状態を日本語で出す（R488：生の `waiting` は出さない）。 */
export const TEST_RUN_STATUS_LABEL: Record<string, string> = {
  queued: '受け付け済み',
  running: '動いています',
  waiting: '待機中',
  success: '終わりました',
  partial: '一部だけ終わりました',
  // 失敗の文は立て直し方まで書く（error-copy-recovery-contract）。次の手は下の「実行の結果を見る」。
  failed: '失敗しました。実行の結果を見てください。',
  cancelled: '取りやめました',
  skipped_condition: '条件に外れて動きませんでした',
  busy: '混み合っています',
}

export const testRunStatusLabel = (status: string): string =>
  Object.prototype.hasOwnProperty.call(TEST_RUN_STATUS_LABEL, status) ? TEST_RUN_STATUS_LABEL[status] : '確認中'
