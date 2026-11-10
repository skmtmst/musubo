'use client'

import Button from '@/components/shared/button'
import Notice from '@/components/shared/notice'
import { useCallback, useEffect, useState } from 'react'
import { ListPage } from '@/components/templates'
import { PageContent } from '@/components/templates/page-frame'
import { Steps } from '@/components/templates/steps'
import { usePageCrumbs, usePageTitle } from '@/components/shell/page-chrome'
import { api } from '@/lib/api'
import styles from './card-registration.module.css'

type CardState = 'checking' | 'unregistered' | 'registered' | 'error'
type ReturnState = 'success' | 'cancel' | null

interface Props {
  /** Stripe Checkout から戻る入口だけが渡す。戻り値だけでは登録完了とみなさない。 */
  returnState?: ReturnState
  quoteId?: string | null
  onContinue?: () => void
  onBackToPricing?: () => void
  onOpenStripe?: (url: string) => void
}

const CARD_CHECK_DELAYS_MS = [0, 2_000, 2_000, 2_000]

/** Stripe から返された URL だけをブラウザで開く。API が誤った URL を返しても転送しない。 */
export function isStripeCardSetupUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname === 'checkout.stripe.com'
  } catch {
    return false
  }
}

export default function CardRegistration({ returnState = null, quoteId, onContinue, onBackToPricing, onOpenStripe }: Props) {
  usePageTitle('お支払い情報')
  usePageCrumbs([{ label: 'ホーム', href: '/hq' }, { label: '利用開始の準備' }])
  const [state, setState] = useState<CardState>('checking')
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState('')

  const refresh = useCallback(async () => {
    setState('checking')
    setActionError('')
    try {
      const result = await api.hqBilling.cardStatus({ cache: 'reload' })
      if (!result.success) throw new Error(result.error)
      setState(result.data.registered ? 'registered' : 'unregistered')
    } catch {
      setState('error')
    }
  }, [])

  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const check = async (attempt: number) => {
      try {
        const result = await api.hqBilling.cardStatus({ cache: 'reload' })
        if (disposed) return
        if (!result.success) throw new Error(result.error)
        if (result.data.registered) {
          setState('registered')
          return
        }
        if (returnState === 'success' && attempt + 1 < CARD_CHECK_DELAYS_MS.length) {
          timer = setTimeout(() => void check(attempt + 1), CARD_CHECK_DELAYS_MS[attempt + 1])
          return
        }
        setState('unregistered')
      } catch {
        if (!disposed) setState('error')
      }
    }
    void check(0)
    return () => { disposed = true; if (timer) clearTimeout(timer) }
  }, [returnState])

  const openCardForm = async () => {
    if (busy) return
    setBusy(true)
    setActionError('')
    try {
      const result = await api.hqBilling.cardSetup(quoteId ?? undefined)
      if (!result.success || !isStripeCardSetupUrl(result.data.url)) throw new Error('invalid_checkout_url')
      if (onOpenStripe) onOpenStripe(result.data.url)
      else window.location.assign(result.data.url)
    } catch {
      setActionError('カード登録画面を開けませんでした。通信状態を確認して、もう一度お試しください。')
      setBusy(false)
    }
  }

  const next = () => {
    if (onContinue) onContinue()
    else window.location.assign('/accounts/new')
  }

  return <ListPage heightMode="viewport" title="お支払い情報" help="カード登録後、LINE公式アカウントを接続します。"
    steps={<Steps label="利用開始の手順" steps={[{ key: 'price', label: '料金を確認', state: 'done' },
      { key: 'card', label: 'カードを登録', state: 'current' }, { key: 'line', label: 'LINEを接続', state: 'todo' }]} />}>
    <PageContent>
      <Notice tone="info">カード情報はStripeの安全な画面で入力します。musuboにカード番号やセキュリティコードは保存されません。</Notice>
      <section className={styles.card} aria-labelledby="card-state-title">
        <div className={styles.stateHeading}>
          <span className={state === 'registered' ? styles.successIcon : styles.cardIcon} aria-hidden="true">
            {state === 'registered' ? '✓' : state === 'checking' ? '…' : '!'}
          </span>
          <div>
            <h2 id="card-state-title">{state === 'registered' ? 'カードの登録が完了しました'
              : state === 'checking' ? 'カードの登録状況を確認しています'
                : state === 'error' ? 'カードの登録状況を確認できません'
                  : returnState === 'cancel' ? 'カード登録はまだ完了していません'
                    : returnState === 'success' ? 'Stripeの完了通知を確認できませんでした'
                      : 'カードを登録してください'}</h2>
            <p>{state === 'registered' ? '次はLINE公式アカウントを接続します。'
              : state === 'checking' ? 'Stripeの完了通知が届くまで、少し時間がかかる場合があります。'
                : state === 'error' ? '通信状態を確認し、もう一度読み込んでください。'
                  : returnState === 'cancel' ? '入力が中断されました。料金の確認内容を保ったまま、もう一度登録できます。'
                    : returnState === 'success' ? 'Stripeの画面から戻りましたが、登録完了をまだ確認できません。しばらくしてから再確認してください。'
                      : 'Stripeの画面でカード情報を入力して続けてください。'}</p>
          </div>
        </div>
        <div className={styles.statusBox}>
          <strong>現在の状態</strong>
          <p>✓ 料金条件を確認済み</p>
          <p>{state === 'registered' ? '✓ カード登録済み・LINE未接続' : '○ カード未登録・LINE未接続'}</p>
          <p>カード登録時の請求：¥0</p>
        </div>
        <p className={styles.note}>カードを登録するだけでは請求は始まりません。無料期間と初回請求日は、最初のLINEを有効化した後に確認できます。</p>
        {actionError && <Notice tone="danger" role="alert">{actionError}</Notice>}
        <div className={styles.actions}>
          {state === 'registered'
            ? <Button type="button" variant="primary" onClick={next}>LINEアカウントの接続へ</Button>
            : state === 'checking'
              ? <Button type="button" variant="primary" disabled>確認中…</Button>
              : <>
                <Button type="button" variant="primary" onClick={() => void openCardForm()} busy={busy} busyLabel="画面を開いています…">
                  {returnState === 'cancel' ? 'カードを登録し直す' : 'Stripeでカードを登録する'}
                </Button>
                {(state === 'error' || returnState === 'success') && <Button type="button" variant="secondary" onClick={() => void refresh()}>登録状況を再確認</Button>}
              </>}
        </div>
      </section>
      <div className={styles.footer}>
        <p>後で再開する場合は、ログイン後の「利用開始の準備」から続けられます。</p>
        {onBackToPricing && <Button type="button" variant="text" onClick={onBackToPricing}>料金の確認に戻る</Button>}
      </div>
    </PageContent>
  </ListPage>
}
