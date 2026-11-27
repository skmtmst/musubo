'use client'

/*
 * 下書きの API が無い画面の「入力の消失だけ防ぐ」仕組み（★V8 共通）。
 *
 * サーバへは送らず、このブラウザ（localStorage）にだけ書きかけを残す。
 * - 入力が止まってから AUTOSAVE_DELAY_MS（一斉配信の自動保存と同じ2秒）で書く
 * - 開き直したとき、保存済みの形と違う書きかけが残っていれば「前の入力を戻す」を出す
 * - 保存できた・元の形に戻した・「捨てる」を押したら消す
 * - 閲覧のみ（active=false）は読みも書きもしない
 * - localStorage が使えない（シークレット・容量・拒否）ときは黙って何もしない
 *
 * 保存のキーはアカウントと対象（id・新規）で分け、別の行の書きかけを混ぜない。
 *
 * シナリオの3画面はサーバーの下書きの口（use-scenario-draft.ts）へ移った。ここに残した
 * 書きかけは、そちらが一度だけ移して消す（readBrowserDraft・removeBrowserDraft を使う）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { AUTOSAVE_DELAY_MS, savedAgoLabel } from './use-draft-autosave'

const PREFIX = 'lh:v8-draft:'
const CLOCK_TICK_MS = 10_000

export const BROWSER_DRAFT_WORDS = {
  unsaved: '保存していない変更があります',
  saved: (ago: string) => `入力をこのブラウザに一時保存済み・${ago}`,
  restoreTitle: (ago: string) => `保存していない入力が残っています（${ago}）。`,
  restore: '前の入力を戻す',
} as const

type Stored<T> = { savedAt: number; value: T }

export function browserDraftKey(parts: Array<string | null | undefined>): string {
  return PREFIX + parts.map((part) => part || '-').join(':')
}

function safeJsonStringify(value: unknown): string | null {
  try {
    return JSON.stringify(value) ?? null
  } catch {
    return null
  }
}

export function readBrowserDraft<T>(key: string): Stored<T> | null {
  try {
    const raw = globalThis.localStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<Stored<T>> | null
    if (
      !parsed
      || typeof parsed !== 'object'
      || Array.isArray(parsed)
      || typeof parsed.savedAt !== 'number'
      || !Number.isFinite(parsed.savedAt)
      || parsed.savedAt <= 0
      || !('value' in parsed)
    ) return null
    return { savedAt: parsed.savedAt, value: parsed.value as T }
  } catch {
    return null
  }
}

function writeBrowserDraft<T>(key: string, value: T): number | null {
  try {
    const savedAt = Date.now()
    globalThis.localStorage.setItem(key, JSON.stringify({ savedAt, value }))
    return savedAt
  } catch {
    return null
  }
}

export function removeBrowserDraft(key: string): void {
  try {
    globalThis.localStorage.removeItem(key)
  } catch {
    /* 消せなくても画面は続ける */
  }
}

export interface BrowserDraftOptions<T> {
  /** 保存先のキー。読み込みが済むまでは null（比べる元が無いので出さない）。 */
  storageKey: string | null
  /** いまの入力。 */
  value: T
  /** 保存済み（サーバにある）形。これと同じなら書きかけは無い。 */
  baseline: T
  /** 閲覧のみは false。 */
  active?: boolean
}

export function useBrowserDraft<T>({ storageKey, value, baseline, active = true }: BrowserDraftOptions<T>) {
  const valueJson = safeJsonStringify(value)
  const baselineJson = safeJsonStringify(baseline)
  const dirty = valueJson !== null && baselineJson !== null && valueJson !== baselineJson
  const [pending, setPending] = useState<Stored<T> | null>(null)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const checkedKeyRef = useRef<string | null>(null)
  const baselineRef = useRef(baselineJson)
  baselineRef.current = baselineJson

  // キーが決まったとき（読み込み済み）に一度だけ、残っている書きかけを確かめる。
  useEffect(() => {
    if (!active || !storageKey) {
      checkedKeyRef.current = null
      setPending(null)
      setSavedAt(null)
      return
    }
    if (checkedKeyRef.current === storageKey) return
    checkedKeyRef.current = storageKey
    setSavedAt(null)
    const stored = readBrowserDraft<T>(storageKey)
    if (!stored) {
      setPending(null)
      return
    }
    if (baselineRef.current !== null && safeJsonStringify(stored.value) === baselineRef.current) {
      // 保存済みと同じなら戻すものは無い。
      removeBrowserDraft(storageKey)
      setPending(null)
      return
    }
    setPending(stored)
  }, [active, storageKey])

  // 入力が止まって2秒で書く。戻すか捨てるかを決める前は上書きしない（前の入力を消さない）。
  useEffect(() => {
    if (!active || !storageKey || pending || checkedKeyRef.current !== storageKey || valueJson === null) return
    if (!dirty) {
      if (savedAt !== null) {
        removeBrowserDraft(storageKey)
        setSavedAt(null)
      }
      return
    }
    const timer = setTimeout(() => {
      const at = writeBrowserDraft(storageKey, JSON.parse(valueJson) as T)
      if (at !== null) {
        setSavedAt(at)
        setNow(at)
      }
    }, AUTOSAVE_DELAY_MS)
    return () => clearTimeout(timer)
  }, [active, storageKey, pending, dirty, valueJson, savedAt])

  useEffect(() => {
    if (savedAt === null && pending === null) return
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS)
    return () => clearInterval(timer)
  }, [savedAt, pending])

  /** 「前の入力を戻す」。戻した値を返す（画面が自分の state へ入れる）。 */
  const restore = useCallback((): T | null => {
    if (!active) return null
    const stored = pending
    setPending(null)
    return stored ? stored.value : null
  }, [active, pending])

  /** 「捨てる」・保存できたあと。残っている書きかけを消す。 */
  const clear = useCallback(() => {
    setPending(null)
    setSavedAt(null)
    if (storageKey) removeBrowserDraft(storageKey)
  }, [storageKey])

  return {
    dirty,
    pending: active ? pending : null,
    pendingAgo: active && pending ? savedAgoLabel(pending.savedAt, now) : null,
    restore,
    clear,
    label: !active
      ? null
      : dirty && savedAt !== null
        ? BROWSER_DRAFT_WORDS.saved(savedAgoLabel(savedAt, now))
        : dirty
          ? BROWSER_DRAFT_WORDS.unsaved
          : null,
  }
}
