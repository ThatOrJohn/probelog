import { useEffect, useRef } from 'preact/hooks'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import type { LogData } from './log'
import { fmtClock, toUnit, type Unit } from './units'

export interface AlarmLine { probe: number; f: number; kind: 'over' | 'under' }
export type TimeMode = 'clock' | 'elapsed'
/** A measured time range, seconds since epoch. */
export type Region = [number, number]

/** Colours for one rendering of the chart: the dark UI, or a light image for reports. */
export interface ChartTheme {
  background: string
  text: string
  muted: string
  grid: string
  hairline: string
  probes: [string, string]
  alarm: string
  selection: string
}

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim()

/** The on-screen theme, read from the stylesheet. */
export const darkTheme = (): ChartTheme => ({
  background: css('--panel'),
  text: css('--text'),
  muted: css('--muted'),
  grid: css('--grid'),
  hairline: css('--line-strong'),
  probes: [css('--probe1'), css('--probe2')],
  alarm: css('--live'),
  selection: 'rgb(86 194 255 / 0.10)',
})

/** For exported images on white (palette checked for colour-vision and contrast on #fff). */
export const LIGHT_THEME: ChartTheme = {
  background: '#ffffff',
  text: '#16191d',
  muted: '#5f6873',
  grid: '#e6e9ed',
  hairline: '#c9ced4',
  probes: ['#1d6fc4', '#c2580f'],
  alarm: '#d32f2f',
  selection: 'rgb(29 111 196 / 0.10)',
}

const MONO = '"IBM Plex Mono", ui-monospace, Menlo, monospace'
const font = (px: number) => `${px}px ${MONO}`

/** Elapsed time from the start of the log, `T+00:12:30`. */
export const fmtElapsed = (seconds: number) => `T+${fmtClock(seconds)}`

/** Round elapsed-time steps, seconds. */
const ELAPSED_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400, 172800, 604800]

/** In elapsed mode, ticks fall on round offsets from the start (+00:05, +00:10…), not wall-clock minutes. */
function elapsedSplits(origin: number, k: number) {
  return (u: uPlot, _axis: number, min: number, max: number) => {
    const target = Math.max(2, Math.floor(u.bbox.width / devicePixelRatio / (110 * k)))
    const step = ELAPSED_STEPS.find((s) => (max - min) / s <= target) ?? ELAPSED_STEPS[ELAPSED_STEPS.length - 1]
    const out: number[] = []
    for (let t = origin + Math.ceil((min - origin) / step) * step; t <= max; t += step) out.push(t)
    return out
  }
}

function timeLabels(mode: TimeMode, origin: number) {
  return (u: uPlot, ticks: number[]) => {
    const span = (u.scales.x.max ?? 0) - (u.scales.x.min ?? 0)
    const step = ticks.length > 1 ? ticks[1] - ticks[0] : span
    return ticks.map((t) => {
      if (mode === 'elapsed') {
        const s = Math.round(t - origin)
        const label = fmtClock(Math.abs(s))
        // Drop the seconds when every tick is on a whole minute.
        return `${s < 0 ? '−' : '+'}${step % 60 === 0 ? label.slice(0, -3) : label}`
      }
      const d = new Date(t * 1000)
      const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
      return span > 86400 ? `${d.getMonth() + 1}/${d.getDate()} ${hm}` : hm
    })
  }
}

