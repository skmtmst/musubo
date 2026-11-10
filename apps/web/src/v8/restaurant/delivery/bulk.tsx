'use client'

import OperationTargetSummary from '@/components/shared/operation-target-summary'


/*
 * ★V8 デリバリー受注・品切れ一括設定（板 `h7OeT`）と受付の一括停止（窓 `XCVGd`）。
 *
 * 品切れ一括設定は絵のとおり「板」（窓ではない）。上の帯の段は
 * `飲食店向け（テスト） › デリバリー受注 › 品切れ一括設定` になる。
 * 探す欄と「品切れ中のみ」は板の頭（親が RestaurantPage の picker に置く）。
 *
 * どちらも送信は親（delivery.tsx）が持ち、ここは選んでもらうだけにする。
 * 受付の停止は取り消せないので、対象と戻し方を文字で必ず見せる。
 * サービスから返った文はそのまま出さない（日本語の案内と品名だけを出す）。
 */

import { Ban, Pause, RotateCcw } from 'lucide-react'
import BulkBar from '@/components/shared/bulk-bar'
import Button from '@/components/shared/button'
import Card from '@/components/shared/card'
import Checkbox from '@/components/shared/checkbox'
import FilterChip from '@/components/shared/filter-chip'
import ListState from '@/components/shared/list-state'
import ListToolbar from '@/components/shared/list-toolbar'
import { PREPARING_WORD } from '@/components/shared/preparing-dialog'
import Pagination from '@/components/shared/pagination'
import PageSizeSelect from '@/components/shared/page-size-select'
import CheckCard from '@/components/shared/check-card'
import SegmentedControl from '@/components/shared/segmented'
import StatusBadge from '@/components/shared/status-badge'
import { DataTable, TableHeadRow, TableStateRow, Td, Th, Tr } from '@/components/shared/table'
import Toggle from '@/components/shared/toggle'
import TruncatedText from '@/components/shared/truncated-text'
import {
  DELIVERY_SERVICE_LABELS,
  type DeliveryIntakeStopPreset,
  type DeliveryMenuItem,
  type DeliveryService,
  type DeliveryServiceState,
} from '@/lib/restaurant-delivery-api'
import { DialogField, DialogNote, RsDialog } from '@/v8/restaurant/booking-kit/public/parts/index'
import { DASH, INTAKE_STOP_PRESET_OPTIONS, SERVICE_TONES, formatYen } from './format'
import styles from './delivery.module.css'
import { intakeStopSelection } from './intake-stop-selection'
import { intakeActionReason } from './intake-access'
import { formatNumber } from '@/lib/format'

/*
 * 受付停止の確認（XCVGd）。長い本文と操作欄が収まる位置にする。
 * 幅は絵が 500 だが、窓の幅は正本で 480／560／720／960 の4段に決まっている
 * （docs/v8-design-rules.md §6.12 の項目8・ の `DIALOG_WIDTHS`）。500 は4段に無いので
 * 共通部品の `dialogWidth` が 480 へ寄せる。暗に寄せられるのに任せず、
 * 実際に出る 480 をここに書く。中身は真ん中に並ぶので絵より左右 10 外へ出る
 * （この差は「絵と正本の食い違いを正本で解いた分」として記録する）。
 */
const STOP_WIDTH = 480
const STOP_TOP = 80
/*
 * 絵（XCVGd）の段の間。絵は段ごとに下の余白を持ち、一文の下が 10・欄の下が 12。
 * 段の間は1つの値しか持てないので小さい方の 10 に合わせる。
 * ボタンの段の上の間は 14（絵の y598→612）。
 */
const STOP_BODY_GAP = 10
const STOP_FOOT_GAP = 14

const SOLD_OUT_COLUMN_COUNT = 6
/** 閲覧のみの人には「選択」と「切替」を出さないので2つ少ない（★V8 2026-10-06）。 */
const SOLD_OUT_COLUMN_COUNT_VIEW_ONLY = SOLD_OUT_COLUMN_COUNT - 2

/* ── D-5 `h7OeT` 品切れ一括設定 ───────────────────────────────── */

