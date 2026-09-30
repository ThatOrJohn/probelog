# ThermaData Logger TCD — USB protocol notes

Reverse-engineered from `windows-data/tds.pcapng` (capture 1, 2026-09-27). Working notes; anything marked **?** is a guess.

## Device

Tested hardware: ThermoWorks ThermaData Logger LCD, 2 inputs (product code THS-292-501), with general-purpose Type K thermocouple probes (THS-113-444-MC). Over USB it identifies as "ThermaData™ Logger TCD".

- VID `0x0483`, PID `0xA07B`, manufacturer "Electronic Temperature Instruments Ltd", product "ThermaData™ Logger TCD"
- USB HID, vendor usage page `0xFF00`, interrupt endpoints, no driver needed on macOS
- Report IDs (payload size excluding ID byte), all both IN and OUT:
  1:5, 2:191, 3:1023, 4:9, 5:3, 6:3, 7:4, 8:4, 9:7, 10:28

## Commands seen (host → device)

| Bytes | Meaning |
|---|---|
| `01 02 00 00 00 00` | Request report 2 (status/config). Studio polls every 1–2 s. **Read-only.** |
| `01 ff ff ff ff ff` | Request log download → device returns report 3 (1024 bytes). **Read-only?** (only thing Studio sent for download) |
| `05 'E' 'T' 'I'` | Sent right before config writes — unlock/"prepare to write"? |
| `02 …` (192 bytes) | **Write config.** Rewrites mode, start/stop times and clock. Erases the log. |
| `08 'E' 'T' 'I' 10` | Start logging now? (status mode → `0x09`, start time stamped) |
| `08 'E' 'T' 'I' 20` | Stop logging? |

⚠️ Never send report 2/5/8 writes during development without a deliberate reason: Studio's "setup" write wiped the logger's previous log.

## Report 2 — status/config (191 bytes after ID)

Offsets are from the report ID byte.

| Offset | Example | Meaning |
|---|---|---|
| 0x01–0x20 | `"test"` + NUL pad | User-assigned logger name (32 bytes) |
| 0x21 | `0d` | ? |
| 0x22 | `24` / `28` | ? (changed when delayed start configured) |
| 0x23 | `29`, `00`, `01`, `09` | Mode/state? (`01` written = armed, `09` = logging) |
| 0x24–0x26 | `09 11 0e` / `09 11 14` | ? |
| 0x27–0x2c | BCD `MM DD YY hh mm ss` | Programmed start time (`ff…` = none) |
| 0x2d–0x32 | BCD datetime | Programmed stop time |
| 0x33–0x38 | BCD datetime | Actual start time |
| 0x44–0x57 | `12 00 40 92 40 1f ff 42 6a 43 …` | Alarm limits / probe config? |
| 0x58–0x60 | `"D14380098"` | Serial number (ASCII) |
| 0x73–0x92 | doubles (e.g. 41.2728, 0.0730) | Calibration coefficients? |
| 0x95–0x9a | BCD datetime | Logger real-time clock |
| 0xa0–0xa3 | `e0 2c ff ff` | Latest reading per probe (see below) |
| 0xa6 | `0a` | Readings per probe |
| 0xb6 | `10` / `20` / `00` | Last start/stop event: `10` started, `20` stopped (software Stop or on the logger), `00` after setup. `0x23` keeps its armed bit after stopping, so use this for "stopped" |

## Report 3 — log data (1024 bytes)

```
03 | 0a | 40 1f | 01 | 09 28 26 11 36 36 | d4 2c | … | <status block copy>
     n    addr    ?     BCD MM DD YY hh mm ss   raw
```

- Byte 1 = record count in this chunk
- Bytes 2–3 = LE address **in readings**. Each probe has its own 8000-reading (`0x1f40`) region: probe 1 at `0x0000`, probe 2 at `0x1f40`.
- Byte 4 = `01` on every chunk seen so far (**not** a "last chunk" flag)
- Records: `BCD datetime (6) + LE u16 raw (2)`, 8 bytes each, from byte 5. The probes share timestamps.
- The rest of the report is a copy of the status block
- Max 127 records per chunk; longer logs continue in further chunks at address + 127 (confirmed: 175 readings → chunks `7f@0000`, `30@007f`, `7f@1f40`, `30@1fbf`)
- Timestamps are per reading; spacing occasionally drifts by 1 s (18/19 s)

