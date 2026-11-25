'use client'
import { useCallback, useMemo, useState } from 'react'
import { useStaffIdentity } from '@/lib/staff-role'
import type { IndustryStyle, StyleSideCard } from './model'

/*
 * 「今日の確認」の開き方を、本人（本人APIで確かめた担当者）・アカウント・スタイルごとにこの端末へ覚える。
 * 覚えるのは開き方だけで、業務上の確認済みとは別の物（確認済みは店の全員で共有する別の口）。
 * 本人かアカウントが分からない間は、覚えた値を読まず書きもしない（持ち主の分からない値を復元しない）。
 * 覚えた値が無い時は、新着予約が1件以上あれば新着予約だけを開き、無ければ全部閉じる。
 */

const STORAGE_PREFIX = 'lh_today_check_open:'
const STORAGE_VERSION = 1

export function todayCheckStorageKey(staffId: string, accountId: string, style: IndustryStyle): string {
  return STORAGE_PREFIX + [staffId, accountId, style].map(encodeURIComponent).join(':')
}

/** 覚えた値を読む。形の違う値・壊れた値は無かったことにする。 */
export function parseTodayCheckOpen(raw: string | null): string[] | null {
  if (raw === null) return null
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object') return null
    const { v, open } = value as { v?: unknown; open?: unknown }
    if (v !== STORAGE_VERSION || !Array.isArray(open) || !open.every((id) => typeof id === 'string')) return null
    return open
  } catch {
    return null
  }
}

/** 覚えた値が無い時の開き方。新着予約の本当の件数で決める（「まだありません」の行を数えない）。 */
export function initialTodayCheckOpen(cards: readonly Pick<StyleSideCard, 'id' | 'count'>[]): string[] {
  return cards.some((card) => card.id === 'new' && (card.count ?? 0) > 0) ? ['new'] : []
}

function readStored(key: string | null): string[] | null {
  if (!key) return null
  try {
    return parseTodayCheckOpen(window.localStorage.getItem(key))
  } catch {
    return null
  }
}

export function useTodayCheckOpen(accountId: string | null, style: IndustryStyle, cards: readonly Pick<StyleSideCard, 'id' | 'count'>[], scope = '', defaultOpen?: readonly string[]) {
  const staffId = useStaffIdentity()?.id ?? null
  const key = staffId && accountId ? `${todayCheckStorageKey(staffId, accountId, style)}${scope ? `:${encodeURIComponent(scope)}` : ''}` : null
  const stored = useMemo(() => readStored(key), [key])
  // この画面で押した開き方。覚えられない間も押したとおりに開閉する。鍵が変わったら使わない。
  const [pressed, setPressed] = useState<{ key: string | null; open: string[] } | null>(null)
  const open = pressed && pressed.key === key ? pressed.open : stored ?? defaultOpen ?? initialTodayCheckOpen(cards)
  const isOpen = useCallback((id: string) => open.includes(id), [open])
  const setOpen = useCallback((id: string, next: boolean) => {
    const updated = next ? [...open.filter((x) => x !== id), id] : open.filter((x) => x !== id)
    setPressed({ key, open: updated })
    if (!key) return
    try {
      window.localStorage.setItem(key, JSON.stringify({ v: STORAGE_VERSION, open: updated }))
    } catch {
      // 端末に保存できない時は、この画面の中だけの開き方にする。
    }
  }, [key, open])
  return { isOpen, setOpen }
}

/** カード全体の開閉。項目ごとの記録とは別にし、本人・店舗・スタイルを共有する。 */
export function useTodayCheckFolded(accountId: string | null, style: IndustryStyle, scope = '') {
  const staffId = useStaffIdentity()?.id ?? null
  const key = staffId && accountId ? `${todayCheckStorageKey(staffId, accountId, style)}${scope ? `:${encodeURIComponent(scope)}` : ''}:folded` : null
  const stored = useMemo(() => {
    if (!key) return false
    try { return window.localStorage.getItem(key) === '1' } catch { return false }
  }, [key])
  const [pressed, setPressed] = useState<{ key: string | null; folded: boolean } | null>(null)
  const folded = pressed && pressed.key === key ? pressed.folded : stored
  const toggle = useCallback(() => {
    const next = !folded
    setPressed({ key, folded: next })
    if (key) try { window.localStorage.setItem(key, next ? '1' : '0') } catch { /* 保存できなくても画面では切り替える */ }
  }, [folded, key])
  return { folded, toggle }
}
