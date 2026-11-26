import AppKit
import CryptoKit
import NookdeckCore

/// Installs a newer Nookdeck.app in place: download the dmg, check its SHA-256 and that it is signed by the same
/// certificate as the running app, copy it out, then hand over to a small script that swaps the bundle after we quit.
enum SelfUpdater {
    enum Failure: Error {
        case notReplaceable(String)
        case verify(String)
        case step(String)
    }

    static var bundlePath: String { Bundle.main.bundlePath }

    /// Same checks as `SelfUpdate.replaceable`, plus: we may write the app and the folder it sits in.
    static func canReplace() -> Bool {
        let fm = FileManager.default
        let parent = (bundlePath as NSString).deletingLastPathComponent
        return SelfUpdate.replaceable(bundlePath: bundlePath) && fm.isWritableFile(atPath: parent) && fm.isWritableFile(atPath: bundlePath)
    }

    /// Everything up to the swap. On success the staged app is ready and the caller quits the app.
    static func prepare(_ r: AppRelease, log: URL) async throws {
        guard canReplace() else { throw Failure.notReplaceable(bundlePath) }
        let fm = FileManager.default
        let dir = fm.temporaryDirectory.appendingPathComponent("nookdeck-update-\(UUID().uuidString)")
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        var handedOver = false
        defer { if !handedOver { try? fm.removeItem(at: dir) } }

        // 1. download, check the digest
        let (shaData, shaResp) = try await URLSession.shared.data(from: r.sha256)
        guard (shaResp as? HTTPURLResponse)?.statusCode == 200, let want = SelfUpdate.expectedDigest(String(decoding: shaData, as: UTF8.self)) else {
            throw Failure.step("Nookdeck.dmg.sha256")
        }
        let (tmp, resp) = try await URLSession.shared.download(from: r.dmg)
        let dmg = dir.appendingPathComponent("Nookdeck.dmg")
        // URLSession leaves the downloaded file to us: move it into the work dir first so every failure below removes it
        do { try fm.moveItem(at: tmp, to: dmg) } catch { try? fm.removeItem(at: tmp); throw error }
        guard (resp as? HTTPURLResponse)?.statusCode == 200 else { throw Failure.step("Nookdeck.dmg") }
        let got = SHA256.hash(data: try Data(contentsOf: dmg, options: .mappedIfSafe)).map { String(format: "%02x", $0) }.joined()
        guard got == want else { throw Failure.verify("checksum") }

        // 2. mount read-only, copy the app out, unmount
        let mnt = dir.appendingPathComponent("mnt")
        try fm.createDirectory(at: mnt, withIntermediateDirectories: true)
        let attach = await runProcess(URL(fileURLWithPath: "/usr/bin/hdiutil"), ["attach", "-nobrowse", "-readonly", "-noautoopen", "-quiet", "-mountpoint", mnt.path, dmg.path])
        guard attach.code == 0 else { throw Failure.step("hdiutil: \(attach.output)") }
        let staged = dir.appendingPathComponent("Nookdeck.app")
        let copy = await runProcess(URL(fileURLWithPath: "/usr/bin/ditto"), [mnt.appendingPathComponent("Nookdeck.app").path, staged.path])
        _ = await runProcess(URL(fileURLWithPath: "/usr/bin/hdiutil"), ["detach", "-quiet", "-force", mnt.path])
        guard copy.code == 0 else { throw Failure.step("ditto: \(copy.output)") }

        // 3. same signer as us, and the version the release says
        let codesign = URL(fileURLWithPath: "/usr/bin/codesign")
        let mine = await runProcess(codesign, ["-d", "-r-", bundlePath])
        guard let req = mine.output.split(separator: "\n").first(where: { $0.hasPrefix("designated => ") })?.dropFirst("designated => ".count),
              !req.contains("cdhash") else { throw Failure.verify("this copy of Nookdeck is not release signed") } // ad hoc: pinned to one build
        let check = await runProcess(codesign, ["--verify", "--deep", "--strict", "-R", "=\(req)", staged.path])
        guard check.code == 0 else { throw Failure.verify("signature") }
        let v = NSDictionary(contentsOf: staged.appendingPathComponent("Contents/Info.plist"))?["CFBundleShortVersionString"] as? String
        guard v == r.version else { throw Failure.verify("version \(v ?? "?")") }

        // 4. the swap runs after we quit (nohup: it must outlive this process)
        try? fm.createDirectory(at: log.deletingLastPathComponent(), withIntermediateDirectories: true)
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/nohup")
        p.arguments = ["/bin/sh", "-c", SelfUpdate.swapScript, "sh", String(ProcessInfo.processInfo.processIdentifier), bundlePath, staged.path, dir.path, log.path]
        // ditto and open by their system paths, whatever PATH the app was started with (a terminal launch inherits the shell's)
        p.environment = ProcessInfo.processInfo.environment.merging(["PATH": "/usr/bin:/bin:/usr/sbin:/sbin"]) { _, new in new }
        p.standardInput = FileHandle.nullDevice
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        do { try p.run() } catch { throw Failure.step("\(error.localizedDescription)") }
        handedOver = true
    }
}
