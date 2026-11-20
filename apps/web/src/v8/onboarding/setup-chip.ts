'use client'

import { useEffect, useState } from 'react'

/*
  上の帯の「開店準備 N/9」の札（承認済み Pen
  /Users/masatosakamoto/Documents/musubo-course-media-upload-20261110.pen
  枠 02 (C5i3rw) の IJocF / XzDt5）と、その札から初回ポップアップを開き直す合図。

  帯（AppTopBar）はダッシュボードの親にあるので、React の文脈では値を上へ渡せない。
  左メニューの畳む合図（SIDEBAR_TOGGLE_EVENT）と同じ作りで、窓の合図でつなぐ。
  札を出すのは値を出した画面の間だけ。関係ない画面で「はじめにやること」を読み直さない。
*/

export type SetupChipState = { accountId: string; done: number; total: number }

export const SETUP_CHIP_EVENT = 'lh:v8:setup-chip'
export const SETUP_CHIP_REOPEN_EVENT = 'lh:v8:setup-chip-reopen'

let current: SetupChipState | null = null

export function readSetupChip(): SetupChipState | null {
  return current
}

/** 画面が値を出す（`null` で札を下げる）。同じ値なら合図を出さない。 */
export function publishSetupChip(next: SetupChipState | null): void {
  const same = current === next
    || (current && next && current.accountId === next.accountId && current.done === next.done && current.total === next.total)
  if (same) return
  current = next
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(SETUP_CHIP_EVENT))
}

/** 札を押した。値を出した画面が受けて、初回ポップアップを開き直す。 */
export function requestSetupChipReopen(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(SETUP_CHIP_REOPEN_EVENT))
}

export function useSetupChipState(): SetupChipState | null {
  const [state, setState] = useState<SetupChipState | null>(null)
  useEffect(() => {
    const read = () => setState(readSetupChip())
    read()
    window.addEventListener(SETUP_CHIP_EVENT, read)
    return () => window.removeEventListener(SETUP_CHIP_EVENT, read)
  }, [])
  return state
}

export function useSetupChipReopen(onReopen: () => void): void {
  useEffect(() => {
    const handle = () => onReopen()
    window.addEventListener(SETUP_CHIP_REOPEN_EVENT, handle)
    return () => window.removeEventListener(SETUP_CHIP_REOPEN_EVENT, handle)
  }, [onReopen])
}
