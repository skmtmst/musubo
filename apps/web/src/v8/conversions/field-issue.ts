export type ConversionFieldIssue = { field: string; message: string }

const FOCUSABLE_SELECTOR =
  'input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled])'

/** 入力の誤りを知らせたあと、閉じた詳細設定も開いて該当欄へ移る。 */
export function focusConversionField(id: string): void {
  if (!id || typeof document === 'undefined') return
  const field = document.getElementById(id)
  if (!field) return
  let disclosure = field.closest('details')
  while (disclosure) {
    disclosure.open = true
    disclosure = disclosure.parentElement?.closest('details') ?? null
  }
  const control = field.matches(FOCUSABLE_SELECTOR)
    ? field
    : field.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)
  control?.focus()
  ;(control ?? field).scrollIntoView?.({ block: 'center' })
}
