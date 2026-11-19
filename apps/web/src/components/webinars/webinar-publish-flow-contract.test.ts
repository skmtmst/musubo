import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const DONE = fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'webinars', 'published', 'page.tsx'), 'utf8')
/** 撮影モックの公開応答は、本物と同じ器で返す。 */
const MOCK = fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', '..', 'scripts', 'visual-qa', 'mock-api.mjs'), 'utf8')

describe("管理画面 ウェビナー公開前確認と公開完了の契約", () => {
  // 保存・公開前検査・専用APIは v8/webinar-edit/video-publish.test.tsx の実DOM試験で守る。

  it('公開完了は実Nodeと実データだけを表示する', () => {
    expect(DONE).toContain('data-design-node="TimXl"')
    expect(DONE).toContain("webinarApi.get(id)")
    expect(DONE).toContain("webinar.status !== 'active'")
    expect(DONE).toContain("const publicPeriod = publicationWindow(webinar as PublishedWebinar)")
    expect(DONE).toContain("['対象', publicPeriod]")
    expect(DONE).not.toContain('申込 1,284')
    expect(DONE).not.toContain('<Header')
  })

  it('撮影モックの公開応答は本物と同じ `{ webinar, validation }` の器で返す', () => {
    expect(MOCK).toContain('data: { webinar: WEBINARS[0], validation: WEBINAR_PUBLISH_VALIDATION }')
    /* 停止・複製は単体のまま。公開と混ぜない。 */
    expect(MOCK).toContain('/(pause|duplicate)$/')
    expect(MOCK).not.toContain('/(publish|pause|duplicate)$/')
  })

})
