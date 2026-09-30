import Foundation
import XCTest
@testable import LoggerKit

final class SettingsTests: XCTestCase {
    struct Fixture: Decodable { let source: String; let statusAfterErase: String; let studioWrite: String }

    func bytes(_ hex: String) -> [UInt8] {
        stride(from: 0, to: hex.count, by: 2).map {
            let s = hex.index(hex.startIndex, offsetBy: $0)
            return UInt8(hex[s..<hex.index(s, offsetBy: 2)], radix: 16)!
        }
    }

    func fixtures() throws -> [Fixture] {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("studio_writes.json")
        return try JSONDecoder().decode([Fixture].self, from: Data(contentsOf: url))
    }

    /// Rebuilding every captured Studio save from its decoded settings must give identical bytes.
    func testReproducesStudioWrites() throws {
        let fx = try fixtures()
        XCTAssertEqual(fx.count, 12)
        for f in fx {
            let base = bytes(f.statusAfterErase), studio = bytes(f.studioWrite)
            let settings = Settings(block: studio)
            var ours = settings.encode(base: base, clock: bcdDate(studio[Settings.clock..<Settings.clock + 6])!)
            // The vendor software fills unused date fields and its delay box with its own values; skip those.
            var startIsAt = false, stopIsAt = false, isButton = false
            if case .at = settings.start { startIsAt = true }
            if case .button = settings.start { isButton = true }
            if case .at = settings.stop { stopIsAt = true }
            if !startIsAt && !stopIsAt { for o in Settings.startDate..<Settings.startDate + 6 { ours[o] = studio[o] } }
            if !stopIsAt { for o in Settings.stopDate..<Settings.stopDate + 6 { ours[o] = studio[o] } }
            if !isButton { for o in Settings.buttonDelay..<Settings.buttonDelay + 2 { ours[o] = studio[o] } }
            let diff = (0..<studio.count).filter { ours[$0] != studio[$0] }.map { String(format: "%02x:%02x≠%02x", $0, ours[$0], studio[$0]) }
            XCTAssertEqual(diff, [], f.source)
        }
    }

    /// The values the user entered in Studio decode to what they asked for.
    func testUserEnteredValues() throws {
        let w = try fixtures().map { Settings(block: bytes($0.studioWrite)) }
        let save1 = w[1]
        XCTAssertEqual(save1.intervalSeconds, 18)
        XCTAssertEqual(save1.start, .button(delaySeconds: 90))
        XCTAssertEqual(save1.stop, .software)
        XCTAssertEqual(save1.probes[1].high, .init(enabled: true, raw: rawFor(fahrenheit: 400)))
        XCTAssertEqual(save1.probes[1].low, .init(enabled: true, raw: rawFor(fahrenheit: -10)))
        XCTAssertFalse(save1.probes[0].high.enabled)

        XCTAssertEqual(w[2].stop, .whenFull)
        XCTAssertEqual(w[3].stop, .afterReadings(100))
        guard case .at(let d) = w[4].start else { return XCTFail("expected date start") }
        XCTAssertEqual(Calendar.current.dateComponents([.hour, .minute], from: d), DateComponents(hour: 8, minute: 0))
        XCTAssertEqual(w[5].probes[0].high, .init(enabled: true, raw: rawFor(fahrenheit: 200)))
        XCTAssertEqual(w[5].probes[1].low, .init(enabled: true, raw: rawFor(fahrenheit: 0)))
        XCTAssertEqual(w[6].intervalSeconds, 600)
        XCTAssertEqual(w[7].name, "test")

        // tds_save3: stop at 9/30/26 1:49 PM, then probe 2 off, then probe 1 under alarm at 22 °F.
        XCTAssertEqual(w[8].start, .manual)
        XCTAssertEqual(w[8].stop, .at(Calendar.current.date(from: DateComponents(year: 2026, month: 9, day: 30, hour: 13, minute: 49))!))
        XCTAssertEqual(w[9].probeCount, 1)
        XCTAssertEqual(w[10].probes[0].low, .init(enabled: true, raw: rawFor(fahrenheit: 22)))
        // tds_save4: button start after 1 h 2 min 3 s — the delay is a 16-bit count of seconds.
        XCTAssertEqual(w[11].start, .button(delaySeconds: 3723))
    }
}
