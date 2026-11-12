'use client'
import { formatYen } from '@line-crm/shared';
import type { Dispatch, SetStateAction } from 'react'
import Button from '@/components/shared/button'
import ConditionBuilder from '@/components/shared/condition-builder'
import Dialog, { DialogActions } from '@/components/shared/dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import EditorSurface from '@/components/shared/editor-surface'
import HelpTip from '@/components/shared/help-tip'
import Notice from '@/components/shared/notice'
import Select from '@/components/shared/select'
import { TextField } from '@/components/shared/text-field'
import { Field } from '@/components/shared/form-controls'
import type { ConversionFieldIssue } from './field-issue'
import { formatNumber } from '@/lib/format'
import type {
  ConversionDefinitionEvent,
  ConversionDefinitionListItem,
  ConversionDefinitionState,
  ConversionIngestionEvent,
} from '@/lib/api'
import { deduplicationLabel } from './dedup'
import { originInfoOf } from './origin-labels'
import { readExclusionView, type ExclusionCondition } from './exclusion'
import NumberInput from '@/components/shared/number-field'
import { SaveErrorField } from '@/components/shared/save-form-errors'


/*
 * ★V8 成果地点の詳細・取消・編集の窓。
 *
 * 今の画面（app/conversions/_components/conversion-dialogs.tsx）から写したもの
 * （src/v8 から古い画面ファイルは import できないため）。文言・動き・送る形は
 * 今と同じ。止める操作は V8 では表の下の小窓（list.tsx）で行うので、
 * 止める窓は写していない。
 */

/**
 * 編集の入力（N-252）。
 *
 * 数値は入力途中で空になるので文字列で持ち、送るときだけ数へ直す。
 * 途中を数値に強制すると「消して打ち直す」ができない。
 */
export type EditForm = {
  name: string
  sourceType: string
  deduplicationMode: 'every' | 'once_per_friend' | 'window'
  deduplicationWindowDays: string
  valueMode: 'source' | 'fixed' | 'none'
  fixedValue: string
  reversalPolicy: 'source_cancelled' | 'manual' | 'none'
  attributionDays: string
  targetUrl: string
  /** R40: 数えない条件とメモも版上げで直せる。 */
  exclusion: ExclusionCondition | null
  exclusionMemo: string
}
/** R40: 詳細の「数えない条件」行の1行。条件・メモ・壊れを言い分ける。 */
function exclusionLine(sourceConfig: Record<string, unknown>): string {
  const view = readExclusionView(sourceConfig)
  if (view.invalid) return '条件が読み取れません（全件数えています）'
  if (view.hasCondition) {
    return `条件あり（${view.summary ?? '条件'}を除く）${view.memo ? `・メモ：${view.memo}` : ''}`
  }
  if (view.legacyMemo) return `メモのみ（記録に影響しません）：${view.memo ?? ''}`
  if (view.memo) return `メモ：${view.memo}（記録に影響しません）`
  return '除外なし'
}
/** R41: 詳細の「金額」行の1行。起点の対応表と同じ言葉を使う。 */
function valueModeLine(item: Pick<ConversionDefinitionListItem, 'sourceType' | 'valueMode' | 'value'>): string {
  if (item.valueMode === 'fixed') {
    return item.value == null ? '決まった額（金額なし）' : `決まった額（1件 ${formatYen(item.value)}）`
  }
  if (item.valueMode === 'source') return `起点の金額を使う（${originInfoOf(item.sourceType).amount}）`
  return '金額を集計しない'
}
/**
 * 編集の金額の決め方の表示名。選べるものは対応表(origin-labels)の
 * valueModes から作り、ここでは名前だけを持つ。作成と同じ動きにする。
 */
