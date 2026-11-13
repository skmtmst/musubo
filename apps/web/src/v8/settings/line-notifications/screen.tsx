'use client'
import { customerNotificationIncomplete as isIncomplete, customerNotificationStatus } from './customer-status'
import { requiredText } from '@/lib/form-requirement'
const notificationTitleRequirement = requiredText('通知の見出しを入力してください。')
import { RowActions } from '@/components/shared/row-actions'
import { notifySaved } from '@/components/shared/toast'
import { useListUrlValue } from '@/components/shared/list-url-state'
import MediaSlot from '@/components/shared/media-slot'
import { uploadImageFile } from '@/components/shared/media-library-upload'
import Link from '@/components/shared/list-navigation'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMergedTab } from '@/components/layout/merged-tabs'
import KpiBand from '@/components/shared/kpi-band'
import { ListFolderContext } from '@/components/shared/list-folder-context'
import Toggle from '@/components/shared/toggle'
import { Download, Inbox, Plus } from 'lucide-react'
import { formatNumber } from '@/lib/format'
import { canManageRole, useStaffRole } from '@/lib/staff-role'
import { SbSettingsScreen } from '../sb-frame/settings-screen'
import OperatorTab from './operator-tab'
import RunsTab from './runs-tab'
import styles from './screen.module.css'
import { Field } from '@/components/shared/form-controls'
import { TextField, TextArea } from '@/components/shared/text-field'
import { DataTable, TableHeadRow, Th, Tr, Td, StatusCell, ActionCell, RowNameButton } from '@/components/shared/table'
import StatusBadge from '@/components/shared/status-badge'
import { StatusDot } from '@/components/shared/status-pill'
import { Tabs } from '@/components/shared/tabs'
import Button from '@/components/shared/button'
import { DialogActions } from '@/components/shared/dialog'
import { PageFooter } from '@/components/templates/page-footer'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import ListState from '@/components/shared/list-state'
import { DelayedSkeleton, Skeleton } from '@/components/shared/skeleton'
import Notice from '@/components/shared/notice'
import UriTapActionField from '@/components/shared/uri-tap-action-field'
import { ApiError, api, fetchApi, type EcCommerceOverview, type EcNotificationSetting, type LineNotificationDefinition, type LineNotificationSendCounts } from '@/lib/api'
import { useAccount } from '@/contexts/account-context'
import { canOpenCustomerNotificationKpi, customerNotificationKpis, type CustomerNotificationKpi, type LineNotificationQuota } from './customer-kpis'
import KpiCard from '@/components/shared/kpi-card'
import Card from '@/components/shared/card'
import TruncatedText from '@/components/shared/truncated-text'
import SegmentedControl from '@/components/shared/segmented'
import { isForbiddenOrRateLimited, loadFailureNotice } from '@/components/shared/api-error-message'
import { emptyValue } from '@/components/shared/empty-value'
import { readSaveFieldErrors } from '@/lib/api/helpers/field-errors'
import { SaveErrorField, useSaveFormErrors, SaveErrorScope } from '@/components/shared/save-form-errors'
import ReadOnlyNotice from '@/components/shared/read-only-notice'
import { usePermissionLockReason } from '@/components/shared/use-permission-lock-reason'
import { PERMISSION_LOCK_REASON, PERMISSION_LOCK_SUMMARY } from '@/components/shared/permission-lock'
/*
 * ★V8 LINE通知（Pencil 。運用者へのお知らせ ・送れなかったもの ・記録 ）。
 *
 * app/line-notifications/page.tsx を写して、見た目（外側の型・中のメニュー・タブ・数のカード・帯・札・表）だけを
 * 絵に合わせた（src/v8 は @/app を読めない）。動き（読み込み・下書き・保存・公開・止める・テスト送信・
 * アカウント切替の見張り）は同じ。運用者へのお知らせの一覧は今の部品を入口（page.tsx）から差し込む。
 * 動きの一覧は同じ場所の BEHAVIOR.md。
 */

const customerFilters = [
  ['all', 'すべて'],
  ['enabled', '出している'],
  ['stopped', '停止中'],
  ['incomplete', '文面が未設定'],
] as const
type CustomerFilter = typeof customerFilters[number][0]
type CustomerLoadState = 'loading' | 'ready' | 'error' | 'forbidden'

/**
 * 見出しの下に、**内部のイベントキーを出さない**。
 *
 * 出来事の言葉は下の eventDeliveryWords（運用者の言葉の一覧）だけから取る。
 * `ec.order.confirmed` のような口の値をそのまま描かない。
 */
/*
 * #988 NEXT-06: 「いつ・誰に送るか」の説明は、イベント別に文のかたちを
 * 決め打ちする。表示名（label）を文に繋ぐと「注文完了らすぐ」のような
 * 壊れた文になる。宛先は一斉配信ではなく、その出来事に関わるお客さま
 * だけ（Workerは出来事の line_user_id に結び付く友だち1人へ送る）なので、
 * 「全員に送る」のような表現は使わない。
 */
const eventDeliveryWords: Record<string, { trigger: string; timing: string; audience: string }> = {
  'ec.order.confirmed': { trigger: '注文が確定したとき', timing: '確定のあとすぐ', audience: 'その注文のお客さまだけ' },
  'ec.order.payment_received': { trigger: '入金を確認したとき', timing: '確認のあとすぐ', audience: 'その注文のお客さまだけ' },
  'ec.order.bank_transfer_reminder': { trigger: '振込の期限が近づいたとき', timing: '期限が近づいたらすぐ', audience: 'その注文のお客さまだけ' },
  'ec.order.shipped': { trigger: '商品を発送したとき', timing: '発送のあとすぐ', audience: 'その注文のお客さまだけ' },
  'ec.order.cancelled': { trigger: '注文がキャンセルされたとき', timing: 'キャンセルのあとすぐ', audience: 'その注文のお客さまだけ' },
  'ec.order.refunded': { trigger: '返金が完了したとき', timing: '返金のあとすぐ', audience: 'その注文のお客さまだけ' },
  'ec.subscription.upcoming': { trigger: '次回定期便の発送日が近づいたとき', timing: '設定した日時', audience: 'その定期便のお客さまだけ' },
  'ec.subscription.payment_failed': { trigger: '定期便の決済に失敗したとき', timing: '失敗のあとすぐ', audience: 'その定期便のお客さまだけ' },
  'ec.subscription.card_updated': { trigger: 'カード変更・再決済の結果が出たとき', timing: '結果が出たあとすぐ', audience: 'その定期便のお客さまだけ' },
  'ec.subscription.cancelled': { trigger: '定期便が解約されたとき', timing: '解約のあとすぐ', audience: 'その定期便のお客さまだけ' },
  'ec.customer.profile_updated': { trigger: 'ペット情報が更新されたとき', timing: '更新のあとすぐ', audience: '情報を更新したお客さまだけ' },
}

function deliveryWords(setting: EcNotificationSetting) {
  return eventDeliveryWords[setting.eventType] ?? {
    // 表に無いイベントは、表示名を文の部品としてではなく引用して置く。
    trigger: `「${setting.label}」が起きたとき`,
    timing: '起きたあとすぐ',
    audience: 'その出来事に関わるお客さまだけ',
  }
}

function triggerLabel(setting: EcNotificationSetting): string {
  return `${deliveryWords(setting).trigger} ／ EC連携から`
}

function timingLabel(setting: EcNotificationSetting): string {
  return deliveryWords(setting).timing
}

function audienceLabel(setting: EcNotificationSetting): string {
  return deliveryWords(setting).audience
}

/**
 * N-338: 一覧の「送った数が多い順」は、行の「今日」列と同じ数で降順に並べる。
 *
 * 集計がまだ無い行は末尾へ寄せる。同数は受け取った設定順のまま
 *（`Array.prototype.sort` は安定）。
 */
function sortCustomerSettingsBySentCount(
  settings: EcNotificationSetting[],
  countOf: (eventType: string) => number | null,
): EcNotificationSetting[] {
  return [...settings].sort((a, b) => (countOf(b.eventType) ?? -1) - (countOf(a.eventType) ?? -1))
}

/**
 * 「今日 送った」の内訳の文。読み込んだ設定の `label` から表示名を引く。
 *
 * 設定に無い eventType は「その他」にまとめる。`ec.order.confirmed` のような
 * 内部のイベントキーをそのまま文にしない。名前で出すのは上位3件までで、
 * 4件目以降の設定にある種類も「その他」に足す（内訳の合計が今日の合計と合う）。
 * 読めていないときは空文字を返し、呼び出し側の「種類別の件数は未取得」の
 * ままにする（0 とは書かない）。
 */
export function buildSentBreakdown(
  byEventType: LineNotificationSendCounts['byEventType'] | null | undefined,
  settings: EcNotificationSetting[],
): string {
  if (!Array.isArray(byEventType)) return ''
  const labelOf = new Map(settings.map((setting) => [setting.eventType, setting.label]))
  const ranked = [...byEventType]
    .filter((item) => item.today > 0)
    .sort((a, b) => b.today - a.today)
  const knownAll = ranked.filter((item) => labelOf.has(item.eventType))
  const known = knownAll.slice(0, 3)
  const otherTotal = knownAll.slice(3).reduce((sum, item) => sum + item.today, 0)
    + ranked.filter((item) => !labelOf.has(item.eventType)).reduce((sum, item) => sum + item.today, 0)
  const parts = known.map((item) => `${labelOf.get(item.eventType)} ${item.today}`)
  if (otherTotal > 0) parts.push(`その他 ${otherTotal}`)
  return parts.join('・')
}

/**
 * send-counts の形の見張り。偽APIや段階配備中の旧Workerが想定外の形
 * （配列・byEventTypeなし）を返しても `.map` で落ちないようにする。
 * 形が違うときは「読み込めなかった」として null 扱いにする。
 */
function isSendCountsData(value: unknown): value is LineNotificationSendCounts {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const data = value as Record<string, unknown>
  if (typeof data.sentToday !== 'number' || typeof data.sentLast30d !== 'number') return false
  if (!Array.isArray(data.byEventType)) return false
  return (data.byEventType as unknown[]).every((item) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return false
    const row = item as Record<string, unknown>
    return typeof row.eventType === 'string' && typeof row.today === 'number' && typeof row.last30d === 'number'
  })
}

