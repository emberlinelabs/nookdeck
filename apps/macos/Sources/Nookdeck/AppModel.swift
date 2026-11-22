import AppKit
import ServiceManagement
import SwiftUI
import NookdeckCore

@MainActor
final class AppModel: ObservableObject {
    let config: AppConfig
    let service: AgentService
    let api: AgentAPI
    let strings: Strings
    let lang: Strings.Lang

    @Published var status: AgentStatus = .unknown
    @Published var phones = 0
    @Published var pairing: Pairing?
    @Published var pairingFailed = false
    @Published var doctor: DoctorReport?
    @Published var update: UpdateInfo?
    @Published var appUpdate: String?
    @Published var updateNote: String?
    @Published var checkingUpdates = false
    @Published var busy: String?          // a status key while an action runs
    @Published var error: String?
    @Published var loginEnabled = false
    @Published var agentVersion: String?

    private var busyInstall = false
    private var tick = 0
    private var polling: Task<Void, Never>?

    var appVersion: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.0.0" }

    init() {
        let env = ProcessInfo.processInfo.environment
        config = AppConfig.from(env: env, userHome: FileManager.default.homeDirectoryForCurrentUser)
        service = AgentService(config: config)
        api = AgentAPI(base: config.apiBase)
        lang = Strings.pick(Locale.preferredLanguages)
        strings = Strings(json: Self.loadStrings())
        loginEnabled = SMAppService.mainApp.status == .enabled
        start()
    }

    /// Resources/strings.json inside the app; a dev run (swift run) falls back to apps/shared/strings.json next to the sources.
    static func loadStrings() -> Data {
        if let u = Bundle.main.url(forResource: "strings", withExtension: "json"), let d = try? Data(contentsOf: u) { return d }
        var dir = URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent()
        for _ in 0..<8 {
            let c = dir.appendingPathComponent("apps/shared/strings.json")
            if let d = try? Data(contentsOf: c) { return d }
            dir.deleteLastPathComponent()
        }
        return Data()
    }

    func t(_ key: String, _ values: [String: String] = [:]) -> String { strings.text(key, lang, values) }

    // MARK: lifecycle

    private func start() {
        polling = Task { [weak self] in
            await self?.setUp()
            while !Task.isCancelled {
                await self?.poll()
                try? await Task.sleep(nanoseconds: 10_000_000_000) // the status dot: every 10 s, nothing else runs between
            }
        }
    }

    func setUp() async {
        busyInstall = true
        status = .installing
        defer { busyInstall = false }
        do {
            let action = try await service.ensureInstalled()
            error = nil
            if action != .adopt { await waitReachable(seconds: 20) } // a fresh service needs a moment before it answers
        } catch { self.error = t("error.setupFailed", ["error": error.localizedDescription]) }
        busyInstall = false
        await poll(force: true)
    }

    // MARK: polling (cheap check each time, the heavier ones less often)

    func poll(force: Bool = false) async {
        if busyInstall { return }
        tick += 1
        do {
            let devices = try await api.devices()
            phones = devices.filter { $0.online == true }.count
            if force || doctor == nil || tick % 6 == 0 { doctor = try? await api.doctor() }
            if force || update == nil || tick % 60 == 0 { await refreshUpdates(force: false) }
            if agentVersion == nil { agentVersion = update?.current ?? doctor?.version }
            status = computeStatus(reachable: true, serviceInstalled: true, busy: busy != nil && status == .installing, doctor: doctor)
        } catch {
            phones = 0
            status = computeStatus(reachable: false, serviceInstalled: service.serviceInstalled, busy: false, doctor: nil)
        }
    }

    // MARK: actions

    /// Waits until the agent answers (up to `seconds`), so a start does not flash "stopped" while it is still coming up.
    func waitReachable(seconds: Int) async {
        for _ in 0..<seconds {
            if (try? await api.devices()) != nil { return }
            try? await Task.sleep(nanoseconds: 1_000_000_000)
        }
    }

    private func run(_ key: String, errorKey: String, wait: Bool = true, _ work: () async throws -> Void) async {
        busy = key
        defer { busy = nil }
        do { try await work(); error = nil; if wait { await waitReachable(seconds: 10) } }
        catch { self.error = t(errorKey, ["error": error.localizedDescription]) }
        await poll(force: true)
    }

    func startAgent() async { await run("status.starting", errorKey: "error.startFailed") { try await service.restart() } }
    func restartAgent() async { await run("status.restarting", errorKey: "error.restartFailed") { try await service.restart() } }
    func stopAgent() async { await run("status.stopping", errorKey: "error.stopFailed", wait: false) { try await service.stop() } }

    func openManage() { NSWorkspace.shared.open(config.manageURL) }
    func openLogs() {
        try? FileManager.default.createDirectory(at: config.logsDir, withIntermediateDirectories: true)
        NSWorkspace.shared.open(config.logsDir)
    }
    func openWebsite() { NSWorkspace.shared.open(URL(string: "https://nookdeck.app")!) }
    func openDocs() { NSWorkspace.shared.open(URL(string: "https://nookdeck.app/docs")!) }

    func loadPairing(regenerate: Bool = false) async {
        do {
            pairing = regenerate ? try await api.regeneratePin() : try await api.pairing(all: false)
            pairingFailed = false
        } catch { pairing = nil; pairingFailed = true }
    }

    func setLogin(_ on: Bool) {
        if config.sandbox { loginEnabled = on; return } // a dev sandbox never registers a login item
        do {
            if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
            error = nil
        } catch { self.error = t("error.loginItemFailed", ["error": error.localizedDescription]) }
        loginEnabled = SMAppService.mainApp.status == .enabled
    }

    // MARK: updates

    func refreshUpdates(force: Bool) async {
        checkingUpdates = force
        defer { checkingUpdates = false }
        do { update = try await api.update(refresh: force); updateNote = nil }
        catch { if force { updateNote = t("error.updateCheckFailed") } }
        appUpdate = await newerAppRelease()
        if force && updateNote == nil && update?.available != true && appUpdate == nil { updateNote = t("menu.upToDate", ["version": appVersion]) }
        if force, updateNote != nil { // the answer replaces the menu item for a few seconds, then it is the button again
            Task { try? await Task.sleep(nanoseconds: 6_000_000_000); updateNote = nil }
        }
    }

    /// The newest GitHub release when it is newer than this app (the dmg is downloaded by hand: no Sparkle without a Developer ID).
    func newerAppRelease() async -> String? {
        let urlString = ProcessInfo.processInfo.environment["NOOKDECK_APP_RELEASES_URL"] ?? "https://api.github.com/repos/howznguyen/nookdeck/releases/latest"
        guard let url = URL(string: urlString) else { return nil }
        var r = URLRequest(url: url)
        r.setValue("application/vnd.github+json", forHTTPHeaderField: "accept")
        r.timeoutInterval = 8
        guard let (d, resp) = try? await URLSession.shared.data(for: r), (resp as? HTTPURLResponse)?.statusCode == 200,
              let tag = (try? JSONSerialization.jsonObject(with: d) as? [String: Any])?["tag_name"] as? String else { return nil }
        return Version.compare(tag, appVersion) > 0 ? Version.bare(tag) : nil
    }

    func openReleasePage() { NSWorkspace.shared.open(URL(string: "https://github.com/howznguyen/nookdeck/releases/latest")!) }

    func updateNow() async { await run("status.restarting", errorKey: "error.updateFailed") { try await service.updateAgent() } }
}
