'use client'
import { useEffect, useRef, useState } from 'react';
import { INBOX_INFO_PANEL_MIN_WIDTH } from './inbox-layout';
export function useInboxPanel() {

  const [wideInfoPanel, setWideInfoPanel] = useState(false)
  const [desktopViewport, setDesktopViewport] = useState(false)

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

  useEffect(() => {
    const media = window.matchMedia('(min-width: 1024px)')
    const sync = () => setDesktopViewport(media.matches)
    sync(); media.addEventListener('change', sync)
    return () => media.removeEventListener('change', sync)
  }, [])

  const inlineInfoPanel = wideInfoPanel || desktopViewport
  const narrowDesktop = desktopViewport && !wideInfoPanel
  const showFriendInfo = friendInfoChoice ?? inlineInfoPanel

  const setShowFriendInfo = (next: boolean | ((current: boolean) => boolean)) => {
    setFriendInfoChoice((current) => (typeof next === 'function' ? next(current ?? inlineInfoPanel) : next))
  }

  /*
   * ドロワーで開いているあいだは Escape で閉じられるようにし、
   * 開いた時点でフォーカスをパネルへ移す。常設の列（広い幅）では
   * 開閉ボタンがいつも見えているので、この扱いはドロワーだけにする。
   */
  const customerPanelRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!showFriendInfo || inlineInfoPanel) return
    customerPanelRef.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) setFriendInfoChoice(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [showFriendInfo, inlineInfoPanel])
  return { wideInfoPanel, inlineInfoPanel, narrowDesktop, panesRef, showFriendInfo, setShowFriendInfo, customerPanelRef }
}
