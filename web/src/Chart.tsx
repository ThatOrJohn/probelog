import { useEffect, useRef } from 'preact/hooks'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import type { LogData } from './log'
import { toUnit, type Unit } from './units'

export interface AlarmLine { probe: number; f: number; kind: 'over' | 'under' }

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim()
const probeColor = (i: number) => css(i === 0 ? '--probe1' : '--probe2')
const MONO = '11px "IBM Plex Mono", ui-monospace, monospace'

/** Dashed, labelled lines at alarm limits, in the probe's colour. */
function alarmPlugin(lines: AlarmLine[], unit: Unit): uPlot.Plugin {
  return {
    hooks: {
      draw: (u) => {
        const { ctx, bbox } = u
        const px = devicePixelRatio
        ctx.save()
        ctx.font = `${10 * px}px "IBM Plex Mono", ui-monospace, monospace`
        ctx.textAlign = 'right'
        for (const a of lines) {
          const v = toUnit(a.f, unit)
          const y = u.valToPos(v, 'y', true)
          if (y < bbox.top || y > bbox.top + bbox.height) continue
          // Faint red band over the alarm zone, beyond the limit.
          ctx.fillStyle = css('--live')
          ctx.globalAlpha = 0.07
          if (a.kind === 'over') ctx.fillRect(bbox.left, bbox.top, bbox.width, y - bbox.top)
          else ctx.fillRect(bbox.left, y, bbox.width, bbox.top + bbox.height - y)
          ctx.strokeStyle = ctx.fillStyle = probeColor(a.probe)
          ctx.globalAlpha = 0.6
          ctx.setLineDash([6 * px, 4 * px])
          ctx.lineWidth = px
          ctx.beginPath()
          ctx.moveTo(bbox.left, y)
          ctx.lineTo(bbox.left + bbox.width, y)
          ctx.stroke()
          ctx.globalAlpha = 1
          const label = `CH${a.probe + 1} ${a.kind === 'over' ? 'HI' : 'LO'} ${v.toFixed(1)}`
          ctx.fillText(label, bbox.left + bbox.width - 6 * px, a.kind === 'over' ? y - 5 * px : y + 13 * px)
        }
        ctx.restore()
      },
    },
  }
}

