import Foundation
import LoggerKit

let usage = """
usage: tdlog status
       tdlog download [-o file.csv] [--raw file.bin]
       tdlog parse-raw file.bin [-o file.csv]
       tdlog setup [options] [--yes]     (ERASES the logger; without --yes only shows the plan)
         --name NAME            --interval SECONDS        --probes 1|2
         --start software|button[:DELAY_S]|"YYYY-MM-DD HH:MM:SS"
         --stop software|full|after:N
         --p1-high F  --p1-low F  --p2-high F  --p2-low F   (°F; omit to disable)
       tdlog start | stop
"""

func describe(_ s: Settings) -> String {
    let start: String
    switch s.start {
    case .software: start = "now (by software)"
    case .button(let d): start = "on button press, after \(d) s"
    case .at(let d): start = "at \(fmt(d))"
    }
    let stop: String
    switch s.stop {
    case .software: stop = "by software"
    case .whenFull: stop = "when full"
    case .afterReadings(let n): stop = "after \(n) readings"
    }
    func alarm(_ a: Settings.Alarm) -> String { a.enabled ? String(format: "%.1f °F", fahrenheit(raw: a.raw)) : "off" }
    var lines = ["Name:      \(s.name)", "Interval:  \(s.intervalSeconds) s", "Probes:    \(s.probeCount)",
                 "Start:     \(start)", "Stop:      \(stop)"]
    for p in 0..<s.probeCount {
        lines.append("Probe \(p + 1):   over \(alarm(s.probes[p].high)), under \(alarm(s.probes[p].low))")
    }
    return lines.joined(separator: "\n")
}

func parseSettings(_ args: [String], current: Settings) throws -> Settings {
    struct Bad: Error, CustomStringConvertible { let description: String }
    var s = current
    if let v = option("--name", in: args) { s.name = v }
    if let v = option("--interval", in: args) {
        guard let n = Int(v), (1...65535).contains(n) else { throw Bad(description: "bad --interval") }
        s.intervalSeconds = n
    }
    if let v = option("--probes", in: args) {
        guard let n = Int(v), (1...2).contains(n) else { throw Bad(description: "--probes must be 1 or 2") }
        s.probeCount = n
    }
    if let v = option("--start", in: args) {
        if v == "software" { s.start = .software }
        else if v.hasPrefix("button") {
            let d = v.split(separator: ":").dropFirst().first.flatMap { Int($0) } ?? 0
            guard (0...255).contains(d) else { throw Bad(description: "button delay must be 0–255 s") }
            s.start = .button(delaySeconds: d)
        } else if let d = stamp.date(from: v) { s.start = .at(d) }
        else { throw Bad(description: "bad --start") }
    }
    if let v = option("--stop", in: args) {
        if v == "software" { s.stop = .software }
        else if v == "full" { s.stop = .whenFull }
        else if v.hasPrefix("after:"), let n = Int(v.dropFirst(6)), n > 0 { s.stop = .afterReadings(n) }
        else { throw Bad(description: "bad --stop") }
    }
    // Alarms: any alarm flag given resets all four to exactly what's on the command line.
    let alarmFlags = ["--p1-high", "--p1-low", "--p2-high", "--p2-low"]
    if alarmFlags.contains(where: args.contains) {
        s.probes = [.defaults, .defaults]
        for (i, flag) in alarmFlags.enumerated() {
            guard let v = option(flag, in: args) else { continue }
            guard let f = Double(v), (-100...1372).contains(f) else { throw Bad(description: "\(flag) must be −100…1372 °F") }
            let a = Settings.Alarm(enabled: true, raw: rawFor(fahrenheit: f))
            if i % 2 == 0 { s.probes[i / 2].high = a } else { s.probes[i / 2].low = a }
        }
    }
    return s
}

func option(_ name: String, in args: [String]) -> String? {
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    return args[i + 1]
}

let stamp: DateFormatter = {
    let f = DateFormatter()
    f.dateFormat = "yyyy-MM-dd HH:mm:ss"
    return f
}()
func fmt(_ d: Date?) -> String { d.map(stamp.string(from:)) ?? "—" }

