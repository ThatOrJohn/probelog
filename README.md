# ProbeLog

Download, chart, set up and watch ThermaData-compatible temperature loggers — from a web browser on any computer. No Windows, no install.

**Open the app: https://thatorjohn.github.io/probelog/**

ProbeLog talks to the logger directly over USB using [WebHID](https://developer.mozilla.org/docs/Web/API/WebHID_API), so it runs in **Chrome, Edge, Brave or Arc** on macOS, Windows, Linux and ChromeOS. (Safari and Firefox don't support WebHID; you can still open saved CSV files there.)

> Not affiliated with or endorsed by ThermoWorks or Electronic Temperature Instruments. ThermoWorks and ThermaData are trademarks of their respective owners. This is an independent project, provided with no warranty — check readings against a reference before relying on them.

## Features

- **Download** the full log from both probes (up to 8,000 readings each) and chart it
- **Live view** — watch readings arrive while the logger is recording
- **Set up** the logger: name, interval, probes, start (now / later by button or app / on button press after a delay of up to about 18 hours / at a date and time), stop (manually / when full / after N readings / at a date and time), over/under alarms per probe, and sync its clock to your computer
- **Start / stop** logging
- **Export CSV** and re-open CSVs later
- °F / °C, zoomable chart with alarm lines, per-probe min / max / average / 5-minute change

## Tested hardware

- ThermoWorks ThermaData Logger LCD, 2 inputs (product code THS-292-501), which identifies over USB as "ThermaData™ Logger TCD" (USB ID `0483:a07b`)
- General-purpose Type K thermocouple probes (THS-113-444-MC)

Other ThermaData models may use the same protocol but haven't been tested. Reports welcome.

## How it works

The USB protocol isn't documented, so it was worked out by recording the vendor software's USB traffic with Wireshark/USBPcap and comparing it with the readings it saved. No vendor software was decompiled or redistributed. The details are in [PROTOCOL.md](PROTOCOL.md).

In short: the logger is a USB HID device with fixed-size reports. A status report carries its settings, clock and latest readings; a download returns 8-byte records (BCD timestamp + raw reading), and `°F = raw / 20 − 500`. Saving settings erases the logger, exactly as the vendor software does.

## Repository layout

| Path | What |
|---|---|
| `web/` | The web app (Vite, TypeScript, Preact, uPlot) |
| `Sources/LoggerKit/` | Swift implementation of the protocol (IOKit HID, macOS) |
| `Sources/tdlog/` | `tdlog` command-line tool built on LoggerKit |
| `Tests/LoggerKitTests/` | Tests, including captured vendor-software settings writes that both implementations must reproduce byte for byte |
| `PROTOCOL.md` | Protocol notes |

## Development

Web app:

```bash
cd web
npm install
npm run dev      # http://localhost:5173 — open in Chrome
npm test
npm run build    # static site in web/dist
```

Command-line tool (macOS):

```bash
swift run tdlog status
swift run tdlog download -o log.csv
swift run tdlog            # lists all commands, including setup
```

Pushes to `main` run the tests and deploy the web app to GitHub Pages.

## License

[MIT](LICENSE)