/** Shaded alarm zones and dashed, labelled limit lines. */
function alarmPlugin(lines: AlarmLine[], unit: Unit, theme: ChartTheme, k: number): uPlot.Plugin {
  return {
    hooks: {
      draw: (u) => {
        const { ctx, bbox } = u
        const px = devicePixelRatio * k
        ctx.save()
        ctx.font = font(10 * px)
        ctx.textAlign = 'right'
        for (const a of lines) {
          const v = toUnit(a.f, unit)
          const y = u.valToPos(v, 'y', true)
          if (y < bbox.top || y > bbox.top + bbox.height) continue
          ctx.fillStyle = theme.alarm
          ctx.globalAlpha = 0.07
          if (a.kind === 'over') ctx.fillRect(bbox.left, bbox.top, bbox.width, y - bbox.top)
          else ctx.fillRect(bbox.left, y, bbox.width, bbox.top + bbox.height - y)
          ctx.strokeStyle = ctx.fillStyle = theme.probes[a.probe]
          ctx.globalAlpha = 0.6
          ctx.setLineDash([6 * px, 4 * px])
          ctx.lineWidth = px
          ctx.beginPath()
          ctx.moveTo(bbox.left, y)
          ctx.lineTo(bbox.left + bbox.width, y)
          ctx.stroke()
          ctx.globalAlpha = 1
          ctx.fillText(`CH${a.probe + 1} ${a.kind === 'over' ? 'HI' : 'LO'} ${v.toFixed(1)}`,
            bbox.left + bbox.width - 6 * px, a.kind === 'over' ? y - 5 * px : y + 13 * px)
        }
        ctx.restore()
      },
    },
  }
}

/** A dot on each probe's newest reading and a hairline at that time. */
function latestPlugin(theme: ChartTheme, k: number): uPlot.Plugin {
  return {
    hooks: {
      draw: (u) => {
        const xs = u.data[0]
        if (!xs.length) return
        const { ctx, bbox } = u
        const px = devicePixelRatio * k
        const last = xs.length - 1
        const x = u.valToPos(xs[last], 'x', true)
        if (x < bbox.left - 1 || x > bbox.left + bbox.width + 1) return
        ctx.save()
        ctx.strokeStyle = theme.hairline
        ctx.lineWidth = px
        ctx.beginPath()
        ctx.moveTo(x, bbox.top)
        ctx.lineTo(x, bbox.top + bbox.height)
        ctx.stroke()
        for (let s = 1; s < u.data.length; s++) {
          const v = u.data[s][last]
          if (v == null) continue
          // A ring in the background colour keeps the dot readable where lines cross.
          ctx.fillStyle = theme.background
          ctx.beginPath()
          ctx.arc(x, u.valToPos(v, 'y', true), 5 * px, 0, Math.PI * 2)
          ctx.fill()
          ctx.fillStyle = theme.probes[s - 1]
          ctx.beginPath()
          ctx.arc(x, u.valToPos(v, 'y', true), 3.5 * px, 0, Math.PI * 2)
          ctx.fill()
        }
        ctx.restore()
      },
    },
  }
}

/** The measured region as a tinted band with edge lines. */
function regionPlugin(getRegion: () => Region | null, theme: ChartTheme, k: number): uPlot.Plugin {
  return {
    hooks: {
      drawClear: (u) => {
        const r = getRegion()
        if (!r) return
        const { ctx, bbox } = u
        const x0 = Math.max(bbox.left, u.valToPos(r[0], 'x', true))
        const x1 = Math.min(bbox.left + bbox.width, u.valToPos(r[1], 'x', true))
        if (x1 <= x0) return
        ctx.save()
        ctx.fillStyle = theme.selection
        ctx.fillRect(x0, bbox.top, x1 - x0, bbox.height)
        ctx.strokeStyle = theme.muted
        ctx.globalAlpha = 0.6
        ctx.lineWidth = devicePixelRatio * k
        for (const x of [x0, x1]) {
          ctx.beginPath()
          ctx.moveTo(x, bbox.top)
          ctx.lineTo(x, bbox.top + bbox.height)
          ctx.stroke()
        }
        ctx.restore()
      },
    },
  }
}

export interface ChartSpec {
  width: number
  height: number
  unit: Unit
  alarms: AlarmLine[]
  probeCount: number
  theme: ChartTheme
  timeMode: TimeMode
  /** Time the elapsed axis counts from (first reading). */
  origin: number
  /** Size multiplier for fonts, lines and spacing (image export renders larger). */
  scale?: number
  region?: () => Region | null
  plugins?: uPlot.Plugin[]
}

