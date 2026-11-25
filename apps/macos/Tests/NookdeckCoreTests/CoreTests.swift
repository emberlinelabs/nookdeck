import XCTest
@testable import NookdeckCore

final class ConfigTests: XCTestCase {
    let home = URL(fileURLWithPath: "/Users/me")

    func testDefaultsUseTheRealPlace() {
        let c = AppConfig.from(env: [:], userHome: home)
        XCTAssertEqual(c.home.path, "/Users/me/.nookdeck")
        XCTAssertEqual(c.port, 7420)
        XCTAssertEqual(c.label, "dev.nookdeck.agent")
        XCTAssertNil(c.launchAgentsDir)
        XCTAssertFalse(c.sandbox)
        XCTAssertEqual(c.plistURL(userHome: home).path, "/Users/me/Library/LaunchAgents/dev.nookdeck.agent.plist")
        XCTAssertEqual(c.installedBinary.path, "/Users/me/.nookdeck/bin/nookdeck")
        XCTAssertTrue(c.childEnvironment.isEmpty)
    }

    func testAnyOverrideMakesASandboxThatNeverSharesTheRealLabelOrFolder() {
        for env in [["NOOKDECK_PORT": "7633"], ["NOOKDECK_HOME": "/tmp/sb"], ["NOOKDECK_SERVICE_LABEL": "dev.nookdeck.t1"]] {
            let c = AppConfig.from(env: env, userHome: home)
            XCTAssertTrue(c.sandbox)
            XCTAssertNotEqual(c.label, "dev.nookdeck.agent")
            XCTAssertNotNil(c.launchAgentsDir)
            XCTAssertNotEqual(c.plistURL(userHome: home).path, "/Users/me/Library/LaunchAgents/dev.nookdeck.agent.plist")
        }
        let c = AppConfig.from(env: ["NOOKDECK_HOME": "/tmp/sb", "NOOKDECK_PORT": "7633"], userHome: home)
        XCTAssertEqual(c.launchAgentsDir?.path, "/tmp/sb/LaunchAgents")
        XCTAssertEqual(c.childEnvironment["NOOKDECK_PORT"], "7633")
        XCTAssertEqual(c.childEnvironment["NOOKDECK_HOME"], "/tmp/sb")
        XCTAssertEqual(c.childEnvironment["NOOKDECK_SERVICE_LABEL"], "dev.nookdeck.sandbox")
        XCTAssertEqual(c.apiBase.absoluteString, "http://127.0.0.1:7633")
    }

    func testJunkOverridesAreIgnored() {
        let c = AppConfig.from(env: ["NOOKDECK_PORT": "99999", "NOOKDECK_SERVICE_LABEL": "../x y"], userHome: home)
        XCTAssertEqual(c.port, 7420)
        XCTAssertFalse(c.sandbox)
        XCTAssertEqual(c.label, "dev.nookdeck.agent")
    }
}

final class VersionTests: XCTestCase {
    func testCompare() {
        XCTAssertLessThan(Version.compare("0.2.9", "0.3.0"), 0)
        XCTAssertEqual(Version.compare("v0.3.0", "0.3.0"), 0)
        XCTAssertGreaterThan(Version.compare("0.10.0", "0.9.0"), 0)
        XCTAssertLessThan(Version.compare("0.4.0-beta.1", "0.4.0"), 0)
    }
    func testParse() {
        XCTAssertEqual(Version.parse("nookdeck 0.3.0\n"), "0.3.0")
        XCTAssertEqual(Version.parse("0.4.0-beta.2"), "0.4.0-beta.2")
        XCTAssertNil(Version.parse("no version here"))
    }
}