export const EDIT_VALUE_MODE_LABELS: Record<EditForm['valueMode'], string> = {
  fixed: '1件あたりの金額を決める',
  source: '連携元の金額を使う',
  none: '金額を数えない',
}
const DEDUP_OPTIONS = [
  { value: 'every', label: deduplicationLabel('every', null) },
  { value: 'once_per_friend', label: deduplicationLabel('once_per_friend', null) },
  { value: 'window', label: deduplicationLabel('window', null) },
]
const REVERSAL_OPTIONS = [
  { value: 'manual', label: '人が取り消す' },
  { value: 'source_cancelled', label: '連携元の取消に合わせる' },
  { value: 'none', label: '取り消さない' },
]
/**
 * N-268: 導出状態を運用者の言葉にする。status 列だけでは
 * 「まだ公開していない」「設定が足りない」「受け口を止めている」が
 * 全部「動いている」に潰れてしまうので、口が導出した `state` を見る。
 */
export const STATE_LABELS: Record<ConversionDefinitionState, string> = {
  active: '有効',
  draft: '下書き',
  stopped: '停止中',
  invalid: '入力不良',
  sourceStopped: '起点停止',
}
/**
 * IDEA-19: 外部受信の失敗理由を業務の言葉にする。
 * 口が返す理由コードをそのまま出すと運用者が読めないため、ここで訳す。
 * 辞書に無い理由はコードを出さず、判別用に title へ残す。
 */
const INGEST_REASON_LABELS: Record<string, string> = {
  point_not_found: 'この成果地点が見つかりませんでした',
  point_draft: '下書きのため、まだ計測していません',
  point_stopped: '計測を止めているため、受け取りませんでした',
  ingest_disabled: '外部からの受け口を止めています',
  secret_not_issued: '受信用の鍵がまだ発行されていません',
  signature_missing: '署名のない送信でした',
  signature_mismatch: '署名が一致しませんでした。連携先の鍵を確認してください',
  invalid_json: '送信内容の形式が正しくありませんでした',
  source_event_id_missing: '送信側のイベントIDが無いため、重複かどうかを判定できませんでした',
  friend_missing: '友だちを特定できませんでした',
  friend_not_found: '指定された友だちが見つかりませんでした',
  account_mismatch: 'このアカウントの友だちではないため、数えませんでした',
  idempotency_conflict: '同じイベントIDで違う内容が届いたため、受け取りませんでした',
  excluded_by_condition: '「数えない条件」に当てはまるため、数えませんでした',
}
/** 受信履歴1件を運用者の言葉にする。検証の受信は本番実績と区別して出す。 */
function ingestionEventLabel(event: ConversionIngestionEvent): string {
  const reason = event.reason
    ? INGEST_REASON_LABELS[event.reason] ?? '受け取れませんでした。理由は管理側の記録を確認してください'
    : null
  const base = event.isTest
    ? event.result === 'rejected' ? '検証の受信（受け取れなかった）' : '検証の受信（実績には数えません）'
    : event.result === 'recorded' ? '検知して数えた'
      : event.result === 'duplicate' ? '同じ受信の再送（二重には数えません）'
      : '受け取れなかった'
  return reason ? `${base}（${reason}）` : base
}
/**
 * R41: 起点の説明は対応表(origin-labels)が正本。ここでは URL 到達だけ
 * 対象URLを添える。タグ起点で「EC連携」と出ていた取り違えを直す。
 */
export function sourceTriggerLabel(point: Pick<ConversionDefinitionListItem, 'measureMethod' | 'sourceType' | 'targetUrl'>): string {
  if (point.measureMethod === 'url_reach') {
    return point.targetUrl ? `サイトの「${point.targetUrl}」に到達` : '指定したページに到達'
  }
  if (point.measureMethod === 'manual') return '管理画面から担当者が記録'
  return originInfoOf(point.sourceType).trigger
}
export function usageLabel(point: ConversionDefinitionListItem): string {
  if (point.usageCount === 0) return 'どこからも使われていません'
  if (point.usageNames?.length) return point.usageNames.join('・')
  return `${formatNumber(point.usageCount)}か所で使用中`
}

