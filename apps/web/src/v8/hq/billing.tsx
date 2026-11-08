'use client'

import Card from '@/components/shared/card'

import { PageContent } from '@/components/templates/page-frame'

/*
 * ★V8 統括の請求（Pencil ）。
 *
 * 管理画面 の画面（app/hq/billing/page.tsx）と読み書きの口・権限・失敗時の扱いは同じ。
 * 見た目だけを絵どおりに一から組んだ：頭（型 ListPage）・左の「統括の設定」の列
 * （型のフォルダの列）・契約の帯・周期の切り替えと「支払い方法を管理」・プラン3枚・
 * 支払い履歴の表。
 *
 * 2026-10-08 オーナー：いま契約しているプランに印（緑の枠・「利用中」・押せない［いまのプラン］）、
 * ほかのカードに［このプランに変える］（今のプランが無いときは［このプランにする］）。オーナーだけ。
 * 課金の対象外の統括でも、API がプラン（planKey）を返すならそのプランを「利用中」にする。
 * お金が動く操作は新しく作らない：変えるときは確認の窓から、今ある口（支払いの管理＝Stripe の画面）
 * へ渡す。課金の対象外・支払いの管理画面が無いときは、運営へのお問い合わせへ渡す。
 */
import { PRODUCT_SCOPE, planFeatureLabel } from '@/lib/product-scope'
import HelpTip from '@/components/shared/help-tip'
import { Check, CreditCard, Download } from 'lucide-react'
import { useSearchParams } from 'next/navigation'
import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation'
import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { ListPage } from '@/components/templates'
import { DataTable, TableHeadRow, Th, Tr, Td } from '@/components/shared/table'
import Button from '@/components/shared/button'
import TruncatedText from '@/components/shared/truncated-text'
import StatusBadge from '@/components/shared/status-badge'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import KpiBand from '@/components/shared/kpi-band'
import KpiCard from '@/components/shared/kpi-card'
import SegmentedControl from '@/components/shared/segmented'
import { usePageCrumbs, usePageTitle } from '@/components/shell/page-chrome'
import { api, ApiError } from '@/lib/api'
import { fetchHqBillingMetrics } from '@/lib/api/helpers/hq-billing'
import { useStaffRole, canAdministerRole } from '@/lib/staff-role'
import {
  INVOICE_STATUS_LABELS,
  billingBanner,
  billingPlanPrice,
  billingPriceNote,
  yen,
  type BillingInvoice,
  type BillingInterval,
  type BillingPlanView,
  type BillingSummary,
} from '@/lib/hq-billing'
import { billingFailureMessage } from './billing-failure'
import HqSettingsNavV8, { useHqSettingsFolderNav } from './settings-nav'
import styles from './billing.module.css'
import { formatDate as polishFormatDate } from '@/lib/format'
import { emptyValue, EmptyCell } from '@/components/shared/empty-value'

type LoadStatus = 'loading' | 'ready' | 'error' | 'forbidden'
type BillingMetrics = Awaited<ReturnType<typeof fetchHqBillingMetrics>>['data']

/** プランを変える確認の窓の渡し先。portal＝支払いの管理（Stripe の画面）、contact＝運営へのお問い合わせ。 */
type ChangeRoute = 'portal' | 'contact'

/**
 * いま使っているプラン。契約中（active・past_due）は API の `current`、
 * 課金の対象外は API が返す `planKey`（返さなければ無し）。
 */
export function currentPlanKey(summary: BillingSummary): BillingSummary['planKey'] {
  const current = summary.plans.find((plan) => plan.current)
  if (current) return current.key
  if (summary.state === 'exempt' && summary.planKey && summary.plans.some((plan) => plan.key === summary.planKey)) return summary.planKey
  return null
}

/** 絵の言葉。まだ払われていない請求は「請求中」。 */
const INVOICE_WORDS: Record<string, string> = { ...INVOICE_STATUS_LABELS, open: '請求中' }

