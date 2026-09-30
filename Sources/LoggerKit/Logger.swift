import Foundation
import IOKit.hid

/// Talks to a ThermaData-compatible logger over USB HID.
///
/// Only sends the requests observed from the vendor software. Note that
/// `applySettings` erases the logger's memory, as the vendor software does.
/// Use an instance from a single thread: its callbacks run on that thread's run loop.
public final class Logger {
    public static let vendorID = 0x0483
    public static let productID = 0xA07B

    public enum Failure: Error, CustomStringConvertible {
        case notFound, openFailed(IOReturn), sendFailed(IOReturn), timeout(String)
        public var description: String {
            switch self {
            case .notFound: return "Logger not found. Is it plugged in?"
            case .openFailed(let r): return String(format: "Could not open logger (IOReturn 0x%08x)", r)
            case .sendFailed(let r): return String(format: "Could not send request (IOReturn 0x%08x)", r)
            case .timeout(let what): return "Timed out waiting for \(what)"
            }
        }
    }

    private let manager: IOHIDManager
    private let device: IOHIDDevice
    private let inputBuffer = UnsafeMutablePointer<UInt8>.allocate(capacity: 1025)
    private var reports: [[UInt8]] = []

    public init() throws {
        manager = IOHIDManagerCreate(kCFAllocatorDefault, IOOptionBits(kIOHIDOptionsTypeNone))
        IOHIDManagerSetDeviceMatching(manager, [
            kIOHIDVendorIDKey: Logger.vendorID,
            kIOHIDProductIDKey: Logger.productID,
        ] as CFDictionary)
        guard let set = IOHIDManagerCopyDevices(manager) as? Set<IOHIDDevice>, let dev = set.first else {
            throw Failure.notFound
        }
        device = dev
        let r = IOHIDDeviceOpen(device, IOOptionBits(kIOHIDOptionsTypeNone))
        guard r == kIOReturnSuccess else { throw Failure.openFailed(r) }

        let context = Unmanaged.passUnretained(self).toOpaque()
        IOHIDDeviceRegisterInputReportCallback(device, inputBuffer, 1025, { ctx, _, _, _, reportID, report, length in
            let me = Unmanaged<Logger>.fromOpaque(ctx!).takeUnretainedValue()
            // The buffer contains the report ID as its first byte for numbered reports.
            var bytes = Array(UnsafeBufferPointer(start: report, count: length))
            if bytes.first != UInt8(reportID) { bytes.insert(UInt8(reportID), at: 0) }
            me.reports.append(bytes)
        }, context)
        IOHIDDeviceScheduleWithRunLoop(device, CFRunLoopGetCurrent(), CFRunLoopMode.defaultMode.rawValue)
    }

    deinit {
        IOHIDDeviceUnscheduleFromRunLoop(device, CFRunLoopGetCurrent(), CFRunLoopMode.defaultMode.rawValue)
        IOHIDDeviceClose(device, IOOptionBits(kIOHIDOptionsTypeNone))
        inputBuffer.deallocate()
    }

    /// Sends an output report; `data[0]` is the report ID.
    private func send(_ data: [UInt8]) throws {
        var data = data
        let r = IOHIDDeviceSetReport(device, kIOHIDReportTypeOutput, CFIndex(data[0]), &data, data.count)
        guard r == kIOReturnSuccess else { throw Failure.sendFailed(r) }
    }

    /// Report 1 is the request report; payload[0] selects what the logger sends back.
    private func request(_ payload: [UInt8]) throws { try send([0x01] + payload) }

    private static let eti: [UInt8] = Array("ETI".utf8)

    /// ERASES the logger's memory, writes `settings`, and returns the settings read back.
    public func applySettings(_ settings: Settings, clock: Date = Date()) throws -> Settings {
        try send([0x05] + Logger.eti)
        let base = try readStatusRaw()
        try send(settings.encode(base: base, clock: clock))
        let readBack = try readStatusRaw()
        if case .software = settings.start { try startNow() }
        return Settings(block: readBack)
    }

    /// Report 8 commands, as sent by Studio's Start/Stop buttons.
    public func startNow() throws { try send([0x08] + Logger.eti + [0x10]) }
    public func stopNow() throws { try send([0x08] + Logger.eti + [0x20]) }

    /// Pumps the run loop until `done` returns true or `timeout` seconds pass with no new report.
    private func collect(timeout: TimeInterval, until done: ([[UInt8]]) -> Bool) {
        var lastCount = reports.count
        var deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline, !done(reports) {
            CFRunLoopRunInMode(.defaultMode, 0.05, true)
            if reports.count != lastCount {
                lastCount = reports.count
                deadline = Date().addingTimeInterval(timeout)
            }
        }
    }

    public func readStatus() throws -> Status { Status(try readStatusRaw()) }

    public func readStatusRaw() throws -> [UInt8] {
        reports.removeAll()
        try request([0x02, 0x00, 0x00, 0x00, 0x00])
        collect(timeout: 2) { $0.contains { $0.first == 0x02 } }
        guard let r = reports.first(where: { $0.first == 0x02 }) else { throw Failure.timeout("status") }
        return r
    }

    /// Returns every report-3 chunk received, in order.
    public func downloadRaw() throws -> [[UInt8]] {
        let status = try readStatus()
        let expected = status.channelCount * status.readingCount
        reports.removeAll()
        try request([0xff, 0xff, 0xff, 0xff, 0xff])
        // Done once every channel's readings have arrived; otherwise stop after 2 s of silence.
        collect(timeout: 2) { reports in
            parseReadings(reports.filter { $0.first == 0x03 }).count >= expected
        }
        let chunks = reports.filter { $0.first == 0x03 }
        guard !chunks.isEmpty else { throw Failure.timeout("log data") }
        return chunks
    }
}
