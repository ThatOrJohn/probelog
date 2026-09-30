import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import { Chart, type AlarmLine } from './Chart'
import { LoggerDevice, grantedLoggers, requestLogger, webHidSupported } from './device'
import { appendLatest, fromCsv, logFromReadings, recent, stamp, toCsv, type LogData } from './log'
import { ChannelPanel, LoggerPanel } from './Panels'
import { decodeSettings, fahrenheit, type Settings, type Status } from './protocol'
import { SetupDialog } from './SetupDialog'
import { fmtClock, useUnit } from './units'

const POLL_MS = 5000
/** Live view polls often enough to catch every reading at short intervals. */
const LIVE_POLL_MS = 1500
const RANGES = [{ label: '5 MIN', seconds: 300 }, { label: '30 MIN', seconds: 1800 }, { label: 'ALL', seconds: null }] as const

interface LoadedLog extends LogData { alarms: AlarmLine[] }

/** Alarm limits configured on the logger, for the chart and channel panels. */
function alarmLines(status: Status): AlarmLine[] {
  const s = decodeSettings(status.raw)
  return s.probes.slice(0, status.channelCount).flatMap((p, probe) => [
    ...(p.high.enabled ? [{ probe, f: fahrenheit(p.high.raw), kind: 'over' as const }] : []),
    ...(p.low.enabled ? [{ probe, f: fahrenheit(p.low.raw), kind: 'under' as const }] : []),
  ])
}

function saveFile(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }))
  const a = Object.assign(document.createElement('a'), { href: url, download: name })
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

const safeName = (s: string) => s.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'log'

/** Current time, ticking every second while `active` (for elapsed/ETA readouts). */
function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [active])
  return active ? now : Date.now()
}

