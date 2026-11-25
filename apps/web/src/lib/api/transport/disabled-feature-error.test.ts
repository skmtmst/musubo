import { expect, it } from 'vitest'
import { responseApiError } from './errors'

it('機能停止の識別子を各応答のエラーにだけ保持する', () => {
  const response = new Response(null, { status: 403 })
  const mileage = responseApiError(response, JSON.stringify({ code: 'FEATURE_DISABLED', featureId: 'mileage' }))
  const tags = responseApiError(response, JSON.stringify({ code: 'FEATURE_DISABLED', featureId: 'tags' }))
  const actualShape = responseApiError(response, JSON.stringify({ success: false, error: { code: 'FEATURE_DISABLED', message: 'off', requestId: 'req', fieldErrors: [] }, featureId: 'mileage' }))
  expect(actualShape.code).toBe('FEATURE_DISABLED')
  expect(actualShape.featureId).toBe('mileage')
  expect(mileage.featureId).toBe('mileage')
  expect(tags.featureId).toBe('tags')
  expect(responseApiError(response, JSON.stringify({ code: 'FEATURE_DISABLED', featureId: 'bad value' })).featureId).toBeUndefined()
  expect(responseApiError(new Response(null, { status: 500 }), JSON.stringify({ code: 'FEATURE_DISABLED', featureId: 'mileage' })).featureId).toBeUndefined()
})
