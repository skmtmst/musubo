import { useEffect, useState } from 'react'

/** 本文の下に続きがある間だけ、固定した操作枠へ案内を出す。 */
export function useDialogScrollHint() {
  const [content, setContent] = useState<HTMLDivElement | null>(null)
  const [hasMore, setHasMore] = useState(false)

  useEffect(() => {
    const viewport = content?.closest<HTMLElement>('[data-window-body]')
    if (!content || !viewport) { setHasMore(false); return }
    const update = () => {
      const { scrollHeight, scrollTop, clientHeight } = viewport
      if (
        !Number.isFinite(scrollHeight) ||
        !Number.isFinite(scrollTop) ||
        !Number.isFinite(clientHeight) ||
        clientHeight <= 0 ||
        scrollHeight <= clientHeight + 2
      ) {
        setHasMore(false)
        return
      }
      const safeTop = Math.max(0, scrollTop)
      setHasMore(scrollHeight - safeTop - clientHeight > 2)
    }
    update()
    viewport.addEventListener('scroll', update, { passive: true })
    window.addEventListener('resize', update)
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
    observer?.observe(viewport)
    observer?.observe(content)
    return () => {
      viewport.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
      observer?.disconnect()
    }
  }, [content])

  return { contentRef: setContent, hasMore }
}
