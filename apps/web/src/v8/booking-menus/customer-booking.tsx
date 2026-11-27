'use client'

import { useCallback, useState } from 'react'
import Button from '@/components/shared/button'
import Card, { CardHeader } from '@/components/shared/card'
import CheckCard from '@/components/shared/check-card'
import Checkbox from '@/components/shared/checkbox'
import { EntityPickerField } from '@/components/shared/entity-picker'
import { Field } from '@/components/shared/form-controls'
import HelpTip from '@/components/shared/help-tip'
import Notice from '@/components/shared/notice'
import NumberInput from '@/components/shared/number-field'
import Select from '@/components/shared/select'
import { SettingsFormRow } from '@/components/shared/settings-form-card'
import { storedStringList } from '@/lib/stored-json'
import { formatNumber } from '@/lib/format'
import type { BookingMenu } from '@/lib/api'
import type { Gap2MenuWrite } from '@/lib/api/helpers/gap2'
import styles from './menu-form.module.css'

/*
 * 予約メニューの「お客さまの予約のしかた」（要件 B4・B5）。
 * お客さまの繰り返し予約、一度に予約できる人数、追加メニュー、追加専用のメニューを持つ。
 * 保存はメニューの保存と同じ口（recurring・maxPartySize・addonMenuIds・addonOnly）。
 * 口はオーナー・管理者にしか開いていないので、変えられない人の保存には載せない。
 * 繰り返しの今の設定は一覧の口が返さないことがある。読めないときは上書きせず、入れ直すと送る。
 */

export type RecurringFreq = 'weekly' | 'biweekly' | 'monthly_nth'

export const RECURRING_FREQS: Array<{ value: RecurringFreq; label: string }> = [
  { value: 'weekly', label: '毎週' },
  { value: 'biweekly', label: '隔週' },
  { value: 'monthly_nth', label: '毎月第 n 曜日' },
]

export const PARTY_SIZE_MAX = 6
export const RECURRING_COUNT_MIN = 2
export const RECURRING_COUNT_MAX = 12

type Recurring = { enabled: boolean; freqs: RecurringFreq[]; maxCount: string }
type CustomerBookingValues = { recurring: Recurring | null; maxPartySize: number; addonMenuIds: string[]; addonOnly: boolean }

const DEFAULT_RECURRING: Recurring = { enabled: false, freqs: ['weekly'], maxCount: String(RECURRING_COUNT_MAX) }

/** 一覧の口が返すメニューの行（足した欄は返らないことがあるので全部任意）。 */
type WideMenu = BookingMenu & {
  customer_recurring_enabled?: number | boolean | null
  recurring_freqs_json?: string | null
  recurring_max_count?: number | null
  max_party_size?: number | null
  addon_menu_ids_json?: string | null
  addon_only?: number | boolean | null
}

function isFreq(value: string): value is RecurringFreq {
  return RECURRING_FREQS.some((item) => item.value === value)
}

function normalizeMaxCount(raw: unknown): number {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= RECURRING_COUNT_MIN && raw <= RECURRING_COUNT_MAX) {
    return raw
  }
  return RECURRING_COUNT_MAX
}

function parseMaxCountText(raw: string): number | null {
  const trimmed = raw.trim()
  if (!/^\d+$/.test(trimmed)) return null
  const count = Number(trimmed)
  if (!Number.isInteger(count) || count < RECURRING_COUNT_MIN || count > RECURRING_COUNT_MAX) return null
  return count
}

function normalizePartySize(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isInteger(n)) return 1
  return Math.min(PARTY_SIZE_MAX, Math.max(1, n))
}

function uniqueStrings<T extends string>(values: readonly T[]): T[] {
  return Array.from(new Set(values))
}

/** 保存済みの値。作る画面は既定値。繰り返しが返っていなければ null（＝読めない）。 */
export function readCustomerBooking(menu: BookingMenu | null): CustomerBookingValues {
  if (!menu) return { recurring: DEFAULT_RECURRING, maxPartySize: 1, addonMenuIds: [], addonOnly: false }
  const wide = menu as WideMenu
  const known = wide.customer_recurring_enabled !== undefined && wide.customer_recurring_enabled !== null
  const freqs = uniqueStrings(storedStringList(wide.recurring_freqs_json).filter(isFreq))
  return {
    recurring: known ? {
      enabled: Boolean(wide.customer_recurring_enabled),
      freqs: freqs.length ? freqs : ['weekly'],
      maxCount: String(normalizeMaxCount(wide.recurring_max_count)),
    } : null,
    maxPartySize: normalizePartySize(wide.max_party_size),
    addonMenuIds: uniqueStrings(storedStringList(wide.addon_menu_ids_json)),
    addonOnly: Boolean(wide.addon_only),
  }
}