/** uPlot options shared by the on-screen chart and image export. */
export function chartOptions(spec: ChartSpec): uPlot.Options {
  const { theme, unit } = spec
  const k = spec.scale ?? 1
  const axis: uPlot.Axis = {
    stroke: theme.muted,
    font: font(11 * k),
    gap: 5 * k,
    grid: { stroke: theme.grid, width: k },
    ticks: { stroke: theme.grid, width: k, size: 10 * k },
  }
  // Keep alarm limits in view even when readings never get close.
  const limits = spec.alarms.map((a) => toUnit(a.f, unit))
  return {
    width: spec.width,
    height: spec.height,
    legend: { show: false },
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
      {
        ...axis, values: timeLabels(spec.timeMode, spec.origin), size: 40 * k, space: 80 * k,
        ...(spec.timeMode === 'elapsed' ? { splits: elapsedSplits(spec.origin, k) } : {}),
      },
      { ...axis, size: 52 * k, space: 36 * k, values: (_u, ticks) => ticks.map((t) => `${t}°`) },
    ],
    series: [
      {},
      ...Array.from({ length: spec.probeCount }, (_, i) => ({
        label: `CH ${i + 1}`,
        stroke: theme.probes[i],
        width: 2 * k,
        spanGaps: false,
        points: { show: false },
      })),
    ],
    plugins: [
      ...(spec.region ? [regionPlugin(spec.region, theme, k)] : []),
      alarmPlugin(spec.alarms, unit, theme, k),
      latestPlugin(theme, k),
      ...(spec.plugins ?? []),
    ],
  }
}

export const chartData = (log: LogData, unit: Unit): uPlot.AlignedData => [
  log.times,
  ...log.probes.map((p) => p.map((f) => (f == null ? null : toUnit(f, unit)))),
]

/**
 * Crosshair readout: time (clock and elapsed), each probe's value, and the difference
 * between probes, at the reading nearest the pointer. Built with textContent only.
 */
function tooltipPlugin(unit: Unit, theme: ChartTheme, origin: () => number): uPlot.Plugin {
  let box: HTMLDivElement
  return {
    hooks: {
      init: (u) => {
        box = document.createElement('div')
        box.className = 'chart-tip'
        box.hidden = true
        u.over.appendChild(box)
      },
      setCursor: (u) => {
        const i = u.cursor.idx
        if (i == null || u.cursor.left == null || u.cursor.left < 0) { box.hidden = true; return }
        const t = u.data[0][i]
        const vals = u.data.slice(1).map((s) => s[i] ?? null)
        box.replaceChildren()
        const head = document.createElement('div')
        head.className = 'tip-time'
        head.textContent = `${new Date(t * 1000).toLocaleTimeString([], { hour12: false })}  ${fmtElapsed(t - origin())}`
        box.append(head)
        vals.forEach((v, s) => {
          const row = document.createElement('div')
          row.className = 'tip-row'
          const key = document.createElement('span')
          key.className = 'tip-key'
          key.style.background = theme.probes[s]
          const value = document.createElement('strong')
          value.textContent = v == null ? '—' : `${v.toFixed(2)} °${unit}`
          const name = document.createElement('span')
          name.className = 'tip-name'
          name.textContent = `CH ${s + 1}`
          row.append(key, value, name)
          box.append(row)
        })
        if (vals.length === 2 && vals[0] != null && vals[1] != null) {
          const row = document.createElement('div')
          row.className = 'tip-row tip-diff'
          const value = document.createElement('strong')
          const d = vals[0] - vals[1]
          value.textContent = `${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(2)} °${unit}`
          const name = document.createElement('span')
          name.className = 'tip-name'
          name.textContent = 'CH1 − CH2'
          row.append(document.createElement('span'), value, name)
          box.append(row)
        }
        box.hidden = false
        // Sit beside the crosshair, flipping sides near the right edge.
        const x = u.valToPos(t, 'x')
        const flip = x + box.offsetWidth + 16 > u.over.clientWidth
        box.style.left = `${flip ? x - box.offsetWidth - 12 : x + 12}px`
        box.style.top = `${Math.max(4, (u.cursor.top ?? 0) - box.offsetHeight / 2)}px`
      },
    },
  }
}

