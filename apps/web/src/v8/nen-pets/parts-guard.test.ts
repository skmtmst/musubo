import { describe, expect, it } from 'vitest'
import type { NenPetRow } from '@/lib/nen-pets-api'
import { feedingLines, normalizeBirthdayInput, petsToCsv } from './parts'

const BASE_PET: NenPetRow = {
  id: 'pet-1',
  name: 'こむぎ',
  callName: 'こむぎ',
  gender: 'female',
  animalType: 'dog',
  breed: '柴',
  birthday: '2020-03-15',
  ageLabel: '4歳',
  weightKg: 5.5,
  neutered: 'yes',
  activityLabel: 'ふつう',
  productName: '鹿肉フード',
  weightUpdatedAt: '2026-09-28T00:00:00Z',
  owner: { friendId: 'f-1', name: '見本 太郎', customerId: 'c-1' },
  feeding: { dailyGrams: 120, dailyKcal: 480, venisonGrams: 15, stageLabel: '成犬' },
} as unknown as NenPetRow

describe('nen-pets/parts の誕生日検証・CSV欠損・給餌目安異常値ガード', () => {
  it('実在しない暦日（2月30日・13月・非うるう年の2月29日）を invalid と判定し、有効日は通す', () => {
    expect(normalizeBirthdayInput('02-30')).toBe('invalid')
    expect(normalizeBirthdayInput('13-01')).toBe('invalid')
    expect(normalizeBirthdayInput('2021-02-29')).toBe('invalid')
    expect(normalizeBirthdayInput('2020-02-31')).toBe('invalid')
    expect(normalizeBirthdayInput('02-29')).toBe('02-29')
    expect(normalizeBirthdayInput('2020-02-29')).toBe('2020-02-29')
    expect(normalizeBirthdayInput('   ')).toBeNull()
  })

  it('weightUpdatedAt が欠損していても petsToCsv が落ちない', () => {
    const missingDate = { ...BASE_PET, weightUpdatedAt: null as unknown as string }
    expect(() => petsToCsv([missingDate])).not.toThrow()
    expect(petsToCsv([missingDate])).toContain('こむぎ')
  })

  it('給餌目安に NaN や負数が混ざっても「約—kcal」「—g／日」「鹿肉 NaNg」を出さない', () => {
    const malformed: NenPetRow = {
      ...BASE_PET,
      feeding: { dailyGrams: Number.NaN, dailyKcal: Number.NaN, venisonGrams: Number.NaN, stageLabel: '成犬' },
    }
    const result = feedingLines(malformed)
    expect(result.main).toBe('—')
    expect(result.sub).toBe('カロリーを確認できません')
    expect(result.main).not.toContain('g')
    expect(result.sub).not.toContain('NaN')
    expect(result.sub).not.toContain('約—')

    const venisonNaN: NenPetRow = {
      ...BASE_PET,
      feeding: { dailyGrams: 120, dailyKcal: 480, venisonGrams: Number.NaN, stageLabel: '成犬' },
    }
    expect(feedingLines(venisonNaN)).toEqual({ main: '120g／日', sub: '約480kcal' })
  })
})