function sameRecurring(a: Recurring | null, b: Recurring | null) {
  if (!a || !b) return a === b
  return a.enabled === b.enabled && a.maxCount === b.maxCount && [...a.freqs].sort().join(',') === [...b.freqs].sort().join(',')
}

/** 入れた値の誤り。保存の前に出す（口の範囲：回数 2〜12・間隔は1つ以上）。 */
export function recurringError(recurring: Recurring | null): string | null {
  if (!recurring || !recurring.enabled) return null
  if (recurring.freqs.length === 0) return '選べる間隔を1つ以上選んでください。'
  if (parseMaxCountText(recurring.maxCount) === null) return `最大の回数は${RECURRING_COUNT_MIN}〜${RECURRING_COUNT_MAX}の整数で入力してください。`
  return null
}

export function useMenuCustomerBooking(canManage: boolean) {
  const [saved, setSaved] = useState<CustomerBookingValues>(() => readCustomerBooking(null))
  const [values, setValues] = useState<CustomerBookingValues>(() => readCustomerBooking(null))
  /** 読み込んだメニュー（作るときは null）で置き直す。 */
  const load = useCallback((menu: BookingMenu | null) => {
    const next = readCustomerBooking(menu)
    setSaved(next)
    setValues(next)
  }, [])
  const recurringChanged = values.recurring !== null && !sameRecurring(values.recurring, saved.recurring)
  const addonsChanged = [...values.addonMenuIds].sort().join(',') !== [...saved.addonMenuIds].sort().join(',')
  const dirty = canManage && (
    values.addonOnly
      ? values.addonOnly !== saved.addonOnly
      : (recurringChanged || addonsChanged || values.maxPartySize !== saved.maxPartySize || values.addonOnly !== saved.addonOnly)
  )
  const error = canManage && !values.addonOnly ? recurringError(values.recurring) : null
  const recurringPayload = (): NonNullable<Gap2MenuWrite['recurring']> | null => {
    if (!recurringChanged || !values.recurring) return null
    const validFreqs = uniqueStrings(values.recurring.freqs.filter(isFreq))
    const fallbackFreqs = saved.recurring?.freqs.length ? saved.recurring.freqs : DEFAULT_RECURRING.freqs
    const parsedMaxCount = parseMaxCountText(values.recurring.maxCount)
    const fallbackMaxCount = saved.recurring ? (parseMaxCountText(saved.recurring.maxCount) ?? RECURRING_COUNT_MAX) : RECURRING_COUNT_MAX
    return {
      enabled: values.recurring.enabled,
      freqs: validFreqs.length > 0 ? validFreqs : fallbackFreqs,
      maxCount: parsedMaxCount ?? fallbackMaxCount,
    }
  }
  /** メニューの保存に足す項目。変えた物だけ・変えられる人だけ。 */
  const body = (): Partial<Gap2MenuWrite> => {
    if (!canManage) return {}
    const out: Partial<Gap2MenuWrite> = {}
    if (values.addonOnly !== saved.addonOnly) out.addonOnly = values.addonOnly
    if (values.addonOnly) return out
    const nextRecurring = recurringPayload()
    if (nextRecurring) out.recurring = nextRecurring
    if (values.maxPartySize !== saved.maxPartySize) out.maxPartySize = values.maxPartySize as Gap2MenuWrite['maxPartySize']
    if (addonsChanged) out.addonMenuIds = values.addonMenuIds
    return out
  }
  return {
    values,
    saved,
    dirty,
    error,
    body,
    load,
    /** 保存できたら、いまの入力を保存済みにする（繰り返しが読めない口でも、送った値を覚える）。 */
    markSaved: () => {
      if (values.addonOnly) {
        setSaved((prev) => ({ ...prev, addonOnly: true }))
        return
      }
      const nextRecurring = recurringPayload()
      const synced: CustomerBookingValues = nextRecurring
        ? {
            ...values,
            recurring: { enabled: nextRecurring.enabled, freqs: nextRecurring.freqs, maxCount: String(nextRecurring.maxCount) },
          }
        : values
      setSaved(synced)
      if (nextRecurring) setValues(synced)
    },
    setRecurring: (patch: Partial<Recurring>) => setValues((current) => {
      const base = current.recurring ?? DEFAULT_RECURRING
      const nextFreqs = patch.freqs ? uniqueStrings(patch.freqs.filter(isFreq)) : base.freqs
      return { ...current, recurring: { ...base, ...patch, freqs: nextFreqs } }
    }),
    /** 読めなかった繰り返しの設定を入れ直す（初めはオフ）。 */
    startRecurring: () => setValues((current) => ({ ...current, recurring: DEFAULT_RECURRING })),
    setMaxPartySize: (size: number) => {
      if (!Number.isInteger(size) || size < 1 || size > PARTY_SIZE_MAX) return
      setValues((current) => ({ ...current, maxPartySize: size }))
    },
    setAddonMenuIds: (ids: string[]) => setValues((current) => ({ ...current, addonMenuIds: uniqueStrings(ids) })),
    setAddonOnly: (addonOnly: boolean) => setValues((current) => ({ ...current, addonOnly })),
  }
}
export type MenuCustomerBookingState = ReturnType<typeof useMenuCustomerBooking>

