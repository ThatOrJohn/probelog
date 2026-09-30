import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  OFFSETS, bcdDate, decodeSettings, encodeSettings, fahrenheit, parseReadings, parseStatus, rawFor,
} from '../src/protocol'

// Captured vendor-software saves, shared with the Swift tests.
const fixtures: { source: string; statusAfterErase: string; studioWrite: string }[] = JSON.parse(
  readFileSync(new URL('../../Tests/LoggerKitTests/studio_writes.json', import.meta.url), 'utf8'),
)
const hex = (s: string) => Uint8Array.from(s.match(/../g)!.map((h) => parseInt(h, 16)))

describe('settings encoding', () => {
  it('reproduces every captured vendor write byte for byte', () => {
    expect(fixtures).toHaveLength(8)
    for (const f of fixtures) {
      const base = hex(f.statusAfterErase)
      const studio = hex(f.studioWrite)
      const ours = encodeSettings(decodeSettings(studio), base, bcdDate(studio, OFFSETS.clock)!)
      // The vendor software fills unused start/stop dates with its own defaults; don't compare those.
      if (decodeSettings(studio).start.kind !== 'at') ours.set(studio.subarray(OFFSETS.startDate, OFFSETS.startDate + 6), OFFSETS.startDate)
      ours.set(studio.subarray(OFFSETS.stopDate, OFFSETS.stopDate + 6), OFFSETS.stopDate)
      const diff = [...studio].flatMap((v, i) => (ours[i] === v ? [] : [`${i.toString(16)}:${ours[i].toString(16)}≠${v.toString(16)}`]))
      expect(diff, f.source).toEqual([])
    }
  })

  it('decodes the values entered in the vendor software', () => {
    const w = fixtures.map((f) => decodeSettings(hex(f.studioWrite)))
    expect(w[1].intervalSeconds).toBe(18)
    expect(w[1].start).toEqual({ kind: 'button', delaySeconds: 90 })
    expect(w[1].probes[1].high).toEqual({ enabled: true, raw: rawFor(400) })
    expect(w[1].probes[1].low).toEqual({ enabled: true, raw: rawFor(-10) })
    expect(w[2].stop).toEqual({ kind: 'whenFull' })
    expect(w[3].stop).toEqual({ kind: 'afterReadings', count: 100 })
    expect(w[4].start.kind).toBe('at')
    expect(w[5].probes[0].high).toEqual({ enabled: true, raw: rawFor(200) })
    expect(w[5].probes[1].low).toEqual({ enabled: true, raw: rawFor(0) })
    expect(w[6].intervalSeconds).toBe(600)
    expect(w[7].name).toBe('test')
  })
})

describe('readings', () => {
  it('converts raw values like the vendor software', () => {
    expect(fahrenheit(10662)).toBeCloseTo(33.1)
    expect(fahrenheit(11476)).toBeCloseTo(73.8)
  })

  it('parses a two-probe download and its status block', () => {
    // Probe 2's first chunk from capture 3: 10 records at address 0x1f40.
    const chunk = new Uint8Array(1024)
    chunk.set([0x03, 0x02, 0x40, 0x1f, 0x01, 0x09, 0x28, 0x26, 0x11, 0x36, 0x36, 0xf0, 0x2c, 0x09, 0x28, 0x26, 0x11, 0x36, 0x54, 0xe6, 0x2c])
    const r = parseReadings([chunk])
    expect(r.map((x) => [x.channel, x.raw])).toEqual([[1, 11504], [1, 11494]])
    expect(r[1].time.getSeconds()).toBe(54)

    const status = hex(fixtures[1].studioWrite)
    const s = parseStatus(status)
    expect(s.serial).toBe('D14380098')
    expect(s.channelCount).toBe(2)
  })

  it('reports stopped when the last event was a stop, even though the armed bit stays set', () => {
    const b = new Uint8Array(193)
    b[0x23] = 0x0a // armed + button start, as read from the stopped logger
    b.set([0x09, 0x28, 0x26, 0x21, 0x47, 0x30], 0x33) // actual start
    b[0xa6] = 7696 & 0xff; b[0xa7] = 7696 >> 8
    expect(parseStatus(b).state).toBe('logging')
    b[0xb6] = 0x20
    expect(parseStatus(b).state).toBe('stopped')
  })
})