/** N-340: 編集中の下書きは入力欄の6項目だけを残す。出・止めの切替は即保存なので入れない。 */
type CustomerEditorDraft = Pick<
  EcNotificationSetting, 'title' | 'introText' | 'outroText' | 'buttonLabel' | 'buttonUrl' | 'imageUrl'
>

function pickCustomerDraft(setting: EcNotificationSetting): CustomerEditorDraft {
  return {
    title: setting.title,
    introText: setting.introText,
    outroText: setting.outroText,
    buttonLabel: setting.buttonLabel,
    buttonUrl: setting.buttonUrl,
    imageUrl: setting.imageUrl,
  }
}

function isSameCustomerDraft(setting: EcNotificationSetting, draft: CustomerEditorDraft): boolean {
  const current = pickCustomerDraft(setting)
  return (Object.keys(current) as (keyof CustomerEditorDraft)[]).every((key) => current[key] === draft[key])
}

/**
 * N-340: 保存・公開の応答が返った時点で「送った文面」と「いま画面にある文面」が
 * 同じかを見るための指紋。
 *
 * 保存は押した瞬間の写しを送る。押したあとも入力欄は動くので、応答が返るころには
 * 画面の文面が先へ進んでいることがある。写しと指紋が違えば、その保存は
 * 「いまの文面」を保存したものではない。端末の控えを消したり未保存の印を外すと、
 * 進んだぶんの入力が再読込で消える。
 */
function customerDraftFingerprint(draft: CustomerEditorDraft): string {
  return JSON.stringify([
    draft.title ?? '', draft.introText, draft.outroText,
    draft.buttonLabel, draft.buttonUrl, draft.imageUrl,
  ])
}

/**
 * N-340: 再読込で編集中身が消えないよう、端末内に下書きを置く。
 * 鍵にアカウントを入れる。別アカウントの切替で混ざらないため。
 */
function customerDraftKey(lineAccountId: string, eventType: string): string {
  return `line-notifications:draft:v1:${lineAccountId}:${eventType}`
}

function readStorage(): Storage | null {
  try {
    if (typeof window === 'undefined') return null
    return window.localStorage
  } catch { return null }
}

function readCustomerDraft(lineAccountId: string, eventType: string): CustomerEditorDraft | null {
  const storage = readStorage()
  if (!storage) return null
  try {
    const raw = storage.getItem(customerDraftKey(lineAccountId, eventType))
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<CustomerEditorDraft>
    if (typeof parsed.introText !== 'string' || typeof parsed.outroText !== 'string') return null
    return {
      title: typeof parsed.title === 'string' ? parsed.title : null,
      introText: parsed.introText,
      outroText: parsed.outroText,
      buttonLabel: typeof parsed.buttonLabel === 'string' ? parsed.buttonLabel : '',
      buttonUrl: typeof parsed.buttonUrl === 'string' ? parsed.buttonUrl : '',
      imageUrl: typeof parsed.imageUrl === 'string' ? parsed.imageUrl : '',
    }
  } catch { return null }
}

function writeCustomerDraft(lineAccountId: string, eventType: string, draft: CustomerEditorDraft): void {
  try { readStorage()?.setItem(customerDraftKey(lineAccountId, eventType), JSON.stringify(draft)) } catch { /* 端末に置けないときは警告だけで続ける */ }
}

function clearCustomerDraft(lineAccountId: string, eventType: string): void {
  try { readStorage()?.removeItem(customerDraftKey(lineAccountId, eventType)) } catch { /* 同上 */ }
}

/**
 * N-341: 運用者タブの件数。読み込み前は `—`、取れなかったときは
 * `取得失敗` と出し、0件・読み込み中と区別する。
 */
type OperatorTabState = 'loading' | 'ready' | 'error' | 'forbidden'

function operatorTabCountLabel(state: OperatorTabState, count: number | null): string {
  if (state === 'ready' && count !== null) return `${count}`
  if (state === 'loading') return '—'
  // M031: 403は取れなかったのではなく権限が無い。「取得失敗」と混ぜない。
  if (state === 'forbidden') return '権限なし'
  return '取得失敗'
}

/**
 * N-340: 保存・公開の呼び出し口。実APIと同じ非同期境界を持たせ、
 * 遅れて返った応答や逆順応答を試験で再現できるようにする。
 */
type CustomerMutationApi = {
  updateDraft: typeof api.lineNotifications.updateDraft
  publishDefinition: typeof api.lineNotifications.publishDefinition
  stopDefinition: typeof api.lineNotifications.stopDefinition
  createDefinition: typeof api.lineNotifications.createDefinition
}

/**
 * `stale` は「サーバへの反映は終わったが、画面はもう別のアカウントを見ている」状態。
 * このときは画面へ一切書かない。前のアカウントの応答で、いま見ている
 * アカウントの設定・定義・未保存の印を上書きしないため。
 *
 * `contentSaved` は、送った文面がサーバに入ったかどうか。
 *
 * `settleDraft` は「その保存をもって、端末の控えを消し、未保存の印を外し、
 * 戻し先を更新してよいか」。文面が入っていて、なおかつ応答の時点でも
 * 同じアカウントの同じ文面のままのときだけ真になる。保存中に足された入力や、
 * アカウントを往復したあとの再編集を、古い応答で消さないための錠。
 */
type CustomerMutationOutcome =
  | {
      kind: 'applied'
      fields?: Record<string, string>
      definition: LineNotificationDefinition | null
      enabled: boolean
      tone: 'success' | 'error'
      message: string
      contentSaved: boolean
      settleDraft: boolean
    }
  | { kind: 'stale'; contentSaved: boolean; settleDraft: false }
  | {
      kind: 'failed'
      fields?: Record<string, string>
      message: string
      contentSaved: boolean
      settleDraft: false
      /** WEB199：作れたあと公開だけ失敗した定義。覚えておき、やり直しは同じ定義を公開する。 */
      createdDefinition?: LineNotificationDefinition
    }

/**
 * 送った文面が、いまも画面の文面と同じアカウント・同じ中身で残っているか。
 *
 * `generation`/`currentGeneration` は同一アカウント内での読み直し
 * （再読み込みボタンなど）を見分ける。`forAccountId`/`currentAccountId` は
 * アカウント切替そのものを見分ける——`currentAccountId` は描画のたびに
 * 同期して更新される ref を指すので、切替後の load が実際に走るより前の
 * 応答でも、ここだけで正しく古いと分かる（`loadGeneration` の発火待ちに
 * 頼らない）。
 */
type CustomerMutationGuard = {
  generation: number
  currentGeneration: () => number
  forAccountId: string
  currentAccountId: () => string | null
  sentFingerprint: string
  currentFingerprint: () => string | undefined
}

function isStale(guard: CustomerMutationGuard): boolean {
  return guard.generation !== guard.currentGeneration() || guard.forAccountId !== guard.currentAccountId()
}

function canSettleDraft(guard: CustomerMutationGuard, contentSaved: boolean): boolean {
  if (!contentSaved) return false
  if (isStale(guard)) return false
  return guard.currentFingerprint() === guard.sentFingerprint
}

/** 保存できたが画面の文面が先へ進んでいるときは、そのことを言い添える。 */
function savedNotice(base: string, settled: boolean): string {
  return settled ? base : `${base}そのあとに入力した分は、まだ保存していません。`
}

function customerDraftPayload(setting: EcNotificationSetting, definition: LineNotificationDefinition) {
  return {
    lineAccountId: definition.lineAccountId,
    expectedVersion: definition.version,
    name: setting.title || setting.label,
    category: definition.category,
    sourceEventType: definition.sourceEventType,
    draft: {
      ...definition.draft,
      title: setting.title,
      introText: setting.introText,
      outroText: setting.outroText,
      buttonLabel: setting.buttonLabel,
      buttonUrl: setting.buttonUrl,
      imageUrl: setting.imageUrl,
    },
  }
}

/**
 * テスト送信の呼び出し口。保存・公開と同じ isStale を使う——生成した文面
 * ではなく、応答が返った時点の account・世代の一致だけを見ればよいので、
 * 指紋の一致は問わない（呼び出し側は保存・公開と同じ guardFor を渡す）。
 */
async function sendCustomerTestNotification(args: {
  api: { testSend: typeof api.ecCommerce.testSend }
  setting: EcNotificationSetting
  accountId: string
  expectedRecipientIds: string[]
  expectedConfirmationRevision: number
  guard: CustomerMutationGuard
}): Promise<
  | { kind: 'applied'; tone: 'success' | 'error'; message: string }
  | { kind: 'stale' }
> {
  const { setting, accountId, expectedRecipientIds, expectedConfirmationRevision, guard } = args
  try {
    const result = await args.api.testSend({
      eventType: setting.eventType, accountId, title: setting.title || '',
      introText: setting.introText, outroText: setting.outroText, buttonLabel: setting.buttonLabel,
      buttonUrl: setting.buttonUrl, imageUrl: setting.imageUrl, expectedRecipientIds, expectedConfirmationRevision,
    })
    if (!result.success) throw new Error(result.error)
    // 別アカウントへ切り替わった後の応答は、いまの画面へ出さない。
    if (isStale(guard)) return { kind: 'stale' }
    return { kind: 'applied', tone: 'success', message: `テスト受信者 ${formatNumber(result.data.sent)}名へ送信しました。` }
  } catch {
    if (isStale(guard)) return { kind: 'stale' }
    return { kind: 'applied', tone: 'error', message: 'テスト送信できませんでした。テスト受信者の設定をご確認ください。' }
  }
}