/** A dot on each probe's newest reading and a hairline at that time. */
const latestPlugin: uPlot.Plugin = {
  hooks: {
    draw: (u) => {
      const xs = u.data[0]
      if (!xs.length) return
      const { ctx, bbox } = u
      const px = devicePixelRatio
      const last = xs.length - 1
      const x = u.valToPos(xs[last], 'x', true)
      if (x < bbox.left - 1 || x > bbox.left + bbox.width + 1) return
      ctx.save()
      ctx.strokeStyle = css('--line-strong')
      ctx.lineWidth = px
      ctx.beginPath()
      ctx.moveTo(x, bbox.top)
      ctx.lineTo(x, bbox.top + bbox.height)
      ctx.stroke()
      for (let s = 1; s < u.data.length; s++) {
        const v = u.data[s][last]
        if (v == null) continue
        ctx.fillStyle = probeColor(s - 1)
        ctx.beginPath()
        ctx.arc(x, u.valToPos(v, 'y', true), 3 * px, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.restore()
    },
  },
}

export function Chart({ log, unit, alarms, follow = false, rangeSeconds = null, onUnzoom }: {
  log: LogData
  unit: Unit
  alarms: AlarmLine[]
  /** Live mode: keep the newest readings in view as they arrive (unless the user has zoomed). */
  follow?: boolean
  /** Show only the last N seconds; null = the whole log. */
  rangeSeconds?: number | null
  /** Called when the user resets the zoom (double-click). */
  onUnzoom?: () => void
}) {
  const box = useRef<HTMLDivElement>(null)
  const plot = useRef<uPlot | null>(null)
  const zoomed = useRef(false)
  const probeCount = log.probes.length
  const range = useRef(rangeSeconds)
  range.current = rangeSeconds
  const unzoomRef = useRef(onUnzoom)
  unzoomRef.current = onUnzoom

  const toData = (l: LogData): uPlot.AlignedData => [
    l.times,
    ...l.probes.map((p) => p.map((f) => (f == null ? null : toUnit(f, unit)))),
  ]

  /** Applies the time-range buttons unless the user is looking at a drag-zoomed window. */
  const applyRange = (u: uPlot) => {
    const xs = u.data[0]
    if (!range.current || !xs.length || zoomed.current) return
    const end = xs[xs.length - 1]
    u.setScale('x', { min: Math.max(xs[0], end - range.current), max: end })
  }

  // Build the plot when its shape or styling changes; new readings only update the data.
  useEffect(() => {
    const el = box.current!
    const axis: uPlot.Axis = {
      stroke: css('--muted'),
      font: MONO,
      grid: { stroke: css('--grid'), width: 1 },
      ticks: { stroke: css('--grid'), width: 1 },
    }
    // Keep alarm limits in view even when readings never get close.
    const limits = alarms.map((a) => toUnit(a.f, unit))
    const height = Math.max(260, Math.min(420, el.clientWidth * 0.36))
    const opts: uPlot.Options = {
      width: el.clientWidth,
      height,
      scales: {
        x: { time: true },
        y: {
          range: (_u, min, max) => {
            const lo = Math.min(min, ...limits), hi = Math.max(max, ...limits)
            const pad = Math.max(1, (hi - lo) * 0.08)
            return [lo - pad, hi + pad]
          },
        },
      },
      axes: [
        // 24-hour times; the date too once the view spans more than a day.
        { ...axis, values: (u, ticks) => {
          const span = (u.scales.x.max ?? 0) - (u.scales.x.min ?? 0)
          return ticks.map((t) => {
            const d = new Date(t * 1000)
            const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
            return span > 86400 ? `${d.getMonth() + 1}/${d.getDate()} ${hm}` : hm
          })
        } },
        { ...axis, size: 52, values: (_u, ticks) => ticks.map((t) => `${t}°`) },
      ],
      series: [
        { label: 'TIME', value: (_u, v) => (v == null ? '—' : new Date(v * 1000).toLocaleString()) },
        ...Array.from({ length: probeCount }, (_, i) => ({
          label: `CH ${i + 1}`,
          stroke: probeColor(i),
          width: 1.6,
          spanGaps: false,
          value: (_u: uPlot, v: number | null) => (v == null ? '—' : `${v.toFixed(2)} °${unit}`),
        })),
      ],
      cursor: { drag: { x: true, y: false } },
      hooks: { setSelect: [(u) => { if (u.select.width > 0) zoomed.current = true }] },
      plugins: [alarmPlugin(alarms, unit), latestPlugin],
    }
    zoomed.current = false
    const u = new uPlot(opts, toData(log), el)
    plot.current = u
    applyRange(u)
    // uPlot resets the zoom on double-click; resume following and show everything.
    const unzoom = () => { zoomed.current = false; unzoomRef.current?.() }
    el.addEventListener('dblclick', unzoom)
    const ro = new ResizeObserver(() => u.setSize({ width: el.clientWidth, height }))
    ro.observe(el)
    return () => { el.removeEventListener('dblclick', unzoom); ro.disconnect(); u.destroy(); plot.current = null }
    // log is deliberately not a dependency: data updates go through setData below.
  }, [log.title, probeCount, unit, alarms])

  useEffect(() => {
    const u = plot.current
    if (!u) return
    // Keep the user's zoom while they're looking at part of a live log.
    u.setData(toData(log), !(zoomed.current && follow))
    applyRange(u)
  }, [log])

  useEffect(() => {
    const u = plot.current
    if (!u || !log.times.length) return
    zoomed.current = false
    if (rangeSeconds) applyRange(u)
    else u.setScale('x', { min: log.times[0], max: log.times[log.times.length - 1] })
  }, [rangeSeconds])

  return <div ref={box} class="chart" />
}
