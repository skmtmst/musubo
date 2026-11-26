import { describe, expect, it } from 'vitest'
import { hqBubbleProblem, newHqBubble } from './bubbles'

describe('統括配信の吹き出しの確認', () => {
  it.each(['future_kind', 'constructor', '__proto__', 'toString'])('未知の種類 %s は送る前に止める', kind => {
    const bubble = { ...newHqBubble(), kind } as Parameters<typeof hqBubbleProblem>[0]
    expect(hqBubbleProblem(bubble)).toBe('この吹き出しの種類は送れません。消して作り直してください')
  })
  it('既知のテキストは内容に応じて確認する', () => {
    expect(hqBubbleProblem({ ...newHqBubble(), body: 'お知らせ' })).toBeNull()
    expect(hqBubbleProblem(newHqBubble())).toBe('本文を入れてください')
  })
})