export interface SoldOutBoardProps {
  loading: boolean
  /** 日本語の案内だけを入れる。 */
  error: string | null
  /** 探す欄と「品切れ中のみ」で絞ったあとの品。 */
  items: DeliveryMenuItem[]
  /** 絞る前の総数（足もとの「全N品中」）。 */
  total: number
  /** 選んだ品の id。 */
  selected: string[]
  page: number
  perPage: number
  /** 探す欄と「品切れ中のみ」。道具の段（ListToolbar）に置く。 */
  query: string
  soldOutOnly: boolean
  /** 品切れ中の品数。取れていないときは出さない。 */
  soldOutCount: number | undefined
  onQueryChange: (value: string) => void
  onSoldOutOnlyChange: (value: boolean) => void
  /** まとめて送っている間。 */
  busy: boolean
  /** 1品だけ切り替えている間の id。 */
  busyItemId: string | null
  canManage: boolean
  onToggle: (id: string, checked: boolean) => void
  onToggleAll: (checked: boolean) => void
  /** 行の切替。`soldOut` が送りたい次の状態。 */
  onToggleOne: (id: string, soldOut: boolean) => void
  /** `true` で品切れ・`false` で販売再開。 */
  onSubmit: (soldOut: boolean) => void
  onRetry: () => void
  onPage: (page: number) => void
  onPerPage: (perPage: number) => void
}

