import { useEffect, useRef, useState } from 'preact/hooks'
import { CAPACITY, decodeSettings, fahrenheit, rawFor, type Settings, type Status } from './protocol'
import { fmtDuration, fromUnit, toUnit, type Unit } from './units'

type StartKind = 'software' | 'button' | 'at'
type StopKind = 'software' | 'whenFull' | 'afterReadings'
interface AlarmForm { enabled: boolean; value: string }

const INTERVAL_UNITS = { s: 1, min: 60, h: 3600 } as const
const MIN_F = -100, MAX_F = 1372

/** `datetime-local` value for a date, in local time. */
const localInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 19)

export function SetupDialog(props: {
  status: Status
  unit: Unit
  /** True when the readings currently on the logger have been downloaded. */
  downloaded: boolean
  onDownload: () => void
  onApply: (s: Settings) => Promise<void>
  onClose: () => void
}) {
  const { status, unit } = props
  const current = decodeSettings(status.raw)
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => { dialog.current?.showModal() }, [])

  const [name, setName] = useState(current.name)
  const initialUnit = current.intervalSeconds % 3600 === 0 ? 'h' : current.intervalSeconds % 60 === 0 ? 'min' : 's'
  const [intervalValue, setIntervalValue] = useState(String(current.intervalSeconds / INTERVAL_UNITS[initialUnit]))
  const [intervalUnit, setIntervalUnit] = useState<keyof typeof INTERVAL_UNITS>(initialUnit)
  const [probeCount, setProbeCount] = useState(current.probeCount === 1 ? 1 : 2)
  const [startKind, setStartKind] = useState<StartKind>('button')
  const [delay, setDelay] = useState('0')
  const [startAt, setStartAt] = useState(localInput(new Date(Date.now() + 3600_000)))
  const [stopKind, setStopKind] = useState<StopKind>('software')
  const [stopCount, setStopCount] = useState('1000')
  const [alarms, setAlarms] = useState<AlarmForm[][]>(() =>
    current.probes.map((p) => [p.high, p.low].map((a) => ({
      enabled: a.enabled,
      value: a.enabled ? toUnit(fahrenheit(a.raw), unit).toFixed(1) : '',
    }))),
  )
  const [eraseOk, setEraseOk] = useState(props.downloaded || status.readingCount === 0)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const intervalSeconds = Math.round(Number(intervalValue) * INTERVAL_UNITS[intervalUnit])

  function build(): Settings {
    if (!/^[\x20-\x7e]{0,32}$/.test(name)) throw new Error('Name must be up to 32 plain characters.')
    if (!Number.isInteger(intervalSeconds) || intervalSeconds < 1 || intervalSeconds > 65535)
      throw new Error('Interval must be between 1 second and about 18 hours.')
    const start: Settings['start'] =
      startKind === 'software' ? { kind: 'software' }
      : startKind === 'button' ? { kind: 'button', delaySeconds: Number(delay) }
      : { kind: 'at', date: new Date(startAt) }
    if (start.kind === 'button' && !(Number.isInteger(start.delaySeconds) && start.delaySeconds >= 0 && start.delaySeconds <= 255))
      throw new Error('Button delay must be 0–255 seconds.')
    if (start.kind === 'at' && !(start.date.getTime() > Date.now())) throw new Error('Start time must be in the future.')
    const n = Number(stopCount)
    const stop: Settings['stop'] =
      stopKind === 'software' ? { kind: 'software' }
      : stopKind === 'whenFull' ? { kind: 'whenFull' }
      : { kind: 'afterReadings', count: n }
    if (stop.kind === 'afterReadings' && !(Number.isInteger(n) && n >= 1 && n <= CAPACITY))
      throw new Error(`Stop after 1–${CAPACITY} readings.`)
    const probes = alarms.map((pair, p) => {
      const [high, low] = pair.map((a, i) => {
        const def = i === 0 ? MAX_F : MIN_F
        if (!a.enabled || p >= probeCount) return { enabled: false, raw: rawFor(def) }
        const f = fromUnit(Number(a.value), unit)
        if (a.value.trim() === '' || !(f >= MIN_F - 0.05 && f <= MAX_F + 0.05))
          throw new Error(`Probe ${p + 1} ${i === 0 ? 'over' : 'under'} alarm must be between ${toUnit(MIN_F, unit).toFixed(0)} and ${toUnit(MAX_F, unit).toFixed(0)} °${unit}.`)
        return { enabled: true, raw: rawFor(f) }
      })
      return { high, low }
    }) as Settings['probes']
    return { name, intervalSeconds, probeCount, start, stop, probes }
  }

  async function submit(e: Event) {
    e.preventDefault()
    setError(null)
    try {
      const s = build()
      setSaving(true)
      await props.onApply(s)
      dialog.current?.close()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const setAlarm = (p: number, i: number, patch: Partial<AlarmForm>) =>
    setAlarms(alarms.map((pair, pp) => pair.map((a, ii) => (pp === p && ii === i ? { ...a, ...patch } : a))))

  return (
    <dialog ref={dialog} class="setup" onClose={props.onClose}>
      <form onSubmit={submit}>
        <h2>Set up logger</h2>

        <label class="field">
          <span>Name</span>
          <input value={name} maxLength={32} onInput={(e) => setName(e.currentTarget.value)} />
        </label>

        <div class="field">
          <span>Interval</span>
          <div class="row">
            <input type="number" min="1" step="any" value={intervalValue} class="short"
              onInput={(e) => setIntervalValue(e.currentTarget.value)} />
            <select value={intervalUnit} onChange={(e) => setIntervalUnit(e.currentTarget.value as keyof typeof INTERVAL_UNITS)}>
              <option value="s">seconds</option><option value="min">minutes</option><option value="h">hours</option>
            </select>
            {intervalSeconds > 0 && <small>Memory lasts {fmtDuration(intervalSeconds * CAPACITY)}</small>}
          </div>
        </div>

        <fieldset class="field">
          <legend>Probes</legend>
          <label><input type="radio" checked={probeCount === 1} onChange={() => setProbeCount(1)} /> Probe 1 only</label>
          <label><input type="radio" checked={probeCount === 2} onChange={() => setProbeCount(2)} /> Probes 1 and 2</label>
        </fieldset>

        <fieldset class="field">
          <legend>Start</legend>
          <label><input type="radio" checked={startKind === 'software'} onChange={() => setStartKind('software')} /> Now</label>
          <label class="row">
            <input type="radio" checked={startKind === 'button'} onChange={() => setStartKind('button')} /> When the logger's button is pressed, after
            <input type="number" min="0" max="255" class="tiny" value={delay} disabled={startKind !== 'button'}
              onInput={(e) => setDelay(e.currentTarget.value)} /> s
          </label>
          <label class="row">
            <input type="radio" checked={startKind === 'at'} onChange={() => setStartKind('at')} /> At
            <input type="datetime-local" step="1" value={startAt} disabled={startKind !== 'at'}
              onInput={(e) => setStartAt(e.currentTarget.value)} />
          </label>
        </fieldset>

        <fieldset class="field">
          <legend>Stop</legend>
          <label><input type="radio" checked={stopKind === 'software'} onChange={() => setStopKind('software')} /> When I press Stop</label>
          <label><input type="radio" checked={stopKind === 'whenFull'} onChange={() => setStopKind('whenFull')} /> When memory is full</label>
          <label class="row">
            <input type="radio" checked={stopKind === 'afterReadings'} onChange={() => setStopKind('afterReadings')} /> After
            <input type="number" min="1" max={CAPACITY} class="short" value={stopCount} disabled={stopKind !== 'afterReadings'}
              onInput={(e) => setStopCount(e.currentTarget.value)} /> readings
          </label>
        </fieldset>

        <fieldset class="field">
          <legend>Alarms</legend>
          {[0, 1].slice(0, probeCount).map((p) => (
            <div class="alarm-row" key={p}>
              <span class={`probe-dot p${p + 1}`}>Probe {p + 1}</span>
              {(['Over', 'Under'] as const).map((label, i) => (
                <label class="alarm" key={label}>
                  <input type="checkbox" checked={alarms[p][i].enabled} onChange={(e) => setAlarm(p, i, { enabled: e.currentTarget.checked })} />
                  <span class="alarm-kind">{label}</span>
                  <input type="number" step="0.1" class="short" value={alarms[p][i].value} disabled={!alarms[p][i].enabled}
                    aria-label={`Probe ${p + 1} ${label.toLowerCase()} alarm, °${unit}`}
                    onInput={(e) => setAlarm(p, i, { value: e.currentTarget.value })} />
                  <span>°{unit}</span>
                </label>
              ))}
            </div>
          ))}
        </fieldset>

        <p class="note">The logger's clock will be set to this computer's time.</p>

        {status.readingCount > 0 && (
          <div class={`warning ${props.downloaded ? 'ok' : ''}`}>
            <strong>Saving erases the {status.readingCount.toLocaleString()} readings on the logger.</strong>
            {props.downloaded ? (
              <p>You've downloaded them in this session. Export a CSV if you want to keep them.</p>
            ) : (
              <>
                <p>They haven't been downloaded yet.</p>
                <div class="row">
                  <button type="button" onClick={() => { dialog.current?.close(); props.onDownload() }}>Download first</button>
                  <label class="row"><input type="checkbox" checked={eraseOk} onChange={(e) => setEraseOk(e.currentTarget.checked)} /> Erase without downloading</label>
                </div>
              </>
            )}
          </div>
        )}

        {error && <p class="error" role="alert">{error}</p>}

        <div class="dialog-actions">
          <button type="button" onClick={() => dialog.current?.close()}>Cancel</button>
          <button type="submit" class="primary" disabled={!eraseOk || saving}>{saving ? 'Saving…' : 'Erase and save'}</button>
        </div>
      </form>
    </dialog>
  )
}
