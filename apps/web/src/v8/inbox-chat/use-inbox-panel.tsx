'use client'
import { useEffect, useRef, useState } from 'react';
import { INBOX_INFO_PANEL_MIN_WIDTH } from './inbox-layout';
export function useInboxPanel() {

  /*
   * 顧客情報の開閉(#982 LAY-01/LAY-02)。
   *
   * 3列に収まる幅（`INBOX_INFO_PANEL_MIN_VIEWPORT`＝1536px〜）では右列と
   * して常設し、既定は開く。それより狭い幅ではトークの上に重ねる
   * ドロワーにし、既定は閉じる——開きっぱなしだと返信の本文が隠れる。
   * 以前は `hidden xl:block` で1280px未満は常に非表示で、開閉ボタンを
   * 押しても何も出なかった。
   *
   * `friendInfoChoice` は運用者が明示的に開閉したときだけ値を持つ。
   * 未操作のあいだは `wideInfoPanel`（現在の画面幅）に従うので、
   * 幅を変えても入力中の文章や選択中の相手を失わない。
   */
  const [wideInfoPanel, setWideInfoPanel] = useState(false)

  const [friendInfoChoice, setFriendInfoChoice] = useState<boolean | null>(null)

  const panesRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const panel = panesRef.current
    if (panel && typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(([entry]) => setWideInfoPanel(entry.contentRect.width >= INBOX_INFO_PANEL_MIN_WIDTH))
      observer.observe(panel)
      return () => observer.disconnect()
    }
    const media = window.matchMedia('(min-width: 1440px)')
    const sync = () => setWideInfoPanel(media.matches)
    sync()
    media.addEventListener('change', sync)
    return () => media.removeEventListener('change', sync)
  }, [])

  const showFriendInfo = friendInfoChoice ?? wideInfoPanel

  const setShowFriendInfo = (next: boolean | ((current: boolean) => boolean)) => {
    setFriendInfoChoice((current) => (typeof next === 'function' ? next(current ?? wideInfoPanel) : next))
  }

  /*
   * ドロワーで開いているあいだは Escape で閉じられるようにし、
   * 開いた時点でフォーカスをパネルへ移す。常設の列（広い幅）では
   * 開閉ボタンがいつも見えているので、この扱いはドロワーだけにする。
   */
  const customerPanelRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!showFriendInfo || wideInfoPanel) return
    customerPanelRef.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) setFriendInfoChoice(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [showFriendInfo, wideInfoPanel])
  return { wideInfoPanel, panesRef, showFriendInfo, setShowFriendInfo, customerPanelRef }
}