/**
 * IDEA-19: 成果1件の業務状態を運用者の言葉にする。
 * 状態の導出は口(listConversionDefinitionEvents)が済ませている。
 * 「検知」は受信履歴の「受け取った」が担い、ここは確定後の帰結を出す。
 */
const EVENT_STATUS_LABELS: Record<ConversionDefinitionEvent['status'], string> = {
  confirmed: '確定',
  pending: '確認待ち',
  rejected: '却下',
  cancelled: '取消',
}

/** 止めるときの3択（`page.tsx` の持ち方とそろえる）。 */
export type ConversionStopAction = 'stop' | 'replace' | 'delete'

export interface ConversionDetailDialogProps {
  detailTarget: ConversionDefinitionListItem | null
  setDetailTarget: (target: ConversionDefinitionListItem | null) => void
  publishing: boolean
  publishDraft: (target: ConversionDefinitionListItem) => void
  openEdit: (target: ConversionDefinitionListItem) => void
  openStop: (target: ConversionDefinitionListItem) => void
  issueIngest: (target: ConversionDefinitionListItem) => void
  toggleIngest: (target: ConversionDefinitionListItem) => void
  ingestBusy: '' | 'issue' | 'toggle'
  ingestError: string
  issuedSecret: string
  ingestEvents: ConversionIngestionEvent[]
  definitionEvents: ConversionDefinitionEvent[]
  eventsFailed: boolean
  canReverse: boolean
  openReversal: (event: ConversionDefinitionEvent, kind: 'reverse' | 'restore') => void
}

