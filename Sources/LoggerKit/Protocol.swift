import Foundation

/// Decoding for the logger's reports. See PROTOCOL.md for the byte layout.

public func bcd(_ b: UInt8) -> Int { Int(b >> 4) * 10 + Int(b & 0x0f) }

/// 6-byte BCD `MM DD YY hh mm ss`; all 0xff means "not set".
public func bcdDate(_ b: ArraySlice<UInt8>) -> Date? {
    let v = Array(b)
    guard v.count == 6, !v.allSatisfy({ $0 == 0xff }) else { return nil }
    var c = DateComponents()
    c.month = bcd(v[0]); c.day = bcd(v[1]); c.year = 2000 + bcd(v[2])
    c.hour = bcd(v[3]); c.minute = bcd(v[4]); c.second = bcd(v[5])
    return Calendar.current.date(from: c)
}

public func le16(_ b: [UInt8], _ i: Int) -> Int { Int(b[i]) | Int(b[i + 1]) << 8 }

/// Raw reading → °F: 0.05 °F per count. Matches Studio's stored values exactly.
public func fahrenheit(raw: Int) -> Double { Double(raw) / 20 - 500 }
public func celsius(fahrenheit f: Double) -> Double { (f - 32) * 5 / 9 }

/// Each probe's log lives in its own 8000-reading region; chunk addresses count readings.
public let channelRegionSize = 0x1f40

public struct Status {
    public let name: String
    public let serial: String
    public let clock: Date?
    public let programmedStart: Date?
    public let programmedStop: Date?
    public let actualStart: Date?
    public let intervalSeconds: Int
    public let channelCount: Int
    public let readingCount: Int
    /// Run state from the mode byte (0x23) as the logger reports it.
    public let state: String
    /// Most recent logged reading per channel (nil when none).
    public let latestRaw: [Int?]

    public init(_ r: [UInt8]) {
        func ascii(_ range: Range<Int>) -> String {
            String(decoding: r[range].prefix { $0 != 0 }, as: UTF8.self)
        }
        name = ascii(1..<0x21)
        serial = ascii(0x58..<0x61)
        programmedStart = bcdDate(r[0x27..<0x2d])
        programmedStop = bcdDate(r[0x2d..<0x33])
        actualStart = bcdDate(r[0x33..<0x39])
        clock = bcdDate(r[0x95..<0x9b])
        intervalSeconds = le16(r, 0x44)
        channelCount = max(1, Int(r[0x66]))
        readingCount = le16(r, 0xa6)
        // 0x23 bit 0x08 = armed/active, low bits echo the start mode; it stays set after
        // logging ends. 0xb6 records the last start/stop event: 0x20 = stopped.
        if readingCount >= 8000 {
            state = "full"
        } else if r[0xb6] == 0x20 {
            state = "stopped"
        } else if r[0x23] & 0x08 == 0 {
            state = readingCount > 0 ? "stopped" : "idle"
        } else if actualStart != nil {
            state = "logging"
        } else {
            state = r[0x23] & 0x02 != 0 ? "armed, waiting for button press" : "armed"
        }
        latestRaw = (0..<channelCount).map { ch in
            let v = le16(r, 0xa0 + 2 * ch)
            return v == 0xffff ? nil : v
        }
    }
}

public struct Reading {
    public let channel: Int
    public let time: Date
    public let raw: Int
    public var fahrenheit: Double { LoggerKit.fahrenheit(raw: raw) }
}

/// Parses report-3 chunks: byte 1 = record count, bytes 2–3 = memory address
/// (which selects the channel), records of 8 bytes from byte 5.
public func parseReadings(_ chunks: [[UInt8]]) -> [Reading] {
    var out: [Reading] = []
    for c in chunks where c.count > 5 {
        let channel = le16(c, 2) / channelRegionSize
        for i in 0..<Int(c[1]) {
            let o = 5 + 8 * i
            guard o + 8 <= c.count, let t = bcdDate(c[o..<o + 6]) else { break }
            out.append(Reading(channel: channel, time: t, raw: le16(c, o + 6)))
        }
    }
    return out
}
