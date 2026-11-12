import { expect, it } from 'vitest'
import { extractApiErrorData } from './errors'

it('preserves the conflict reason for the confirmation screen', () => {
  expect(extractApiErrorData(JSON.stringify({ error: 'closure_conflict', reason: '臨時休業・貸切と重なります' }))).toEqual({ reason: '臨時休業・貸切と重なります' })
})
