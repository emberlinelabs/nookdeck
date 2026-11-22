import Foundation
import NookdeckCore

enum ServiceError: LocalizedError {
    case noBundledAgent
    case failed(String)
    var errorDescription: String? {
        switch self {
        case .noBundledAgent: return "the app does not contain the Nookdeck program"
        case .failed(let s): return s
        }
    }
}

/// Installs, adopts, starts and stops the agent. The agent stays a login service (spec A1): the app only controls it.
struct AgentService {
    let config: AppConfig
    let userHome = FileManager.default.homeDirectoryForCurrentUser
    var fm: FileManager { .default }

    var plistURL: URL { config.plistURL(userHome: userHome) }
    var serviceInstalled: Bool { fm.fileExists(atPath: plistURL.path) }
    var env: [String: String] { config.childEnvironment }

    /// The program inside the app (Contents/Resources/agent/nookdeck-<arch>). NOOKDECK_APP_AGENT overrides it for a dev run.
    func bundledBinary() -> URL? {
        if let o = ProcessInfo.processInfo.environment["NOOKDECK_APP_AGENT"], fm.isExecutableFile(atPath: o) { return URL(fileURLWithPath: o) }
        #if arch(arm64)
        let name = "nookdeck-arm64"
        #else
        let name = "nookdeck-x86_64"
        #endif
        let u = Bundle.main.resourceURL?.appendingPathComponent("agent/\(name)")
        return u.flatMap { fm.isExecutableFile(atPath: $0.path) ? $0 : nil }
    }

    func version(of exe: URL) async -> String? {
        let r = await runProcess(exe, ["--version"], env: env, timeout: 20)
        return r.code == 0 ? Version.parse(r.output) : nil
    }

    /// ProgramArguments[0] of the plist, when there is one.
    func plistProgram() -> String? {
        guard let data = try? Data(contentsOf: plistURL),
              let plist = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
              let args = plist["ProgramArguments"] as? [String] else { return nil }
        return args.first
    }

    func facts() async throws -> (InstallFacts, URL) {
        guard let bundled = bundledBinary() else { throw ServiceError.noBundledAgent }
        let installed = config.installedBinary
        let have = fm.isExecutableFile(atPath: installed.path) ? await version(of: installed) : nil
        let bundledVersion = await version(of: bundled) ?? "0.0.0"
        return (InstallFacts(installedVersion: have, bundledVersion: bundledVersion, plistExists: serviceInstalled, plistProgram: plistProgram(), installedPath: installed.path), bundled)
    }

    /// Spec A2: install the bundled program on first run, update it when it is older, adopt an existing install otherwise.
    @discardableResult
    func ensureInstalled() async throws -> InstallAction {
        let (f, bundled) = try await facts()
        let action = planInstall(f)
        switch action {
        case .adopt: break
        case .install:
            try copyProgram(from: bundled)
            try await migrateOldData()
            try await registerService()
        case .registerService:
            try await registerService()
        case .update:
            try copyProgram(from: bundled)
            try await restart()
        }
        return action
    }

    /// Copies the program next to its final name and renames it over, so a running copy is never half written (same as setup.sh).
    func copyProgram(from src: URL) throws {
        try fm.createDirectory(at: config.binDir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let tmp = config.binDir.appendingPathComponent(".nookdeck.new")
        try? fm.removeItem(at: tmp)
        try fm.copyItem(at: src, to: tmp)
        try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: tmp.path)
        removexattr(tmp.path, "com.apple.quarantine", 0) // a file copied out of a downloaded app would otherwise be refused at launch
        _ = try fm.replaceItemAt(config.installedBinary, withItemAt: tmp)
    }

    /// A 0.1.x PhoneDesk folder is moved over by the program's own `migrate` (real home only: a sandbox starts clean).
    func migrateOldData() async throws {
        guard !config.sandbox, fm.fileExists(atPath: userHome.appendingPathComponent(".phonedesk").path) else { return }
        _ = await runProcess(config.installedBinary, ["migrate", "--no-service"], env: env, timeout: 120)
    }

    func registerService() async throws {
        var args = ["service", "install"]
        if config.port != AppConfig.defaultPort { args += ["--port", String(config.port)] }
        let r = await runProcess(config.installedBinary, args, env: env, timeout: 60)
        if r.code != 0 { throw ServiceError.failed(r.output.isEmpty ? "service install failed (\(r.code))" : r.output) }
    }

    /// Start and restart are the same call: it kickstarts a loaded service and loads one that was stopped.
    func restart() async throws {
        let r = await runProcess(config.installedBinary, ["service", "restart"] + (config.port != AppConfig.defaultPort ? ["--port", String(config.port)] : []), env: env, timeout: 60)
        if r.code != 0 { throw ServiceError.failed(r.output) }
    }

    /// Unloads the login service (a clean stop: it stays stopped until Start, or the next login).
    func stop() async throws {
        let target = "gui/\(getuid())/\(config.label)"
        let r = await runProcess(URL(fileURLWithPath: "/bin/launchctl"), ["bootout", target], timeout: 30)
        // 3 = "no such process": it was not loaded, which is the state we wanted
        if r.code != 0 && r.code != 3 && !r.output.contains("No such process") { throw ServiceError.failed(r.output) }
    }

    /// `nookdeck update`: downloads the newest program, swaps it in and restarts the service.
    func updateAgent() async throws {
        let r = await runProcess(config.installedBinary, ["update"] + (config.port != AppConfig.defaultPort ? ["--port", String(config.port)] : []), env: env, timeout: 300)
        if r.code != 0 { throw ServiceError.failed(r.output) }
    }
}
