'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Calculator, CreditCard, Pencil, Settings } from 'lucide-react'
import Card, { CardHeader } from '@/components/shared/card'
import HelpTip from '@/components/shared/help-tip'
import NumberInput from '@/components/shared/number-field'
import { Field } from '@/components/shared/form-controls'
import Notice from '@/components/shared/notice'
import RadioCard, { RadioCardGroup } from '@/components/shared/radio-card'
import TextLink from '@/components/shared/text-link'
import { isSaveConflict, SaveConflictBand, SaveConflictCompareDialog, saveConflictTitle, useSaveConflict, type SaveConflictDiffLine, type SaveConflictState } from '@/components/shared/save-conflict'
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import { formatYen } from '@/lib/format'
import { bookingApi } from '@/lib/api'
import { bookingPaymentAdminApi, isNotReadyError, type BookingPaymentMode } from '@/lib/api/helpers/booking-payment-admin'
import { MODE_LABEL, providerFor } from './labels'
import styles from './payments.module.css'

/*
 * メニュー・コース・クラスごとの「お支払い」の段（ 追記 3・絵 mauOC・XFRyO・）。
 * いつもの方法を使う／このメニューだけ変える（オンラインで先払い・お店で払う・お客さまが選ぶ）。
 * 決済をつないでいない店では段を出さず、1 行だけ「お支払いをつなぐ →」（押せない形にしない）。
 * 予約メニューは saveMenuPayment／clearMenuPayment、コース・クラスは組3 の口（版つき。古いと 409 → 共通の比べる窓）。
 */

export type MenuPaymentKind = 'booking' | 'course' | 'event'
type Status = 'loading' | 'ready' | 'not-ready' | 'error'
type Latest = { mode: BookingPaymentMode | null; price: number | null }

export interface MenuPaymentState {
  status: Status
  connected: boolean
  defaultMode: BookingPaymentMode
  /** null＝いつもの方法を使う。 */
  value: BookingPaymentMode | null
  /** クラスの 1 回の値段（event のときだけ。ほかは null）。 */
  price: number | null
  dirty: boolean
  setValue: (next: BookingPaymentMode | null) => void
  setPrice: (next: number | null) => void
  /** 変えていれば保存する。口が無いときは保存しない（準備中）。版が古いと 409 → 比べる窓。 */
  save: (id?: string) => Promise<void>
  reset: () => void
  conflict: SaveConflictState<Latest>
  saveErrors: ReturnType<typeof useSaveFormErrors>
}

function normal(mode: BookingPaymentMode | null | undefined): BookingPaymentMode {
  return !mode || mode === 'none' ? 'onsite' : mode
}

/** 409（版が古い）を受けたかどうか。保存した側へ投げ直さず、比べる窓で選んでもらう。 */
export class PaymentConflictError extends Error {}

