// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { Area } from '@/components/rich-menus/area-types'
import type { RichMenuAreaIntent } from '@line-crm/shared'

const access = vi.hoisted(() => vi.fn())
vi.mock('@line-crm/shared', async original => {
  const actual = await original<typeof import('@line-crm/shared')>()
  return { ...actual, RICH_MENU_ACTION_TYPE_BY_INTENT: new Proxy(actual.RICH_MENU_ACTION_TYPE_BY_INTENT, {
    get(target, key, receiver) { access(key); return Reflect.get(target, key, receiver) },
  }) }
})
import { actionTypeForIntent, AreaProperties } from '@/components/rich-menus/area-properties'

afterEach(cleanup)

it.each([
  ['url', 'uri'], ['tel', 'uri'], ['form', 'uri'], ['booking', 'uri'],
  ['booking_history', 'uri'], ['visit_stamp', 'uri'], ['text', 'message'],
  ['template', 'postback'], ['switch', 'richmenuswitch'], ['postback', 'postback'],
  ['datetime', 'datetimepicker'], ['clipboard', 'clipboard'],
] as const)('押したときの動き %s は共有の対応表から %s を得る', (intent, expected) => {
  access.mockClear()
  expect(actionTypeForIntent(intent as RichMenuAreaIntent)).toBe(expected)
  expect(access).toHaveBeenCalledWith(intent)
})

it('画面でURLを選ぶ時も共有表から対応する動きを得る', () => {
  const area: Area = { id: 'a', boundsX: 0, boundsY: 0, boundsWidth: 10, boundsHeight: 10, actionType: 'message', actionData: { text: '' }, intent: 'text' }
  const onUpdate = vi.fn()
  render(<AreaProperties area={area} pages={[]} tags={[]} templates={[]} forms={[]} trackedLinks={[]} taps={null} onUpdate={onUpdate} showManagementDetails={false} liffId="L-1" />)
  access.mockClear()
  fireEvent.click(within(screen.getByRole('group', { name: '押したときの動き' })).getByRole('radio', { name: 'URLを開く' }))
  expect(access).toHaveBeenCalledWith('url')
  expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ intent: 'url', actionType: 'uri' }))
})