/** 中身を見る窓（詳細）。中身は `page.tsx` にあったまま。 */
export function ConversionDetailDialog(props: ConversionDetailDialogProps) {
  const {
    detailTarget,
    setDetailTarget,
    publishing,
    publishDraft,
    openEdit,
    openStop,
    issueIngest,
    toggleIngest,
    ingestBusy,
    ingestError,
    issuedSecret,
    ingestEvents,
    definitionEvents,
    eventsFailed,
    canReverse,
    openReversal,
  } = props
  return (
    <Dialog
      open={detailTarget !== null}
      title={detailTarget?.name ?? ''}
      description="この成果地点の数え方と利用状況です。"
      onCancel={() => setDetailTarget(null)}
      footer={detailTarget ? (<DialogActions>
          {canReverse && detailTarget.state === 'draft' ? (<Button
              variant="primary"
              disabled={publishing}
              onClick={() => void publishDraft(detailTarget)} busy={publishing} busyLabel="公開しています">計測をはじめる（公開）
            </Button>) : null}
          {canReverse && detailTarget.status !== 'stopped' ? (<Button onClick={() => openEdit(detailTarget)}>
              編集
            </Button>) : null}
          {canReverse && detailTarget.status !== 'stopped' ? (<Button onClick={() => void openStop(detailTarget)}>
              停止・削除する
            </Button>) : null}
        </DialogActions>) : null}
    >
      {detailTarget ? (
        <div className="space-y-4">
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <div><dt className="text-ink-faint">状態</dt><dd className="text-ink mt-1 font-semibold">{STATE_LABELS[detailTarget.state]}</dd></div>
            <div><dt className="text-ink-faint">何が起きたら数えるか</dt><dd className="text-ink mt-1 font-semibold">{sourceTriggerLabel(detailTarget)}</dd></div>
            {/* R41: 対象・金額の説明も対応表と同じものを使う。 */}
            <div><dt className="text-ink-faint">対象</dt><dd className="text-ink mt-1 font-semibold">{originInfoOf(detailTarget.sourceType).target}</dd></div>
            {/* R281: ページ到達の対象URLは詳細で確認できる。長いURLは安全な位置で折り返す。 */}
            {detailTarget.measureMethod === 'url_reach' ? (
              <div className="col-span-2">
                <dt className="text-ink-faint">数えてよいページ</dt>
                <dd className="text-ink mt-1 font-semibold break-all" title={detailTarget.targetUrl ?? undefined}>
                  {detailTarget.targetUrl ?? '決まっていません'}
                </dd>
              </div>
            ) : null}
            <div><dt className="text-ink-faint">金額</dt><dd className="text-ink mt-1 font-semibold">{valueModeLine(detailTarget)}</dd></div>
            {/* R281: 計測期間と取消方針も詳細で確認できる。空欄は既定の90日と分かる書き方にする。 */}
            <div>
              <dt className="text-ink-faint">
                計測期間{' '}
                <HelpTip label="計測期間の説明">
                  友だち追加からこの日数までの成果を数えます。同じ人を数えない「数えない日数」とは別の設定です。
                </HelpTip>
              </dt>
              <dd className="text-ink mt-1 font-semibold">
                {detailTarget.attributionDays == null ? '90日（既定）' : `${detailTarget.attributionDays}日`}
              </dd>
            </div>
            <div>
              <dt className="text-ink-faint">取り消しの扱い</dt>
              <dd className="text-ink mt-1 font-semibold">
                {REVERSAL_OPTIONS.find((option) => option.value === detailTarget.reversalPolicy)?.label ?? detailTarget.reversalPolicy}
              </dd>
            </div>
            {/* R40: 数えない条件とメモを詳細でも確認できる。 */}
            <div className="col-span-2"><dt className="text-ink-faint">数えない条件</dt><dd className="text-ink mt-1 font-semibold">{exclusionLine(detailTarget.sourceConfig)}</dd></div>
            <div><dt className="text-ink-faint">数え方</dt><dd className="text-ink mt-1 font-semibold">{deduplicationLabel(detailTarget.deduplicationMode, detailTarget.deduplicationWindowDays)}</dd></div>
            <div><dt className="text-ink-faint">この30日</dt><dd className="text-ink mt-1 font-semibold">{formatNumber(detailTarget.metrics.netCount)} 件</dd></div>
            <div><dt className="text-ink-faint">利用先</dt><dd className="text-ink mt-1 font-semibold">{usageLabel(detailTarget)}</dd></div>
            <div><dt className="text-ink-faint">取消内訳</dt><dd className="text-ink mt-1 font-semibold">{detailTarget.metrics.reversedCount == null ? '取消台帳は未接続' : `${formatNumber(detailTarget.metrics.reversedCount)} 件・${formatYen((detailTarget.metrics.reversedValue ?? 0))}`}</dd></div>
          </dl>
          {detailTarget.stateReason ? (
            <Notice tone="warn" message={detailTarget.stateReason} />
          ) : null}
          {ingestError ? <Notice tone="danger" >{ingestError}</Notice> : null}
          {/*
           * IDEA-19: 「購入」「相談完了」など成果1件ずつの記録。
           * 検知は受信履歴、ここは数えた成果の状態(確定・確認待ち・却下・取消)
           * を業務の言葉で出す。重複通知・再送は冪等で1件に潰れているので、
           * この一覧の件数と「この30日」の確定数は同じ台帳から数えて一致する。
           * 検証の受信は成果表へ書かないため、ここには本番実績だけが並ぶ。
           */}
          <section className="border-hairline rounded-control border p-4">
            <h3 className="text-ink text-sm font-bold">最近の成果</h3>
            {eventsFailed ? (
              <p className="text-ink-faint mt-2 text-xs leading-5" role="status">
                成果の記録を読み込めませんでした。一覧の件数は上の「この30日」を確認してください。
              </p>
            ) : definitionEvents.length === 0 ? (
              <p className="text-ink-faint mt-2 text-xs leading-5">
                まだ成果がありません。検知した成果がここに新しい順で並びます。
              </p>
            ) : (
              <ul className="mt-3 space-y-1 text-xs">
                {definitionEvents.map((event) => (
                  <li key={event.id} className="text-ink-secondary flex items-baseline justify-between gap-2">
                    <span className="text-ink min-w-0">
                      <span className="font-semibold">{event.friendName ?? '名前のない友だち'}</span>
                      <span
                        className={`ml-2 inline-block rounded-mini px-1.5 py-0.5 font-semibold ${
                          event.status === 'cancelled' ? 'bg-danger-bg text-danger'
                            : event.status === 'pending' ? 'bg-info-bg text-info'
                            : event.status === 'rejected' ? 'bg-canvas-sunken text-ink-faint'
                            : 'bg-success-bg text-success'
                        }`}
                      >
                        {EVENT_STATUS_LABELS[event.status]}
                      </span>
                      {/* R42: 金額なしは0円と区別して出す。 */}
                      {event.value !== null ? (
                        <span className="text-ink-faint ml-2 tabular-nums">{formatYen(event.value)}</span>
                      ) : (
                        <span className="text-ink-faint ml-2">金額なし</span>
                      )}
                    </span>
                    <span className="text-ink-faint flex shrink-0 items-baseline gap-3 tabular-nums">
                      {/*
                       * #819: 取消は追記なので元の行は残る。取り消せるのは
                       * 台帳で取り消されていない成果だけ。「取消を戻す」は
                       * この台帳で取り消したものに限る（連携元の取消は
                       * ここから戻せない）。
                       */}
                      {canReverse && event.reversed ? (
                        <button
                          type="button"
                          className="text-action underline"
                          onClick={() => openReversal(event, 'restore')}
                        >
                          取消を戻す
                        </button>
                      ) : canReverse && !event.cancelled ? (
                        <button
                          type="button"
                          className="text-action underline"
                          onClick={() => openReversal(event, 'reverse')}
                        >
                          取り消す
                        </button>
                      ) : null}
                      {event.createdAt.slice(0, 16).replace('T', ' ')}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          {detailTarget.measureMethod === 'webhook' ? (
            <section className="border-hairline rounded-control border p-4">
              <h3 className="text-ink text-sm font-bold">外部からの受信</h3>
              <p className="text-ink-faint mt-1 text-xs leading-5">
                連携先システムがこの成果地点へ成果を送るときの受け口です。
                送り側は `POST {detailTarget.id ? `/api/conversions/ingest/${detailTarget.id}` : ''}` に
                `X-Conversion-Signature` 署名を付けて送ります。
              </p>
              <p className="text-ink-secondary mt-2 text-sm">
                {detailTarget.ingest.configured
                  ? detailTarget.ingest.disabledAt
                    ? '受け口は止まっています（起点停止）。'
                    : '受け口は動いています。鍵は発行済みです。'
                  : 'まだ鍵を発行していません。発行すると連携先へ渡す鍵が一度だけ表示されます。'}
              </p>
              {canReverse ? <div className="mt-2 flex flex-wrap gap-2">
                <Button
                  disabled={ingestBusy !== '' || detailTarget.state !== 'active'}
                  onClick={() => void issueIngest(detailTarget)}
                >
                  {detailTarget.ingest.configured ? '鍵を出し直す' : '鍵を発行する'}
                </Button>
                {detailTarget.ingest.configured ? (
                  <Button
                    disabled={ingestBusy !== ''}
                    onClick={() => void toggleIngest(detailTarget)}
                  >
                    {detailTarget.ingest.disabledAt ? '受け口を再開する' : '受け口を止める'}
                  </Button>
                ) : null}
              </div> : null}
              {issuedSecret ? (
                <Notice tone="info" className="mt-2">
                  新しい鍵: <code className="break-all">{issuedSecret}</code><br />
                  この表示は一度だけです。連携先へ渡して保管してください。
                </Notice>
              ) : null}
              {ingestEvents.length > 0 ? (
                <ul className="mt-3 space-y-1 text-xs">
                  {ingestEvents.slice(0, 5).map((event) => (
                    <li key={event.id} className="text-ink-secondary flex justify-between gap-2">
                      <span
                        className={event.result === 'rejected' ? 'text-danger' : event.isTest ? 'text-info' : 'text-ink'}
                        title={event.reason ?? undefined}
                      >
                        {ingestionEventLabel(event)}
                      </span>
                      <span className="text-ink-faint tabular-nums">{event.createdAt.slice(0, 16).replace('T', ' ')}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>
          ) : null}
        </div>
      ) : null}
    </Dialog>
  )
}

export interface ConversionReversalDialogProps {
  reversalTarget: ConversionDefinitionEvent | null
  account: { id: string; name?: string | null }
  reversalKind: 'reverse' | 'restore'
  reversalBusy: boolean
  reversalError: string
  reversalReason: string
  setReversalTarget: (target: ConversionDefinitionEvent | null) => void
  setReversalReason: (reason: string) => void
  submitReversal: () => void
}

/** 成果の取消・取消の戻しの窓。中身は `page.tsx` にあったまま。 */
export function ConversionReversalDialog(props: ConversionReversalDialogProps) {
  const {
    reversalTarget,
    account,
    reversalKind,
    reversalBusy,
    reversalError,
    reversalReason,
    setReversalTarget,
    setReversalReason,
    submitReversal,
  } = props
  return (
    <>
    {/*
     * #819: 成果の取消/取消の取消。元の成果行は消えず、理由つきの
     * 追記として台帳へ残る。二重取消・未取消への取消の取消は口が 409 で返す。
     */}
    <Dialog
      open={reversalTarget !== null}
      title={reversalKind === 'restore' ? 'この成果の取消を戻す' : 'この成果を取り消す'}
      description={
        reversalKind === 'restore'
          ? '取り消しを戻すと、この成果はふたたび数えます。操作は理由と一緒に記録として残ります。'
          : '取り消すと、この成果は「取消」となり純数から引かれます。もとの記録は残り、あとから戻せます。'
      }
      tone={reversalKind === 'restore' ? 'default' : 'destructive'}
      busy={reversalBusy}
      error={reversalError || undefined}
      confirmLabel={reversalKind === 'restore' ? '取消を戻す' : '取り消す'}
      onConfirm={() => submitReversal()}
      onCancel={() => setReversalTarget(null)}
    >
      <OperationTargetSummary accounts={[account]} externalTarget={{ label: '友だち', name: reversalTarget?.friendName }} />
      <Field label="理由" required><SaveErrorField names={["reversalReason","reversal_reason"]}><TextField
          className="mt-1 w-full"
          value={reversalReason}
          maxLength={500}
          placeholder="例：重複のため"
          onChange={(e) => setReversalReason(e.target.value)}
        /></SaveErrorField></Field>
    </Dialog>
    </>
  )
}

export interface ConversionEditDialogProps {
  editTarget: ConversionDefinitionListItem | null
  setEditTarget: (target: ConversionDefinitionListItem | null) => void
  editForm: EditForm | null
  setEditForm: Dispatch<SetStateAction<EditForm | null>>
  editValueModeNotice: string | null
  setEditValueModeNotice: (notice: string | null) => void
  editSaving: boolean
  editError: string
  editFieldIssue?: ConversionFieldIssue | null
  submitEdit: () => void
}

/** 「○○を編集」の窓。中身は `page.tsx` にあったまま。 */
export function ConversionEditDialog(props: ConversionEditDialogProps & { surface?: 'page' | 'dialog' }) {
  const {
    editTarget,
    setEditTarget,
    editForm,
    setEditForm,
    editValueModeNotice,
    setEditValueModeNotice,
    editSaving,
    editError,
    editFieldIssue,
    submitEdit,
  } = props
  return (
    <EditorSurface surface={props.surface}
      open={editTarget !== null && editForm !== null}
      busy={editSaving}
      title={editTarget ? `「${editTarget.name}」を編集` : ''}
      description="直すと次の版になります。過去に数えた成果と金額は、そのまま残ります。"
      onCancel={() => { setEditTarget(null); setEditForm(null); setEditValueModeNotice(null) }}
      footer={(
        <div className="flex justify-end gap-2">
          <Button disabled={editSaving} onClick={() => { setEditTarget(null); setEditForm(null); setEditValueModeNotice(null) }}>キャンセル</Button>
          <Button variant="primary" disabled={editSaving} onClick={() => void submitEdit()} busy={editSaving} busyLabel="保存中…">この内容にする
          </Button>
        </div>
      )}
    >
      {editForm ? (
        <div className="space-y-3 text-sm">
          {/* R41: 編集でも起点を確認できる。起点自体は変えられない。 */}
          <p className="bg-canvas-sunken rounded-control px-3 py-2 text-xs text-ink-secondary">
            起点：{originInfoOf(editForm.sourceType).trigger}／{originInfoOf(editForm.sourceType).target}
          </p>
          <Field label="名前" htmlFor="cv-edit-name" error={editFieldIssue?.field === 'cv-edit-name' ? editFieldIssue.message : undefined}>
            <SaveErrorField names={["name","editForm.name","edit_form.name","edit_form"]}><TextField
              aria-label="成果地点の名前"
              value={editForm.name}
              maxLength={120}
              onChange={(event) => setEditForm({ ...editForm, name: event.target.value })}
            /></SaveErrorField>
          </Field>
          {/* R281: ページ到達の対象URLも編集できる。URL以外は起点が固定で入力欄は出さない。 */}
          {editForm.sourceType === 'url_reach' ? (
            <Field label="数えてよいページ" htmlFor="cv-edit-url" error={editFieldIssue?.field === 'cv-edit-url' ? editFieldIssue.message : undefined}>
              <SaveErrorField names={["targetUrl","editForm.targetUrl","target_url","edit_form.target_url","edit_form"]}><TextField
                aria-label="数えてよいページ"
                inputMode="url"
                value={editForm.targetUrl}
                maxLength={2000}
                placeholder="https://example.com/thanks"
                onChange={(event) => setEditForm({ ...editForm, targetUrl: event.target.value })}
              /></SaveErrorField>
            </Field>
          ) : null}
          {/* 起点に金額が無いものは注文の金額を出さない。選択肢は対応表が持つ(作成と同じ)。 */}
          <Field label="金額の決め方"><SaveErrorField names={["valueMode","editForm.valueMode","value_mode","edit_form.value_mode","edit_form"]}><Select
              id="cv-edit-value-mode"
              error={editFieldIssue?.field === 'cv-edit-value-mode' ? editFieldIssue.message : undefined}
              aria-label="金額の決め方"
              value={editForm.valueMode}
              options={originInfoOf(editForm.sourceType).valueModes.map((mode) => ({
                value: mode,
                label: EDIT_VALUE_MODE_LABELS[mode],
              }))}
              onChange={(value) => {
                setEditForm({ ...editForm, valueMode: value as EditForm['valueMode'] })
                setEditValueModeNotice(null)
              }}
            /></SaveErrorField>
{editValueModeNotice ? (
              <span className="text-warning mt-1 block text-xs" role="status">
                {editValueModeNotice}
              </span>
            ) : null}</Field>
          {editForm.valueMode === 'fixed' ? (
            <Field label="1件あたりの金額" htmlFor="cv-edit-value" error={editFieldIssue?.field === 'cv-edit-value' ? editFieldIssue.message : undefined}>
              <SaveErrorField names={["fixedValue","editForm.fixedValue","fixed_value","edit_form.fixed_value","edit_form"]}><NumberInput numericText
                aria-label="1件あたりの金額"
                inputMode="numeric"
                value={editForm.fixedValue}
                onChange={(event) => setEditForm({ ...editForm, fixedValue: event.target.value })}
              /></SaveErrorField>
            </Field>
          ) : null}
          <Field label="同じ人を何回数えるか"><SaveErrorField names={["deduplicationMode","editForm.deduplicationMode","deduplication_mode","edit_form.deduplication_mode","edit_form"]}><Select
              aria-label="同じ人を何回数えるか"
              value={editForm.deduplicationMode}
              options={DEDUP_OPTIONS}
              onChange={(value) => setEditForm({ ...editForm, deduplicationMode: value as EditForm['deduplicationMode'] })}
            /></SaveErrorField></Field>
          {editForm.deduplicationMode === 'window' ? (
            <Field label="数えない日数（1〜365）" htmlFor="cv-edit-window" error={editFieldIssue?.field === 'cv-edit-window' ? editFieldIssue.message : undefined}>
              <SaveErrorField names={["deduplicationWindowDays","editForm.deduplicationWindowDays","deduplication_window_days","edit_form.deduplication_window_days","edit_form"]}><NumberInput numericText
                aria-label="数えない日数"
                inputMode="numeric"
                value={editForm.deduplicationWindowDays}
                onChange={(event) => setEditForm({ ...editForm, deduplicationWindowDays: event.target.value })}
              /></SaveErrorField>
            </Field>
          ) : null}
          <Field label="取り消しの扱い"><SaveErrorField names={["reversalPolicy","editForm.reversalPolicy","reversal_policy","edit_form.reversal_policy","edit_form"]}><Select
              aria-label="取り消しの扱い"
              value={editForm.reversalPolicy}
              options={REVERSAL_OPTIONS}
              onChange={(value) => setEditForm({ ...editForm, reversalPolicy: value as EditForm['reversalPolicy'] })}
            /></SaveErrorField></Field>
          {/* R281: 友だち追加からの計測期間も編集できる。空欄は既定の90日。 */}
          <Field
            label="友だち追加からの計測期間（日）"
            htmlFor="cv-edit-days"
            error={editFieldIssue?.field === 'cv-edit-days' ? editFieldIssue.message : undefined}
            note="空欄なら既定の90日です。"
            help="友だち追加からこの日数までの成果を数えます。同じ人を数えない「数えない日数」とは別の設定です。"
            helpLabel="計測期間"
          >
            <SaveErrorField names={["attributionDays","editForm.attributionDays","attribution_days","edit_form.attribution_days","edit_form"]}><NumberInput numericText unit="日"
              aria-label="友だち追加からの計測期間"
              inputMode="numeric"
              value={editForm.attributionDays}
              placeholder="90"
              onChange={(event) => setEditForm({ ...editForm, attributionDays: event.target.value })}
            /></SaveErrorField>
          </Field>
          {/* R40: 数えない条件とメモも編集できる。条件は作成と同じ共通部品。 */}
          <div id="cv-edit-exclusion" aria-invalid={editFieldIssue?.field === 'cv-edit-exclusion' || undefined}>
            <Field label="数えない条件" error={editFieldIssue?.field === 'cv-edit-exclusion' ? editFieldIssue.message : undefined}>
              <ConditionBuilder
                value={editForm.exclusion}
                onChange={(next) => setEditForm({ ...editForm, exclusion: next })}
                label="数えない条件"
                showCount={false}
              />
            </Field>
          </div>
          <Field note={<>
            いま使っている場所（{usageLabel(editTarget!)}）は、この成果地点のまま次の版へ引き継がれます。
            過去の成果は数えたときの金額のままなので、集計額は変わりません。
          </>} label="数えない条件のメモ（任意）" htmlFor="cv-edit-memo" error={editFieldIssue?.field === 'cv-edit-memo' ? editFieldIssue.message : undefined}>
            <SaveErrorField names={["exclusionMemo","editForm.exclusionMemo","exclusion_memo","edit_form.exclusion_memo","edit_form"]}><TextField
              aria-label="数えない条件のメモ"
              value={editForm.exclusionMemo}
              maxLength={500}
              onChange={(event) => setEditForm({ ...editForm, exclusionMemo: event.target.value })}
            /></SaveErrorField>
          </Field>

          {editError ? <Notice tone="danger">{editError}</Notice> : null}
        </div>
      ) : null}
    </EditorSurface>
  )
}
