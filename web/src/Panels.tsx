import type { AlarmLine } from './Chart'
import { change, recent, stamp, stats, type LogData } from './log'
import { CAPACITY, type Status } from './protocol'
import { fmtClock, fmtDuration, toUnit, type Unit } from './units'

const num = (f: number | null | undefined, unit: Unit, digits = 2) => (f == null ? '—' : toUnit(f, unit).toFixed(digits))

function Sparkline({ values, probe }: { values: number[]; probe: number }) {
  if (values.length < 2) return <div class="spark" />
  const lo = Math.min(...values) - 0.2, hi = Math.max(...values) + 0.2
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${((200 * i) / (values.length - 1)).toFixed(1)},${(40 - (40 * (v - lo)) / (hi - lo)).toFixed(1)}`).join(' ')
  return (
    <svg class="spark" viewBox="0 0 200 40" preserveAspectRatio="none" aria-hidden="true">
      <path d={d} fill="none" stroke={`var(--probe${probe + 1})`} stroke-width="1.2" vector-effect="non-scaling-stroke" opacity="0.7" />
    </svg>
  )
}

/** One probe's big readout, alarm limits, recent trend and stats. */
export function ChannelPanel({ index, enabled, connected, latestF, log, alarms, unit }: {
  index: number
  enabled: boolean
  /** A logger is connected (so "no alarm" is known, not just unknown). */
  connected: boolean
  /** Newest reading in °F (null = none / probe unplugged). */
  latestF: number | null
  log: LogData | null
  alarms: AlarmLine[]
  unit: Unit
}) {
  const series = log?.probes[index]
  const s = series ? stats(series) : null
  const delta = log && series ? change(log, index, 300) : null
  const cls = `ch${index + 1}`
  return (
    <section class="panel channel" aria-label={`Channel ${index + 1}`}>
      <div class="panel-head">
        <span class="label" style={{ color: 'var(--bright)' }}>
          <span class="swatch" style={{ background: `var(--probe${index + 1})` }} />CH {index + 1}
        </span>
        <span class={`tags ${cls}`}>
          {!enabled && <span class="tag muted">OFF</span>}
          {enabled && connected && alarms.length === 0 && <span class="tag muted" style={{ color: 'var(--muted)' }}>NO ALARM</span>}
          {alarms.map((a) => (
            <span class="tag" key={a.kind}>{a.kind === 'over' ? 'HI ▲' : 'LO ▼'} {num(a.f, unit, 1)}</span>
          ))}
        </span>
      </div>
      <div class={`readout ${enabled && latestF != null ? cls : 'off'}`} aria-live="off">
        <span class="value">{enabled && latestF != null ? num(latestF, unit) : '--.--'}</span>
        <span class="unit">°{unit}</span>
      </div>
      {enabled && log ? <Sparkline values={recent(log, index, 60)} probe={index} /> : <div class="spark" />}
      <dl class="stats4">
        <div><dt>MIN</dt><dd>{num(s?.min, unit)}</dd></div>
        <div><dt>MAX</dt><dd>{num(s?.max, unit)}</dd></div>
        <div><dt>AVG</dt><dd>{num(s?.mean, unit)}</dd></div>
        <div><dt>Δ 5 MIN</dt><dd>{delta == null ? '—' : `${delta >= 0 ? '+' : '−'}${Math.abs(unit === 'F' ? delta : (delta * 5) / 9).toFixed(2)}`}</dd></div>
      </dl>
    </section>
  )
}

const STATE_LED: Record<Status['state'], string> = {
  logging: 'ok', full: 'warn', 'waiting for button': 'warn', armed: 'warn', stopped: 'off', idle: 'off',
}

function fmtDrift(seconds: number) {
  const sign = seconds >= 0 ? '+' : '−'
  const a = Math.abs(Math.round(seconds))
  return `${sign}${a < 60 ? `${a} s` : fmtDuration(a)}`
}

/** Logger state, timing and memory — or a connect prompt. */
export function LoggerPanel({ status, now, supported, busy, onConnect }: {
  status: Status | null
  now: number
  supported: boolean
  busy: boolean
  onConnect: () => void
}) {
  if (!status) {
    return (
      <section class="panel logger" aria-label="Logger">
        <div class="panel-head"><span class="label" style={{ color: 'var(--bright)' }}>LOGGER</span><span class="led off">NOT CONNECTED</span></div>
        <div class="connect">
          <p>{supported
            ? 'Plug the logger into a USB port, then connect to it. Chrome will ask which device to use.'
            : 'This browser can’t talk to USB devices. Use Chrome, Edge, Brave or Arc on a computer.'}</p>
          <button class="primary" disabled={!supported || busy} onClick={onConnect}>Connect logger</button>
        </div>
      </section>
    )
  }
  const { state, intervalSeconds: iv, readingCount: n, actualStart } = status
  const elapsed = state === 'logging' && actualStart ? (now - actualStart.getTime()) / 1000 : n > 0 ? (n - 1) * iv : null
  const drift = status.clock ? (status.clock.getTime() - now) / 1000 : null
  const lit = n > 0 ? Math.max(1, Math.round((n / CAPACITY) * 40)) : 0
  return (
    <section class="panel logger" aria-label="Logger">
      <div class="panel-head">
        <span class="label" style={{ color: 'var(--bright)' }}>LOGGER</span>
        <span class={`led ${STATE_LED[state]}`}>{state}</span>
      </div>
      <dl class="facts">
        <dt>Name</dt><dd title={status.name}>{status.name || '—'}</dd>
        <dt>Interval</dt><dd>{fmtClock(iv)}</dd>
        <dt>Started</dt><dd>{actualStart ? stamp(actualStart) : '—'}</dd>
        <dt>Elapsed</dt><dd>{elapsed == null ? '—' : fmtClock(elapsed)}</dd>
        <dt>Clock Δ</dt><dd style={drift != null && Math.abs(drift) > 60 ? { color: 'var(--warn)' } : undefined}>{drift == null ? '—' : fmtDrift(drift)}</dd>
      </dl>
      <div>
        <div class="memory-head">
          <span>Memory {n.toLocaleString()} / {CAPACITY.toLocaleString()}</span>
          <span>{state === 'logging' ? `Full in ${fmtClock((CAPACITY - n) * iv)}` : state === 'full' ? 'Full' : ''}</span>
        </div>
        <div class={`segments ${state === 'full' ? 'full' : ''}`} role="meter" aria-valuemin={0} aria-valuemax={CAPACITY} aria-valuenow={n}
          aria-label={`Memory ${n} of ${CAPACITY} readings`}>
          {Array.from({ length: 40 }, (_, i) => <span key={i} class={i < lit ? 'on' : ''} />)}
        </div>
      </div>
    </section>
  )
}
