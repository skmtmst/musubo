// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest'
import { tapActionFromUri } from './tap-actions'
import { buildCarouselContent, emptyChoice } from '@/v8/templates/carousel-core'
import { panelsFromContent } from '@/v8/templates/carousel'
import { readUrlState } from '../../../liff/src/lib/salon-url-state'

afterEach(() => window.history.replaceState(null, '', '/'))

it.each(['menu_id', 'menu'])('保存済みの %s を編集しても、LIFF で選択したメニューが開く', parameter => {
  const selection = tapActionFromUri(`https://liff.line.me/store/?page=salon-book&${parameter}=menu-1`)
  expect(selection).toEqual({ kind: 'booking', refId: 'menu-1' })
  const draft = [{ thumbnailImageUrl: '', title: '', text: '予約のご案内', actions: [{ ...emptyChoice(), label: '予約', kind: 'booking' as const, formId: selection.refId }] }]
  const saved = buildCarouselContent(draft, 'tpl-1', 'store')
  const loaded = panelsFromContent(saved)
  const resaved = buildCarouselContent(loaded, 'tpl-1', 'store')
  const destination = new URL(JSON.parse(resaved)[0].actions[0].uri)
  window.history.replaceState(null, '', `/${destination.search}`)
  expect(readUrlState().menuId).toBe('menu-1')
})
