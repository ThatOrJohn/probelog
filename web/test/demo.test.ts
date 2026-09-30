import { describe, expect, it } from 'vitest'
import { createDemoLogger } from '../src/demo'
import { LoggerDevice } from '../src/device'
import { decodeSettings, fahrenheit, rawFor } from '../src/protocol'

describe('demo logger', () => {
  it('is logging a two-probe run with history', async () => {
    const d = new LoggerDevice(createDemoLogger())
    await d.open()
    const s = await d.readStatus()
    expect(s.state).toBe('logging')
    expect(s.channelCount).toBe(2)
    expect(s.serial).toBe('DEMO00001')
    // 45 minutes at 5 s per reading.
    expect(s.readingCount).toBeGreaterThanOrEqual(540)
    // Probe 1 has warmed past its 80 °F alarm by now.
    expect(fahrenheit(s.latestRaw[0]!)).toBeGreaterThan(80)
    expect(decodeSettings(s.raw).probes[0].high).toEqual({ enabled: true, raw: rawFor(80) })
  })

  it('downloads every reading for both probes through the real protocol code', async () => {
    const d = new LoggerDevice(createDemoLogger())
    await d.open()
    const { status, chunks, readings } = await d.download()
    expect(chunks.length).toBe(2 * Math.ceil(status.readingCount / 127))
    expect(readings).toHaveLength(2 * status.readingCount)
    const p1 = readings.filter((r) => r.channel === 0)
    expect(fahrenheit(p1[0].raw)).toBeCloseTo(72, 0)
    expect(p1[1].time.getTime() - p1[0].time.getTime()).toBe(5000)
  })

  it('erases on setup, arms for a manual start, then starts and stops', async () => {
    const d = new LoggerDevice(createDemoLogger())
    await d.open()
    const armed = await d.applySettings({
      name: 'bench-2', intervalSeconds: 2, probeCount: 1,
      start: { kind: 'manual' }, stop: { kind: 'software' },
      probes: [{ high: { enabled: false, raw: rawFor(1372) }, low: { enabled: true, raw: rawFor(40) } },
               { high: { enabled: false, raw: rawFor(1372) }, low: { enabled: false, raw: rawFor(-100) } }],
    })
    expect(armed.state).toBe('armed')
    expect(armed.readingCount).toBe(0)
    expect(armed.name).toBe('bench-2')
    expect(armed.channelCount).toBe(1)
    await d.startNow()
    expect((await d.readStatus()).state).toBe('logging')
    await d.stopNow()
    const stopped = await d.readStatus()
    expect(stopped.state).toBe('stopped')
    expect(stopped.readingCount).toBe(1)
  })
})