export function useMenuPayment(kind: MenuPaymentKind, accountId: string | null, id: string | null): MenuPaymentState {
  const [status, setStatus] = useState<Status>('loading')
  const [connected, setConnected] = useState(false)
  const [defaultMode, setDefaultMode] = useState<BookingPaymentMode>('onsite')
  const [saved, setSaved] = useState<Latest>({ mode: null, price: null })
  const [value, setValue] = useState<BookingPaymentMode | null>(null)
  const [price, setPrice] = useState<number | null>(null)
  const [version, setVersion] = useState<{ mode: number; price: number }>({ mode: 0, price: 0 })
  const [reloadSeq, setReloadSeq] = useState(0)
  const saveErrors = useSaveFormErrors()
  const generation = useRef(0)

  const readLatest = useCallback(async (): Promise<Latest & { modeVersion: number; priceVersion: number }> => {
    if (!accountId || !id) return { mode: null, price: null, modeVersion: 0, priceVersion: 0 }
    if (kind === 'booking') {
      const response = await bookingPaymentAdminApi.menuOverrides(accountId)
      return { mode: response.data.menus.find((item) => item.menuId === id)?.mode ?? null, price: null, modeVersion: 0, priceVersion: 0 }
    }
    if (kind === 'course') {
      const response = await bookingPaymentAdminApi.courseMode(accountId, id)
      return { mode: response.data.mode, price: null, modeVersion: response.data.version ?? 0, priceVersion: 0 }
    }
    const [mode, unit] = await Promise.all([bookingPaymentAdminApi.eventMode(accountId, id), bookingPaymentAdminApi.eventPrice(accountId, id)])
    return { mode: mode.data.mode, price: unit.data.unitPrice, modeVersion: mode.data.version ?? 0, priceVersion: unit.data.version ?? 0 }
  }, [accountId, id, kind])

  useEffect(() => {
    if (!accountId) return
    const mine = ++generation.current
    setStatus('loading')
    void Promise.allSettled([Promise.resolve().then(() => bookingApi.getPaymentConfig(accountId)), Promise.resolve().then(() => bookingPaymentAdminApi.connection(accountId)), Promise.resolve().then(readLatest)]).then(([config, link, latest]) => {
      if (mine !== generation.current) return
      const configData = config.status === 'fulfilled' ? config.value?.data : undefined
      if (!configData) { setStatus('error'); return }
      setDefaultMode(normal(configData.mode))
      setConnected(link.status === 'fulfilled' && link.value?.data ? link.value.data.connected : configData.provider === 'stripe')
      const next = latest.status === 'fulfilled' ? latest.value : { mode: null, price: null, modeVersion: 0, priceVersion: 0 }
      setSaved({ mode: next.mode, price: next.price })
      setValue(next.mode)
      setPrice(next.price)
      setVersion({ mode: next.modeVersion, price: next.priceVersion })
      setStatus(latest.status === 'rejected' && isNotReadyError(latest.reason) ? 'not-ready' : latest.status === 'rejected' ? 'error' : 'ready')
    })
  }, [kind, accountId, readLatest, reloadSeq])

  const conflict = useSaveConflict<Latest>({
    contextKey: `${kind}:${accountId}:${id}`,
    fetchLatest: async () => { const latest = await readLatest(); return { mode: latest.mode, price: latest.price } },
    reload: () => { conflict.clear(); setReloadSeq((value) => value + 1) },
  })

  const dirty = status === 'ready' && (value !== saved.mode || price !== saved.price)
  const save = useCallback(async (targetId?: string) => {
    const menuId = targetId ?? id
    if (!accountId || !menuId || status !== 'ready' || !dirty) return
    try {
      if (kind === 'booking') {
        if (value === null) await bookingApi.clearMenuPayment(accountId, menuId)
        else await bookingApi.saveMenuPayment(accountId, menuId, { mode: value, provider: providerFor(value) })
      } else if (kind === 'course') {
        const response = await bookingPaymentAdminApi.saveCourseMode(accountId, menuId, value, version.mode)
        setVersion((current) => ({ ...current, mode: response.data.version }))
      } else {
        if (value !== saved.mode) {
          const response = await bookingPaymentAdminApi.saveEventMode(accountId, menuId, value, version.mode)
          setVersion((current) => ({ ...current, mode: response.data.version }))
        }
        if (price !== saved.price && price !== null) {
          const response = await bookingPaymentAdminApi.saveEventPrice(accountId, menuId, price, version.price)
          setVersion((current) => ({ ...current, price: response.data.version }))
        }
      }
    } catch (cause) {
      if (isSaveConflict(cause)) {
        conflict.mark()
        throw new PaymentConflictError('version_conflict')
      }
      // 400/422 の欄の理由は、支払いの欄の下に出す。投げ直すので、保存した側の知らせも残る。
      saveErrors.capture(cause)
      throw cause
    }
    setSaved({ mode: value, price })
    conflict.clear()
  }, [accountId, id, kind, status, dirty, value, price, saved, version, conflict, saveErrors])

  return {
    saveErrors, status, connected, defaultMode, value, price, dirty, setValue, setPrice, save, reset: () => { setValue(saved.mode); setPrice(saved.price) }, conflict,
  }
}

/** ぶつかったときの共通の帯と比べる窓（：比べる窓は共通の部品）。 */
export function MenuPaymentConflict({ state, subject }: { state: MenuPaymentState; subject: string }) {
  const { conflict } = state
  if (!conflict.conflict) return null
  const latest = conflict.latest
  const label = (mode: BookingPaymentMode | null) => mode === null ? `いつもの方法（${MODE_LABEL[state.defaultMode]}）` : MODE_LABEL[mode]
  const lines: SaveConflictDiffLine[] | null = latest === null ? null : [
    ...(latest.mode !== state.value ? [{ text: `お支払い：あなた「${label(state.value)}」／最新「${label(latest.mode)}」` }] : []),
    ...(latest.price !== state.price ? [{ text: `1回の値段：あなた「${formatYen(state.price)}」／最新「${formatYen(latest.price)}」` }] : []),
  ]
  return <>
    <SaveConflictBand title={saveConflictTitle('', subject, '')} compareBusy={conflict.compareBusy} onCompare={() => void conflict.compare()} onReload={() => void conflict.reloadLatest()} />
    <SaveConflictCompareDialog open={conflict.compareOpen} error={conflict.compareError} lines={lines} onReload={() => void conflict.reloadLatest()} onCancel={conflict.closeCompare} />
  </>
}

const OVERRIDE_CHOICES: BookingPaymentMode[] = ['online', 'onsite', 'customer_choice']

