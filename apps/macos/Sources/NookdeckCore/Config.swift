import Foundation

/// Where this app's agent lives. A normal run uses the usual place (`~/.nookdeck`, port 7420, LaunchAgent `dev.nookdeck.agent`).
/// A dev SANDBOX is any run with NOOKDECK_HOME, NOOKDECK_PORT or NOOKDECK_SERVICE_LABEL set: it then gets its own folder, port,
/// service label and LaunchAgents folder, and never touches the real login service.
public struct AppConfig: Equatable {
    public static let defaultLabel = "dev.nookdeck.agent"
    public static let defaultPort = 7420

    public var home: URL
    public var port: Int
    public var label: String
    /// nil = ~/Library/LaunchAgents
    public var launchAgentsDir: URL?
    public var sandbox: Bool

    public init(home: URL, port: Int, label: String, launchAgentsDir: URL?, sandbox: Bool) {
        self.home = home; self.port = port; self.label = label; self.launchAgentsDir = launchAgentsDir; self.sandbox = sandbox
    }

    public static func from(env: [String: String], userHome: URL) -> AppConfig {
        let defaultHome = userHome.appendingPathComponent(".nookdeck", isDirectory: true)
        let homeOverride = env["NOOKDECK_HOME"].flatMap { $0.isEmpty ? nil : $0 }
        let portOverride = env["NOOKDECK_PORT"].flatMap { Int($0) }.flatMap { (1...65535).contains($0) ? $0 : nil }
        let labelOverride = env["NOOKDECK_SERVICE_LABEL"].flatMap { isValidLabel($0) ? $0 : nil }
        let agentsOverride = env["NOOKDECK_LAUNCH_AGENTS_DIR"].flatMap { $0.isEmpty ? nil : $0 }
        let sandbox = homeOverride != nil || portOverride != nil || labelOverride != nil
        let home = homeOverride.map { URL(fileURLWithPath: $0, isDirectory: true) } ?? defaultHome
        // a sandbox must never share the real label or LaunchAgents folder, even when only the port was given
        let label = labelOverride ?? (sandbox ? "dev.nookdeck.sandbox" : defaultLabel)
        let agents = agentsOverride.map { URL(fileURLWithPath: $0, isDirectory: true) } ?? (sandbox ? home.appendingPathComponent("LaunchAgents", isDirectory: true) : nil)
        return AppConfig(home: home, port: portOverride ?? defaultPort, label: label, launchAgentsDir: agents, sandbox: sandbox)
    }

    public static func isValidLabel(_ s: String) -> Bool {
        s.range(of: "^[A-Za-z0-9][A-Za-z0-9._-]{2,80}$", options: .regularExpression) != nil
    }

    public var binDir: URL { home.appendingPathComponent("bin", isDirectory: true) }
    public var installedBinary: URL { binDir.appendingPathComponent("nookdeck") }
    public var logsDir: URL { home.appendingPathComponent("logs", isDirectory: true) }
    public func plistURL(userHome: URL) -> URL {
        (launchAgentsDir ?? userHome.appendingPathComponent("Library/LaunchAgents", isDirectory: true)).appendingPathComponent("\(label).plist")
    }
    public var apiBase: URL { URL(string: "http://127.0.0.1:\(port)")! }
    public var manageURL: URL { URL(string: "http://localhost:\(port)/manage/")! }

    /// What the agent's own commands need to find the same instance (merged over the app's environment).
    public var childEnvironment: [String: String] {
        var e: [String: String] = [:]
        if sandbox {
            e["NOOKDECK_HOME"] = home.path
            e["NOOKDECK_PORT"] = String(port)
            e["NOOKDECK_SERVICE_LABEL"] = label
            if let a = launchAgentsDir { e["NOOKDECK_LAUNCH_AGENTS_DIR"] = a.path }
        }
        return e
    }
}
