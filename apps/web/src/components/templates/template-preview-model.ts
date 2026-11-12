'use client'

import { listInterpolations, type CommonVar, type FriendField } from '@line-crm/shared'

export type TemplateReferenceState = 'idle' | 'loading' | 'ready' | 'failed'

export interface TemplateReferences {
  friendFields: FriendField[]
  commonVars: CommonVar[]
}

export const EMPTY_TEMPLATE_REFERENCES: TemplateReferences = { friendFields: [], commonVars: [] }

export function jstDateParts(date: Date): { year: number; month: number; day: number; weekday: string } {
  const parts = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    weekday: 'short',
  }).formatToParts(date)
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? ''
  return {
    year: Number(value('year')),
    month: Number(value('month')),
    day: Number(value('day')),
    weekday: value('weekday'),
  }
}

export function previewDateValue(name: string, deliveredAt: Date): string | null {
  const daysUntil = /^days_until:(\d{4})-(\d{2})-(\d{2})$/.exec(name)
  if (daysUntil) {
    const current = jstDateParts(deliveredAt)
    const currentDay = Date.UTC(current.year, current.month - 1, current.day)
    const targetDay = Date.UTC(Number(daysUntil[1]), Number(daysUntil[2]) - 1, Number(daysUntil[3]))
    return String(Math.max(0, Math.round((targetDay - currentDay) / 86_400_000)))
  }

  const dateToken = /^date(?:([+-])(\d+))?(?::([a-z_]+))?$/.exec(name)
  if (!dateToken) return null
  const direction = dateToken[1] === '-' ? -1 : 1
  const offset = Number(dateToken[2] ?? 0) * direction
  const parts = jstDateParts(new Date(deliveredAt.getTime() + offset * 86_400_000))
  const format = dateToken[3] ?? 'md_w'
  const ymd = `${parts.year}年${parts.month}月${parts.day}日`
  const md = `${parts.month}月${parts.day}日`
  const slashYmd = `${parts.year}/${parts.month}/${parts.day}`
  const slashMd = `${parts.month}/${parts.day}`
  switch (format) {
    case 'ymd_w': return `${ymd}(${parts.weekday})`
    case 'ymd': return ymd
    case 'md': return md
    case 'slash_ymd_w': return `${slashYmd}(${parts.weekday})`
    case 'slash_ymd': return slashYmd
    case 'slash_md_w': return `${slashMd}(${parts.weekday})`
    case 'slash_md': return slashMd
    default: return `${md}(${parts.weekday})`
  }
}

export interface TemplatePreviewResult {
  content: string
  unresolved: string[]
}

export function buildTemplatePreview(
  content: string,
  references: TemplateReferences,
  deliveredAt = new Date(),
): TemplatePreviewResult {
  /*
   * D007: 本文が無い応答でも落ちない。**形の違う詳細応答が来ると
   * 文字列でない中身がここへ届く。** `content.replace` の前に確かめ、
   * 違えば空の見本を返す（「本文がまだありません」の表示になる）。
   */
  if (typeof content !== 'string') return { content: '', unresolved: [] }
  const fields = new Map(references.friendFields.map((field) => [field.fieldKey, field]))
  const commonVars = new Map(references.commonVars.map((item) => [item.varKey, item]))
  const unresolved = new Set<string>()
  const interpolation = /\{\{\s*([^{}]+?)\s*\}\}/g

  const preview = content.replace(interpolation, (token, rawName: string) => {
    const name = rawName.trim()
    if (name === 'name') return '見本 141'
    if (name === 'liff_id') return '［LIFF ID］'

    const fieldKey = /^field\.([a-z][a-z0-9_]*)$/.exec(name)?.[1]
    if (fieldKey) {
      const field = fields.get(fieldKey)
      if (!field) {
        unresolved.add(name)
        return token
      }
      return field.defaultValue?.trim() || `［${field.name}の値］`
    }

    const varKey = /^var\.([a-z][a-z0-9_]*)$/.exec(name)?.[1]
    if (varKey) {
      const commonVar = commonVars.get(varKey)
      if (!commonVar) {
        unresolved.add(name)
        return token
      }
      return commonVar.value || `［${commonVar.name}は空です］`
    }

    const dateValue = previewDateValue(name, deliveredAt)
    if (dateValue !== null) return dateValue
    unresolved.add(name)
    return token
  })

  for (const name of listInterpolations(content)) {
    if (preview.includes(`{{${name}}}`)) unresolved.add(name)
  }
  return { content: preview, unresolved: [...unresolved] }
}

export function extractMessageUrls(content: string): string[] {
  if (typeof content !== 'string') return []
  return [...new Set(content.match(/https?:\/\/[^\s<>"'）)]+/g) ?? [])]
}