const TITLE = '請求'
const DESCRIPTION = `プランと支払いの記録です。プランの申込はオーナーだけ、支払い方法の管理はオーナーか管理者ができます。${PRODUCT_SCOPE.estimates} ${PRODUCT_SCOPE.boundaries}`

export default function HqBillingV8() {
  return (
    <Suspense fallback={null}>
      <BillingInner />
    </Suspense>
  )
}

/** 支払い履歴の日付（絵は「2026/10/01」）。 */
function invoiceDate(iso: string): string {
  return polishFormatDate(iso, { style: 'list-day', fallback: '—' })
}

function BillingInner() {
  // ★V8 上の帯のパンくずは「ホーム › 統括の設定 › 画面名」。
  usePageTitle('請求')
  usePageCrumbs([{ label: '統括の設定', href: '/hq/settings' }])
  const settingsNav = useHqSettingsFolderNav('billing')
  const params = useSearchParams()
  const router = useRouter()
  const checkoutResult = params.get('checkout')
  /* 役割はサーバ（/api/staff/me）から読む。手元の保存値は使わない。 */
  const role = useStaffRole() ?? ''

  const [status, setStatus] = useState<LoadStatus>('loading')
  const [summary, setSummary] = useState<BillingSummary | null>(null)
  const [metrics, setMetrics] = useState<BillingMetrics | null>(null)
  const [metricsLoading, setMetricsLoading] = useState(false)
  const [metricsFailed, setMetricsFailed] = useState(false)
  const [metricsAttempt, setMetricsAttempt] = useState(0)
  const [invoices, setInvoices] = useState<BillingInvoice[] | null>(null)
  /* R118: 履歴だけの取得失敗は概要と分けて持つ（失敗を `[]` に畳まない）。 */
  const [invoiceFailed, setInvoiceFailed] = useState(false)
  /* M023：履歴の 502（決済サービス不通）も決済サービスの案内にするための目安。 */
  const [invoiceError, setInvoiceError] = useState<unknown>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [interval, setInterval] = useState<BillingInterval>('month')
  /* 最初に読めたときだけ、周期の切り替えを契約中の周期に合わせる（あとは人が選んだまま）。 */
  const intervalSynced = useRef(false)
  const [change, setChange] = useState<{ plan: BillingPlanView; route: ChangeRoute } | null>(null)

  const load = useCallback(async (reload = false) => {
    setStatus('loading')
    setInvoiceFailed(false)
    setInvoiceError(null)
    try {
      const [summaryRes, invoiceRes] = await Promise.all([
        api.hqBilling.summary(reload ? { cache: 'reload' } : undefined),
        api.hqBilling.invoices().catch((caught: unknown) => {
          setInvoiceError(caught)
          return null
        }),
      ])
      if (!summaryRes.success) throw new Error(summaryRes.error)
      setSummary(summaryRes.data)
      if (!intervalSynced.current) {
        intervalSynced.current = true
        if (summaryRes.data.planInterval) setInterval(summaryRes.data.planInterval)
      }
      setInvoices(invoiceRes?.success ? invoiceRes.data : null)
      setInvoiceFailed(!invoiceRes?.success)
      setStatus('ready')
    } catch (caught) {
      setStatus(caught instanceof ApiError && caught.status === 403 ? 'forbidden' : 'error')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    let cancelled = false
    setMetrics(null)
    setMetricsFailed(false)
    if (!role) {
      setMetricsLoading(false)
      return () => { cancelled = true }
    }
    setMetricsLoading(true)
    void fetchHqBillingMetrics().then((res) => {
      if (cancelled) return
      if (res.success) setMetrics(res.data)
      else setMetricsFailed(true)
    }).catch(() => {
      if (!cancelled) setMetricsFailed(true)
    }).finally(() => {
      if (!cancelled) setMetricsLoading(false)
    })
    return () => { cancelled = true }
  }, [role, metricsAttempt])

  // Checkout から戻った直後は Webhook がまだ届いていないことがある。少し待って読み直す。
  useEffect(() => {
    if (checkoutResult !== 'success') return
    const timer = setTimeout(() => void load(true), 4000)
    return () => clearTimeout(timer)
  }, [checkoutResult, load])

  const checkout = async (plan: BillingPlanView, selectedInterval: BillingInterval) => {
    setBusy(plan.key)
    setError('')
    try {
      const res = await api.hqBilling.checkout(plan.key, selectedInterval)
      if (!res.success) throw new Error(res.error)
      window.location.href = res.data.url
    } catch (caught) {
      // M023/M024：原文のまま出さず、共通の案内へ渡す（502 は決済サービスの案内）。
      setError(billingFailureMessage(caught, '申込画面の表示', 'プランの申込はオーナーだけができます。オーナーの方に操作してもらってください。'))
      setBusy(null)
    }
  }

  const portal = async () => {
    setBusy('portal')
    setError('')
    try {
      const res = await api.hqBilling.portal()
      if (!res.success) throw new Error(res.error)
      window.location.href = res.data.url
      return true
    } catch (caught) {
      setError(billingFailureMessage(caught, '支払い方法の管理画面の表示', '支払い方法の管理はオーナーか管理者だけができます。オーナーか管理者の方に操作してもらってください。'))
      setBusy(null)
      return false
    }
  }

  const invoiceUnreachable = invoiceError instanceof ApiError && invoiceError.status === 502

  /*
   * 設定の画面はどれも「左に設定の列・右に中身」にそろえる（メンバーと同じ）。
   * 数の帯も右の中身の先頭に置き、左の列より上へ横いっぱいに張り出さない。
   */
  const metricsBand = status === 'ready' && role !== null ? (
    <KpiBand data-template-region="stats">
      <KpiCard title="今月の請求" value={metrics?.thisMonthBilledYen} valueText={metrics?.thisMonthBilledYen != null ? yen(metrics.thisMonthBilledYen) : undefined} unit="" detail={metricsLoading ? '読み込んでいます' : metricsFailed ? '読み込めませんでした' : metrics?.thisMonthBilledYen == null ? '今月の請求は未取得' : '保存済みの請求から集計'} loading={metricsLoading} onRetry={metricsFailed ? () => setMetricsAttempt((attempt) => attempt + 1) : undefined} />
      <KpiCard title="契約中" value={metrics?.contractCount} unit="契約" detail={metricsLoading ? '読み込んでいます' : metricsFailed ? '読み込めませんでした' : metrics?.activeAccountCount != null && metrics.trialCount != null ? `稼働中 ${metrics.activeAccountCount}アカウント・トライアル ${metrics.trialCount}` : '未取得'} help="統括単位の契約数です。LINEアカウントごとの契約数ではありません。" loading={metricsLoading} />
      <KpiCard title="未払い" value={metrics?.unpaidInvoiceCount} unit="件" detail={metricsLoading ? '読み込んでいます' : metricsFailed ? '読み込めませんでした' : metrics?.unpaidInvoiceCount == null ? '請求の記録は未取得' : '保存済みの請求から集計'} loading={metricsLoading} />
      <KpiCard title="次の請求日" value={null} valueText={metrics?.nextBillingAt ? polishFormatDate(metrics.nextBillingAt, { style: 'list-day' }) : undefined} unit="" detail={metricsLoading ? '読み込んでいます' : metricsFailed ? '読み込めませんでした' : metrics?.nextBillingAt ? '現在の契約の更新日' : '予定は未取得'} loading={metricsLoading} />
    </KpiBand>
  ) : null

  const frame = (body: React.ReactNode) => (
    <ListPage boardId="JB8V1" title={TITLE} help={DESCRIPTION} folders={<HqSettingsNavV8 active="billing" />} folderNav={settingsNav}>
      <PageContent>{metricsBand}{body}</PageContent>
    </ListPage>
  )

  if (status === 'loading') return frame(<ListState permissionScope="hq" kind="loading" title="契約状況を読み込んでいます" />)
  // 担当者は見られない（権限表: 課金プランは担当者 不可。閲覧のみは閲覧できる）。
  if (status === 'forbidden' || role === 'staff') return frame(<ListState permissionScope="hq" kind="forbidden" />)
  if (status === 'error' || !summary) {
    return frame(<ListState permissionScope="hq" kind="error" title="契約状況を読み込めませんでした" description="通信の状態を確認して、もう一度お試しください。" onRetry={() => void load(true)} />)
  }

  const banner = billingBanner(summary)
  const isOwner = role === 'owner'
  const canManagePayment = canAdministerRole(role)
  const canChoose = isOwner && summary.state !== 'exempt' && summary.state !== 'active' && summary.state !== 'past_due'
  const currentKey = currentPlanKey(summary)
  /* 契約中の変更は支払いの管理（Stripe の画面）で。管理画面が無い・課金の対象外は運営へ頼む。 */
  const changeRoute: ChangeRoute | null = summary.state === 'exempt'
    ? 'contact'
    : summary.state === 'active' || summary.state === 'past_due'
      ? (summary.portalAvailable ? 'portal' : 'contact')
      : null
  const yearlyMins = summary.plans
    .map((plan) => billingPlanPrice(plan, 'year').yearlyYen)
    .filter((yenValue): yenValue is number => yenValue !== null)
  const yearlyMin = yearlyMins.length > 0 ? Math.min(...yearlyMins) : null
  /* 申込の口が押せない理由（決済の設定がまだ・オーナー以外）は、押せないときだけ出す。 */
  const blockedNote = !summary.stripeReady
    ? `決済の接続設定がまだのため、申込ボタンは押せません。${billingPriceNote(summary.plans, interval)}`
    : !isOwner && role !== ''
      ? `プランの申込と変更はオーナーだけができます。${billingPriceNote(summary.plans, interval)}`
      : ''

  return frame(
    <>
      {checkoutResult === 'success' ? (
        <Notice tone="info" message="お申し込みを受け付けました。決済の確認が済むと「契約中」に変わります（数秒〜1分ほどかかります）。" />
      ) : null}
      {checkoutResult === 'cancel' ? (
        <Notice tone="info" message="お申し込みを中止しました。プランはいつでも選び直せます。" />
      ) : null}

      {banner.tone === 'info' ? (
        <p className={styles.contract} data-design="Status"><ContractText summary={summary} /></p>
      ) : (
        <div data-design="Status"><Notice tone={banner.tone} message={bannerSentence(banner.title, banner.body)} /></div>
      )}

      <div className={styles.intervalRow} data-design="Interval">
        <SegmentedControl<BillingInterval>
          aria-label="支払いの周期"
          size="small"
          value={interval}
          onChange={setInterval}
          options={[
            { value: 'month', label: '月払い' },
            { value: 'year', label: yearlyMin !== null ? `年払い（年 ${yen(yearlyMin)}〜）` : '年払い' },
          ]}
        />
        {summary.portalAvailable && canManagePayment ? (
          <Button onClick={() => void portal()} disabled={busy !== null} busy={busy === 'portal'} busyLabel="開いています…">
            <CreditCard aria-hidden="true" className={styles.buttonIcon} />支払い方法を管理
          </Button>
        ) : null}
      </div>

      {error ? <Notice tone="danger" >{error}</Notice> : null}

      <div className={styles.plans} data-design="Plans">
        {summary.plans.map((plan) => {
          const price = billingPlanPrice(plan, interval)
          const isCurrent = plan.key === currentKey
          return (
            <Card as="section" layout="vertical" padding="default" gap="normal" key={plan.key} aria-current={isCurrent ? 'true' : undefined}>
              <div className={styles.planHead}>
                <h2 className={styles.planName}>{plan.name}</h2>
                {plan.recommended ? <span className={styles.badge}>おすすめ</span> : null}
                {interval === 'year' ? <span className={styles.badge}>約15% OFF</span> : null}
                {isCurrent ? <StatusBadge tone="success">利用中</StatusBadge> : null}
              </div>
              <p className={styles.planDesc}>{plan.description}</p>
              <p className={styles.price} data-price-source={price.fromStripe ? 'stripe' : 'fallback'}>
                <span className={styles.priceValue}>{yen(price.monthlyYen)}</span>
                <span className={styles.priceUnit}>/月（税込）</span>
                {price.yearlyYen !== null ? <span className={styles.priceUnit}>年額 {yen(price.yearlyYen)}（税込）</span> : null}
                {!price.fromStripe ? <span className={styles.priceUnit}>仮の料金です</span> : null}
              </p>
              <ul className={styles.features}>
                {plan.features.map((feature) => (
                  <li key={feature} className={styles.feature}>
                    <Check aria-hidden="true" className={styles.check} />
                    {planFeatureLabel(feature)}
                  </li>
                ))}
              </ul>
              <div className={styles.planFoot}>
                {isCurrent ? (
                  <Button disabled title="現在利用中のプランです" className={styles.planButton}>
                    <Check aria-hidden="true" className={styles.buttonIcon} />いまのプラン
                  </Button>
                ) : isOwner && changeRoute ? (
                  <Button
                    onClick={() => { setError(''); setChange({ plan, route: changeRoute }) }}
                    disabled={busy !== null}
                    className={styles.planButton}
                  >
                    {currentKey ? 'このプランに変える' : 'このプランにする'}
                  </Button>
                ) : isOwner ? (
                  <Button
                    onClick={() => void checkout(plan, interval)}
                    disabled={busy !== null || !canChoose || !price.available}
                    className={styles.planButton}
                    busy={busy === plan.key}
                    busyLabel="申込画面へ移動中…"
                  >
                    このプランにする
                  </Button>
                ) : null}
                {!price.available && !isCurrent && !changeRoute ? <p className={styles.planNote}>価格がまだ設定されていません</p> : null}
              </div>
            </Card>
          )
        })}
      </div>

      <p className={styles.note}>数は目安です</p>
      {blockedNote ? <p className={styles.note} data-design="Note">{blockedNote}</p> : null}

      <ConfirmDialog
        open={change !== null}
        title={change ? `${change.plan.name}に${currentKey ? '変えます' : 'します'}か` : ''}
        description={change?.route === 'portal'
          ? `プランの変更は Stripe の支払いの画面で確定します。開いた画面で「${change?.plan.name ?? ''}」を選び、差額と適用日を確かめてから確定してください。ここではまだプランは変わりません。`
          : `この統括は課金の対象外のため、プランの変更は運営が行います。お問い合わせから、変えたいプラン（${change?.plan.name ?? ''}・${interval === 'year' ? '年払い' : '月払い'}）を運営に伝えてください。差額と適用日は運営からの返事で確かめられます。`}
        confirmLabel={change?.route === 'portal' ? 'Stripe の画面を開く' : 'お問い合わせへ'}
        busy={busy === 'portal'}
        onCancel={() => setChange(null)}
        onConfirm={() => {
          if (!change) return
          if (change.route === 'portal') {
            return portal()
          }
          setChange(null)
          router.push('/hq/support')
          return true
        }}
        error={error || undefined}
        onSuccess={() => setChange(null)}
      />

      <section className={styles.history} data-design="History">
        <h2 className={styles.historyTitle}>支払い履歴</h2>
        {invoiceFailed ? (
          <ListState permissionScope="hq"
            kind="error"
            title={invoiceUnreachable ? '決済サービスにつながりませんでした' : '支払い履歴を読み込めませんでした'}
            description={invoiceUnreachable ? '少し待って、もう一度読み込んでください。' : undefined}
            error={invoiceError ?? undefined}
            onRetry={() => void load(true)}
          />
        ) : invoices === null || invoices.length === 0 ? (
          <p className={styles.empty}>まだ支払いはありません。プランを選ぶと、ここに請求と支払いの記録が並びます。</p>
        ) : (
          <DataTable label="支払い履歴" columnSizing="content" grid={{
            columns: 'var(--tpl-hq-col-date) minmax(0, 1fr) var(--tpl-hq-col-amount) var(--tpl-rt-col-130) max(var(--tpl-hq-col-receipt), var(--row-action-width, 0px))',
            padding: 'var(--tpl-hq-pay-row-pad)',
            headPadding: 'var(--tpl-hq-head-pad)',
            gap: 'var(--tpl-hq-col-gap)',
            bodyTextSize: 'var(--text-caption)',
            headTextSize: 'var(--text-micro)',
          }}>
            <thead><TableHeadRow>
              <Th>日付</Th>
              <Th grow>内容</Th>
              <Th align="right">金額</Th>
              <Th>状態</Th>
              <Th>領収書</Th>
            </TableHeadRow></thead>
            <tbody>{invoices.map((inv) => (
              <Tr key={inv.id}>
                <Td>{invoiceDate(inv.createdAt)}</Td>
                <Td grow><TruncatedText value={inv.description ?? inv.number ?? emptyValue('unknown')} /></Td>
                <Td align="right">{yen(inv.amountYen)}</Td>
                <Td>
                  <StatusBadge tone={inv.status === 'paid' ? 'success' : inv.status === 'open' || inv.status === 'draft' ? 'info' : 'neutral'}>{INVOICE_WORDS[inv.status ?? ''] ?? inv.status ?? emptyValue('unknown')}</StatusBadge>
                </Td>
                <Td align="right" data-list-action-cell>
                  {inv.hostedUrl ? (
                    <Button size="compact" external href={inv.hostedUrl}>
                      <Download aria-hidden="true" className={styles.buttonIcon} />領収書
                    </Button>
                  ) : (
                    <EmptyCell />
                  )}
                </Td>
              </Tr>
            ))}</tbody>
          </DataTable>
        )}
      </section>
    </>,
  )
}

/** 見出しと本文の間に句点を入れる。見出しが句点で終わっていれば重ねない。 */
function bannerSentence(title: string, body: string): string {
  return `${title}${/[。！？]$/u.test(title) ? '' : '。'}${body}`
}

/** 契約の帯（板の灰色の箱）。契約中は絵の文面、ほかは帯の文面をそのまま出す。 */
function ContractText({ summary }: { summary: BillingSummary }) {
  if (summary.state === 'active' && summary.planName) {
    const current = summary.plans.find((plan) => plan.current)
    const basis = summary.planInterval === 'year' ? '年払い' : summary.planInterval === 'month' ? '月払い' : null
    const price = current ? billingPlanPrice(current, summary.planInterval === 'year' ? 'year' : 'month') : null
    const amount = price ? ` ${yen(summary.planInterval === 'year' && price.yearlyYen !== null ? price.yearlyYen : price.monthlyYen)}` : ''
    return (
      <>
        <span>いまのプラン：{summary.planName}（{[basis, amount].filter(Boolean).join('')}）{summary.currentPeriodEndsLabel ? `・次回の更新日 ${summary.currentPeriodEndsLabel}` : ''}</span>
        <HelpTip label="プラン変更の説明">プランを変えるときは、「支払い方法を管理」から開く Stripe の画面で、差額と適用日を確かめてから確定します。</HelpTip>
      </>
    )
  }
  const exemptPlan = summary.state === 'exempt' ? summary.plans.find((plan) => plan.key === currentPlanKey(summary)) : undefined
  if (exemptPlan) {
    return (
      <>
        <span>いまのプラン：{exemptPlan.name}（課金の対象外）</span>
        <HelpTip label="プラン変更の説明">この統括は運営用のため、料金はかかりません。プランを変えるときは、お問い合わせから運営に伝えます。</HelpTip>
      </>
    )
  }
  const banner = billingBanner(summary)
  return <>{bannerSentence(banner.title, banner.body)}</>
}
