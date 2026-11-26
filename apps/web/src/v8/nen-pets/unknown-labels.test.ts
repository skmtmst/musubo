import { describe, expect, it } from 'vitest'
import { petAnimalTypeLabel } from '@/lib/nen-pets-api'
import { NEUTERED_LABEL } from './parts'

describe('ペットの種類と不妊・去勢の状態', () => {
  it.each(['constructor', 'toString', '__proto__', 'future'])('%s は未知の値として扱う', value => {
    expect(petAnimalTypeLabel(value)).toBe(value)
    expect(NEUTERED_LABEL[value as keyof typeof NEUTERED_LABEL]).toBeUndefined()
  })
  it('既知の値を表示する', () => {
    expect(petAnimalTypeLabel('dog')).toBe('犬')
    expect(NEUTERED_LABEL.yes).toBe('済み')
  })
})
