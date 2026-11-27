import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const SHARED = path.join(__dirname, '..', 'templates', 'steps.tsx')
const BROADCAST = path.join(__dirname, '..', 'broadcasts', 'broadcast-form.tsx')


function code(src: string): string {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}


describe('手順の進み表示は現役の共通Steps', () => {
  it('shared に在る', () => {
    expect(fs.existsSync(SHARED), 'templates/steps.tsx が無い').toBe(true)
  })

  it('旧 StepRail / StepTrail の入口が残っていない', () => {
    expect(fs.existsSync(path.join(__dirname, 'step-rail.tsx')), 'step-rail.tsx が残っている').toBe(false)
    expect(fs.existsSync(path.join(__dirname, 'step-trail.tsx')), 'step-trail.tsx が残っている').toBe(false)
  })

  it('配信の部品は、共通部品へ渡すだけにする', () => {
    const broadcast = code(fs.readFileSync(BROADCAST, 'utf8'))
    // 設計 C：いまいる所は currentKey（URL の ?step=）で渡す。入力済みの数で決めない。
    expect(broadcast, '描き方を配信側に残さない').not.toContain('STEP {step.order}')
  })

  it('何の進みかを言う', () => {

    const shared = code(fs.readFileSync(SHARED, 'utf8'))
    expect(shared, 'aria-label を固定しない').toContain('aria-label={label}')
    const broadcast = code(fs.readFileSync(BROADCAST, 'utf8'))
    expect(broadcast).toContain('label="配信作成の進み"')
  })

  it('番号と名前で現在の段を出す', () => {

    const stepper = code(fs.readFileSync(SHARED, 'utf8'))
    expect(stepper).toContain('step.order')
    expect(stepper).not.toContain('STEP ')
  })

  it('いまいる所と入力済みを分ける（設計 C）', () => {

    const stepper = code(fs.readFileSync(SHARED, 'utf8'))
    expect(stepper).toContain('currentKey')
    expect(stepper).toContain("'attention'")
    expect(stepper).toContain('aria-current')
  })
})
