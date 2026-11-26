import { expect, it } from 'vitest'
import { resolveInboxChannel } from './inbox-model'

it('媒体の選択をURLから復元する', () => {
  expect(resolveInboxChannel(null, false)).toBe('all')
  expect(resolveInboxChannel('email', false)).toBe('email')
  expect(resolveInboxChannel('all', false)).toBe('all')
  expect(resolveInboxChannel(null, true)).toBe('all')
  expect(resolveInboxChannel('email', true)).toBe('email')
})