/** D-5 `h7OeT`。保存済みの商品を確認する。Uberを含む商品は同期しない。 */
export default function SoldOutBoard({
  loading,
  error,
  items,
  total,
  selected,
  page,
  perPage,
  query,
  soldOutOnly,
  soldOutCount,
  onQueryChange,
  onSoldOutOnlyChange,
  busy,
  busyItemId,
  canManage,
  onToggle,
  onToggleAll,
  onToggleOne,
  onSubmit,
  onRetry,
  onPage,
  onPerPage,
}: SoldOutBoardProps) {
  const pageCount = Math.max(1, Math.ceil(items.length / perPage))
  const currentPage = Math.min(page, pageCount)
  const firstIndex = (currentPage - 1) * perPage
  const visible = items.slice(firstIndex, firstIndex + perPage)
  const selectedSet = new Set(selected)
  const canSync = (item: DeliveryMenuItem) => !item.services.some(({ service }) => service === 'ubereats')
  const checkedCount = visible.filter((item) => canSync(item) && selectedSet.has(item.id)).length
  const selectableCount = visible.filter(canSync).length
  const allChecked = selectableCount > 0 && checkedCount === selectableCount
  const someChecked = checkedCount > 0 && !allChecked
  // 権限の有無は帯ごと出す・出さないで分ける。ここは「選んでいないので押せない」だけ。
  const canSubmit = checkedCount > 0 && !busy

  return (
    <>
      {/* 探す欄と「品切れ中のみ」は道具の段に置く（板の頭の右には置かない）。 */}
      <ListToolbar
        search={{ placeholder: '商品名で探す', label: '商品名で探す', value: query, onChange: onQueryChange }}
        filters={(
          <FilterChip selected={soldOutOnly} disabled={loading && items.length === 0} count={soldOutCount} onChange={onSoldOutOnlyChange}>
            品切れ中のみ
          </FilterChip>
        )}
        trailing={<PageSizeSelect value={perPage} onChange={onPerPage} />}
      />
      {loading && items.length === 0 && !error ? (
        <ListState kind="loading" title="メニューを読み込んでいます" />
      ) : null}
      {error && items.length === 0 ? (
        <ListState
          kind="error"
          title="メニューを表示できませんでした"
          description={error}
          onRetry={onRetry}
        />
      ) : null}

      {items.length > 0 ? (
        <>
          {error ? <p className={styles.muted}>{error}</p> : null}

          <Card overflow="hidden"><DataTable density="reviews" columnSizing="content" data-design="h7OeT" label="メニューの品切れ設定"><thead>
            <TableHeadRow data-table-layout="columns">
              {canManage ? (
                <Th>
                  <Checkbox
                    aria-label="表示中をすべて選ぶ"
                    checked={allChecked}
                    indeterminate={someChecked}
                    disabled={selectableCount === 0 || busy}
                    onCheckedChange={onToggleAll}
                  />
                </Th>
              ) : null}
              <Th grow>商品名</Th>
              <Th>分類</Th>
              {/*
                * 絵（h7OeT）の「価格」は左。見出し `X4NEtR` も中の欄 `hwhgs`・`IRs4m` も
                * 左寄せで、右へ寄せる詰め物を持っていない。注文履歴（OzHLO）の「金額」は
                * 逆に詰め物を持っていて右寄せなので、3つの表をまとめて同じにしない。
                */}
              <Th align="right">価格</Th>
              <Th>状態</Th>
              {canManage ? <Th>切替</Th> : null}
            </TableHeadRow></thead><tbody>
            {visible.length === 0 ? (
              <TableStateRow
                colSpan={canManage ? SOLD_OUT_COLUMN_COUNT : SOLD_OUT_COLUMN_COUNT_VIEW_ONLY}
                kind="empty"
              />
            ) : (
              visible.map((item) => (
                <Tr selected={canSync(item) && selectedSet.has(item.id)} key={item.id} data-table-layout="columns">
                  {canManage ? (
                    <Td>
                      <Checkbox
                        aria-label={`${item.name || '商品'}を選ぶ`}
                        checked={canSync(item) && selectedSet.has(item.id)}
                        disabled={!canSync(item) || busy}
                        onCheckedChange={(checked) => onToggle(item.id, checked)}
                      />
                    </Td>
                  ) : null}
                  <Td grow>
                    <TruncatedText value={item.name || DASH} />
                  </Td>
                  <Td data-list-number>{item.category || DASH}</Td>
                  <Td align="right" data-list-number>
                    <span className={styles.amount}>{formatYen(item.price)}</span>
                  </Td>
                  <Td>
                    {/* 絵（h7OeT）の「品切れ」は赤（#b3261e）。共通の札の赤は tone="danger"。
                        橙（warning）だと絵と色の系統が変わるため danger を渡す。 */}
                    <StatusBadge tone={item.soldOut ? 'danger' : 'success'} size="delivery">
                      {item.soldOut ? '品切れ' : '販売中'}
                    </StatusBadge>
                  </Td>
                  {canManage ? (
                    <Td>
                      {!canSync(item) ? <StatusBadge tone="neutral" size="compact">{PREPARING_WORD}</StatusBadge> : null}
                      <Toggle
                        label={`${item.name || '商品'}の販売`}
                        checked={!item.soldOut}
                        disabled={!canSync(item) || busy || busyItemId === item.id}
                        onChange={(next) => onToggleOne(item.id, !next)}
                      />
                    </Td>
                  ) : null}
                </Tr>
              ))
            )}
          </tbody></DataTable></Card>

          {canManage ? (
            <BulkBar count={checkedCount} unit="品" onClear={() => onToggleAll(false)}>
              <Button variant="danger-outline" disabled={!canSubmit} busy={busy} busyLabel="送信中…" onClick={() => onSubmit(true)}>
                <Ban size={16} aria-hidden="true" />選んだ商品を品切れにする
              </Button>
              <Button variant="secondary" disabled={!canSubmit} onClick={() => onSubmit(false)}>
                <RotateCcw size={16} aria-hidden="true" />販売を再開する
              </Button>
            </BulkBar>
          ) : null}

          <Pagination
            page={currentPage}
            pageCount={pageCount}
            onPageChange={onPage}
            summary={`全${total}品中 ${firstIndex + 1}〜${firstIndex + visible.length}品を表示`}
          />
        </>
      ) : null}

      {!loading && !error && items.length === 0 ? (
        total === 0 ? (
          <ListState kind="empty" title="商品がまだありません" description="メニュー管理で商品を作ると表示されます。" action={<Button href="/restaurant-test/menu">メニュー管理を開く</Button>} />
        ) : (
          <ListState kind="empty" title="あてはまる商品がありません" description="条件を変えて、もう一度お試しください。" />
        )
      ) : null}
    </>
  )
}

/* ── D-6 `XCVGd` 受付の一括停止 ───────────────────────────────── */

export interface IntakeStopDialogProps {
  accountId?: string | null
  store?: { id: string; name?: string | null }

  open: boolean
  /** サービスの今の状態。すでに停止中のものは「対象外」にする。 */
  services: DeliveryServiceState[]
  disabledReason?: string
  /** 止める相手として選んでいるもの。 */
  selected: DeliveryService[]
  preset: DeliveryIntakeStopPreset | ''
  busy: boolean
  /** 日本語の案内だけを入れる。 */
  error: string | null
  onToggleService: (service: DeliveryService, checked: boolean) => void
  onPresetChange: (preset: DeliveryIntakeStopPreset) => void
  onClose: () => void
  onSubmit: () => void
}

