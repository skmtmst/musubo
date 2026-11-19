import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mockFetch } from './mock-local.mjs'

test('style GET is a real empty request stream and finishes successfully', async () => {
  const response = await mockFetch('GET', '/api/dashboard/style?account_id=visual-qa-account')
  assert.equal(response.status, 200)
  const body = JSON.parse(response.body)
  assert.equal(body.success, true)
  assert.equal(body.data.style, 'standard')
  assert.equal(typeof body.data.version, 'number')
})

test('style summary and existing GET routes still complete', async () => {
  for (const path of ['/api/dashboard/style/summary?account_id=visual-qa-account&style=restaurant', '/api/entry-routes?accountId=visual-qa-account']) {
    const response = await mockFetch('GET', path)
    assert.equal(response.status, 200)
    assert.equal(JSON.parse(response.body).success, true)
  }
})

test('成果の一覧と集計に必要な模擬データがある', async () => {
  const range = 'from=2026-09-01&to=2026-10-01&lineAccountId=visual-qa-account'
  const list = JSON.parse((await mockFetch('GET', `/api/conversions/definitions?${range}&limit=100`)).body)
  const report = JSON.parse((await mockFetch('GET', `/api/conversions/report?${range}`)).body)
  assert.equal(list.success, true)
  assert.ok(list.data.items.length > 0)
  assert.equal(list.data.pagination.nextCursor, null)
  assert.equal(report.success, true)
  assert.ok(Array.isArray(report.data.byDefinition))
})


test('来店フォローの現在の読取応答は編集可能な本文と予約フォームを持つ',async()=>{
 const base='/api/restaurant-test/followups/visual-store?account_id=visual-qa-account'
 const read=async suffix=>{const response=await mockFetch('GET',base.replace('?',`${suffix}?`));assert.equal(response.status,200);const body=JSON.parse(response.body);assert.equal(body.success,true);return body.data}
 const page=await read(''),board=await read('/engines'),form=await read('/reservation-form')
 assert.equal(page.setup.notUsing,false)
 assert.deepEqual(board.legacyContents.map(row=>row.trigger),page.rows.map(row=>row.trigger))
 assert.equal(board.legacyContents.length,7)
 assert.ok(board.legacyContents.every(row=>row.content.messageParts.length>0&&row.content.messageParts.every(part=>part.messageType==='text'&&part.messageContent)))
 assert.equal(form.version,0);assert.ok(form.definition.fields.some(field=>field.id==='name'&&field.required))
 const history=await read('/review-history');assert.deepEqual(history.invitations,[])
})