### Temperature encoding (confirmed against Studio's stored values, 2 logs, both probes, exact match)

```
°F = raw / 20 − 500        (0.05 °F per count)
```

e.g. 10662 → 33.1 °F (probe in ice bath), 11476 → 73.8 °F (room air). Raw `0xFFFF` = no valid reading (probe not connected?).

### Status fields for downloads

| Offset | Meaning |
|---|---|
| 0x44 | LE u16 sample interval (s) |
| 0x66 | Number of enabled probes (1 or 2) |
| 0xa0, 0xa2 | LE u16 latest raw reading, probe 1 / probe 2 (`ffff` = none) |
| 0xa6 | LE u16 readings logged per probe (0xa7 always `00` so far) |
| 0x73, 0x85 | Per-probe calibration doubles (41.27 / 0.073, 41.29 / 0.092) **?** unused |

## Writing settings (captures `tds_save.pcapng`, `tds_save2.pcapng`)

Sequence: `05 'E' 'T' 'I'` (**erases the logger** — status afterwards shows mode 0, blank dates) → status poll → write report 2 (192 bytes). Studio sometimes sends the `05` twice.

The write is the post-erase status block with these changes (reproduced byte-for-byte by `Settings.encode`, see `tdlog/Tests`):

| Offset | Meaning |
|---|---|
| 0x01–0x20 | Logger name, NUL-padded (factory default "NO TITLE") |
| 0x21 | Flags. Low nibble kept as read (`0d`). High nibble = alarm enables: `10` probe 1 over, `40` probe 1 under, `20` probe 2 over, `80` probe 2 under |
| 0x22 | Always written `28` |
| 0x23 | Mode (written): low nibble start (`1` manually — by software or the logger's button, `2` button press + delay, `4` date/time), high nibble stop (`0` by software, `2` when full, `4` date/time, `8` after N readings). Status reads back `00` idle/stopped, or `0x08 | start mode` while armed AND while logging (use actual start 0x33 + reading count to tell apart) |
| 0x26 | Always written `14` (status reads `0e`) |
| 0x27, 0x2d | BCD start / stop date-time. The vendor software always fills both: unused ones get the other date, or a default |
| 0x39 | Button start delay, seconds (default `3b` = 59). The vendor UI takes hours/minutes/seconds, so this may be wider than one byte — only values < 256 seen. Written even when unused |
| 0x44 | LE u16 interval, seconds (factory default 6) |
| 0x46, 0x48 | Probe 1 over / under limit, LE u16 raw. Disabled alarms keep a limit (default 1372 °F / −100 °F) |
| 0x4f, 0x51 | Probe 2 over / under limit |
| 0x4a–0x4e, 0x53–0x57 | Unknown per-probe bytes (changed after a factory reset) — kept as read |
| 0x66 | Probe count |
| 0x6f | LE u32 "stop after N readings" (1 when unused) |
| 0x73–0x94 | Calibration — written as zeros, logger keeps its own |
| 0x95 | BCD clock, set from the PC |

Commands (report 8): `08 'E' 'T' 'I' 10` = start now, `08 'E' 'T' 'I' 20` = stop.

Not yet captured: a button delay of 256 s or more (to learn the field's width).

## Export (`.msdb`)

SQLite. `readings.DataBlob`: 8-byte header (byte 7 = probe count?), a table of 16-byte entries (float32 time + u32 offset), then one 154-byte slot per timestamp. Each probe's value is 3 bytes LE, stored as **(°C + 250) × 1000**, padded with `ff`.

## Open questions

- Delayed-start behaviour: programmed start 20:35:30, first reading 20:45:32
- Logger clock is set from the PC during setup, so a PC with a wrong clock gives the logger a wrong clock