/** 段の中身（題は呼び出し側の段に合わせて MenuPaymentCard か、そのまま置く）。 */
export function MenuPaymentFields({ state, name, price, people, unit, readOnly = false }: {
  state: MenuPaymentState
  name: string
  /** 1 名（1 回）の値段。 */
  price: number | null
  /** 先払いの計算に使う人数（予約の人数の下限など）。 */
  people?: number
  unit?: string
  readOnly?: boolean
}) {
  if (state.status === 'loading') return <p className={styles.minor}>お支払いの設定を読み込んでいます…</p>
  if (state.status === 'error') return <p className={styles.minor}>お支払いの設定を読み込めませんでした。いつもの方法（予約設定 › お支払い）で受けます。</p>
  if (!state.connected) {
    return <p className={styles.sideCardLink}><CreditCard size={16} aria-hidden="true" className={styles.connectionIcon} />先払いを受けるには<TextLink iconTone="link" href="/booking/menus?tab=payments">お支払いをつなぐ</TextLink></p>
  }
  const own = state.value !== null
  const effective = state.value ?? state.defaultMode
  const count = people && people > 0 ? people : 1
  const locked = state.status === 'not-ready'
  const conflictBand = <MenuPaymentConflict state={state} subject={name === 'event' ? 'クラスのお支払い' : name === 'course' ? 'コースのお支払い' : 'メニューのお支払い'} />
  if (readOnly) return <p className={styles.readValue}>{own ? `このメニューだけ：${MODE_LABEL[effective]}` : `いつもの方法（${MODE_LABEL[state.defaultMode]}）`}</p>
  return (
    <SaveErrorScope errors={state.saveErrors}>
      {conflictBand}
      {state.status === 'not-ready' ? <Notice tone="info">このメニューだけ変える設定は、データの準備が済むと保存できます（今はいつもの方法で受けます）。</Notice> : null}
      <SaveErrorField names={['mode', 'payment_mode', 'provider']}><RadioCardGroup legend={`${name}のお支払い`} columns={2}>
        <RadioCard name={`${name}-payment-source`} value="default" title="いつもの方法を使う" note={`今は：${MODE_LABEL[state.defaultMode]}（予約設定 › お支払い）`}
          icon={<Settings size={16} aria-hidden="true" />} checked={!own} disabled={locked} onChange={() => state.setValue(null)} />
        <RadioCard name={`${name}-payment-source`} value="own" title="このメニューだけ変更する" note="下で選んだ方法にします"
          icon={<Pencil size={16} aria-hidden="true" />} checked={own} disabled={locked}
          onChange={() => state.setValue(state.value ?? (state.defaultMode === 'online' ? 'onsite' : 'online'))} />
      </RadioCardGroup></SaveErrorField>
      {own ? (
        <SaveErrorField names={['mode', 'payment_mode', 'provider']}><RadioCardGroup legend="このメニューの支払い方法" className={styles.choiceRow}>
          {OVERRIDE_CHOICES.map((mode) => (
            <RadioCard key={mode} variant="row" name={`${name}-payment-mode`} value={mode} title={MODE_LABEL[mode]}
              checked={state.value === mode} disabled={locked} onChange={() => state.setValue(mode)} />
          ))}
        </RadioCardGroup></SaveErrorField>
      ) : null}
      {effective === 'online' && price !== null ? (
        <div className={styles.amountBox}>
          <Calculator size={16} aria-hidden="true" />
          {`先払いの金額：${formatYen(price)} × ${count}${unit ?? '名'} = ${formatYen(price * count)}`}
          <span className={styles.amountNote}>人数に合わせて計算</span>
        </div>
      ) : null}
    </SaveErrorScope>
  )
}

export function MenuPaymentCard({ priceField = false, readOnly = false, ...props }: Parameters<typeof MenuPaymentFields>[0] & { priceField?: boolean }) {
  const { state } = props
  return (
    <Card variant="form" gap="normal">
      <CardHeader size="stacked" title="お支払い" help={<HelpTip label="お支払いの説明">先払いのときは、予約の最後に Stripe の支払いページへ進みます。払い終わると予約が決まります。</HelpTip>} />
      {/* 絵 XFRyO：クラスの 1 回の値段（組3 の口・版つき）。決済をつないでいなくても値段は決められる。 */}
      {priceField && state.status === 'ready' ? (
        readOnly ? <p className={styles.readValue}>{`1回の値段：${formatYen(state.price ?? 0)}`}</p> : (
          <SaveErrorScope errors={state.saveErrors}>
            <Field label="1回の値段" htmlFor={`${props.name}-unit-price`}>
              <SaveErrorField names={['unitPrice', 'unit_price', 'price']}><NumberInput id={`${props.name}-unit-price`} aria-label="1回の値段" unit="円" type="number" min={0} step={1} value={state.price ?? ''}
                onChange={(event) => state.setPrice(event.target.value === '' ? null : Math.max(0, Math.floor(Number(event.target.value))))} /></SaveErrorField>
            </Field>
          </SaveErrorScope>
        )
      ) : null}
      <MenuPaymentFields {...props} readOnly={readOnly} price={priceField ? state.price : props.price} />
    </Card>
  )
}

/** 右の欄の説明カード（mauOC・XFRyO）。 */
export function PaymentSideCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className={styles.sideCard}>
      <h3 className={styles.sideCardTitle}>{title}</h3>
      <p className={styles.sideCardText}>{children}</p>
    </section>
  )
}