export function Chart({ log, unit, alarms, follow = false, rangeSeconds = null, timeMode, measuring, region, onRegion, onUnzoom, viewRef }: {
  log: LogData
  unit: Unit
  alarms: AlarmLine[]
  /** Live mode: keep the newest readings in view as they arrive (unless the user has zoomed). */
  follow?: boolean
  /** Show only the last N seconds; null = the whole log. */
  rangeSeconds?: number | null
  timeMode: TimeMode
  /** Drag measures a region instead of zooming (Shift-drag does the other one). */
  measuring: boolean
  region: Region | null
  onRegion: (r: Region | null) => void
  /** Called when the user resets the zoom (double-click). */
  onUnzoom?: () => void
  /** Filled with a function returning the visible time range, for exporting what's on screen. */
  viewRef?: { current: (() => Region | null) | null }
}) {
  const box = useRef<HTMLDivElement>(null)
  const plot = useRef<uPlot | null>(null)
  const zoomed = useRef(false)
  const probeCount = log.probes.length
  // Latest values for handlers that live as long as the plot.
  const range = useRef(rangeSeconds); range.current = rangeSeconds
  const regionRef = useRef(region); regionRef.current = region
  const measuringRef = useRef(measuring); measuringRef.current = measuring
  const onRegionRef = useRef(onRegion); onRegionRef.current = onRegion
  const unzoomRef = useRef(onUnzoom); unzoomRef.current = onUnzoom
  const originRef = useRef(log.times[0] ?? 0); originRef.current = log.times[0] ?? 0

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
    const height = Math.max(260, Math.min(420, el.clientWidth * 0.36))
    const theme = darkTheme()
    let measureDrag = false
    const opts = chartOptions({
      width: el.clientWidth, height, unit, alarms, probeCount, theme, timeMode,
      origin: originRef.current,
      region: () => regionRef.current,
      plugins: [tooltipPlugin(unit, theme, () => originRef.current)],
    })
    opts.cursor = { drag: { x: true, y: false, setScale: true } }
    opts.hooks = {
      setSelect: [(u) => {
        if (u.select.width <= 0) return
        if (measureDrag) {
          const t0 = u.posToVal(u.select.left, 'x'), t1 = u.posToVal(u.select.left + u.select.width, 'x')
          onRegionRef.current([t0, t1])
          u.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false)
        } else {
          zoomed.current = true
        }
      }],
    }
    zoomed.current = false
    const u = new uPlot(opts, chartData(log, unit), el)
    plot.current = u
    applyRange(u)
    if (viewRef) viewRef.current = () => (u.scales.x.min != null && u.scales.x.max != null ? [u.scales.x.min, u.scales.x.max] : null)
    // Decide per drag whether it zooms or measures (Shift swaps the current mode).
    const down = (e: MouseEvent) => {
      measureDrag = measuringRef.current !== e.shiftKey
      u.cursor.drag!.setScale = !measureDrag
    }
    u.over.addEventListener('mousedown', down, true)
    // uPlot resets the zoom on double-click; resume following and show everything.
    const unzoom = () => { zoomed.current = false; unzoomRef.current?.() }
    el.addEventListener('dblclick', unzoom)
    const ro = new ResizeObserver(() => u.setSize({ width: el.clientWidth, height }))
    ro.observe(el)
    return () => {
      u.over.removeEventListener('mousedown', down, true)
      el.removeEventListener('dblclick', unzoom)
      ro.disconnect()
      u.destroy()
      plot.current = null
    }
    // log is deliberately not a dependency: data updates go through setData below.
  }, [log.title, probeCount, unit, alarms, timeMode])

  useEffect(() => {
    const u = plot.current
    if (!u) return
    // Keep the user's zoom while they're looking at part of a live log.
    u.setData(chartData(log, unit), !(zoomed.current && follow))
    applyRange(u)
  }, [log])

  useEffect(() => {
    const u = plot.current
    if (!u || !log.times.length) return
    zoomed.current = false
    if (rangeSeconds) applyRange(u)
    else u.setScale('x', { min: log.times[0], max: log.times[log.times.length - 1] })
  }, [rangeSeconds])

  // Redraw when the measured region changes (it's painted by a plugin).
  useEffect(() => { plot.current?.redraw(false) }, [region])

  return <div ref={box} class={`chart ${measuring ? 'measuring' : ''}`} />
}