final class PlanTests: XCTestCase {
    let bin = "/Users/me/.nookdeck/bin/nookdeck"
    func facts(_ installed: String?, bundled: String = "0.4.0", plist: Bool = true, program: String? = "/Users/me/.nookdeck/bin/nookdeck") -> InstallFacts {
        InstallFacts(installedVersion: installed, bundledVersion: bundled, plistExists: plist, plistProgram: program, installedPath: bin)
    }
    func testFreshMacInstalls() { XCTAssertEqual(planInstall(facts(nil, plist: false, program: nil)), .install) }
    func testCliInstallIsAdoptedNotDuplicated() { XCTAssertEqual(planInstall(facts("0.4.0")), .adopt) }
    func testNewerInstalledIsAdopted() { XCTAssertEqual(planInstall(facts("0.5.0")), .adopt) }
    func testOlderInstalledIsUpdated() { XCTAssertEqual(planInstall(facts("0.3.0")), .update(from: "0.3.0")) }
    func testProgramWithoutServiceRegistersTheServiceOnly() { XCTAssertEqual(planInstall(facts("0.4.0", plist: false, program: nil)), .registerService) }
    func testAServiceRunningAnotherProgramIsLeftAlone() { XCTAssertEqual(planInstall(facts("0.3.0", program: "/opt/homebrew/bin/nookdeck")), .adopt) }
}

final class StatusTests: XCTestCase {
    func report(_ statuses: [String]) -> DoctorReport { DoctorReport(version: "0.4.0", asService: true, items: statuses.enumerated().map { DoctorItem(id: "i\($0.offset)", title: "t", status: $0.element, detail: nil) }) }
    func testStates() {
        XCTAssertEqual(computeStatus(reachable: true, serviceInstalled: true, busy: false, doctor: report(["ok", "n/a"])), .running)
        XCTAssertEqual(computeStatus(reachable: true, serviceInstalled: true, busy: false, doctor: report(["ok", "denied"])), .needsPermission)
        XCTAssertEqual(computeStatus(reachable: true, serviceInstalled: true, busy: false, doctor: report(["unknown"])), .running)
        XCTAssertEqual(computeStatus(reachable: false, serviceInstalled: true, busy: false, doctor: nil), .stopped)
        XCTAssertEqual(computeStatus(reachable: false, serviceInstalled: false, busy: false, doctor: nil), .notInstalled)
        XCTAssertEqual(computeStatus(reachable: false, serviceInstalled: false, busy: true, doctor: nil), .installing)
    }
}

struct FakeTransport: Transport {
    var reply: (URLRequest) -> (Data, Int)
    func send(_ request: URLRequest) async throws -> (Data, Int) { reply(request) }
}

