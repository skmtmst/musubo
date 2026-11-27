import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react'
import type { PendingImage } from './create-types'

/** 店舗を替えたときに、前の店舗で選んだ画像と選択窓を残さない。 */
export function useMenuMediaScope(accountId: string | null, hosted: boolean,
  setPendingImages: Dispatch<SetStateAction<Array<PendingImage | null>>>,
  setMediaPickerOpen: Dispatch<SetStateAction<boolean>>) {
  const previousAccount = useRef(accountId)
  useEffect(() => {
    if (hosted) {
      previousAccount.current = accountId
      return
    }
    if (previousAccount.current === accountId) return
    previousAccount.current = accountId
    setPendingImages(previous => {
      if (!Array.isArray(previous)) return []
      const seen = new Set<string>()
      for (const image of previous) {
        const url = image?.url
        if (typeof url === 'string' && url.startsWith('blob:') && !seen.has(url)) {
          seen.add(url)
          URL.revokeObjectURL(url)
        }
      }
      return []
    })
    setMediaPickerOpen(false)
  }, [accountId, hosted, setPendingImages, setMediaPickerOpen])
}