export async function saveCustomerNotification(args: {
  api: CustomerMutationApi
  accountId: string
  setting: EcNotificationSetting
  definition: LineNotificationDefinition | null
  enabled: boolean
  guard: CustomerMutationGuard
}): Promise<CustomerMutationOutcome> {
  const { setting, definition, enabled, guard } = args
  let created: Awaited<ReturnType<CustomerMutationApi['createDefinition']>> | null = null
  try {
    if (definition && enabled === setting.isEnabled) {
      const result = await args.api.updateDraft(definition.id, customerDraftPayload(setting, definition))
      if (!result.success) throw new Error('save failed')
      if (isStale(guard)) return { kind: 'stale', contentSaved: true, settleDraft: false }
      const settleDraft = canSettleDraft(guard, true)
      return {
        kind: 'applied', definition: result.data, enabled, tone: 'success',
        message: savedNotice(`${setting.label}の下書きを保存しました。`, settleDraft),
        contentSaved: true, settleDraft,
      }
    }
    if (definition) {
      const result = enabled
        ? await args.api.publishDefinition(definition.id, { lineAccountId: definition.lineAccountId, expectedVersion: definition.version })
        : await args.api.stopDefinition(definition.id, { lineAccountId: definition.lineAccountId, expectedVersion: definition.version })
      if (!result.success) throw new Error('status failed')
      // 出す・止めるの切替は文面を送っていない。編集中の文面には触れない。
      if (isStale(guard)) return { kind: 'stale', contentSaved: false, settleDraft: false }
      return {
        kind: 'applied', definition: result.data, enabled, tone: 'success',
        message: `${setting.label}を保存しました。`, contentSaved: false, settleDraft: false,
      }
    }
    /*
     * N-330 (#943): 正本の定義が無い従来設定は、ここで定義を1回だけ作る。
     * 作ったあとは更新・公開・停止すべて定義側のAPIだけを使い、旧設定
     * テーブルへの二重書き込みをやめる。`key` はイベントごとに固定し、
     * 同じ設定から定義が2つ生えないようにする。
     */
    created = await args.api.createDefinition({
      lineAccountId: args.accountId,
      key: `ec:${setting.eventType}`,
      name: setting.title || setting.label,
      category: setting.category,
      sourceEventType: setting.eventType,
      draft: {
        title: setting.title,
        introText: setting.introText,
        outroText: setting.outroText,
        buttonLabel: setting.buttonLabel,
        buttonUrl: setting.buttonUrl,
        imageUrl: setting.imageUrl,
        fixedFields: setting.fixedFields,
      },
    })
    if (!created.success) throw new Error('create failed')
    if (isStale(guard)) return { kind: 'stale', contentSaved: true, settleDraft: false }
    if (!enabled) {
      // 止める側は、作った下書きをそのまま置く。公開しない限り送られない。
      const settleDraft = canSettleDraft(guard, true)
      return {
        kind: 'applied', definition: created.data, enabled: false, tone: 'success',
        message: savedNotice(`${setting.label}を保存しました。`, settleDraft),
        contentSaved: true, settleDraft,
      }
    }
    const published = await args.api.publishDefinition(created.data.id, {
      lineAccountId: args.accountId,
      expectedVersion: created.data.version,
    })
    if (!published.success) throw new Error('publish failed')
    if (isStale(guard)) return { kind: 'stale', contentSaved: true, settleDraft: false }
    const settleDraft = canSettleDraft(guard, true)
    return {
      kind: 'applied', definition: published.data, enabled: true, tone: 'success',
      message: savedNotice(`${setting.label}を保存しました。`, settleDraft),
      contentSaved: true, settleDraft,
    }
  } catch (saveFailure) {
    const fieldErrors = readSaveFieldErrors(saveFailure)
    const createdDefinition = created?.success ? created.data : undefined
    if (isStale(guard)) return { kind: 'stale', contentSaved: Boolean(createdDefinition), settleDraft: false }
    if (createdDefinition) {
      return {
        kind: 'failed', ...(Object.keys(fieldErrors).length ? { fields: fieldErrors } : {}),
        message: `${setting.label}の下書きは作りましたが、出せませんでした。もう一度お試しください。`,
        contentSaved: true,
        settleDraft: false,
        createdDefinition,
      }
    }
    return { kind: 'failed', ...(Object.keys(fieldErrors).length ? { fields: fieldErrors } : {}), message: `${setting.label}を保存できませんでした。`, contentSaved: false, settleDraft: false }
  }
}

/**
 * 公開は「いま編集している内容」を出すもの。
 * 先に下書きを保存し、その成功で返った版番号で公開する。
 *
 * 保存を挟まないと、編集中の内容を捨てて古い公開版をもう一度出したうえで
 * 端末の控えまで消してしまい、編集内容が失われる。保存できなければ公開しない。
 */
async function publishCustomerNotification(args: {
  api: CustomerMutationApi
  setting: EcNotificationSetting
  definition: LineNotificationDefinition
  guard: CustomerMutationGuard
}): Promise<CustomerMutationOutcome> {
  const { setting, definition, guard } = args
  let saved: LineNotificationDefinition
  try {
    const result = await args.api.updateDraft(definition.id, customerDraftPayload(setting, definition))
    if (!result.success) throw new Error('save before publish failed')
    saved = result.data
  } catch (saveFailure) {
    const fieldErrors = readSaveFieldErrors(saveFailure)
    if (isStale(guard)) return { kind: 'stale', contentSaved: false, settleDraft: false }
    return {
      kind: 'failed', ...(Object.keys(fieldErrors).length ? { fields: fieldErrors } : {}),
      message: `${setting.label}の下書きを保存できなかったため、公開していません。編集内容はそのまま残しています。`,
      contentSaved: false, settleDraft: false,
    }
  }
  try {
    const result = await args.api.publishDefinition(saved.id, { lineAccountId: saved.lineAccountId, expectedVersion: saved.version })
    if (!result.success) throw new Error('publish failed')
    if (isStale(guard)) return { kind: 'stale', contentSaved: true, settleDraft: false }
    const settleDraft = canSettleDraft(guard, true)
    return {
      kind: 'applied', definition: result.data, enabled: true, tone: settleDraft ? 'success' : 'error',
      message: savedNotice(`${setting.label}を公開しました。`, settleDraft),
      contentSaved: true, settleDraft,
    }
  } catch (saveFailure) {
    const fieldErrors = readSaveFieldErrors(saveFailure)
    // 下書きは入った。残っているのは公開だけ。
    if (isStale(guard)) return { kind: 'stale', contentSaved: true, settleDraft: false }
    const settleDraft = canSettleDraft(guard, true)
    return {
      kind: 'applied', ...(Object.keys(fieldErrors).length ? { fields: fieldErrors } : {}), definition: saved, enabled: setting.isEnabled, tone: 'error',
      message: savedNotice(`${setting.label}を公開できませんでした。編集内容は下書きとして保存済みです。もう一度公開を押してください。`, settleDraft),
      contentSaved: true, settleDraft,
    }
  }
}

const TABS = [
  { key: 'customer', label: '顧客へのお知らせ' },
  { key: 'operator', label: '運用者へのお知らせ' },
  { key: 'failures', label: '送れなかったもの' },
  { key: 'history', label: '記録' },
] as const

/* 出す・止める（共通のつまみ）。押すとすぐは変えず、確認の窓を開く（#734）。送っている間は押せない。 */
function NotificationToggle({ setting, busy, allowed, lockedReason, onToggle }: { setting: EcNotificationSetting; busy: boolean; allowed: boolean; lockedReason?: string; onToggle: () => void }) {
  return <SaveErrorField names={["isEnabled","setting.isEnabled","is_enabled","enabled","setting.is_enabled"]}><Toggle checked={setting.isEnabled} label={`${setting.label}のお知らせを出す・止める`} disabled={busy || !allowed} lockedReason={lockedReason} onChange={() => { if (allowed && !busy) onToggle() }} /></SaveErrorField>
}

function CardPreview({ setting }: { setting: EcNotificationSetting }) {
  return <div className="border-nen-border bg-nen-ivory overflow-hidden rounded-card border shadow-float">
    {setting.imageUrl && <img width={400} height={180} src={setting.imageUrl} alt="" className={styles.previewImage} />}
    <div className="p-5">
      <div className="border-nen-gold-soft flex items-center gap-2 border-b pb-3">
        <span className={`text-nen-green text-xl font-bold ${styles.previewBrand}`}>musubo</span>
        <span className="text-nen-label ml-auto text-nano font-semibold">LINE NOTIFICATION</span>
      </div>
      <h3 className="text-nen-green mt-4 text-xl font-bold leading-7">{setting.title}</h3>
      {setting.introText && <p className="text-nen-copy mt-3 whitespace-pre-wrap text-sm leading-6">{setting.introText}</p>}
      <div className="border-nen-gold-soft mt-4 space-y-3 border-t pt-4">
        {setting.fixedFields.slice(0, 5).map((field, index) => <div key={field}>
          <p className="text-nen-label text-nano font-bold">{field}</p>
          <p className="text-nen-ink mt-0.5 text-sm">{index === 0 ? 'ORDER-TEST-001' : index === 1 ? '商品 × 2' : '注文情報から自動表示'}</p>
        </div>)}
      </div>
      {setting.outroText && <p className="text-nen-muted mt-4 whitespace-pre-wrap text-xs leading-5">{setting.outroText}</p>}
      {setting.buttonLabel && <div className="bg-nen-green text-on-accent mt-5 rounded-card px-4 py-3 text-center text-sm font-semibold">{setting.buttonLabel}</div>}
    </div>
  </div>
}

