import { useEffect, useRef, useState, type SetStateAction } from 'react'

type DialogScope = { accountId: string; generation: number }

/** 窓を閉じると確認の世代を失効し、古い窓から新しい窓を閉じさせない。 */
export function useScopedDialog() {
  const [open, setOpenState] = useState(false)
  const scope = useRef<DialogScope | null>(null)
  const renderedScope = scope.current
  const openRef = useRef(open)
  openRef.current = open
  const setOpen = (update: SetStateAction<boolean>) => {
    const next = typeof update === 'function' ? update(openRef.current) : update
    if (!next && renderedScope !== scope.current) return
    if (!next) scope.current = null
    openRef.current = next
    setOpenState(next)
  }
  useEffect(() => () => { scope.current = null }, [])
  return { open, setOpen, scope, renderedScope }
}