/** D-6 `XCVGd`。受付を止めると新しい注文が来なくなるので、対象と時間を見せてから送る。 */
export function IntakeStopDialog({
  accountId, store, open,
  services,
  disabledReason,
  selected,
  preset,
  busy,
  error,
  onToggleService,
  onPresetChange,
  onClose,
  onSubmit,
}: IntakeStopDialogProps) {
  const selectedSet = new Set(selected)
  const selection = intakeStopSelection(services, selected, preset)
  const selectionReason = disabledReason
    ?? selection.services.map(service => intakeActionReason(services.find(state => state.service === service), 'stop')).find(Boolean)
    ?? selection.problem
  const canSubmit = !busy && !selectionReason

  return (
    <RsDialog
      open={open}
      title="受付を一括停止しますか？"
      width={STOP_WIDTH}
      top={STOP_TOP}
      tone="destructive"
      busy={busy}
      designNode="XCVGd"
      /* 絵（`lSfGT`）の頭は白地。帯で囲まず、題の左の丸い印の中は一時停止の印。 */
      titleIcon={(
        <span className={styles.warnMark}>
          <Pause size={20} aria-hidden="true" />
        </span>
      )}
      titleRow="mark"
      plainTitle
      bodyGap={STOP_BODY_GAP}
      footerPlain
      footerGap={STOP_FOOT_GAP}
      actionsPlacement="footer"
      footerNote={selectionReason || error ? <DialogNote>{selectionReason ?? error}</DialogNote> : null}
      onCancel={onClose}
      actions={(
        <>
          <Button onClick={onClose} disabled={busy}>閉じる</Button>
          <Button
            variant="danger"
            busy={busy}
            busyLabel="停止中…"
            disabled={!canSubmit}
            aria-description={selectionReason ?? undefined}
            onClick={onSubmit}
          >
            <Pause size={16} aria-hidden="true" />止める
          </Button>
        </>
      )}
    >
      <div className={styles.targetSummary}><OperationTargetSummary accounts={[{ id: accountId ?? '' }]} store={store ?? { id: '' }} /></div>
      <p className={styles.dialogLead}>
        選んだサービスで新しい注文の受け付けを止めます。すでに受け付けた注文の調理・受け渡しはそのまま続きます。
      </p>

      <DialogField label="停止するサービス" kind="select" optional={false}>
        <div className={styles.stopList}>
          {services.length === 0 ? (
            <p className={styles.muted}>{DASH}</p>
          ) : (
            services.map((state) => {
              const label = state.label || DELIVERY_SERVICE_LABELS[state.service]
              const reason = disabledReason ?? intakeActionReason(state, 'stop')
              const picked = state.intakeStatus !== 'stopped' && selectedSet.has(state.service)
              return (
                <CheckCard
                  key={state.service}
                  size="row"
                  checked={picked}
                  disabled={Boolean(reason) || busy}
                  onChange={(checked) => onToggleService(state.service, checked)}
                  title={(
                    <>
                      <span className="sr-only">{`${label}の受付を止める`}</span>
                      {/* サービス札は点なしの丸い札。 */}
                      <StatusBadge tone={SERVICE_TONES[state.service]} size="compact" dot={false}>{label}</StatusBadge>
                    </>
                  )}
                  note={reason ?? `現在 受付中・${formatNumber(state.todayCount)}件対応中`}
                />
              )
            })
          )}
        </div>
        {!disabledReason && services.some(state => selectedSet.has(state.service) && intakeActionReason(state, 'stop')) ? (
          <Button variant="text" disabled={busy} onClick={() => {
            for (const state of services) if (selectedSet.has(state.service) && intakeActionReason(state, 'stop')) onToggleService(state.service, false)
          }}>操作できないサービスの選択を外す</Button>
        ) : null}
      </DialogField>

      {/*
        * 絵（`To5Y0`）の時間はつながった帯ではなく離れた札4つ。押した札だけ薄い緑にする。
        * 4つの排他的な選択なので共通の切り替え部品に任せ、この見た目は部品側の
        * `appearance="intake-stop"` が持つ（B-172：見た目は持ち主の部品に置く）。
        */}
      <DialogField label="停止する時間（過ぎると自動で再開します）" kind="select" optional={false}>
        <SegmentedControl
          aria-label="停止する時間"
          appearance="intake-stop"
          options={INTAKE_STOP_PRESET_OPTIONS.map((option) => ({
            value: option.value as DeliveryIntakeStopPreset,
            label: option.label,
          }))}
          value={preset}
          onChange={(value) => { if (value) onPresetChange(value) }}
          disabled={busy}
        />
      </DialogField>

    </RsDialog>
  )
}
