import { describe, expect, it } from 'vitest'
import { nearestIndex } from '../src/markers'

describe('markers', () => {
  it('finds the nearest reading', () => {
    const t = [0, 10, 20, 30]
    expect(nearestIndex(t, -5)).toBe(0)
    expect(nearestIndex(t, 14)).toBe(1)
    expect(nearestIndex(t, 16)).toBe(2)
    expect(nearestIndex(t, 99)).toBe(3)
    expect(nearestIndex([], 1)).toBe(-1)
  })
})
