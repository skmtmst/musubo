import type { AccountStyle } from '@line-crm/shared';
import { knownValue } from '@/lib/known-value'



export const KIND_WORD: Record<string, { label: string; icon: string; href: (style: AccountStyle) => string }> = {
  form: {label:'回答フォーム・ご案内',icon:'file',href:()=>'/form-submissions'},
  rich_menu: { label: 'リッチメニュー', icon: 'grid', href: (style) => `/rich-menus/sample?style=${style}` },
  template: { label: 'テンプレート', icon: 'file', href: () => '/templates' },
  booking_menu: { label: '予約メニュー', icon: 'utensils', href: () => '/booking/menus' },
}

export function setupItemKind(kind: string): (typeof KIND_WORD)[string] | null {
  return knownValue<(typeof KIND_WORD)[string] | null>(KIND_WORD, kind, null)
}
