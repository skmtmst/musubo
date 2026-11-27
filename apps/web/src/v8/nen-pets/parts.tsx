'use client'

import { knownValue } from '@/lib/known-value'

import { statusLabel } from '@/lib/status-labels'


/*
 * ★V8 マイペットの小さな部品（CSV・言葉・誕生日の形・行の「…」・件数の文）。
 * 今の画面（app/nen/pets の page.tsx・pet-editor.tsx）から写した。
 * src/v8 は @/app を読めないので、同じ約束のまま持つ。
 */
import { useState, type ReactNode } from 'react'
import { type ActionMenuItem } from '@/components/shared/action-menu'
import { RowMenu as SharedRowMenu } from '@/components/shared/row-actions'
import { csvCell } from '@/lib/presentation'
import { formatNumber } from '@/lib/format'
import { paginationSummary } from '@/components/shared/pagination'
import { petAnimalTypeLabel, type NenPetRow, type NenPetSort, type NenPetWeightFilter } from '@/lib/nen-pets-api'
import StatusBadge from '@/components/shared/status-badge'
import styles from './pets.module.css'
import { formatDate as polishFormatDate } from '@/lib/format'


export type PetTab = 'pets' | 'feeding'
export type PetsQuery = { q: string; species: string; product: string; weight: NenPetWeightFilter; sort: NenPetSort }
export const EMPTY_QUERY: PetsQuery = { q: '', species: '', product: '', weight: '', sort: 'updated_desc' }

export const NEUTERED_LABEL: Readonly<Record<'yes' | 'no' | 'unknown', string>> = Object.assign(Object.create(null), { yes: '済み', no: 'していない', unknown: 'わからない' })

/*
 * #999 DEEP-25: CSV の1マス整形は共通の csvCell（先頭の = + - @ に ' を足す）。
 * #999 DEEP-24: 種類は共通の動物種別ラベル。「その他」を犬へ変換しない。
 * 列と並びは今の画面（管理画面）と同じ。
 */
export function petsToCsv(items: NenPetRow[]): string {
  const header = ['ペット名', '呼び名', '性別', '種類', '品種', '誕生日', '年齢', '体重(kg)', '避妊去勢', '運動量', '主食', '1日の目安(g)', '1日の必要カロリー(kcal)', '然の鹿肉の目安(g)', '体重の更新日', '飼い主', 'EC会員ID']
  const lines = items.map((p) => [
    p.name, p.callName, p.gender === 'male' ? '男の子' : p.gender === 'female' ? '女の子' : '未回答', petAnimalTypeLabel(p.animalType), p.breed, p.birthday ?? '', p.ageLabel, p.weightKg ?? '', knownValue<string>(NEUTERED_LABEL, p.neutered, '状態を確認できません'), p.activityLabel,
    p.productName ?? '', p.feeding?.dailyGrams ?? '', p.feeding?.dailyKcal ?? '', p.feeding?.venisonGrams ?? '', typeof p.weightUpdatedAt === 'string' ? p.weightUpdatedAt.slice(0, 10) : '', p.owner.name, p.owner.customerId ?? '',
  ].map(csvCell).join(','))
  return `﻿${[header.join(','), ...lines].join('\n')}`
}

export function downloadCsv(text: string, name: string) {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

function isValidCalendarMonthDay(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false
  const check = new Date(Date.UTC(year, month - 1, day))
  return check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day
}

/** 誕生日の入力。空＝未登録（null）、「2020-03-15」か月日だけ「03-15」。ほかは 'invalid'。 */
export function normalizeBirthdayInput(value: string): string | null | 'invalid' {
  const trimmed = value.trim()
  if (!trimmed) return null
  const mdMatch = /^(\d{2})-(\d{2})$/.exec(trimmed)
  if (mdMatch) {
    // 年なし入力では 2月29日（うるう年）を許容するため 2000 年で検証する。
    return isValidCalendarMonthDay(2000, Number(mdMatch[1]), Number(mdMatch[2])) ? trimmed : 'invalid'
  }
  const ymdMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed)
  if (ymdMatch) {
    return isValidCalendarMonthDay(Number(ymdMatch[1]), Number(ymdMatch[2]), Number(ymdMatch[3])) ? trimmed : 'invalid'
  }
  return 'invalid'
}

/** 「09/28」（体重の更新日）。日付が無ければ「—」。 */
export function monthDay(value: string | null | undefined): string {
  return polishFormatDate(value, { style: 'list-day', fallback: '—' })
}

/** 件数の文（「8件中 1〜8件」）。 */
export function rangeText(total: number, page: number, size: number): string {
  return paginationSummary(total, total === 0 ? 0 : (page - 1) * size + 1, Math.min(total, page * size))
}

/**
 * 今日の目安の2行目。鹿肉の目安があれば「約560kcal・鹿肉 12g」、
 * 無ければ成長の段階（子犬・子猫・シニア）だけ添える。主食が未設定なら「主食が未設定」。
 * #999 DEEP-24: 犬・猫以外は計算しない（犬の式で出した数値を見せない）。
 */
export function feedingLines(pet: NenPetRow): { main: string; sub: string } {
  const f = pet.feeding
  if (!f) {
    return { main: '—', sub: pet.animalType === 'other' ? '犬・猫以外は目安の計算対象外' : pet.weightKg == null ? '体重が未登録' : '誕生日が未登録' }
  }
  const hasKcal = typeof f.dailyKcal === 'number' && Number.isFinite(f.dailyKcal) && f.dailyKcal >= 0
  const kcal = hasKcal ? `約${formatNumber(f.dailyKcal)}kcal` : 'カロリーを確認できません'
  if (f.dailyGrams == null) return { main: '—', sub: `${kcal}・主食が未設定` }
  if (typeof f.dailyGrams !== 'number' || !Number.isFinite(f.dailyGrams) || f.dailyGrams < 0) {
    return { main: '—', sub: kcal }
  }
  const hasVenison = typeof f.venisonGrams === 'number' && Number.isFinite(f.venisonGrams) && f.venisonGrams >= 0
  const extra = hasVenison ? `・鹿肉 ${formatNumber(f.venisonGrams)}g` : f.venisonGrams == null && /子|シニア/.test(f.stageLabel) ? `・${f.stageLabel}` : ''
  return { main: `${formatNumber(f.dailyGrams)}g／日`, sub: `${kcal}${extra}` }
}

/** 状態の札（点＋文字）。 */
export function Pill({ tone, children, title }: { tone: 'ok' | 'warn' | 'off'; children: ReactNode; title?: string }) {
  return (
    <StatusBadge tone={tone === 'ok' ? 'success' : tone === 'off' ? 'neutral' : tone === 'warn' ? 'warning' : 'neutral'} title={title}>{children}</StatusBadge>
  )
}

/** 行の右端の「…」。押すと行の操作のメニュー（右クリックだけにしない）。 */
export function RowMenu({ subject, items }: { subject: string; items: ActionMenuItem[] }) {
  const [open, setOpen] = useState(false)
  if (items.length === 0) return <span className={styles.menuSpace} aria-hidden="true" />
  return (
    <span className={styles.menuBox}>
      <SharedRowMenu
        appearance="box"
        label={`「${subject}」の操作`}
        open={open}
        onOpenChange={setOpen}
        items={items.map((item) => ({ ...item, onSelect: () => { setOpen(false); item.onSelect?.() } }))}
      />
    </span>
  )
}
