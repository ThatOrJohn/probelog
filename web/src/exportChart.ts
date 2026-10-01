// Renders the chart to a report-ready PNG: title, details, legend, chart and footer.
import uPlot from 'uplot'
import { chartData, chartOptions, type AlarmLine, type ChartTheme, type Region, type TimeMode } from './Chart'
import type { LogData } from './log'
import type { Unit } from './units'

const WIDTH = 1600 // CSS px; rendered at 2× for sharp text when scaled down
const CHART_HEIGHT = 720
const PAD = 40
const HEADER = 112
const FOOTER = 56
const SCALE = 2

export interface ImageSpec {
  log: LogData
  unit: Unit
  alarms: AlarmLine[]
  theme: ChartTheme
  timeMode: TimeMode
  /** Time range to show (what's visible on screen); null = the whole log. */
  range: Region | null
  title: string
  /** e.g. "SN D14380098 · 2 probes · every 5 s". */
  details: string
  region: Region | null
}

const SANS = '"IBM Plex Sans", system-ui, sans-serif'
const MONO = '"IBM Plex Mono", ui-monospace, Menlo, monospace'
const stamp = (t: number) => new Date(t * 1000).toLocaleString([], { hour12: false })

export async function renderChartImage(spec: ImageSpec): Promise<HTMLCanvasElement> {
  await document.fonts.ready
  const { theme, log } = spec
  const host = document.createElement('div')
  host.style.cssText = 'position:fixed;left:-20000px;top:0;'
  document.body.append(host)
  const plotWidth = WIDTH - 2 * PAD
  // uPlot renders at the screen's pixel ratio; draw it bigger so the image is SCALE× everywhere.
  const k = SCALE / devicePixelRatio
  // uPlot draws asynchronously; wait for its draw hook before copying the canvas.
  let drawn: () => void = () => {}
  const nextDraw = () => new Promise<void>((resolve) => {
    drawn = resolve
    setTimeout(resolve, 1500) // never hang an export
  })
  const opts = chartOptions({
    width: plotWidth * k, height: CHART_HEIGHT * k, unit: spec.unit, alarms: spec.alarms,
    probeCount: log.probes.length, theme, timeMode: spec.timeMode, origin: log.times[0] ?? 0,
    scale: k, region: () => spec.region,
    plugins: [{ hooks: { draw: () => drawn() } }],
  })
  let ready = nextDraw()
  const u = new uPlot(opts, chartData(log, spec.unit), host)
  await ready
  if (spec.range) {
    ready = nextDraw()
    u.setScale('x', { min: spec.range[0], max: spec.range[1] })
    await ready
  }

  const out = document.createElement('canvas')
  out.width = WIDTH * SCALE
  out.height = (HEADER + CHART_HEIGHT + FOOTER) * SCALE
  const ctx = out.getContext('2d')!
  ctx.scale(SCALE, SCALE)
  ctx.fillStyle = theme.background
  ctx.fillRect(0, 0, WIDTH, HEADER + CHART_HEIGHT + FOOTER)

  // Header: title, then details and the time range shown.
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = theme.text
  ctx.font = `600 26px ${SANS}`
  ctx.fillText(spec.title, PAD, 52)
  const [from, to] = spec.range ?? [log.times[0], log.times[log.times.length - 1]]
  ctx.fillStyle = theme.muted
  ctx.font = `14px ${MONO}`
  ctx.fillText(`${spec.details}  ·  ${stamp(from)} → ${stamp(to)}  ·  °${spec.unit}`, PAD, 82)

  // Legend, right-aligned, with line keys like the marks.
  ctx.font = `14px ${MONO}`
  let x = WIDTH - PAD
  for (let i = log.probes.length - 1; i >= 0; i--) {
    const label = `CH ${i + 1}`
    x -= ctx.measureText(label).width
    ctx.fillStyle = theme.text
    ctx.fillText(label, x, 52)
    x -= 28
    ctx.fillStyle = theme.probes[i]
    ctx.fillRect(x, 46, 20, 3)
    x -= 24
  }

  ctx.drawImage(u.ctx.canvas, PAD, HEADER, plotWidth, CHART_HEIGHT)
  u.destroy()
  host.remove()

  // Footer.
  ctx.fillStyle = theme.muted
  ctx.font = `12px ${MONO}`
  const y = HEADER + CHART_HEIGHT + 34
  ctx.fillText(`ProbeLog · exported ${stamp(Date.now() / 1000)}`, PAD, y)
  const site = 'thatorjohn.github.io/probelog'
  ctx.fillText(site, WIDTH - PAD - ctx.measureText(site).width, y)
  return out
}

const toBlob = (c: HTMLCanvasElement) =>
  new Promise<Blob>((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not render the image.'))), 'image/png'))

export async function savePng(c: HTMLCanvasElement, name: string) {
  const url = URL.createObjectURL(await toBlob(c))
  Object.assign(document.createElement('a'), { href: url, download: name }).click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Copies the image to the clipboard (needs a secure context and a recent browser). */
export async function copyPng(c: HTMLCanvasElement) {
  if (!navigator.clipboard || typeof ClipboardItem === 'undefined') throw new Error('This browser can’t copy images. Use Save PNG instead.')
  // Passing the promise keeps Safari's user-gesture requirement happy.
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': toBlob(c) })])
}
