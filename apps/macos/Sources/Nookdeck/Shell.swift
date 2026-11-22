import Foundation

/// Runs a program and returns its exit code and combined output. Never blocks the main thread.
func runProcess(_ exe: URL, _ args: [String], env: [String: String] = [:], timeout: TimeInterval = 120) async -> (code: Int32, output: String) {
    await withCheckedContinuation { cont in
        DispatchQueue.global(qos: .utility).async {
            let p = Process()
            p.executableURL = exe
            p.arguments = args
            p.environment = ProcessInfo.processInfo.environment.merging(env) { _, new in new }
            let pipe = Pipe()
            p.standardOutput = pipe
            p.standardError = pipe
            p.standardInput = FileHandle.nullDevice
            do { try p.run() } catch { cont.resume(returning: (127, "\(error.localizedDescription)")); return }
            let killer = DispatchWorkItem { if p.isRunning { p.terminate() } }
            DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: killer)
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            p.waitUntilExit()
            killer.cancel()
            cont.resume(returning: (p.terminationStatus, String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)))
        }
    }
}