function CustomerNotificationEditor({
  setting,
  definition,
  busy,
  onChange,
  onClose,
  onPublish,
  onSave,
  onTestSend,
  notice,
  hasUnsaved,
}: {
  setting: EcNotificationSetting
  definition: LineNotificationDefinition | null
  busy: boolean
  onChange: (patch: Partial<EcNotificationSetting>) => void
  onClose: () => void
  onPublish: () => void
  onSave: () => void
  onTestSend: () => void
  notice: { tone: 'success' | 'error'; text: string } | null
  hasUnsaved: boolean
}) {
  const titleRef = useRef<HTMLInputElement>(null)
  const [titleError, setTitleError] = useState('')
  const validateEditor = (action: () => void) => {
    if (notificationTitleRequirement.check(setting.title ?? '')) {
      setTitleError('通知の見出しを入力してください。')
      titleRef.current?.focus()
      titleRef.current?.scrollIntoView?.({ block: 'center' })
      return
    }
    setTitleError('')
    action()
  }
  return <div data-design-node="Q55bb" className="min-w-0 space-y-4">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <p className="text-xs font-semibold text-ink-faint"><Button variant="text" textTone="ink" size="inline" onClick={onClose} disabled={busy}>LINE通知</Button>　›　お知らせの種類</p>
        <p className="mt-2 text-xl font-bold text-ink">「{setting.title?.trim() || setting.label}」を編集する</p>
        <p className="mt-1 text-xs text-ink-faint">{definition ? `公開中 ${definition.currentVersionNumber ? `第${definition.currentVersionNumber}版` : emptyValue('none')} ／ 編集中の下書き` : '公開中の内容を編集します。保存した内容は次の通知から使われます。'}</p>
        {hasUnsaved ? <p className="mt-1 text-xs font-semibold text-warning">未保存の変更があります</p> : null}
      </div>
      <DialogActions padding="none"><Button onClick={onTestSend} disabled={busy}>テスト受信者に送る</Button>{definition ? <Button variant={hasUnsaved ? "secondary" : "primary"} onClick={() => validateEditor(onPublish)} disabled={busy}>顧客へのお知らせを公開</Button> : null}</DialogActions>
    </div>
    {notice && <Notice tone={notice.tone === 'success' ? 'success' : 'danger'} message={notice.text} />}

    {/* N-337: 狭い幅では見本を下に回す。390pxを無条件に横置きしない。 */}
    <div className={styles.editorGrid}>
      <div className="min-w-0 space-y-4">
        <section className="rounded-card border content-card bg-canvas p-4">
          <h2 className="font-bold text-ink">いつ送りますか</h2>
          <div className="mt-3 grid gap-3 md:grid-cols-3">
            <div><p className="text-xs font-semibold text-ink-faint">きっかけ</p><p className="mt-1 rounded-control border border-hairline px-3 py-2.5 text-sm text-ink">{triggerLabel(setting)}</p></div>
            <div><p className="text-xs font-semibold text-ink-faint">送りかた</p><p className="mt-1 rounded-control border border-hairline px-3 py-2.5 text-sm text-ink">{timingLabel(setting)}</p></div>
            <div><p className="text-xs font-semibold text-ink-faint">送る相手</p><p className="mt-1 rounded-control border border-hairline px-3 py-2.5 text-sm text-ink">{audienceLabel(setting)}</p></div>
          </div>
        </section>

        <section className="rounded-card border content-card bg-canvas p-4">
          <h2 className="font-bold text-ink">送るもの</h2>
          <div className="mt-3 space-y-4">
            <Field htmlFor="customer-notification-title" label="通知の見出し" requirement={notificationTitleRequirement} error={titleError}><SaveErrorField names={["title","setting.title","titleError","name","title_error"]}><TextField id="customer-notification-title" value={setting.title ?? ''} maxLength={80} ref={titleRef} onChange={(event) => { setTitleError(''); onChange({ title: event.target.value }) }} /></SaveErrorField></Field>
            <Field htmlFor="customer-notification-intro" label="ご案内文"><SaveErrorField names={["introText","setting.introText","intro_text","setting.intro_text"]}><TextArea id="customer-notification-intro" value={setting.introText} maxLength={800} rows={5} onChange={(event) => onChange({ introText: event.target.value })} /></SaveErrorField></Field>
            <div className="rounded-control border border-nen-border bg-nen-ivory p-4">
              <p className="text-sm font-bold text-nen-green">このお知らせで差し込める項目（EC連携から来ます）</p>
              <div className="mt-2 flex flex-wrap gap-2">{setting.fixedFields.map((field) => <span key={field} className="rounded-pill bg-canvas px-2.5 py-1 text-xs text-nen-chip ring-1 ring-nen-gold-soft">{field}</span>)}</div>
            </div>
            <Field htmlFor="customer-notification-outro" label="結びの文章"><SaveErrorField names={["outroText","setting.outroText","outro_text","setting.outro_text"]}><TextArea id="customer-notification-outro" value={setting.outroText} maxLength={800} rows={3} onChange={(event) => onChange({ outroText: event.target.value })} /></SaveErrorField></Field>
          </div>
        </section>

        <section className="rounded-card border content-card bg-canvas p-4">
          <h2 className="font-bold text-ink">ボタン</h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <Field htmlFor="customer-notification-button" label="ボタンの文字"><SaveErrorField names={["buttonLabel","setting.buttonLabel","button_label","setting.button_label"]}><TextField id="customer-notification-button" value={setting.buttonLabel} maxLength={20} onChange={(event) => onChange({ buttonLabel: event.target.value })} /></SaveErrorField></Field>
            {/* 押したら（共通の欄・YPzmo・B-129）。保存は今のまま開く URL の文字（空欄＝注文情報の URL）。 */}
            <div className="block text-sm font-semibold text-ink-secondary sm:col-span-2">押したときに開く先<div className="mt-1.5 font-medium"><UriTapActionField name="通知のボタン" kindLabel="押したときに開く先" url={setting.buttonUrl} uriPlaceholder="注文情報のURLを使う場合は空欄" onChange={(buttonUrl) => onChange({ buttonUrl })} /></div></div>
          </div>
          <div className="mt-3">
            <p className="mb-1.5 text-sm font-semibold text-ink-secondary">カード画像（未設定の場合はロゴ中心のカード）</p>
            <SaveErrorField names={["imageUrl","setting.imageUrl","image_url","setting.image_url"]}><MediaSlot
              title="カード画像を追加"
              previewAlt="カード画像"
              value={setting.imageUrl || null}
              accept="image/jpeg,image/png"

              maxBytes={10 * 1024 * 1024}
              upload={uploadImageFile}
              onChange={(url) => onChange({ imageUrl: url ?? '' })}
              urlEntry={{ value: setting.imageUrl, onChange: (url) => onChange({ imageUrl: url }), label: 'カード画像URL', placeholder: 'https://…' }}
            /></SaveErrorField>
          </div>
        </section>

        <section className="rounded-card border content-card bg-canvas p-4">
          <h2 className="font-bold text-ink">届かなかったときの決めごと</h2>
          <p className="mt-2 text-sm leading-6 text-ink-secondary">取引メールと対応済み記録は、送信台帳の接続後に設定できます。いまは受信箱から別の手だてで連絡してください。</p>
        </section>
      </div>

      <aside className="min-w-0 space-y-3">
        <section className="rounded-card border content-card bg-canvas p-4">
          {/* #988 NEXT-06: 実在の人物名を出すと「この人に届く」と誤読される。
              実際の送信先（テスト受信者／注文のお客さま）とは別物の見本だと明記する。 */}
          <p className="mb-2 text-xs font-semibold text-ink-faint">架空の注文による表示例</p>
          <CardPreview setting={setting} />
        </section>
        <Notice tone="warn">
          <h2 className="text-sm font-bold">これは「お知らせ」です</h2>
          <ul className="mt-2 space-y-2 text-sm leading-5"><li>配信を止めている人にも届きます</li><li>売り込みの文章は入れないでください</li><li>遅れると問い合わせが増えます</li></ul>
        </Notice>
        <section className="rounded-card border content-card bg-canvas p-4 text-sm">
          <h2 className="font-bold text-ink">つながる先</h2>
          {/* #988 LAY-10拡張: リンク色だけの p をやめ、実際に移動できる Link にする。 */}
          <div className="mt-2 space-y-2">
            <Link href="/ec-commerce" className="block font-bold text-action hover:underline">→ EC連携</Link>
            <Link href="/contents/vars" className="block font-bold text-action hover:underline">→ 共通情報</Link>
            <Link href="/chats" className="block font-bold text-action hover:underline">→ 受信箱</Link>
            <Link href="/nen-campaigns" className="block font-bold text-action hover:underline">→ NEN配信</Link>
            <Link href="/webhooks" className="block font-bold text-action hover:underline">→ 外部連携</Link>
          </div>
        </section>
      </aside>
    </div>

    {hasUnsaved ? <PageFooter
      status={definition ? '下書きの保存だけでは公開中の内容は変わりません。確認後に公開してください。' : '保存すると、次のお知らせから新しい文面が使われます。'}
      actions={<><Button onClick={onClose} disabled={busy}>キャンセル</Button><Button variant="primary" onClick={() => validateEditor(onSave)} disabled={busy}>{definition ? '下書きを保存する' : 'お知らせを保存する'}</Button></>}
    /> : null}
  </div>
}