const PARTY_OPTIONS = Array.from({ length: PARTY_SIZE_MAX }, (_, index) => ({
  value: String(index + 1),
  label: index === 0 ? '1人（ひとりずつ）' : `${index + 1}人まで`,
}))

function recurringText(recurring: Recurring | null): string {
  if (!recurring) return 'この画面では読み出せません'
  if (!recurring.enabled) return 'お客さまは繰り返しで予約できません'
  const freqs = RECURRING_FREQS.filter((item) => recurring.freqs.includes(item.value)).map((item) => item.label).join('・')
  const count = parseMaxCountText(recurring.maxCount)
  if (!freqs && count === null) return '設定を確認してください'
  if (!freqs) return `最大${count}回`
  if (count === null) return freqs
  return `${freqs}・最大${count}回`
}

/** 追加メニューに選べるのは、固定の料金のほかのメニューだけ（口と同じ条件）。 */
export function addonCandidates(menus: readonly BookingMenu[], selfId: string | null) {
  return menus.filter((menu) => menu.id !== selfId && (menu.price_mode ?? 'fixed') === 'fixed' && Number.isFinite(menu.base_price) && menu.base_price > 0)
}

export function CustomerBookingCard({ state, menus, selfId, readOnly }: {
  state: MenuCustomerBookingState
  menus: readonly BookingMenu[]
  selfId: string | null
  /** 変えられるのはオーナー・管理者だけ。ほかの人には今の設定を読むだけで出す。 */
  readOnly: boolean
}) {
  const { values } = state
  const candidates = addonCandidates(menus, selfId)
  const pickerItems = [
    ...candidates.map((menu) => {
      const durationLabel = Number.isFinite(menu.duration_minutes) && menu.duration_minutes > 0
        ? `${formatNumber(menu.duration_minutes)}分`
        : '時間未設定'
      return { id: menu.id, name: `${menu.name}${menu.is_active ? '' : '（受付停止中）'}`, meta: `${durationLabel}・¥${formatNumber(menu.base_price)}` }
    }),
    ...values.addonMenuIds.filter((id) => !candidates.some((menu) => menu.id === id)).map((id) => ({ id, name: '使えなくなったメニュー', disabled: true })),
  ]
  const addonNames = values.addonMenuIds.map((id) => menus.find((menu) => menu.id === id)?.name ?? '使えなくなったメニュー')
  const title = <span className={styles.titleWithMark}>お客さまの予約のしかた<HelpTip label="お客さまの予約のしかたの説明">お客さまが LINE の予約画面で選べることを決めます。繰り返しは毎週・隔週・毎月第 n 曜日から、同じ時間で続けて予約できます。人数を2人以上にすると、お連れさまの分も一緒に予約できます。追加メニューは、このメニューに足して選べるメニューです（料金と時間が足されます）。</HelpTip></span>

  if (readOnly) {
    return (
      <Card variant="form" gap="normal" aria-label="お客さまの予約のしかた">
        <CardHeader size="stacked" title={title} meta="変えられるのはオーナー・管理者だけです" />
        <div className={styles.ruleRow}><span className={styles.ruleLabel}>追加専用のメニュー</span><span className={styles.ruleValue}>{values.addonOnly ? '単独では予約できません' : 'いいえ'}</span></div>
        {values.addonOnly ? null : <>
          <div className={styles.ruleRow}><span className={styles.ruleLabel}>繰り返しの予約</span><span className={styles.ruleValue}>{recurringText(values.recurring)}</span></div>
          <div className={styles.ruleRow}><span className={styles.ruleLabel}>一度に予約できる人数</span><span className={styles.ruleValue}>{`${values.maxPartySize}人まで`}</span></div>
          <div className={styles.ruleRow}><span className={styles.ruleLabel}>追加メニュー</span><span className={styles.ruleValue} title={addonNames.join('・')}>{addonNames.length ? addonNames.join('・') : 'なし'}</span></div>
        </>}
      </Card>
    )
  }

  return (
    <Card variant="form" gap="normal" aria-label="お客さまの予約のしかた">
      <CardHeader size="stacked" title={title} />
      <Checkbox checked={values.addonOnly} onCheckedChange={state.setAddonOnly}
        description="ほかのメニューの追加でだけ選べます。お客さまの予約画面の一覧には出ません。">追加専用のメニューにする（単独では予約できない）</Checkbox>
      {values.addonOnly ? (
        <Notice tone="info">追加専用のメニューには、繰り返し・人数・追加メニューの設定は使いません。</Notice>
      ) : (
        <>
          {values.recurring === null ? (
            <Notice tone="info" action={<Button variant="secondary" size="compact" onClick={state.startRecurring}>繰り返しの設定を入れ直す</Button>}>
              このメニューの繰り返しの予約の設定は、この画面ではまだ読み出せません。入れ直すまで今の設定は変えません。
            </Notice>
          ) : (
            <>
              <Checkbox checked={values.recurring.enabled} onCheckedChange={(enabled) => state.setRecurring({ enabled })}
                description="同じ曜日・時間で続けて予約できます。取れない回は飛ばします。">お客さまも繰り返しで予約できる</Checkbox>
              {values.recurring.enabled ? (
                <>
                  <Field label="選べる間隔" required error={values.recurring.freqs.length === 0 ? '選べる間隔を1つ以上選んでください。' : undefined}>
                    <SettingsFormRow layout="columns" columns={3} keepColumns role="group" aria-label="選べる間隔">
                      {RECURRING_FREQS.map((item) => {
                        const on = values.recurring!.freqs.includes(item.value)
                        return (
                          <CheckCard key={item.value} size="row" checked={on} title={item.label}
                            invalid={values.recurring!.freqs.length === 0}
                            onChange={(next) => state.setRecurring({ freqs: next ? [...values.recurring!.freqs, item.value] : values.recurring!.freqs.filter((freq) => freq !== item.value) })} />
                        )
                      })}
                    </SettingsFormRow>
                  </Field>
                  <Field label="最大の回数" required error={state.error && values.recurring.freqs.length > 0 ? state.error : undefined}>
                    <NumberInput unit="回まで" short type="number" min={RECURRING_COUNT_MIN} max={RECURRING_COUNT_MAX} step={1}
                      value={values.recurring.maxCount} aria-label="最大の回数"
                      onChange={(event) => state.setRecurring({ maxCount: event.target.value })} />
                  </Field>
                </>
              ) : null}
            </>
          )}
          <Field label="一度に予約できる人数" optional={false} help="2人以上にすると、お連れさまの分も一緒に予約できます">
            <Select size="full" aria-label="一度に予約できる人数" value={String(values.maxPartySize)}
              onChange={(value) => state.setMaxPartySize(Number(value))} options={PARTY_OPTIONS} />
          </Field>
          <Field label="追加メニュー" optional={false} help="固定の料金のメニューから選べます。お客さまは1人3つまで足せます">
            <EntityPickerField multiple label="追加メニュー" noun="追加メニュー" unit="件"
              description="固定の料金のメニューから選べます。お客さまは1人3つまで足せます。"
              items={pickerItems} value={values.addonMenuIds} allowEmpty
              onChange={state.setAddonMenuIds} />
          </Field>
        </>
      )}
    </Card>
  )
}
