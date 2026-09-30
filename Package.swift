// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "tdlog",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "tdlog", targets: ["tdlog"]),
        .library(name: "LoggerKit", targets: ["LoggerKit"]),
    ],
    targets: [
        .target(
            name: "LoggerKit",
            linkerSettings: [.linkedFramework("IOKit")]
        ),
        .executableTarget(name: "tdlog", dependencies: ["LoggerKit"]),
        .testTarget(
            name: "LoggerKitTests",
            dependencies: ["LoggerKit"],
            resources: [.copy("studio_writes.json")]
        ),
    ]
)
