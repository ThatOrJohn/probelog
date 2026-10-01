import { describe, expect, it } from 'vitest'
import { appendLatest, beyond, change, recent, regionStats, timeInAlarm, fromCsv, logFromReadings, stats, toCsv } from '../src/log'
import { rawFor } from '../src/protocol'

describe('log', () => {
  const t0 = new Date(2026, 8, 28, 11, 36, 36)
  const t1 = new Date(2026, 8, 28, 11, 36, 54)
  const log = logFromReadings([
    { channel: 0, time: t0, raw: rawFor(36.9) }, { channel: 1, time: t0, raw: rawFor(75.2) },
    { channel: 0, time: t1, raw: 0xffff }, { channel: 1, time: t1, raw: rawFor(74.7) },
  ], 'test')

  it('aligns probes by time and blanks invalid readings', () => {
    expect(log.probes[0]).toEqual([36.9, null])
    expect(log.probes[1][1]).toBeCloseTo(74.7)
  })

  it('writes the same CSV format as tdlog and reads it back', () => {
    const csv = toCsv(log)
    expect(csv.split('\n')[0]).toBe('time,probe1_f,probe1_c,probe2_f,probe2_c')
    expect(csv.split('\n')[1]).toBe('2026-09-28 11:36:36,36.90,2.72,75.20,24.00')
    expect(csv.split('\n')[2]).toBe('2026-09-28 11:36:54,,,74.70,23.72')
    const back = fromCsv(csv, 'x')
    expect(back.times).toEqual(log.times)
    expect(back.probes[0]).toEqual([36.9, null])
  })

  it('computes stats over valid readings only', () => {
    expect(stats(log.probes[0])).toEqual({ min: 36.9, max: 36.9, mean: 36.9, count: 1 })
    expect(stats([null])).toBeNull()
  })

  it('appends a live reading one interval after the last one', () => {
    const s = { readingCount: 3, actualStart: t0, intervalSeconds: 18, latestRaw: [rawFor(40), null] }
    const next = appendLatest(log, 2, s)!
    expect(next.times.at(-1)).toBe(log.times.at(-1)! + 18)
    expect(next.probes.map((p) => p.at(-1))).toEqual([40, null])
    expect(next.title).toBe('test')
  })

  it('asks for a full download when readings were missed or the probe count changed', () => {
    const s = { readingCount: 4, actualStart: t0, intervalSeconds: 18, latestRaw: [rawFor(40), null] }
    expect(appendLatest(log, 2, s)).toBeNull()
    expect(appendLatest(log, 3, { ...s, latestRaw: [rawFor(40)] })).toBeNull()
  })

  it('measures change over a time window and collects recent values', () => {
    const l = { title: 't', times: [0, 60, 120, 400], probes: [[70, null, 60, 50]] }
    expect(change(l, 0, 300)).toBe(-10) // 120 s → 400 s
    expect(change(l, 0, 1000)).toBe(-20)
    expect(change({ ...l, probes: [[null, null, null, 1]] }, 0, 300)).toBeNull()
    expect(recent(l, 0, 2)).toEqual([60, 50])
  })

  it('counts readings past alarm limits', () => {
    const l = { title: 't', times: [0, 10, 20, 30], probes: [[69, 71, null, 75]] }
    expect(beyond(70, { kind: 'over', f: 70 })).toBe(false)
    expect(timeInAlarm(l, 0, [{ kind: 'over', f: 70 }])).toEqual({ count: 2, seconds: 20 })
    expect(timeInAlarm(l, 0, [{ kind: 'under', f: 70 }]).count).toBe(1)
  })

  it('computes region stats with a least-squares rate', () => {
    // 1 °F per minute with a null gap, plus readings outside the region.
    const l = { title: 't', times: [0, 60, 120, 180, 240, 300], probes: [[50, 70, 71, null, 73, 90]] }
    const r = regionStats(l, 0, 60, 240, [{ kind: 'over', f: 72 }])!
    expect(r).toMatchObject({ count: 3, min: 70, max: 73, change: 3, inAlarm: 1 })
    expect(r.mean).toBeCloseTo(71.333, 3)
    expect(r.ratePerMin).toBeCloseTo(1, 6)
    expect(regionStats(l, 0, 1000, 2000)).toBeNull()
  })

  it('round-trips event markers through CSV, quoting labels with commas', () => {
    const csv = toCsv(log, [{ id: 'a', t: log.times[1], label: 'added ice, stirred' }, { id: 'b', t: log.times[1] + 3, label: 'lid "on"' }])
    expect(csv.split('\n')[0]).toBe('time,probe1_f,probe1_c,probe2_f,probe2_c,marker')
    expect(csv.split('\n')[1].endsWith(',')).toBe(true)
    const back = fromCsv(csv, 'x')
    expect(back.markers.map((m) => [m.t, m.label])).toEqual([[log.times[1], 'added ice, stirred'], [log.times[1], 'lid "on"']])
    expect(back.probes[1][1]).toBeCloseTo(74.7)
    // No markers → same columns as tdlog.
    expect(toCsv(log).split('\n')[0]).toBe('time,probe1_f,probe1_c,probe2_f,probe2_c')
  })
})