function LineNotificationsPage() {
  const saveErrors = useSaveFormErrors()

  const { selectedAccountId, selectedAccount } = useAccount()
  /* 変える操作はオーナー・管理者だけ。許可が無い時も共通の理由を付けて残す。 */
  const staffRole = useStaffRole()
  const canManage = canManageRole(staffRole)
  const manageLockReason = usePermissionLockReason(canManage, 'manager')
  const canChange = canManage && !manageLockReason
  const canChangeRef = useRef(canChange)
  canChangeRef.current = canChange
  /* 運用者へのお知らせ：板の頭の「CSVで書き出す」で開く理由の窓。 */
  const [operatorExportOpen, setOperatorExportOpen] = useState(false)
  /*
   * N-340: `loadGeneration` は load の useEffect の中でしか進まない。
   * アカウント切替の描画コミットと、その useEffect が実際に発火する瞬間の
   * 間には隙間がある（渡された値が変わった描画そのものは同期的に終わるが、
   * useEffect は後回しになる）。保存・公開の応答がその隙間で返ると、
   * 世代はまだ古いままなのに画面はもう別アカウントを向いてしまっている。
   * ここは描画のたびに同期して合わせ、useEffect の発火を待たずに
   * 「いま向いているアカウント」を握っておく（保存応答の照合に使う）。
   */
  const selectedAccountRef = useRef(selectedAccountId)
  selectedAccountRef.current = selectedAccountId
  const testAccountScope = useRef({ accountId: selectedAccountId })
  if (testAccountScope.current.accountId !== selectedAccountId) testAccountScope.current = { accountId: selectedAccountId }
  const tab = useMergedTab(TABS, 'tab', 'customer')
  const [settings, setSettings] = useState<EcNotificationSetting[]>([])
  // 読めたことの確かめだけに使う（WEB198：件数としては出さない）。
  const [, setOverview] = useState<EcCommerceOverview | null>(null)
  const [definitions, setDefinitions] = useState<LineNotificationDefinition[]>([])
  const [sendCounts, setSendCounts] = useState<LineNotificationSendCounts | null>(null)
  // send-countsだけ取れなかった・形が違ったときの印。一覧全体は表示を続ける。
  const [sendCountsFailed, setSendCountsFailed] = useState(false)
  const [quota, setQuota] = useState<LineNotificationQuota | null>(null)
  const [filter, setFilter] = useListUrlValue<CustomerFilter>('filter', 'all')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [loadState, setLoadState] = useState<CustomerLoadState>('loading')
  const [busy, setBusy] = useState<string | null>(null)
  const [pendingToggle, setPendingToggle] = useState<{ setting: EcNotificationSetting; accountId: string; accountName: string | null; scope: object; generation: number } | null>(null)
  const [definitionsFailed, setDefinitionsFailed] = useState(false)
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null)
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false)
  /*
   * #988 NEXT-05: 「自分にテスト送信」は実際にはアカウントの test_recipients
   * （最大20名）へ送る。クリック即APIではなく、宛先と人数を見せる確認を挟む。
   * 開いただけでは送らない。宛先が0人・読み込み失敗のときは送信ボタンを出さない。
   */
  const [testSendDraft, setTestSendDraft] = useState<{ setting: EcNotificationSetting; accountId: string; accountName: string | null; scope: object; generation: number } | null>(null)
  const [testRecipients, setTestRecipients] = useState<{
    state: 'loading' | 'ready' | 'error'
    items: Array<{ id: string; displayName: string; pictureUrl: string | null }>
    confirmationRevision?: number
  }>({ state: 'loading', items: [] })
  const testRecipientGeneration = useRef(0)
  useEffect(() => {
    if (canChange) return
    setExpanded(null); setPendingToggle(null); setTestSendDraft(null)
    testRecipientGeneration.current += 1
  }, [canChange])
  // N-341: 運用者タブの件数は実データで出す。子部品とは別に親で取る。
  const [operatorCount, setOperatorCount] = useState<number | null>(null)
  const [operatorState, setOperatorState] = useState<OperatorTabState>('loading')
  // M031: 捕まえた件数取得の失敗。403・429の言い分けと再試行の有無に使う。
  const [operatorCountError, setOperatorCountError] = useState<unknown>(null)
  // M031: 顧客タブの読み込み失敗。ListState の error へ渡す。
  const [customerLoadError, setCustomerLoadError] = useState<unknown>(null)
  // N-340: 保存していない編集のあるお知らせ。離脱警告と復元の目印。
  const [dirtyEvents, setDirtyEvents] = useState<readonly string[]>([])
  // N-340: 保存済みの姿。編集中に戻るときの戻し先。
  const lastSavedRef = useRef(new Map<string, EcNotificationSetting>())
  // N-340: いま画面にある文面の指紋。保存の応答が「いまの文面のものか」を見る。
  // 描画ではなく操作の中で見るので、state ではなく ref に置く。
  const editFingerprintRef = useRef(new Map<string, string>())
  const loadGeneration = useRef(0)
  const loadedAccountScope = useRef<object | null>(null)

  const load = useCallback(async () => {
    const generation = loadGeneration.current + 1
    loadGeneration.current = generation
    const scope = testAccountScope.current
    loadedAccountScope.current = null
    setLoadState('loading')
    // アカウント切替中に前のアカウントの件数を残さない。
    setSettings([])
    setOverview(null)
    setDefinitions([])
    setSendCounts(null)
    setSendCountsFailed(false)
    setQuota(null)
    setNotice(null)
    setCloseConfirmOpen(false)
    // WEB197：出す・止めるの確認も、前のアカウントの通知のまま残さない。
    setPendingToggle(null)
    // アカウントを切り替えたら、前のアカウント宛の確認は残さない。
    setTestSendDraft(null)
    testRecipientGeneration.current += 1
    setOperatorCount(null)
    setOperatorState('loading')
    setOperatorCountError(null)
    setCustomerLoadError(null)
    setDirtyEvents([])
    setBusy(null)
    lastSavedRef.current = new Map()
    editFingerprintRef.current = new Map()
    if (!selectedAccountId) {
      setLoadState('ready')
      return
    }
    /*
     * 再開点の見張り。保存・公開・テスト送信の3経路と同じ形にそろえる（#695 T3）。
     *
     * 世代（loadGeneration）だけでは、アカウント切替の描画コミット後・この
     * load を差し替える次の load が発火する前の隙間を見分けられない。
     * 描画のたびに同期する selectedAccountRef も見て、この load が
     * 「いま画面が向いているアカウントのものか」を確かめる。
     */
    const stale = () => generation !== loadGeneration.current || selectedAccountId !== selectedAccountRef.current || scope !== testAccountScope.current
    // N-341: 運用者タブの件数だけ先に実数で取る。顧客タブの成否とは切り分ける。
    try {
      const operatorRes = await api.lineNotifications.operatorRules.list(selectedAccountId)
      if (stale()) return
      if (!operatorRes.success) throw new Error('operator count failed')
      setOperatorCount(operatorRes.data.summary.total)
      setOperatorState('ready')
      setOperatorCountError(null)
    } catch (error) {
      if (stale()) return
      setOperatorCount(null)
      setOperatorState(error instanceof ApiError && error.status === 403 ? 'forbidden' : 'error')
      setOperatorCountError(error)
    }
    // 顧客タブだけが定義・集計を読む。運用者・記録タブは子部品が自前で取る（#509 軽1）。
    // 設定口は列車側で店別になったため、持ち回しはしない。
    const needCustomer = tab === 'customer'
    try {
      const [settingRes, overviewRes, definitionRes, sendCountsRes, quotaRes] = await Promise.all([
        api.ecCommerce.settings(selectedAccountId), api.ecCommerce.overview(selectedAccountId),
        needCustomer
          ? api.lineNotifications.definitions(selectedAccountId).catch((error: unknown) => {
              if (error instanceof ApiError && error.status === 403) throw error
              return null
            })
          : Promise.resolve(null),
        needCustomer
          ? api.lineNotifications.sendCounts(selectedAccountId).catch((error: unknown) => {
              if (error instanceof ApiError && error.status === 403) throw error
              return null
            })
          : Promise.resolve(null),
        needCustomer
          ? fetchApi<{ success: true; data: { quota: LineNotificationQuota } }>(
              `/api/line-notifications/deliveries?lineAccountId=${encodeURIComponent(selectedAccountId)}&view=all&limit=1&offset=0&includeQuota=1`,
            ).catch((error: unknown) => {
              if (error instanceof ApiError && error.status === 403) throw error
              return {
                success: true as const,
                data: {
                  quota: {
                    state: 'unavailable' as const,
                    total: null,
                    used: null,
                    remaining: null,
                    asOf: null,
                    reason: 'LINEから送信枠を読み込めませんでした',
                  },
                },
              }
            })
          : Promise.resolve(null),
      ])
      if (stale()) return
      if (!settingRes.success || !overviewRes.success) throw new Error('load failed')
      const loadedDefinitions = definitionRes?.success ? definitionRes.data : []
      // WEB199：定義が読めなかったことを「定義が無い」と見なさない（作り直して重複にしない）。
      setDefinitionsFailed(needCustomer && !definitionRes?.success)
      const loadedDefinitionByEvent = new Map(loadedDefinitions.map((definition) => [definition.sourceEventType, definition]))
      const mergedSettings = settingRes.data.map((setting) => {
        const definition = loadedDefinitionByEvent.get(setting.eventType)
        if (!definition) return setting
        const draftText = (key: string, fallback: string): string => typeof definition.draft[key] === 'string' ? definition.draft[key] as string : fallback
        const draftFields = Array.isArray(definition.draft.fixedFields)
          ? definition.draft.fixedFields.filter((value): value is string => typeof value === 'string')
          : setting.fixedFields
        return {
          ...setting,
          isEnabled: definition.status === 'published',
          title: draftText('title', definition.name),
          introText: draftText('introText', setting.introText),
          outroText: draftText('outroText', setting.outroText),
          buttonLabel: draftText('buttonLabel', setting.buttonLabel),
          buttonUrl: draftText('buttonUrl', setting.buttonUrl),
          imageUrl: draftText('imageUrl', setting.imageUrl),
          fixedFields: draftFields,
          updatedAt: definition.updatedAt,
        }
      })
      // N-340: 保存済みの姿を覚え、端末に残った下書きがあれば重ねる。
      lastSavedRef.current = new Map(mergedSettings.map((setting) => [setting.eventType, setting]))
      const restoredEvents: string[] = []
      const withDrafts = selectedAccountId ? mergedSettings.map((setting) => {
        const draft = readCustomerDraft(selectedAccountId, setting.eventType)
        if (!draft) return setting
        if (isSameCustomerDraft(setting, draft)) {
          clearCustomerDraft(selectedAccountId, setting.eventType)
          return setting
        }
        restoredEvents.push(setting.eventType)
        return { ...setting, ...draft }
      }) : mergedSettings
      editFingerprintRef.current = new Map(withDrafts.map((setting) =>
        [setting.eventType, customerDraftFingerprint(pickCustomerDraft(setting))]))
      setSettings(withDrafts)
      setOverview(overviewRes.data)
      setDefinitions(loadedDefinitions)
      if (sendCountsRes?.success && isSendCountsData(sendCountsRes.data)) {
        setSendCounts(sendCountsRes.data)
        setSendCountsFailed(false)
      } else if (needCustomer) {
        // 顧客タブで読もうとして取れなかった・形が違ったときだけ「読み込めなかった」にする。
        // 運用者・記録タブでは読んでいないので失敗扱いにしない。
        setSendCounts(null)
        setSendCountsFailed(true)
      } else {
        setSendCounts(null)
        setSendCountsFailed(false)
      }
      setQuota(quotaRes?.success ? quotaRes.data.quota : null)
      setExpanded((current) => withDrafts.some((setting) => setting.eventType === current) ? current : null)
      if (restoredEvents.length > 0) {
        setDirtyEvents(restoredEvents)
        notifySaved(`未保存の編集を${formatNumber(restoredEvents.length)}件復元しました。確認して保存してください。`)
      }
      loadedAccountScope.current = scope
      setLoadState('ready')
      setCustomerLoadError(null)
    } catch (error) {
      const fieldFailure = saveErrors.capture(error);

      if (!stale()) {
        // ★管理画面 `x63W5x`：一覧の失敗でページ上の帯は出さない。
        // 一覧の場所の ListState error だけにまとめる。
        setLoadState(error instanceof ApiError && error.status === 403 ? 'forbidden' : 'error')
        // M031: 捕まえた失敗を ListState へ渡す。403は再試行なし、429は待ち案内になる。
        if (!fieldFailure) {
        setCustomerLoadError(error) }
      }
    }
  }, [selectedAccountId, tab, saveErrors])
  useEffect(() => { void load(); return () => { loadGeneration.current += 1 } }, [load])

  /*
   * 行の「今日」「この30日」は実際の送信履歴（send-counts）で数える。
   * ECの取り込み件数（overview.byType）やLINE集計の全期間合計（metrics）は
   * 混ぜない。口がまだ返っていないときだけ null（「—」表示）にする。
   */
  const sendCountMaps = useMemo(() => {
    // 形が違う値が混ざっても落ちないよう、配列のときだけ数える。
    const rows = Array.isArray(sendCounts?.byEventType) ? sendCounts.byEventType : []
    return {
      today: new Map(rows.map((item) => [item.eventType, item.today])),
      last30d: new Map(rows.map((item) => [item.eventType, item.last30d])),
    }
  }, [sendCounts])
  // N-338: 行の「今日」列と同じ数で多い順に並べ、説明文と一致させる。
  const sentCountOf = useCallback((eventType: string): number | null =>
    sendCounts ? (sendCountMaps.today.get(eventType) ?? 0) : null, [sendCounts, sendCountMaps])
  const sent30dOf = useCallback((eventType: string): number | null =>
    sendCounts ? (sendCountMaps.last30d.get(eventType) ?? 0) : null, [sendCounts, sendCountMaps])
  const visible = useMemo(() => sortCustomerSettingsBySentCount(settings.filter((setting) => {
    if (filter === 'enabled') return setting.isEnabled
    if (filter === 'stopped') return !setting.isEnabled
    if (filter === 'incomplete') return isIncomplete(setting)
    return true
  }), sentCountOf), [filter, settings, sentCountOf])
  const expandedSetting = settings.find((setting) => setting.eventType === expanded) ?? null
  const definitionByEvent = useMemo(() => new Map(definitions.map((definition) => [definition.sourceEventType, definition])), [definitions])
  const filterCount = (value: CustomerFilter): number => {
    if (value === 'enabled') return settings.filter((setting) => setting.isEnabled).length
    if (value === 'stopped') return settings.filter((setting) => !setting.isEnabled).length
    if (value === 'incomplete') return settings.filter(isIncomplete).length
    return settings.length
  }
  const sentBreakdown = useMemo(() => buildSentBreakdown(sendCounts?.byEventType, settings), [sendCounts, settings])
  /*
   * R611: 一覧の取得に失敗したときは、上部の件数・送信枠も「取得中」の
   * ままにしない。値は「—」のまま、注記を失敗の言葉へ変える。
   * 権限不足も同じく、取れていないのに「取得中」とは出さない。
   */
  const customerLoadFailed = loadState === 'error' || loadState === 'forbidden'
  const kpis = customerNotificationKpis({
    ready: loadState === 'ready',
    sentToday: typeof sendCounts?.sentToday === 'number' ? sendCounts.sentToday : null,
    sentLast30d: typeof sendCounts?.sentLast30d === 'number' ? sendCounts.sentLast30d : null,
    sentBreakdown,
    // WEB198：EC の取り込み失敗（overview.failed）は「送れなかったお知らせ」の数ではない。
    // 送れなかった通数を返す口がまだ無いので「—」にする（Codex に依頼）。
    failed: null,
    quota,
    loadFailed: customerLoadFailed,
  })
  /*
   * send-countsだけ取れなかったときは、そのカードだけ「読み込めませんでした」にする。
   * 一覧全体は ListState error にしない（設定・定義は表示を続ける）。
   * 見た目は共通の失敗の1枚と同じ中立（赤を使わない。★管理画面 `x63W5x`）。
   */
  const kpisWithSendCountsState = sendCountsFailed
    ? kpis.map((kpi) => kpi.label === '今日 送った' ? { ...kpi, note: '送信件数を読み込めませんでした' } : kpi)
    : kpis
  const tabsWithCounts = TABS.map((item) => {
    if (item.key === 'customer') return { ...item, label: `${item.label} ${loadState === 'ready' ? settings.length : emptyValue('unknown')}` }
    // N-341: 運用者タブの件数は実データ。取れなかったときは「取得失敗」と区別する。
    if (item.key === 'operator') return { ...item, label: `${item.label} ${operatorTabCountLabel(operatorState, operatorCount)}` }
    // WEB198：EC の取り込み失敗の数を「送れなかった」の件数として出さない。
    if (item.key === 'failures') return item
    return item
  })
  const update = (eventType: string, patch: Partial<EcNotificationSetting>) => setSettings((current) => current.map((setting) => setting.eventType === eventType ? { ...setting, ...patch } : setting))
  // 板 ：共通の数カード4枚。0件のときは押し口を出さない。押しても何も無い。
  // 共通カードは数しか受けないので、「上限なし」の文字は valueText へ回す。
  const renderKpiCard = (kpi: CustomerNotificationKpi) => (
    <KpiCard
      key={kpi.label}
      presentation="band"
      icon={<Inbox size={16} aria-hidden="true" />}
      title={kpi.label}
      value={typeof kpi.value === 'number' || kpi.value === null ? kpi.value : null}
      valueText={kpi.valueText ?? (typeof kpi.value === 'string' ? kpi.value : undefined)}
      unit={kpi.label === '送れなかった' ? '件' : (kpi.unit ?? '')}
      valueTextWithUnit
      detail={kpi.note || null}
      detailLayout={kpi.label === '今日 送った' ? 'single' : undefined}
      valueTone={kpi.label === '送れなかった' && typeof kpi.value === 'number' && kpi.value > 0 ? 'warning' : 'default'}
      loading={loadState === 'loading'}
      action={canOpenCustomerNotificationKpi(kpi) && kpi.href ? { label: '見る', href: kpi.href } : undefined}
    />
  )
  // N-340: 入力のたびに端末へ下書きを置き、未保存の印を付ける。
  const edit = (eventType: string, patch: Partial<EcNotificationSetting>) => {
    if (!canChange) return
    const current = settings.find((setting) => setting.eventType === eventType)
    if (current) {
      const draft = pickCustomerDraft({ ...current, ...patch })
      if (selectedAccountId) writeCustomerDraft(selectedAccountId, eventType, draft)
      // 保存中でも入力は続けられる。1打ごとに指紋を進め、飛んでいる保存を古いものにする。
      editFingerprintRef.current.set(eventType, customerDraftFingerprint(draft))
    }
    update(eventType, patch)
    setDirtyEvents((prev) => prev.includes(eventType) ? prev : [...prev, eventType])
  }
  // N-340: 編集中に戻るとき、未保存があれば警告し、閉じるなら保存済みへ戻す。
  const closeEditor = (setting: EcNotificationSetting) => {
    if (!dirtyEvents.includes(setting.eventType)) { setExpanded(null); return }
    setCloseConfirmOpen(true)
  }
  const discardEditorChanges = (setting: EcNotificationSetting) => {
    const saved = lastSavedRef.current.get(setting.eventType)
    if (saved) {
      update(setting.eventType, { ...saved })
      editFingerprintRef.current.set(setting.eventType, customerDraftFingerprint(pickCustomerDraft(saved)))
    }
    if (selectedAccountId) clearCustomerDraft(selectedAccountId, setting.eventType)
    setDirtyEvents((prev) => prev.filter((value) => value !== setting.eventType))
    setCloseConfirmOpen(false)
    setExpanded(null)
  }
  // N-340: 未保存のまま再読込・タブを閉じるときは警告する。
  useEffect(() => {
    if (dirtyEvents.length === 0) return
    const handler = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [dirtyEvents.length])

  /*
   * N-340/N-341: 応答が返った時点で、まだ同じアカウントを見ているときだけ画面へ書く。
   * 端末の控えを消す・未保存の印を外すのは、送った文面がそのまま画面に残っている
   * ときだけ（`settleDraft`）。保存中に足された入力を消さないため。
   */
  const mutationApi: CustomerMutationApi = {
    updateDraft: api.lineNotifications.updateDraft,
    publishDefinition: api.lineNotifications.publishDefinition,
    stopDefinition: api.lineNotifications.stopDefinition,
    createDefinition: api.lineNotifications.createDefinition,
  }
  const guardFor = (setting: EcNotificationSetting): CustomerMutationGuard => ({
    generation: loadGeneration.current,
    currentGeneration: () => loadGeneration.current,
    forAccountId: selectedAccountId ?? '',
    currentAccountId: () => selectedAccountRef.current,
    sentFingerprint: customerDraftFingerprint(pickCustomerDraft(setting)),
    currentFingerprint: () => editFingerprintRef.current.get(setting.eventType),
  })
  const applyOutcome = (
    accountId: string,
    setting: EcNotificationSetting,
    generation: number,
    outcome: CustomerMutationOutcome,
  ) => {
    if (outcome.kind === 'stale' || generation !== loadGeneration.current) return
    if (outcome.settleDraft) {
      // 送った文面がそのまま画面に残っている。ここで初めて「保存済み」にする。
      clearCustomerDraft(accountId, setting.eventType)
      lastSavedRef.current.set(setting.eventType, { ...setting, isEnabled: outcome.enabled })
      setDirtyEvents((prev) => prev.filter((value) => value !== setting.eventType))
    }
    if (outcome.kind === 'failed') {
      // WEB199：作れた定義は一覧に足す（やり直しで同じキーの作成をもう一度送らない）。
      const createdDefinition = outcome.createdDefinition
      if (createdDefinition) {
        setDefinitions((current) => current.some((item) => item.id === createdDefinition.id)
          ? current.map((item) => item.id === createdDefinition.id ? createdDefinition : item)
          : [...current, createdDefinition])
      }
      if (!saveErrors.apply(outcome.fields ?? {}))
      setNotice({ tone: 'error', text: outcome.message });

      return
    }
    const saved = outcome.definition
    // N-330: 従来設定から作った新しい定義は、一覧に無いので足す。
    if (saved) setDefinitions((current) => current.some((item) => item.id === saved.id)
      ? current.map((item) => item.id === saved.id ? saved : item)
      : [...current, saved])
    update(setting.eventType, { isEnabled: outcome.enabled })
    if (!outcome.contentSaved) {
      // 出す・止めるの切替は文面を送っていない。戻し先の出・止めだけを直し、文面は触らない。
      const previous = lastSavedRef.current.get(setting.eventType)
      if (previous) lastSavedRef.current.set(setting.eventType, { ...previous, isEnabled: outcome.enabled })
    }
    if (outcome.tone !== 'error' || !saveErrors.apply(outcome.fields ?? {}))
    setNotice({ tone: outcome.tone, text: outcome.message })
  }

  const save = async (setting: EcNotificationSetting, enabled = setting.isEnabled) => {
    if (!canChange) return
    if (enabled === setting.isEnabled && !dirtyEvents.includes(setting.eventType)) return
    if (notificationTitleRequirement.check(setting.title ?? '')) { setNotice({ tone: 'error', text: '通知の見出しを入力してください。' }); return }
    if (!selectedAccountId) { setNotice({ tone: 'error', text: 'LINEアカウントを選択してください。' }); return }
    if (definitionsFailed && !definitionByEvent.get(setting.eventType)) {
      setNotice({ tone: 'error', text: 'お知らせの設定を読み込めなかったため、保存できません。読み直してから、もう一度お試しください。' })
      return
    }
    const accountId = selectedAccountId
    const guard = guardFor(setting)
    setBusy(setting.eventType)
    const outcome = await saveCustomerNotification({
      api: mutationApi,
      accountId,
      setting,
      definition: definitionByEvent.get(setting.eventType) ?? null,
      enabled,
      guard,
    })
    applyOutcome(accountId, setting, guard.generation, outcome)
    if (guard.generation !== loadGeneration.current || outcome.kind === 'stale') return
    setBusy(null)
    return outcome.kind === 'applied' && outcome.tone === 'success'
  }

  const publish = async (setting: EcNotificationSetting) => {
    if (!canChange) return
    const definition = definitionByEvent.get(setting.eventType)
    if (!definition) return
    if (!selectedAccountId) { setNotice({ tone: 'error', text: 'LINEアカウントを選択してください。' }); return }
    const accountId = selectedAccountId
    const guard = guardFor(setting)
    setBusy(setting.eventType)
    const outcome = await publishCustomerNotification({ api: mutationApi, setting, definition, guard })
    applyOutcome(accountId, setting, guard.generation, outcome)
    if (guard.generation === loadGeneration.current) setBusy(null)
  }

  /*
   * #988 NEXT-05: ボタンを押してもまだ送らない。アカウントに登録された
   * テスト受信者を取り、宛先・人数を見せる確認を開く。確認の中で
   * 「送信」を押して初めて testSend が走る。
   */
  const openTestSendConfirm = (setting: EcNotificationSetting) => {
    if (!canChange) return
    if (!selectedAccountId) { setNotice({ tone: 'error', text: 'LINEアカウントを選択してください。' }); return }
    if (loadedAccountScope.current !== testAccountScope.current) return
    const accountId = selectedAccountId
    const generation = ++testRecipientGeneration.current
    const scope = testAccountScope.current
    setTestSendDraft({ setting, accountId, accountName: selectedAccount?.id === accountId ? selectedAccount.name : null, scope, generation })
    setTestRecipients({ state: 'loading', items: [] })
    api.accountSettings.getTestRecipients(accountId).then((result) => {
      // 閉じた・開き直した・アカウント切替のあとに返った古い応答は捨てる。
      if (generation !== testRecipientGeneration.current || accountId !== selectedAccountRef.current || scope !== testAccountScope.current) return
      if (result.success) setTestRecipients({ state: 'ready', items: result.data, confirmationRevision: result.confirmationRevision })
      else setTestRecipients({ state: 'error', items: [] })
    }).catch(() => {
      if (generation !== testRecipientGeneration.current || accountId !== selectedAccountRef.current || scope !== testAccountScope.current) return
      setTestRecipients({ state: 'error', items: [] })
    })
  }
  const closeTestSendConfirm = () => {
    setTestSendDraft(null)
    testRecipientGeneration.current += 1
  }
  const confirmTestSend = () => {
    const target = testSendDraft
    return canChangeRef.current && target && target.scope === testAccountScope.current && target.generation === testRecipientGeneration.current && target.accountId === selectedAccountRef.current && testRecipients.state === 'ready' && testRecipients.items.length > 0 && testRecipients.confirmationRevision !== undefined ? testSend(target.setting, testRecipients.items.map((item) => item.id), testRecipients.confirmationRevision) : undefined
  }

  const testSend = async (setting: EcNotificationSetting, expectedRecipientIds: string[], expectedConfirmationRevision: number) => {
    if (!canChange) return
    if (!selectedAccountId) { setNotice({ tone: 'error', text: 'LINEアカウントを選択してください。' }); return }
    const accountId = selectedAccountId
    // 保存・公開とまったく同じ見張りを渡す。テスト送信の結果も「返った時点で
    // 同じアカウント・同じ世代を見ているか」で入れる・入れないを決める。
    const guard = guardFor(setting)
    setBusy(setting.eventType)
    const outcome = await sendCustomerTestNotification({
      api: { testSend: api.ecCommerce.testSend },
      setting,
      accountId,
      expectedRecipientIds,
      expectedConfirmationRevision,
      guard,
    })
    if (outcome.kind === 'stale') return
    setNotice({ tone: outcome.tone, text: outcome.message })
    setBusy(null)
    return outcome.tone === 'success'
  }

  const tabHref: Record<string, string> = {
    customer: '/line-notifications',
    operator: '/line-notifications?tab=operator',
    failures: '/line-notifications?tab=failures',
    history: '/line-notifications?tab=history',
  }
  const statusOf = customerNotificationStatus

  return <SaveErrorScope errors={saveErrors}><SbSettingsScreen
    boardId={expandedSetting === null ? ({ customer: 'g3iDs', operator: 'u8xibp', failures: 'DrwMm', history: 'PZBVb' } as Record<string, string>)[tab] : undefined}
    contentLayout={tab === 'customer' ? 'wide' : undefined}
    actions={tab === 'operator' && expandedSetting === null ? <>
      <Button onClick={() => { if (canChange) setOperatorExportOpen(true) }} disabled={!selectedAccountId || !canChange} lockedReason={manageLockReason}><Download aria-hidden="true" size={16} />CSVで書き出す</Button>
      <Button {...(canChange ? { href: "/line-notifications/operator/new" } : { disabled: true })} variant="primary" lockedReason={manageLockReason}><Plus aria-hidden="true" size={16} />運用者へのお知らせを作る</Button>
    </> : undefined}
    title="LINE通知" help={tab === 'customer' ? '注文・入金・発送・返金・定期便など、取引に必要なお知らせを LINE で送ります。' : tab === 'failures' ? '送れなかった理由や再試行の予定を確かめます。ブロックなどの対象外と、再試行が必要な失敗を分けて確認してください。' : undefined}
    explanationKey={`line-notifications:${tab}`}
    explanation={tab === 'customer' ? 'これは「お知らせ」であって「売り込みの配信」ではありません。お客さまが配信を止めていても、取引に必要な連絡は届きます。' : tab === 'operator' ? 'この画面の宛先はお店の人だけです。お客様へ送るものは「顧客へのお知らせ」で設定します。' : '注文・入金・発送・返金・定期便など、取引に必要なお知らせを LINE で送ります。'}
  >
    {expandedSetting === null ? <Tabs label="LINE通知の中の切り替え" size="notification" items={tabsWithCounts.map(item => ({ label: item.label, href: tabHref[item.key], current: tab === item.key }))} /> : null}
    {/*
      * #634・M031：運用者タブの件数だけが取れなかったとき、その場所に小さく1行だけ。403 は権限変更後に読み直せるようにする。
      */}
    {expandedSetting === null && (operatorState === 'error' || operatorState === 'forbidden') ? (
      <Notice tone="danger" className={styles.minorNoticePlacement} >{isForbiddenOrRateLimited(operatorCountError)
          ? loadFailureNotice(operatorCountError, '運用者へのお知らせ')
          : '運用者へのお知らせの件数を読み込めませんでした。'}
        <Button variant="text" size="inline" type="button" onClick={() => void load()} data-notice-inline-action>もう一度読み込む</Button></Notice>
    ) : null}
    {staffRole !== null && !canChange && expandedSetting === null ? <section className={styles.viewerBand} aria-label="操作権限の案内">
      {staffRole === 'viewer' && manageLockReason !== PERMISSION_LOCK_REASON.impersonation
        ? <ReadOnlyNotice />
        : <Notice tone="info" role="status">{manageLockReason === PERMISSION_LOCK_REASON.impersonation
          ? PERMISSION_LOCK_SUMMARY.impersonation
          : PERMISSION_LOCK_SUMMARY.manager}</Notice>}
    </section> : null}
    {tab === 'failures' ? <RunsTab lineAccountId={selectedAccountId} mode="failures" /> : null}
    {tab === 'history' ? <RunsTab lineAccountId={selectedAccountId} mode="history" /> : null}
    {tab === 'operator' ? <OperatorTab lineAccountId={selectedAccountId} canManage={canChange} exportOpen={operatorExportOpen} onExportClose={() => setOperatorExportOpen(false)} /> : null}
    {tab === 'customer' && expandedSetting ? <>
      <CustomerNotificationEditor
        setting={expandedSetting}
        definition={definitionByEvent.get(expandedSetting.eventType) ?? null}
        busy={busy === expandedSetting.eventType}
        onChange={(patch) => edit(expandedSetting.eventType, patch)}
        onClose={() => closeEditor(expandedSetting)}
        onPublish={() => void publish(expandedSetting)}
        onSave={() => void save(expandedSetting)}
        onTestSend={() => openTestSendConfirm(expandedSetting)}
        notice={notice}
        hasUnsaved={dirtyEvents.includes(expandedSetting.eventType)}
      />
      <ConfirmDialog
        open={closeConfirmOpen}
        title="保存していない編集を破棄しますか？"
        description="破棄すると、入力中の内容は保存済みの内容へ戻ります。この操作は取り消せません。"
        confirmLabel="編集を破棄"
        cancelLabel="編集を続ける"
        destructive
        onConfirm={() => discardEditorChanges(expandedSetting)}
        onCancel={() => setCloseConfirmOpen(false)}
      />
      {/*
        * #988 NEXT-05: 送信前に「どのアカウントの・何を・誰に・何人へ」送るかを
        * 確認させる。宛先が読めていない・0人のときは onConfirm を渡さず、
        * 送信ボタンそのものを出さない（ConfirmDialog の作り）。
        */}
      <ConfirmDialog
        open={testSendDraft !== null && testSendDraft.scope === testAccountScope.current}
        title="テスト受信者に送信しますか？"
        description="編集中の文面を、テスト受信者として登録されている人へ送ります。お客さま全員への一斉配信ではありません。"
        confirmLabel={testRecipients.items.length > 0 ? `テスト受信者 ${formatNumber(testRecipients.items.length)}名へ送信` : 'テスト受信者に送信'}
        busy={busy === testSendDraft?.setting.eventType}
        error={notice?.tone === 'error' ? notice.text : testRecipients.state === 'error' ? 'テスト受信者を読み込めませんでした。時間をおいて、もう一度お試しください。' : undefined}
        onSuccess={closeTestSendConfirm}
        onConfirm={testRecipients.state === 'ready' && testRecipients.items.length > 0 ? confirmTestSend : undefined}
        onCancel={closeTestSendConfirm}
      >
        {testSendDraft ? <OperationTargetSummary accounts={[{ id: testSendDraft.accountId, name: testSendDraft.accountName }]} /> : null}
        <dl className="space-y-3 text-sm">
          <div>
            <dt className="text-xs font-semibold text-ink-faint">送るお知らせ</dt>
            <dd className="mt-0.5 text-ink">「{testSendDraft?.setting.title?.trim() || testSendDraft?.setting.label}」</dd>
          </div>
          <div>
            <dt className="text-xs font-semibold text-ink-faint">宛先</dt>
            <dd className="mt-0.5 text-ink">
              {testRecipients.state === 'loading' ? 'テスト受信者を読み込んでいます…'
                : testRecipients.state === 'error' ? 'テスト受信者を読み込めませんでした。時間をおいて、もう一度お試しください。'
                : testRecipients.items.length === 0
                  ? <>テスト受信者が登録されていません。<Link href={`/accounts/detail?id=${encodeURIComponent(selectedAccountId ?? '')}`} className="text-action hover:underline">アカウント設定</Link>で登録してください。</>
                  : `${testRecipients.items.map((item) => item.displayName).join('・')}（${formatNumber(testRecipients.items.length)}名）`}
            </dd>
          </div>
        </dl>
      </ConfirmDialog>
    </> : null}
    {/*
      * #734: 通知の出す・止めるはお客さまへのLINEに直結するので、
      * 1クリックの即時切替ではなく確認窓を1回挟む（誤タップ防止）。
      * 一覧（expandedSetting が無い状態）から開くので、編集画面の条件の
      * 中には置かない。
      */}
    <ConfirmDialog
      open={pendingToggle !== null && pendingToggle.scope === testAccountScope.current}
      title={pendingToggle?.setting.isEnabled ? `「${pendingToggle.setting.label}」のお知らせを止めますか？` : `「${pendingToggle?.setting.label ?? ''}」のお知らせを出しますか？`}
      description={pendingToggle?.setting.isEnabled ? '止めると、この出来事が起きてもお客さまへLINEが送られなくなります。あとからまた出せます。' : '出すと、この出来事が起きたお客さまへLINEが送られ始めます。'}
      confirmLabel={pendingToggle?.setting.isEnabled ? 'お知らせを止める' : 'お知らせを出す'}
      busy={busy === pendingToggle?.setting.eventType}
      error={notice?.tone === 'error' ? notice.text : undefined}
      onSuccess={() => setPendingToggle(null)}
      onConfirm={pendingToggle ? () => canChangeRef.current && pendingToggle.scope === testAccountScope.current && pendingToggle.generation === loadGeneration.current ? save(pendingToggle.setting, !pendingToggle.setting.isEnabled) : undefined : undefined}
      onCancel={() => setPendingToggle(null)}
    >
      {pendingToggle ? <OperationTargetSummary accounts={[{ id: pendingToggle.accountId, name: pendingToggle.accountName }]} /> : null}
    </ConfirmDialog>
    {tab === 'customer' && !expandedSetting ? <>
    {/* 板 g3iDs：数のカード4枚（共通の KpiBand・KpiCard）。 */}
    <KpiBand presentation="band" data-design="KPIs">
      {kpisWithSendCountsState.map(renderKpiCard)}
    </KpiBand>
    {/* R611: 一覧の取得に失敗したときは、上部の件数も取れていないことを添える（赤は使わない）。 */}
    {loadState === 'error' ? <p className={styles.minor}>お知らせの件数は取得失敗です。下の一覧の「もう一度読み込む」から読み直してください。</p> : null}
    {sendCountsFailed && loadState === 'ready' ? <div className={styles.inlineRow}>
      <p className={styles.minor}>送信件数を読み込めませんでした。時間をおいて、もう一度お試しください。</p>
      <Button variant="secondary" size="compact" onClick={() => load()} busyLabel="処理中…">もう一度読み込む</Button>
    </div> : null}

    {/* 板 g3iDs：絞り込みは共通の札。並びは送った数が多い順のまま。 */}
    <div className={styles.toolbar} aria-label="お知らせの絞り込み">
      <SegmentedControl
        aria-label="お知らせの絞り込み"
        value={filter}
        onChange={setFilter}
        options={customerFilters.map(([value, label]) => ({
          value,
          label,
          count: loadState === 'ready' ? filterCount(value) : undefined,
        }))}
      />
    </div>

    {notice && <Notice tone={notice.tone === 'success' ? 'success' : 'danger'} message={notice.text} />}

    <ListFolderContext.Provider value={false}><Card padding="rows" overflow="hidden" data-design-node="festr" data-list-state={loadState === 'ready' && settings.length === 0 ? 'empty' : loadState}>
      {loadState === 'loading' ? (
        <div aria-busy="true" aria-label="顧客へのお知らせを読み込んでいます">
          <DelayedSkeleton
            loading
            skeleton={(
              <div aria-hidden="true" className={styles.skeleton}>
                {[0, 1, 2, 3, 4].map((row) => (
                  <div key={row} className={styles.skeletonRow}>
                    <span className={styles.skeletonGrow}><Skeleton height={14} width="50%" /></span>
                    <Skeleton height={13} width={110} />
                    <Skeleton height={20} width={76} />
                  </div>
                ))}
              </div>
            )}
          />
        </div>
      )
        : loadState === 'forbidden' ? <ListState kind="forbidden" onRetry={() => void load()} />
        : loadState === 'error' ? <ListState kind="error" title="顧客へのお知らせを表示できませんでした" error={customerLoadError ?? undefined} onRetry={() => void load()} />
        : settings.length === 0 ? <ListState kind="empty" title="顧客へのお知らせはまだありません" description="EC連携の取引イベントを接続すると、ここで種類ごとに管理できます。" />
        : visible.length === 0 ? <ListState kind="empty" emptyPreset="filtered" title="条件に合うものはありません" description="絞り込みや検索を外すと、すべて出ます" action={<Button variant="secondary" onClick={() => setFilter('all')}>条件を外す</Button>} />
        : <DataTable label="顧客へのお知らせ" grid={{ columns: 'minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr) var(--tpl-sb-ln-col-count) var(--tpl-sb-ln-col-status) var(--tpl-sb-ln-col-toggle) max-content', padding: 'var(--tpl-sb-ec-row-pad)', headPadding: 'var(--tpl-sb-ec-head-pad)' }}>
          <thead>
            <TableHeadRow>
              <Th title="お知らせの種類（きっかけ）">種類</Th>
              <Th>いつ送るか</Th>
              <Th>だれに</Th>
              <Th>この30日</Th>
              <Th>状態</Th>
              <Th>出す</Th>
              <Th><span className={styles.srOnly}>内容を編集</span></Th>
            </TableHeadRow>
          </thead>
          <tbody>
            {visible.map((setting) => {
              const status = statusOf(setting)
              const sent = sendCountsFailed ? null : sent30dOf(setting.eventType)
              const name = setting.title?.trim() || setting.label
              return <Tr key={setting.eventType}>
                <Td>{canChange ? <RowNameButton title={name} aria-label={`${name}の内容を編集`} onClick={() => setExpanded(setting.eventType)}>{deliveryWords(setting).trigger || name}</RowNameButton> : <TruncatedText value={deliveryWords(setting).trigger || name} />}</Td>
                <Td><TruncatedText value={timingLabel(setting)} /></Td>
                <Td><TruncatedText value={audienceLabel(setting)} /></Td>
                <Td><span className={`${styles.num} ${sent ? styles.numStrong : styles.numFaint}`} title={sendCountsFailed ? '送信件数を読み込めませんでした' : undefined}>{sendCountsFailed ? '取得失敗' : sent ? formatNumber(sent) : emptyValue('unknown')}</span></Td>
                <StatusCell primary={<><StatusBadge tone={status.tone === 'good' ? 'success' : 'neutral'} title={status.warning ?? undefined} aria-description={status.warning ?? undefined}>{status.label}</StatusBadge>{status.warning ? <StatusDot tone="caution" /> : null}</>} />
                <Td><NotificationToggle setting={setting} busy={busy === setting.eventType} allowed={canChange} lockedReason={manageLockReason} onToggle={() => { if (!selectedAccountId || loadedAccountScope.current !== testAccountScope.current) return; setNotice(null); setPendingToggle({ setting, accountId: selectedAccountId, accountName: selectedAccount?.id === selectedAccountId ? selectedAccount.name : null, scope: testAccountScope.current, generation: loadGeneration.current }) }} /></Td>
                <ActionCell><RowActions edit={{ onClick: () => { if (canChange) setExpanded(setting.eventType) }, disabled: !canChange, lockedReason: manageLockReason }} /></ActionCell>
              </Tr>
            })}
          </tbody>
        </DataTable>}
    </Card></ListFolderContext.Provider>
    </> : null}
  </SbSettingsScreen></SaveErrorScope>
}

/*
 * 試験からは実物の部品と実物の呼び出し口を使う。
 * 画面の hook を作り替えず、実APIと同じ非同期境界のまま
 * 逆順応答・保存失敗・狭幅の並びを確かめられるようにする。
 */
const LineNotificationsPageWithTestSupport = Object.assign(LineNotificationsPage, {
  __testing: {
    CustomerNotificationEditor,
    buildSentBreakdown,
    clearCustomerDraft,
    canSettleDraft,
    customerDraftFingerprint,
    customerDraftKey,
    isSameCustomerDraft,
    operatorTabCountLabel,
    pickCustomerDraft,
    publishCustomerNotification,
    readCustomerDraft,
    saveCustomerNotification,
    sendCustomerTestNotification,
    sortCustomerSettingsBySentCount,
    writeCustomerDraft,
  },
})

export default LineNotificationsPageWithTestSupport