/// One row per timestamp, one °F/°C column pair per probe.
func csv(_ readings: [Reading]) -> String {
    let channels = Set(readings.map(\.channel)).sorted()
    let byTime = Dictionary(grouping: readings, by: \.time)
    var s = "time" + channels.map { ",probe\($0 + 1)_f,probe\($0 + 1)_c" }.joined() + "\n"
    for t in byTime.keys.sorted() {
        s += stamp.string(from: t)
        for ch in channels {
            // 0xFFFF = no valid reading (e.g. probe unplugged); leave the cell empty.
            if let r = byTime[t]!.first(where: { $0.channel == ch }), r.raw != 0xffff {
                s += String(format: ",%.2f,%.2f", r.fahrenheit, celsius(fahrenheit: r.fahrenheit))
            } else {
                s += ",,"
            }
        }
        s += "\n"
    }
    return s
}

func output(_ readings: [Reading], to path: String?) throws {
    if let path {
        try csv(readings).write(toFile: path, atomically: true, encoding: .utf8)
        FileHandle.standardError.write("Wrote \(readings.count) readings to \(path)\n".data(using: .utf8)!)
    } else {
        print(csv(readings), terminator: "")
    }
}

/// Raw dumps are the report-3 chunks concatenated, each padded to 1024 bytes.
func readRawDump(_ path: String) throws -> [[UInt8]] {
    let d = [UInt8](try Data(contentsOf: URL(fileURLWithPath: path)))
    return stride(from: 0, to: d.count, by: 1024).map { Array(d[$0..<min($0 + 1024, d.count)]) }
}

let args = Array(CommandLine.arguments.dropFirst())
do {
    switch args.first {
    case "status" where args.contains("--hex"):
        let logger = try Logger()
        let count = Int(option("--hex", in: args) ?? "") ?? 1
        for i in 0..<count {
            if i > 0 { Thread.sleep(forTimeInterval: 2) }
            print(try logger.readStatusRaw().map { String(format: "%02x", $0) }.joined())
        }
    case "status":
        let s = try Logger().readStatus()
        print("""
        Name:            \(s.name)
        State:           \(s.state)
        Serial:          \(s.serial)
        Logger clock:    \(fmt(s.clock))
        Interval:        \(s.intervalSeconds) s
        Programmed start:\(fmt(s.programmedStart))
        Programmed stop: \(fmt(s.programmedStop))
        Actual start:    \(fmt(s.actualStart))
        Probes:          \(s.channelCount)
        Readings:        \(s.readingCount) per probe
        """)
        for (i, raw) in s.latestRaw.enumerated() {
            print("Latest probe \(i + 1): \(raw.map { String(format: "%.2f °F", fahrenheit(raw: $0)) } ?? "—")")
        }
        if let clock = s.clock {
            let drift = clock.timeIntervalSinceNow
            if abs(drift) > 60 {
                print(String(format: "Note: logger clock is %.0f min %@ this Mac", abs(drift) / 60, drift > 0 ? "ahead of" : "behind"))
            }
        }
    case "download":
        let chunks = try Logger().downloadRaw()
        if let raw = option("--raw", in: args) {
            let padded = chunks.flatMap { $0 + [UInt8](repeating: 0, count: max(0, 1024 - $0.count)) }
            try Data(padded).write(to: URL(fileURLWithPath: raw))
        }
        FileHandle.standardError.write("Received \(chunks.count) chunk(s)\n".data(using: .utf8)!)
        try output(parseReadings(chunks), to: option("-o", in: args))
    case "setup":
        let logger = try Logger()
        let status = try logger.readStatus()
        var current = Settings(block: try logger.readStatusRaw())
        current.start = .software
        let wanted = try parseSettings(args, current: current)
        print("Current settings (start mode not readable):\n\(describe(current))\n\nNew settings:\n\(describe(wanted))")
        print("Clock will be set to this Mac's time: \(fmt(Date()))")
        guard args.contains("--yes") else {
            print("\nThis ERASES the \(status.readingCount) reading(s) on the logger. Download first, then re-run with --yes.")
            exit(0)
        }
        let result = try logger.applySettings(wanted)
        print("\nLogger now reports:\n\(describe(result))")
        // Status reports the logger's run state in the mode byte, not the start mode, so skip that.
        var check = result
        check.start = wanted.start
        if check != wanted { print("⚠️  Read-back differs from what was requested.") }
        print("State:     \(try logger.readStatus().state)")
    case "start":
        try Logger().startNow(); print("Start command sent.")
    case "stop":
        try Logger().stopNow(); print("Stop command sent.")
    case "parse-raw" where args.count >= 2:
        try output(parseReadings(try readRawDump(args[1])), to: option("-o", in: args))
    default:
        FileHandle.standardError.write((usage + "\n").data(using: .utf8)!)
        exit(2)
    }
} catch {
    FileHandle.standardError.write("error: \(error)\n".data(using: .utf8)!)
    exit(1)
}