export function App() {
  const supported = webHidSupported()
  const [unit, setUnit] = useUnit()
  const [device, setDevice] = useState<LoggerDevice | null>(null)
  const [status, setStatus] = useState<Status | null>(null)
  const [log, setLog] = useState<LoadedLog | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [progress, setProgress] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [setupOpen, setSetupOpen] = useState(false)
  const [live, setLive] = useState(false)
  const [range, setRange] = useState<number | null>(null)
  /** Serial + reading count at the last download, so setup can tell if data would be lost. */
  const [downloadedMark, setDownloadedMark] = useState<string | null>(null)
  /** Reading count the live chart is up to date with. */
  const liveCount = useRef(0)
  const fileInput = useRef<HTMLInputElement>(null)
  const busyRef = useRef(false)
  const now = useNow(status?.state === 'logging')

  const refresh = useCallback(async (d: LoggerDevice | null = device) => {
    if (!d) return
    try {
      setStatus(await d.readStatus())
    } catch (e) {
      setError(`Couldn't read the logger: ${e instanceof Error ? e.message : e}`)
    }
  }, [device])

  const attach = useCallback(async (hid: HIDDevice) => {
    try {
      const d = new LoggerDevice(hid)
      await d.open()
      setDevice(d)
      setError(null)
      setStatus(await d.readStatus())
    } catch (e) {
      setError(`Couldn't open the logger: ${e instanceof Error ? e.message : e}`)
    }
  }, [])

  // Reconnect to a logger this site already has permission for, and follow plug/unplug.
  useEffect(() => {
    if (!supported) return
    grantedLoggers().then(([d]) => d && attach(d))
    const onConnect = (e: HIDConnectionEvent) => attach(e.device)
    const onDisconnect = (e: HIDConnectionEvent) => {
      setDevice((cur) => {
        if (cur?.hid !== e.device) return cur
        setStatus(null)
        return null
      })
    }
    navigator.hid.addEventListener('connect', onConnect)
    navigator.hid.addEventListener('disconnect', onDisconnect)
    return () => {
      navigator.hid.removeEventListener('connect', onConnect)
      navigator.hid.removeEventListener('disconnect', onDisconnect)
    }
  }, [attach])

  // Keep status fresh while connected (the vendor software polls too); faster while live.
  const tick = useRef<() => Promise<void>>(async () => {})
  tick.current = live ? liveTick : () => refresh()
  useEffect(() => {
    if (!device) return
    const t = setInterval(() => { if (!busyRef.current) tick.current() }, live ? LIVE_POLL_MS : POLL_MS)
    return () => clearInterval(t)
  }, [device, live])

  // Leave live view if the logger goes away.
  useEffect(() => { if (!device) setLive(false) }, [device])

  async function run(label: string, op: () => Promise<void>) {
    busyRef.current = true
    setBusy(label)
    setError(null)
    try {
      await op()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      busyRef.current = false
      setBusy(null)
      setProgress(null)
      await refresh()
    }
  }

  const connect = () => run('Connecting', async () => {
    const hid = await requestLogger()
    if (hid) await attach(hid)
  })

  /** Downloads the whole log into the chart; returns the status it was taken at. */
  async function fetchLog(title: (s: Status) => string) {
    const { status: s, readings } = await device!.download(setProgress)
    setLog({ ...logFromReadings(readings, title(s)), alarms: alarmLines(s) })
    setDownloadedMark(`${s.serial}:${s.readingCount}`)
    return s
  }

  const download = () => run('Downloading', async () => {
    setLive(false)
    await fetchLog((s) => `${s.name || 'logger'} · downloaded ${stamp(new Date())}`)
  })

  const liveTitle = (s: Status) => `${s.name || 'logger'} · live`

  const startLive = () => run('Loading readings', async () => {
    const s = await fetchLog(liveTitle)
    liveCount.current = s.readingCount
    setNotice(null)
    setLive(true)
  })

  /** One live poll: append the new reading, or re-download if we fell behind. */
  async function liveTick() {
    const d = device
    if (!d) return
    let s: Status
    try {
      s = await d.readStatus()
    } catch (e) {
      setError(`Couldn't read the logger: ${e instanceof Error ? e.message : e}`)
      return
    }
    setStatus(s)
    if (s.readingCount !== liveCount.current) {
      const next = log && appendLatest(log, liveCount.current, s)
      if (next) {
        setLog(next)
        liveCount.current = s.readingCount
        setDownloadedMark(`${s.serial}:${s.readingCount}`)
      } else {
        // Missed readings (e.g. the tab was in the background) or a new log: resync.
        busyRef.current = true
        try { liveCount.current = (await fetchLog(liveTitle)).readingCount } finally { busyRef.current = false; setProgress(null) }
      }
    }
    if (s.state !== 'logging') {
      setLive(false)
      setNotice(`Live view ended: the logger is ${s.state}.`)
    }
  }

  const applySettings = async (settings: Settings) => {
    busyRef.current = true
    try {
      await device!.applySettings(settings)
      setDownloadedMark(null)
      setLive(false)
    } finally {
      busyRef.current = false
      await refresh()
    }
  }

  async function openCsv(file: File) {
    try {
      setLive(false)
      setLog({ ...fromCsv(await file.text(), file.name), alarms: [] })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const exportCsv = () => {
    if (!log) return
    const first = log.times[0] ? stamp(new Date(log.times[0] * 1000)).slice(0, 10) : 'empty'
    saveFile(`${safeName(status?.name ?? 'log')}-${first}.csv`, toCsv(log))
  }

  const connected = !!device && !!status
  const downloaded = !!status && downloadedMark === `${status.serial}:${status.readingCount}`
  const alarms = status ? alarmLines(status) : log?.alarms ?? []
  const channelCount = status?.channelCount ?? log?.probes.length ?? 2
  const latest = (i: number): number | null => {
    if (status) {
      const raw = status.latestRaw[i]
      return raw == null ? null : fahrenheit(raw)
    }
    return log ? recent(log, i, 1)[0] ?? null : null
  }
  const lastTime = log?.times.length ? new Date(log.times[log.times.length - 1] * 1000) : null

  return (
    <div class="page">
      <header>
        <div class="brand">
          <h1 class="wordmark">PROBELOG</h1>
          <span class="divider" aria-hidden="true" />
          <span class="device-line">
            {status ? `ThermaData logger · ${status.channelCount} ch · SN ${status.serial}`
              : log ? `File · ${log.title}` : 'No logger connected'}
          </span>
        </div>
        <div class="header-actions">
          <span class={`led ${connected ? 'ok' : 'off'}`}>{connected ? 'USB connected' : 'No USB'}</span>
          <div class="segmented" role="group" aria-label="Temperature unit">
            {(['F', 'C'] as const).map((u) => (
              <button key={u} aria-pressed={unit === u} onClick={() => setUnit(u)}>°{u}</button>
            ))}
          </div>
          <button class="small" onClick={() => fileInput.current?.click()}>Open CSV</button>
          <input ref={fileInput} type="file" accept=".csv,text/csv" hidden
            onChange={(e) => { const f = e.currentTarget.files?.[0]; if (f) openCsv(f); e.currentTarget.value = '' }} />
        </div>
      </header>

      {notice && <div class="banner" role="status">{notice}<button class="link" onClick={() => setNotice(null)}>Dismiss</button></div>}
      {error && <div class="banner error" role="alert">{error}<button class="link" onClick={() => setError(null)}>Dismiss</button></div>}

      <div class="row3">
        {[0, 1].map((i) => (
          <ChannelPanel key={i} index={i} unit={unit} enabled={i < channelCount} connected={connected} latestF={latest(i)}
            log={log} alarms={alarms.filter((a) => a.probe === i)} />
        ))}
        <LoggerPanel status={status} now={now} supported={supported} busy={!!busy} onConnect={connect} />
      </div>

      <section class="panel trend" aria-label="Trend">
        <div class="trend-head">
          <div class="trend-meta">
            <span class="label" style={{ color: 'var(--bright)' }}>Trend</span>
            {live && <span class="led live">Live</span>}
            {lastTime && <span class="label muted">Last {lastTime.toLocaleTimeString([], { hour12: false })}{status && live ? ` · every ${fmtClock(status.intervalSeconds)}` : ''}</span>}
          </div>
          <div class="ranges" role="group" aria-label="Time range">
            {RANGES.map((r) => (
              <button key={r.label} aria-pressed={range === r.seconds} disabled={!log} onClick={() => setRange(r.seconds)}>{r.label}</button>
            ))}
          </div>
        </div>
        {log && log.times.length ? (
          <>
            <Chart log={log} unit={unit} alarms={log.alarms} follow={live} rangeSeconds={range} onUnzoom={() => setRange(null)} />
            <p class="hint">Drag to zoom · double-click to reset · {log.times.length.toLocaleString()} samples · {log.title}</p>
          </>
        ) : (
          <div class="empty">
            <strong>No data</strong>
            Download from the logger, start live view, or open a CSV you saved earlier.
          </div>
        )}
      </section>

      <div class="actions">
        <div class="group">
          <button class="primary" disabled={!connected || !!busy || status!.readingCount === 0} onClick={download}>Download</button>
          {live
            ? <button class="live-on" aria-pressed="true" onClick={() => setLive(false)}>Live ● on</button>
            : <button disabled={!connected || !!busy || status!.state !== 'logging'} onClick={startLive}>Live</button>}
          {connected && (status!.state === 'armed' || status!.state === 'waiting for button')
            ? <button disabled={!!busy} onClick={() => run('Starting', () => device!.startNow())}>Start now</button>
            : <button disabled={!connected || !!busy || status!.state !== 'logging'} onClick={() => run('Stopping', () => device!.stopNow())}>Stop logging</button>}
          <button disabled={!connected || !!busy} onClick={() => setSetupOpen(true)}>Set up…</button>
          {busy && (
            <span class="busy" aria-live="polite">
              {busy}…{progress != null && ` ${Math.round(progress * 100)}%`}
              {progress != null && <progress max={1} value={progress} />}
            </span>
          )}
        </div>
        <button disabled={!log} onClick={exportCsv}>Export CSV</button>
      </div>

      <footer>
        Not affiliated with or endorsed by ThermoWorks or Electronic Temperature Instruments. No warranty — verify readings against a reference.
      </footer>

      {setupOpen && status && device && (
        <SetupDialog
          status={status}
          unit={unit}
          downloaded={downloaded}
          onDownload={download}
          onApply={applySettings}
          onClose={() => setSetupOpen(false)}
        />
      )}
    </div>
  )
}
