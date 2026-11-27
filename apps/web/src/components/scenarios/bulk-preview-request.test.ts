import { describe, expect, it } from 'vitest'
import { isCurrentPreviewRequest } from './bulk-preview-request'

describe('シナリオ一括プレビューの連続取得', () => {
  it('新しい入力の後に届いた古い応答を採用しない', () => {
    let currentGeneration = 1
    let shown = ''
    const apply = (requestGeneration: number, value: string) => {
      if (isCurrentPreviewRequest(requestGeneration, currentGeneration)) shown = value
    }

    currentGeneration = 2
    apply(2, '新しい入力の結果')
    apply(1, '古い入力の結果')

    expect(shown).toBe('新しい入力の結果')
  })

})
