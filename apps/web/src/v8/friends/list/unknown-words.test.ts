import { describe, expect, it } from 'vitest'
import type { FriendFieldType } from '@line-crm/shared'
import { fieldTypeWord } from '@/v8/tags/fields-list-model'
import { actionShortWord, actionWord } from '@/v8/auto-replies/words'
import { actionWord as secondActionWord } from '@/v8/auto-replies/auto-reply-words'
import { messageWord } from './words'

describe('一覧の未知の種類', () => {
  it.each(['constructor', 'toString', '__proto__', 'future'])('%s を安全に表示する', value => {
    expect(fieldTypeWord(value as FriendFieldType)).toBe(value)
    expect(actionShortWord(value)).toBe('その他の処理')
    expect(actionWord(value)).toBe('その他の処理')
    expect(secondActionWord(value)).toBe('その他の処理')
    expect(messageWord({ messageType: value, content: '内容' })).toBe('メッセージ')
  })
  it('既知の種類とメッセージ本文を保つ', () => {
    expect(fieldTypeWord('select')).toBe('1つ選ぶ')
    expect(actionShortWord('tag')).toBe('タグ')
    expect(messageWord({ messageType: 'image', content: '' })).toBe('画像')
    expect(messageWord({ messageType: 'text', content: '本文' })).toBe('本文')
  })
})
