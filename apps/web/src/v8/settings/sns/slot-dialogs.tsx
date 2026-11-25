/**
 * SNS 連携 複数接続 第1段の料金・解除の窓。
 *
 * 承認デザイン（設定SNS連携 複数接続 第1段 v7）の4つの窓をそのまま置く。
 * - F3 `q9hcp9` 枠超過 有料の確認
 * - F4 `uB88I` 枠超過 無料期間の確認
 * - F5 `R4dYE` 上限10個 個別見積もり
 * - F6 `JvuLH` 接続解除の確認
 *
 * 文言は承認デザインの原文をそのまま使い、数と金額だけを差し替える。
 * 日付と残り日数はサーバーの値だけを使い、利用者の時計から作らない。
 */

'use client'

import { formatYen } from '@line-crm/shared'
import Dialog from '@/components/shared/dialog'
import {
  SNS_CONNECTION_LIMIT,
  SNS_SLOT_UNIT_YEN,
  serviceCardTitle,
  serviceName,
  type SnsAdditionPlan,
  type SnsRemovalPlan,
  type SnsService,
  type SnsSlotsView,
} from './connection-slots'
import styles from './slot-dialogs.module.css'

/** 承認デザインの表記に合わせ、英字で終わる名前のうしろに空白を1つ置く（「Instagram を1個」）。 */
function withSpace(name: string): string {
  return /[A-Za-z0-9]$/.test(name) ? `${name} ` : name
}

/** 「Googleマイビジネス 2個 → 3個 ・ 契約枠 2個｜有料の追加枠 0枠 → 1枠」。 */
function slotChangeText(plan: Extract<SnsAdditionPlan, { kind: 'over-quota' }>): string {
  return (
    `${serviceName(plan.service)} ${plan.connectedBefore}個 → ${plan.connectedAfter}個` +
    ` ・ 契約枠 ${plan.contracted}個｜有料の追加枠 ${plan.paidSlotsBefore}枠 → ${plan.paidSlotsAfter}枠`
  )
}

/* --------------------------------------------- F3 `q9hcp9` 枠超過 有料の確認 */

type AdditionDialogProps = {
  plan: Extract<SnsAdditionPlan, { kind: 'over-quota' }>
  /** LINE アカウントの呼び名（「見本アカウント」）。 */
  accountName: string
  busy?: boolean
  error?: string
  onCancel: () => void
  onConfirm: () => void
}

export function SnsSlotPaidDialog({
  plan,
  accountName,
  busy,
  error,
  onCancel,
  onConfirm,
}: AdditionDialogProps) {
  const name = serviceName(plan.service)
  const days = plan.billing.kind === 'paid' ? plan.billing : null

  return (
    <Dialog
      open
      designNode="q9hcp9"
      designWidth={560}
      designMinHeight={426}
      designHeaderPadding="var(--tpl-e1-sns-slot-dlg-head-pad)"
      designContentPadding="var(--tpl-e1-sns-slot-dlg-body-pad)"
      designFooterPadding="var(--tpl-e1-sns-slot-dlg-foot-pad)"
      headerIcon={false}
      footerDivider={false}
      footerLeadFlexible={false}
      title="追加連携枠の料金を確認"
      cancelLabel="戻る"
      confirmLabel="料金に同意して連携へ"
      busy={busy}
      error={error}
      onCancel={onCancel}
      onConfirm={onConfirm}
    >
      <div className={styles.body}>
        <p className={styles.desc}>
          {`${accountName}に ${withSpace(name)}を1個追加します。` +
            `契約枠（${name} ${plan.contracted}個）を使い切っているため、` +
            `${plan.connectedAfter}個目からは有料の追加枠を使います。`}
        </p>

        <div className={styles.box}>
          <span className={styles.boxLabel}>次回からの月額増分（税込）</span>
          <span className={styles.boxAmount}>{`＋${formatYen(plan.monthlyIncreaseYen)} / 月`}</span>
          <span className={styles.boxDetail}>{slotChangeText(plan)}</span>
        </div>

        <div className={styles.totalRow}>
          <span className={styles.totalLabel}>追加後の連携枠料金（税込）</span>
          <span className={styles.totalValue}>{`${formatYen(plan.monthlyAfterYen)} / 月`}</span>
        </div>

        <div className={styles.boxOutlined}>
          <span className={styles.boxLabel}>
            {days
              ? `今回の追加分（次の月次請求まで残り${days.monthlyDaysRemaining}/${days.monthlyDaysInPeriod}日の見込み）`
              : '今回の追加分'}
          </span>
          <span className={styles.boxStrong}>
            {`決済成功時のお支払い ${formatYen(plan.dueNowYen)}（税込）`}
          </span>
        </div>
      </div>
    </Dialog>
  )
}

