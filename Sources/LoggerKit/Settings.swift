import Foundation

/// Logger setup, encoded the way ThermaData Studio writes it (see PROTOCOL.md,
/// "Writing settings"). Built on top of the status block read right after the
/// erase command, so unknown bytes are passed through untouched.
public struct Settings: Equatable {
    public enum Start: Equatable {
        /// Armed now; logging begins with the "start now" command.
        case software
        case button(delaySeconds: Int)
        case at(Date)
    }
    public enum Stop: Equatable {
        case software
        case whenFull
        case afterReadings(Int)
    }
    public struct Alarm: Equatable {
        public var enabled: Bool
        /// Raw limit (same encoding as readings). Disabled alarms keep a limit too.
        public var raw: Int
        public init(enabled: Bool, raw: Int) { self.enabled = enabled; self.raw = raw }
    }
    public struct Probe: Equatable {
        public var high: Alarm
        public var low: Alarm
        public static let defaults = Probe(high: Alarm(enabled: false, raw: rawFor(fahrenheit: 1372)),
                                    low: Alarm(enabled: false, raw: rawFor(fahrenheit: -100)))
    }

    public var name: String
    public var intervalSeconds: Int
    public var probeCount: Int
    public var start: Start
    public var stop: Stop
    public var probes: [Probe]

    // Offsets into the report-2 block (index 0 = report ID).
    public static let nameRange = 0x01..<0x21
    public static let flags = 0x21, mode = 0x23, startDate = 0x27, stopDate = 0x2d, buttonDelay = 0x39
    public static let interval = 0x44, probeCountOffset = 0x66, stopAfter = 0x6f, clock = 0x95
    public static let calibration = 0x73..<0x95
    public static let limitBase = [0x46, 0x4f]
    /// Alarm-enable bits in `flags`: [probe][high, low]. Probe 1 low (0x40) is inferred, not yet observed.
    public static let alarmBits: [[UInt8]] = [[0x10, 0x40], [0x20, 0x80]]
    public static let writeLength = 192

    /// Encodes the report-2 write. `base` is the status block read after erasing.
    public func encode(base: [UInt8], clock now: Date) -> [UInt8] {
        var b = Array(base.prefix(Settings.writeLength))
        precondition(b.count == Settings.writeLength, "status block too short")

        let nameBytes = Array(name.utf8.prefix(Settings.nameRange.count))
        for (i, o) in Settings.nameRange.enumerated() { b[o] = i < nameBytes.count ? nameBytes[i] : 0 }

        var flags = b[Settings.flags] & 0x0f
        for (p, probe) in probes.prefix(2).enumerated() {
            if probe.high.enabled { flags |= Settings.alarmBits[p][0] }
            if probe.low.enabled { flags |= Settings.alarmBits[p][1] }
        }
        b[Settings.flags] = flags
        b[0x22] = 0x28
        b[0x26] = 0x14

        let startNibble: UInt8
        var startDate = now, delay = Int(b[Settings.buttonDelay]) == 0 ? 59 : Int(b[Settings.buttonDelay])
        switch start {
        case .software: startNibble = 0x1
        case .button(let d): startNibble = 0x2; delay = d
        case .at(let d): startNibble = 0x4; startDate = d
        }
        let stopNibble: UInt8
        var stopAfter = 1
        switch stop {
        case .software: stopNibble = 0x0
        case .whenFull: stopNibble = 0x2
        case .afterReadings(let n): stopNibble = 0x8; stopAfter = n
        }
        b[Settings.mode] = stopNibble << 4 | startNibble
        put(bcd: startDate, into: &b, at: Settings.startDate)
        put(bcd: startDate, into: &b, at: Settings.stopDate)
        b[Settings.buttonDelay] = UInt8(clamping: delay)

        put16(intervalSeconds, into: &b, at: Settings.interval)
        for (p, probe) in probes.prefix(2).enumerated() {
            put16(probe.high.raw, into: &b, at: Settings.limitBase[p])
            put16(probe.low.raw, into: &b, at: Settings.limitBase[p] + 2)
        }
        b[Settings.probeCountOffset] = UInt8(probeCount)
        for i in 0..<4 { b[Settings.stopAfter + i] = UInt8((stopAfter >> (8 * i)) & 0xff) }
        for o in Settings.calibration { b[o] = 0 }
        put(bcd: now, into: &b, at: Settings.clock)
        return b
    }

    /// Decodes settings from a report-2 block (status or write).
    public init(block b: [UInt8]) {
        name = String(decoding: b[Settings.nameRange].prefix { $0 != 0 }, as: UTF8.self)
        intervalSeconds = le16(b, Settings.interval)
        probeCount = Int(b[Settings.probeCountOffset])
        let stopAfterValue = (0..<4).reduce(0) { $0 | Int(b[Settings.stopAfter + $1]) << (8 * $1) }
        switch b[Settings.mode] & 0x0f {
        case 0x2: start = .button(delaySeconds: Int(b[Settings.buttonDelay]))
        case 0x4: start = .at(bcdDate(b[Settings.startDate..<Settings.startDate + 6]) ?? .distantPast)
        default: start = .software
        }
        switch b[Settings.mode] >> 4 {
        case 0x2: stop = .whenFull
        case 0x8: stop = .afterReadings(stopAfterValue)
        default: stop = .software
        }
        probes = (0..<2).map { p in
            Probe(high: Alarm(enabled: b[Settings.flags] & Settings.alarmBits[p][0] != 0, raw: le16(b, Settings.limitBase[p])),
                  low: Alarm(enabled: b[Settings.flags] & Settings.alarmBits[p][1] != 0, raw: le16(b, Settings.limitBase[p] + 2)))
        }
    }

    public init(name: String, intervalSeconds: Int, probeCount: Int, start: Start, stop: Stop, probes: [Probe]) {
        self.name = name; self.intervalSeconds = intervalSeconds; self.probeCount = probeCount
        self.start = start; self.stop = stop; self.probes = probes
    }
}

public func rawFor(fahrenheit f: Double) -> Int { Int(((f + 500) * 20).rounded()) }

private func put16(_ v: Int, into b: inout [UInt8], at o: Int) {
    b[o] = UInt8(v & 0xff); b[o + 1] = UInt8((v >> 8) & 0xff)
}

private func put(bcd date: Date, into b: inout [UInt8], at o: Int) {
    let c = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute, .second], from: date)
    for (i, v) in [c.month!, c.day!, c.year! % 100, c.hour!, c.minute!, c.second!].enumerated() {
        b[o + i] = UInt8((v / 10) << 4 | (v % 10))
    }
}
