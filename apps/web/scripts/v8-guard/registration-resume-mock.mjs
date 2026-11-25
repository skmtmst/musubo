import { mockFetch } from './mock-local.mjs'

export const registrationAccountId = 'visual-qa-account'

export async function mockRegistrationResume(method, path) {
  const { pathname, searchParams } = new URL(path, 'http://mock.invalid')
  const root = `/api/line-accounts/${registrationAccountId}`
  const success = data => ({ status: 200, body: JSON.stringify({ success: true, data }) })
  if (method === 'GET' && pathname === root + '/registration-receipt') {
    return success({ status: 'confirmed', receivedAt: '2026-11-24T12:00:00+09:00' })
  }
  if (method === 'GET' && pathname === root) {
    return success({ id: registrationAccountId, displayName: '検証用 LINE', name: '検証用 LINE', basicId: '@fixture', isActive: true })
  }
  if (method === 'GET' && pathname === root + '/follower-import') {
    return success({ version: 1, capability: 'unknown', phase: 'not_started' })
  }
  const response = await mockFetch(method, path)
  if (method === 'GET' && pathname === '/api/dashboard/style' && searchParams.get('registration') === '1') {
    const body = JSON.parse(response.body)
    body.data.styleSelected = false
    body.data.styleMode = 'later'
    response.body = JSON.stringify(body)
  }
  return response
}
