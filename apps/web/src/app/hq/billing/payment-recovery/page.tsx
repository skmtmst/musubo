'use client'

import { useCallback, useEffect, useState } from 'react'
import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation'
import { ListPage } from '@/components/templates'
import { PageContent } from '@/components/templates/page-frame'
import ListState from '@/components/shared/list-state'
import Button from '@/components/shared/button'
import { usePageCrumbs, usePageTitle } from '@/components/shell/page-chrome'
import { api, ApiError } from '@/lib/api'
import type { BillingPaymentFailureView } from '@/lib/hq-billing'
import MusuboPaymentRecovery from '@/v8/hq/musubo-payment-recovery'
import HqSettingsNavV8, { useHqSettingsFolderNav } from '@/v8/hq/settings-nav'

type LoadState = 'loading' | 'ready' | 'forbidden' | 'error'

function isStripePaymentUrl(value: string, host: 'invoice.stripe.com' | 'billing.stripe.com') {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname === host
  } catch {
    return false
  }
}

export default function BillingPaymentRecoveryPage() {
  usePageTitle('お支払いの確認')
  usePageCrumbs([{ label: '統括の設定', href: '/hq/settings' }, { label: '請求', href: '/hq/billing' }])
  const folderNav = useHqSettingsFolderNav('billing')
  const router = useRouter()
  const [state, setState] = useState<LoadState>('loading')
  const [failure, setFailure] = useState<BillingPaymentFailureView | null>(null)

  const load = useCallback(async () => {
    setState('loading')
    try {
      const result = await api.hqBilling.paymentFailure({ cache: 'reload' })
      if (!result.success) throw new Error(result.error)
      setFailure(result.data)
      setState('ready')
    } catch (error) {
      setState(error instanceof ApiError && error.status === 403 ? 'forbidden' : 'error')
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const frame = (content: React.ReactNode) => (
    <ListPage heightMode="viewport" title="お支払いの確認" folders={<HqSettingsNavV8 active="billing" />} folderNav={folderNav}>
      <PageContent>{content}</PageContent>
    </ListPage>
  )

  if (state === 'loading') return frame(<ListState permissionScope="hq" kind="loading" title="お支払い状況を確認しています" />)
  if (state === 'forbidden') return frame(<ListState permissionScope="hq" kind="forbidden" />)
  if (state === 'error') return frame(<ListState permissionScope="hq" kind="error" title="お支払い状況を読み込めませんでした" onRetry={() => void load()} />)
  if (!failure) return frame(<section aria-label="お支払い状況">
    <h2>未払いのご請求はありません</h2>
    <p>お支払いの記録と次回の請求予定は請求画面で確認できます。</p>
    <Button onClick={() => router.push('/hq/billing')}>請求を確認する</Button>
  </section>)

  return frame(<MusuboPaymentRecovery
    view={failure.state === 'recovered' ? {
      kind: 'invoice', state: 'recovered', amountYen: failure.amountYen,
      invoiceDate: failure.invoiceCreatedAt, graceDeadline: failure.graceDeadlineAt,
      paidAt: failure.paidAt, nextChargeAt: failure.nextChargeAt,
    } : {
      kind: 'invoice', state: failure.state, amountYen: failure.amountYen,
      invoiceDate: failure.invoiceCreatedAt, graceDeadline: failure.graceDeadlineAt,
    }}
    onPrimary={async () => {
      if (failure.state === 'recovered') { router.push('/hq/billing'); return }
      if (failure.paymentUrl && isStripePaymentUrl(failure.paymentUrl, 'invoice.stripe.com')) {
        window.location.assign(failure.paymentUrl)
        return
      }
      const result = await api.hqBilling.portal()
      if (!result.success || !isStripePaymentUrl(result.data.url, 'billing.stripe.com')) throw new Error('invalid_payment_url')
      window.location.assign(result.data.url)
    }}
    onSecondary={() => router.push(failure.state === 'recovered' ? '/accounts' : '/hq/billing')}
  />)
}
