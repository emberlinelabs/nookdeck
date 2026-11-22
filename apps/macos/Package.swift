// swift-tools-version:5.9
import PackageDescription

// The Nookdeck menu bar app (spec: Knowns doc specs/desktop-apps, A1-A7).
// NookdeckCore: everything that can be tested without a window (config, API client, install plan, status, strings, QR).
// Nookdeck: the SwiftUI shell around it.
let package = Package(
    name: "Nookdeck",
    defaultLocalization: "en",
    platforms: [.macOS(.v13)],
    products: [.executable(name: "Nookdeck", targets: ["Nookdeck"])],
    targets: [
        .target(name: "NookdeckCore"),
        .executableTarget(name: "Nookdeck", dependencies: ["NookdeckCore"]),
        .testTarget(name: "NookdeckCoreTests", dependencies: ["NookdeckCore"]),
    ]
)
