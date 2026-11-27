import { INITIAL_MENUS, initialFormKey, initialMenuFormTargets } from '@line-crm/shared'
import type { StarterSetItem } from '@/lib/api/helpers/styles'

export function legacyRemovalKeys(items: StarterSetItem[], key: string): Set<string> {
 const selected = items.find(item => item.key === key)
 if (!selected) return new Set<string>()
 const invalidMenu = (item: StarterSetItem) => item.kind === 'rich_menu' && item.initialMenu != null && !Object.prototype.hasOwnProperty.call(INITIAL_MENUS, item.initialMenu)
 if ((selected.kind === 'form' && items.some(invalidMenu)) || invalidMenu(selected)) return new Set<string>()
 const menu = items.find(item => item.kind === 'rich_menu' && item.initialMenu && (
  item.key === key || (selected?.kind === 'form' && initialMenuFormTargets(item.initialMenu).some(target => initialFormKey(item.initialMenu!, target) === key))
 ))
 if (!menu?.initialMenu) return new Set([key])
 const formKeys = new Set(initialMenuFormTargets(menu.initialMenu).map(target => initialFormKey(menu.initialMenu!, target)))
 return new Set(items.filter(item => item.key === menu.key || (item.kind === 'form' && formKeys.has(item.key))).map(item => item.key))
}

export function removeLegacyItem(items: StarterSetItem[], key: string): StarterSetItem[] {
 const keys = legacyRemovalKeys(items, key)
 if (!keys.size) throw new Error('初期セットの内容を確認できません。一覧を再読み込みしてください。')
 return items.filter(item => !keys.has(item.key))
}
