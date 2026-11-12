import { beforeEach, describe, expect, it, vi } from 'vitest'

const request = vi.hoisted(() => vi.fn())
vi.mock('../transport/request', () => ({ fetchApi: request }))
import { richMenusMethods } from './rich-menus'
import { commerceMethods } from './commerce'
import { webhooksMethods } from './webhooks'

beforeEach(() => { request.mockReset(); request.mockResolvedValue({ success: true }) })

describe('確認時の値をAPIへ渡す', () => {
  it('リッチメニューの取り下げに確認した公開世代を付ける', async () => {
    const confirmation = { expectedVersion: 3, expectedPublishGeneration: 7, expectedIsDefaultForAll: true, expectedPages: [{ id: 'page', orderIndex: 0, lineRichMenuId: 'line-menu' }] }
    await richMenusMethods.richMenuGroups.unpublish('group', confirmation)
    expect(request).toHaveBeenCalledWith('/api/rich-menu-groups/group/unpublish', {
      method: 'POST', body: JSON.stringify(confirmation),
    })
  })
  it('LINE通知のテスト送信に確認した宛先を付ける', async () => {
    const payload = { eventType: 'ec.order.confirmed', accountId: 'a', title: '通知', introText: '', outroText: '', buttonLabel: '', buttonUrl: '', imageUrl: '', expectedRecipientIds: ['f1'] }
    await commerceMethods.ecCommerce.testSend(payload)
    expect(request).toHaveBeenCalledWith('/api/ec-commerce/test-send', { method: 'POST', body: JSON.stringify(payload) })
  })
  it('Webhookの試し送信に確認した版を付ける', async () => {
    await Reflect.apply(webhooksMethods.webhooks.outgoing.test, null, ['wh', 'a', 3])
    expect(request).toHaveBeenCalledWith('/api/webhooks/outgoing/wh/test?lineAccountId=a', {
      method: 'POST', body: JSON.stringify({ expectedVersion: 3 }),
    })
  })
})