final class APITests: XCTestCase {
    func testRequestsGoToLocalhostWithTheHeader() async throws {
        var seen: [URLRequest] = []
        let api = AgentAPI(base: URL(string: "http://127.0.0.1:7633")!, transport: FakeTransport { r in
            seen.append(r)
            if r.url!.path == "/api/pairing" { return (Data(#"{"addresses":[{"id":"a","host":"192.168.1.5","label":"Wi-Fi","url":"http://192.168.1.5:7633/?pin=123456"}],"defaultAddress":"a","pin":"123456","url":"http://192.168.1.5:7633/?pin=123456","port":7633}"#.utf8), 200) }
            if r.url!.path == "/api/devices" { return (Data(#"[{"id":"d1","name":"iPhone","online":true},{"id":"d2","online":false}]"#.utf8), 200) }
            return (Data("{}".utf8), 404)
        })
        let p = try await api.pairing(all: true)
        XCTAssertEqual(p.pin, "123456")
        XCTAssertEqual(p.addresses.first?.host, "192.168.1.5")
        let d = try await api.devices()
        XCTAssertEqual(d.filter { $0.online == true }.count, 1)
        for r in seen {
            XCTAssertEqual(r.value(forHTTPHeaderField: "x-nookdeck"), "1")
            XCTAssertEqual(r.url?.host, "127.0.0.1")
        }
        XCTAssertEqual(seen[0].url?.query, "all=1")
        do { _ = try await api.doctor(); XCTFail("expected an error") } catch { XCTAssertEqual(error as? APIError, .status(404)) }
    }

    func testRegenerateIsAPost() async throws {
        var method = ""
        let api = AgentAPI(base: URL(string: "http://127.0.0.1:7420")!, transport: FakeTransport { r in
            method = r.httpMethod ?? ""
            return (Data(#"{"addresses":[],"pin":"654321","url":"http://x/"}"#.utf8), 200)
        })
        let p = try await api.regeneratePin()
        XCTAssertEqual(method, "POST")
        XCTAssertEqual(p.pin, "654321")
    }

    func testBadBodyAndUnreachable() async {
        let bad = AgentAPI(base: URL(string: "http://127.0.0.1:1")!, transport: FakeTransport { _ in (Data("nope".utf8), 200) })
        do { _ = try await bad.devices(); XCTFail() } catch { XCTAssertEqual(error as? APIError, .badBody) }
    }
}

final class StringsTests: XCTestCase {
    /// the file pd-worker-1 ships, found relative to this test file: apps/macos/Tests/NookdeckCoreTests -> apps/shared
    static func shared() throws -> Strings {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("shared/strings.json")
        return Strings(json: try Data(contentsOf: url))
    }
    func testPick() {
        XCTAssertEqual(Strings.pick(["vi-VN", "en"]), .vi)
        XCTAssertEqual(Strings.pick(["zh-Hans-CN"]), .zh)
        XCTAssertEqual(Strings.pick(["fr-FR", "en-US"]), .en)
        XCTAssertEqual(Strings.pick(["fr-FR"]), .en)
    }
    func testEveryKeyExistsInEveryLanguage() throws {
        let s = try Self.shared()
        XCTAssertGreaterThan(s.keys.count, 60)
        for k in s.keys { for l in [Strings.Lang.vi, .zh] { XCTAssertTrue(s.has(k, l), "\(k) missing in \(l)") } }
    }
    func testKeysTheAppUsesExist() throws {
        let s = try Self.shared()
        let used = ["status.running", "status.stopped", "status.settingUp", "status.needsPermission", "status.unreachable", "status.starting", "status.stopping", "status.restarting",
                    "menu.pair", "menu.openManage", "menu.start", "menu.stop", "menu.restart", "menu.checkUpdates", "menu.checking", "menu.updateNow", "menu.updateAvailable", "menu.upToDate",
                    "menu.openAtLogin", "menu.help", "menu.help.permissions", "menu.help.logs", "menu.help.website", "menu.help.docs", "menu.star", "menu.kofi", "menu.version", "menu.quit", "menu.quit.hint",
                    "pair.title", "pair.scan", "pair.scan.wifi", "pair.scan.tailscale", "pair.qrLabel", "pair.pin", "pair.newPin", "pair.via", "pair.copyLink", "pair.copied", "pair.loading", "pair.done", "pair.error", "pair.notRunning",
                    "error.startFailed", "error.stopFailed", "error.restartFailed", "error.setupFailed", "error.updateCheckFailed", "error.updateFailed", "error.loginItemFailed", "common.retry", "common.close"]
        for k in used { for l in Strings.Lang.allCases { XCTAssertTrue(s.has(k, l), "\(k) missing in \(l)") } }
    }
    func testPlaceholdersPluralsAndFallback() throws {
        let s = try Self.shared()
        XCTAssertEqual(s.phones(0, .en), "No phones connected")
        XCTAssertEqual(s.phones(1, .en), "1 phone connected")
        XCTAssertEqual(s.phones(3, .en), "3 phones connected")
        XCTAssertTrue(s.phones(3, .vi).contains("3"))
        XCTAssertEqual(s.text("menu.version", .en, ["version": "0.4.0"]), "Version 0.4.0")
        XCTAssertEqual(s.text("no.such.key", .vi), "no.such.key")
        let o = Strings(json: Data(#"{"en":{"a":"x"},"vi":{"b":"y"},"xx":{"a":"b"},"zh":{"a":5}}"#.utf8))
        XCTAssertEqual(o.text("a", .vi), "x") // falls back to English
        XCTAssertEqual(o.text("a", .zh), "x") // a non-string value is ignored
        XCTAssertEqual(o.text("b", .vi), "y")
    }
    func testNoEmDashesAndNoLeftoverPlaceholders() throws {
        let s = try Self.shared()
        for k in s.keys { for l in Strings.Lang.allCases { XCTAssertFalse(s.text(k, l).contains("\u{2014}"), "\(k) \(l) has an em dash") } }
    }
}

final class QRTests: XCTestCase {
    func testMakesASquareBitmap() {
        let img = qrImage("http://192.168.1.5:7420/?pin=123456", scale: 4)
        XCTAssertNotNil(img)
        XCTAssertEqual(img?.width, img?.height)
        XCTAssertGreaterThan(img?.width ?? 0, 60)
        XCTAssertNil(qrImage(""))
    }
}