/* ----------------------------------------- F4 `uB88I` 枠超過 無料期間の確認 */

export function SnsSlotTrialDialog({
  plan,
  accountName,
  busy,
  error,
  onCancel,
  onConfirm,
}: AdditionDialogProps) {
  const name = serviceName(plan.service)

  return (
    <Dialog
      open
      designNode="uB88I"
      designWidth={560}
      designMinHeight={426}
      designHeaderPadding="var(--tpl-e1-sns-slot-dlg-head-pad)"
      designContentPadding="var(--tpl-e1-sns-slot-dlg-body-pad)"
      designFooterPadding="var(--tpl-e1-sns-slot-dlg-foot-pad)"
      headerIcon={false}
      footerDivider={false}
      footerLeadFlexible={false}
      title="追加料金はかかりません"
      cancelLabel="戻る"
      confirmLabel={`${withSpace(name)}の連携へ`}
      busy={busy}
      error={error}
      onCancel={onCancel}
      onConfirm={onConfirm}
    >
      <div className={styles.body}>
        <p className={styles.desc}>
          {`${accountName}に ${withSpace(name)}を1個追加します。` +
            `契約枠（${name} ${plan.contracted}個）を使い切っているため` +
            `${plan.connectedAfter}個目は追加枠を使いますが、無料期間中のため料金は0円です。`}
        </p>

        <div className={styles.box}>
          <span className={styles.boxLabel}>追加枠の料金は0円です</span>
          <span className={styles.boxAmount}>{`追加料金 ${formatYen(0)}`}</span>
          <span className={styles.boxDetail}>{slotChangeText(plan)}</span>
        </div>

        <div className={styles.totalRow}>
          <span className={styles.totalLabel}>無料期間終了後の連携枠料金（税込）</span>
          <span className={styles.totalValue}>{`${formatYen(plan.monthlyAfterYen)} / 月`}</span>
        </div>

        <div className={styles.boxOutlined}>
          <span className={styles.boxLabel}>今回のお支払い</span>
          <span className={styles.boxStrong}>
            {`${formatYen(0)}｜無料期間中のため今は請求しません`}
          </span>
        </div>
      </div>
    </Dialog>
  )
}

/** 枠超過の窓。無料期間中は F4、支払い中は F3。 */
export function SnsSlotAdditionDialog(props: AdditionDialogProps) {
  return props.plan.trialing ? <SnsSlotTrialDialog {...props} /> : <SnsSlotPaidDialog {...props} />
}

/* ------------------------------------- F5 `R4dYE` 上限10個 個別見積もり */

/** 「Googleマイビジネス 10個（上限）・ Instagram 2個」。上限に達したほうに（上限）を付ける。 */
function connectedCountText(slots: SnsSlotsView): string {
  const order: SnsService[] = ['googleBusiness', 'instagram']
  return order
    .map((service) => {
      const count = slots[service].connections.length
      const cap = count >= SNS_CONNECTION_LIMIT ? '（上限）' : ''
      return `${serviceName(service)} ${count}個${cap}`
    })
    .join('・ ')
}

/**
 * 「契約枠：Googleマイビジネス 2個 ・ Instagram 2個」。
 * 契約枠は両サービス共通の1つの数（1枠で両方が1個ずつ増える）なので、同じ数を両方に出す。
 */
function contractedCountText(slots: SnsSlotsView): string {
  const order: SnsService[] = ['googleBusiness', 'instagram']
  return `契約枠：${order
    .map((service) => `${serviceName(service)} ${slots.contracted}個`)
    .join(' ・ ')}`
}

