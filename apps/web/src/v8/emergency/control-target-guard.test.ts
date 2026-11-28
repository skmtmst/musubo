import { describe, expect, it } from 'vitest'
import { initialEmergencyTarget } from './control-target'

describe('initialEmergencyTarget defensive guards', () => {
  it('skips null or blank account entries and returns the first valid account id', () => {
    const accounts = [
      null as unknown as { id: string },
      { id: '' },
      { id: '   ' },
      { id: 'acc-valid' },
    ]
    expect(initialEmergencyTarget('admin', '', accounts)).toBe('acc-valid')
    expect(initialEmergencyTarget('admin', '   ', accounts)).toBe('acc-valid')
  })

  it('handles undefined role and non-array accounts safely without throwing', () => {
    expect(initialEmergencyTarget(undefined as unknown as null, 'acc-1', [{ id: 'acc-1' }])).toBe('')
    expect(initialEmergencyTarget('admin', 'acc-1', null as unknown as { id: string }[])).toBe('')
  })

  it('keeps owner all target and selected matching account behavior', () => {
    expect(initialEmergencyTarget('owner', 'acc-2', [{ id: 'acc-1' }, { id: 'acc-2' }])).toBe('all')
    expect(initialEmergencyTarget('admin', 'acc-2', [{ id: 'acc-1' }, { id: 'acc-2' }])).toBe('acc-2')
  })
})