export function SnsSlotQuoteDialog({
  plan,
  slots,
  onCancel,
  onContact,
}: {
  plan: Extract<SnsAdditionPlan, { kind: 'individual-quote' }>
  slots: SnsSlotsView
  onCancel: () => void
  onContact: () => void
}) {
  return (
    <Dialog
      open
      designNode="R4dYE"
      designWidth={560}
      designMinHeight={296}
      designHeaderPadding="var(--tpl-e1-sns-slot-dlg-head-pad)"
      designContentPadding="var(--tpl-e1-sns-slot-dlg-body-pad)"
      designFooterPadding="var(--tpl-e1-sns-slot-dlg-foot-pad)"
      headerIcon={false}
      footerDivider={false}
      footerLeadFlexible={false}
      title="追加の連携は個別見積もりになります"
      cancelLabel="閉じる"
      confirmLabel="お問い合わせへ"
      onCancel={onCancel}
      onConfirm={onContact}
    >
      <div className={styles.body}>
        <p className={styles.desc}>
          {`${serviceName(plan.service)}の連携が上限の${SNS_CONNECTION_LIMIT}個に達しています。` +
            `${SNS_CONNECTION_LIMIT + 1}個目からは料金を個別にお見積もりします。サポートへご相談ください。`}
        </p>

        <div className={styles.box}>
          <span className={styles.boxLabel}>いまの連携数</span>
          <span className={styles.boxStrong}>{connectedCountText(slots)}</span>
          <span className={styles.boxDetail}>{contractedCountText(slots)}</span>
        </div>
      </div>
    </Dialog>
  )
}

/* ---------------------------------------- F6 `JvuLH` 接続解除の確認 */

export function SnsSlotRemovalDialog({
  plan,
  accountName,
  nextBillingLabel,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  plan: SnsRemovalPlan
  accountName: string
  /**
   * 減額を反映する次回の月次請求日（「12月1日」）。サーバーの値だけを使う。
   * 分からないときは減額の箱を出さない（承認デザインに該当のフレームが無いため、
   * 推測の金額や日付を作らない）。
   */
  nextBillingLabel?: string | null
  busy?: boolean
  error?: string
  onCancel: () => void
  onConfirm: () => void
}) {
  const cardTitle = serviceCardTitle(plan.service)
  const showDecrease = plan.monthlyDecreaseYen > 0 && Boolean(nextBillingLabel)

  // 絵（JvuLH の題 nbmJr）は題の文字だけで左の印が無いので、共通部品の口 headerIcon={false} で印を省く。
  return (
    <Dialog
      open
      designNode="JvuLH"
      designWidth={560}
      designMinHeight={470}
      designHeaderPadding="var(--tpl-e1-sns-slot-dlg-head-pad)"
      designContentPadding="var(--tpl-e1-sns-slot-dlg-body-pad)"
      designFooterPadding="var(--tpl-e1-sns-slot-dlg-foot-pad)"
      headerIcon={false}
      footerDivider={false}
      footerLeadFlexible={false}
      title={`${cardTitle}の接続を解除しますか？`}
      cancelLabel="戻る"
      confirmLabel="解除する"
      confirmVariant="danger"
      busy={busy}
      error={error}
      onCancel={onCancel}
      onConfirm={onConfirm}
    >
      <div className={styles.body}>
        <p className={styles.desc}>
          解除すると、この連携先への投稿と情報の取り込みはすぐに停止します。ほかの連携と LINE
          の接続は続きます。あとでもう一度つなぎ直せます。
        </p>

        <dl className={styles.rows}>
          <div className={styles.row}>
            <dt className={styles.rowLabel}>LINEアカウント</dt>
            <dd className={styles.rowValue}>{accountName}</dd>
          </div>
          <div className={styles.row}>
            <dt className={styles.rowLabel}>解除する連携先</dt>
            <dd className={styles.rowValue}>{`${plan.connection.name}（${cardTitle}）`}</dd>
          </div>
          <div className={styles.row}>
            <dt className={styles.rowLabel}>{`${serviceName(plan.service)}の連携数`}</dt>
            <dd className={styles.rowValue}>{`${plan.connectedBefore}個 → ${plan.connectedAfter}個`}</dd>
          </div>
          <div className={styles.row}>
            <dt className={styles.rowLabel}>契約枠</dt>
            <dd className={styles.rowValue}>{`${plan.contracted}個（変わりません）`}</dd>
          </div>
          <div className={styles.row}>
            <dt className={styles.rowLabel}>有料の追加連携枠</dt>
            <dd className={styles.rowValue}>{`${plan.paidSlotsBefore}枠 → ${plan.paidSlotsAfter}枠`}</dd>
          </div>
        </dl>

        {showDecrease ? (
          <div className={styles.boxOutlined}>
            <span className={styles.boxLabel}>次回の月次請求から</span>
            <span className={styles.boxAmountSmall}>
              {`−${formatYen(plan.monthlyDecreaseYen)} / 月（税込）`}
            </span>
            <span className={styles.boxDetail}>
              {`${nextBillingLabel}から1枠あたり${formatYen(SNS_SLOT_UNIT_YEN)}の減額を反映します。今回分の返金はありません。`}
            </span>
          </div>
        ) : null}
      </div>
    </Dialog>
  )
}
