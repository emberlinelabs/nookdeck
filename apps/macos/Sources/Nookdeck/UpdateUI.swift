import AppKit
import SwiftUI
import NookdeckCore

// One small window for an app update: the prompt with what's new, then the progress of the install in the same place.

enum UpdateStage: Equatable {
    case prompt
    case downloading(received: Int64, total: Int64)
    case checking
    case installing
    case failed(String)
}

@MainActor
final class UpdateFlow: ObservableObject {
    @Published var stage: UpdateStage = .prompt
    let release: AppRelease
    let current: String
    /// false when this copy cannot replace itself: the main button opens the download page instead
    let auto: Bool
    let manualNote: String?
    let notes: [ReleaseNotes.Section]
    let moreNotes: Bool
    var onInstall: () -> Void = {}
    var onLater: () -> Void = {}
    var onSkip: () -> Void = {}
    var onCancel: () -> Void = {}
    var onClose: () -> Void = {}
    var onOpenPage: () -> Void = {}

    init(release: AppRelease, current: String, auto: Bool, manualNote: String?, notes: [ReleaseNotes.Section], moreNotes: Bool) {
        self.release = release; self.current = current; self.auto = auto; self.manualNote = manualNote
        self.notes = notes; self.moreNotes = moreNotes
    }
}

typealias Translate = (String, [String: String]) -> String

struct UpdateView: View {
    @ObservedObject var f: UpdateFlow
    let t: Translate
    static let releasePage = URL(string: "https://github.com/howznguyen/nookdeck/releases/latest")!

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            header
            content
            footer
        }
        .padding(.horizontal, 24)
        .padding(.top, 30)
        .padding(.bottom, 20)
        .frame(width: 460, alignment: .leading)
    }

    private var installing: Bool {
        switch f.stage {
        case .downloading, .checking, .installing: return true
        case .prompt, .failed: return false
        }
    }

    private var header: some View {
        HStack(alignment: .center, spacing: 14) {
            Image(nsImage: NSApp.applicationIconImage)
                .resizable()
                .interpolation(.high)
                .frame(width: 64, height: 64)
            VStack(alignment: .leading, spacing: 3) {
                Text(installing ? t("update.progress.heading", ["version": f.release.version]) : t("update.alert.title", ["version": f.release.version]))
                    .font(.title2.weight(.semibold))
                    .fixedSize(horizontal: false, vertical: true)
                Text(t("update.prompt.current", ["current": f.current]))
                    .foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder private var content: some View {
        switch f.stage {
        case .prompt:
            VStack(alignment: .leading, spacing: 12) {
                if let note = f.manualNote {
                    Text(note).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
                if !f.notes.isEmpty {
                    FadingScroll(maxHeight: 320) {
                        NotesView(sections: f.notes, more: f.moreNotes, moreText: t("update.notes.more", [:]), page: f.release.page ?? Self.releasePage)
                    }
                }
            }
        case .failed(let msg):
            VStack(alignment: .leading, spacing: 6) {
                Label(t("update.progress.failed", [:]), systemImage: "exclamationmark.triangle.fill")
                    .font(.system(size: 13, weight: .semibold))
                    .symbolRenderingMode(.multicolor)
                Text(msg).font(.system(size: 13)).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            }
        default:
            ProgressSteps(stage: f.stage, t: t)
        }
    }

    @ViewBuilder private var footer: some View {
        HStack(spacing: 10) {
            switch f.stage {
            case .prompt:
                Button(t("update.alert.skip", [:])) { f.onSkip() }.buttonStyle(.link)
                Spacer()
                Button(t("update.alert.later", [:])) { f.onLater() }.keyboardShortcut(.cancelAction)
                Button(t(f.auto ? "update.alert.install" : "update.alert.download", [:])) { f.onInstall() }.keyboardShortcut(.defaultAction)
            case .downloading:
                Spacer()
                Button(t("update.progress.cancel", [:])) { f.onCancel() }.keyboardShortcut(.cancelAction)
            case .failed:
                Spacer()
                Button(t("update.alert.download", [:])) { f.onOpenPage() }
                Button(t("update.progress.close", [:])) { f.onClose() }.keyboardShortcut(.defaultAction)
            case .checking, .installing:
                // nothing to press while the app is checked and swapped; the hidden button keeps the window from jumping
                Spacer()
                Button(t("update.progress.cancel", [:])) {}.disabled(true).opacity(0)
            }
        }
        .controlSize(.large)
    }
}

/// The release notes as plain content on the window background: version headings, section labels, list rows.
struct NotesView: View {
    let sections: [ReleaseNotes.Section]
    let more: Bool
    let moreText: String
    let page: URL

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            ForEach(Array(sections.enumerated()), id: \.offset) { _, s in
                VStack(alignment: .leading, spacing: 7) {
                    Text(s.version + (s.title.map { " · \($0)" } ?? ""))
                        .font(.system(size: 13, weight: .semibold))
                        .fixedSize(horizontal: false, vertical: true)
                    ForEach(Array(NotesMarkdown.blocks(s.markdown).enumerated()), id: \.offset) { _, b in block(b) }
                }
            }
            if more {
                Link(moreText, destination: page).font(.system(size: 13))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder private func block(_ b: NotesMarkdown.Block) -> some View {
        switch b {
        case .heading(_, let items):
            Text(Self.plain(items).uppercased())
                .font(.system(size: 11, weight: .semibold))
                .tracking(0.5)
                .foregroundStyle(.secondary)
                .padding(.top, 4)
        case .bullet(let depth, let items):
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(depth == 0 ? "•" : "◦").foregroundStyle(.secondary)
                Text(Self.attributed(items))
                    .lineSpacing(3)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .font(.system(size: 13))
            .padding(.leading, CGFloat(depth) * 16)
        case .paragraph(let items):
            Text(Self.attributed(items)).font(.system(size: 13)).lineSpacing(3).fixedSize(horizontal: false, vertical: true)
        }
    }

    static func plain(_ items: [NotesMarkdown.Inline]) -> String {
        items.map { i -> String in
            switch i {
            case .text(let s), .bold(let s), .code(let s): return s
            case .link(let s, _): return s
            }
        }.joined()
    }

    /// Bold, code and links as AttributedString runs (the parsing, and the rule that only http(s) links are links, is
    /// NotesMarkdown's, which has tests). SwiftUI draws links in the accent color and opens them in the browser.
    static func attributed(_ items: [NotesMarkdown.Inline]) -> AttributedString {
        var out = AttributedString()
        for i in items {
            switch i {
            case .text(let s): out += AttributedString(s)
            case .bold(let s):
                var a = AttributedString(s); a.inlinePresentationIntent = .stronglyEmphasized; out += a
            case .code(let s):
                var a = AttributedString(s); a.inlinePresentationIntent = .code; out += a
            case .link(let s, let u):
                var a = AttributedString(s); a.link = u; out += a
            }
        }
        return out
    }
}

private struct HeightKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}

/// Content at its own height, or a scroll view of `maxHeight` with a soft fade at the bottom when it is taller.
struct FadingScroll<Content: View>: View {
    let maxHeight: CGFloat
    @ViewBuilder let content: () -> Content
    @State private var height: CGFloat = 0

    var body: some View {
        let overflow = height > maxHeight
        ScrollView(.vertical) {
            content()
                .padding(.bottom, overflow ? 22 : 0)
                .background(GeometryReader { g in Color.clear.preference(key: HeightKey.self, value: g.size.height) })
        }
        .scrollIndicators(.automatic)
        .frame(height: max(1, min(height, maxHeight)))
        .onPreferenceChange(HeightKey.self) { height = $0 }
        .mask {
            VStack(spacing: 0) {
                Rectangle()
                LinearGradient(colors: [.black, .black.opacity(0)], startPoint: .top, endPoint: .bottom)
                    .frame(height: overflow ? 30 : 0)
            }
        }
    }
}

struct ProgressSteps: View {
    let stage: UpdateStage
    let t: Translate

    private var order: Int {
        switch stage {
        case .checking: return 1
        case .installing: return 2
        default: return 0
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 7) {
                row("update.progress.downloading", order == 0 ? 1 : 2)
                if case .downloading(let got, let total) = stage {
                    Group {
                        // a server that does not send the size: a moving bar and the MB so far
                        if total > 0 { ProgressView(value: Double(min(got, total)), total: Double(total)) } else { ProgressView() }
                    }
                    .progressViewStyle(.linear)
                    .padding(.leading, 26)
                    Text(total > 0 ? t("update.progress.bytes", ["done": Self.mb(got), "total": Self.mb(total) + " MB"]) : got > 0 ? Self.mb(got) + " MB" : " ")
                        .font(.callout).monospacedDigit().foregroundStyle(.secondary)
                        .padding(.leading, 26)
                }
            }
            VStack(alignment: .leading, spacing: 2) {
                row("update.progress.checking", order == 1 ? 1 : order > 1 ? 2 : 0)
                if order == 1 {
                    Text(t("update.progress.checkingDetail", [:])).font(.callout).foregroundStyle(.secondary).padding(.leading, 26)
                }
            }
            row("update.progress.installing", order == 2 ? 1 : 0)
        }
        .font(.system(size: 13))
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// state: 0 waiting, 1 running, 2 done
    private func row(_ key: String, _ state: Int) -> some View {
        HStack(spacing: 10) {
            ZStack {
                if state == 2 { Image(systemName: "checkmark.circle.fill").foregroundStyle(.green) }
                else if state == 1 { ProgressView().controlSize(.small).scaleEffect(0.8) }
                else { Image(systemName: "circle").foregroundStyle(.tertiary) }
            }
            .frame(width: 16, height: 16)
            Text(t(key, [:]))
                .fontWeight(state == 1 ? .semibold : .regular)
                .foregroundStyle(state == 0 ? .secondary : .primary)
        }
    }

    /// "12.4" (or "12,4"): megabytes with one decimal, in the user's number format
    static func mb(_ n: Int64) -> String {
        let f = NumberFormatter()
        f.minimumFractionDigits = 1
        f.maximumFractionDigits = 1
        f.minimumIntegerDigits = 1
        return f.string(from: NSNumber(value: Double(n) / 1_000_000)) ?? "0.0"
    }
}

/// The window: centered, normal level, no title text. The close button means Later on the prompt and Cancel while
/// downloading; while the app is checked and swapped it cannot be closed. It keeps its top edge when it changes height.
@MainActor
final class UpdateWindow: NSObject, NSWindowDelegate {
    let window: NSWindow
    let flow: UpdateFlow
    private var top: NSPoint?

    init(flow: UpdateFlow, title: String, t: @escaping Translate) {
        self.flow = flow
        let host = NSHostingController(rootView: UpdateView(f: flow, t: t))
        host.sizingOptions = [.preferredContentSize]
        window = NSWindow(contentViewController: host)
        super.init()
        window.styleMask = [.titled, .closable, .fullSizeContentView]
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.title = title
        window.isMovableByWindowBackground = true
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.setContentSize(host.view.fittingSize)
    }

    func show() {
        if top == nil { window.center() }
        top = NSPoint(x: window.frame.minX, y: window.frame.maxY)
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    func windowDidResize(_ n: Notification) {
        if let p = top, abs(window.frame.maxY - p.y) > 0.5 { window.setFrameTopLeftPoint(p) }
    }

    func windowDidMove(_ n: Notification) { top = NSPoint(x: window.frame.minX, y: window.frame.maxY) }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        switch flow.stage {
        case .prompt: flow.onLater()
        case .downloading: flow.onCancel()
        case .failed: flow.onClose()
        case .checking, .installing: NSSound.beep()
        }
        return false
    }

    func close() { window.orderOut(nil); window.close() }
}

// MARK: download with progress

/// One file download with progress, moved into `dest` as soon as it finishes (URLSession deletes its temp file after the
/// delegate call). Cancelling the Swift task cancels the download.
final class ProgressDownload: NSObject, URLSessionDownloadDelegate {
    private let dest: URL
    private let progress: (Int64, Int64) -> Void
    private var cont: CheckedContinuation<HTTPURLResponse, Error>?
    private var session: URLSession!
    private var moveError: Error?
    private let lock = NSLock()

    init(dest: URL, progress: @escaping (Int64, Int64) -> Void) {
        self.dest = dest
        self.progress = progress
        super.init()
        session = URLSession(configuration: .ephemeral, delegate: self, delegateQueue: nil)
    }

    static func run(_ url: URL, to dest: URL, progress: @escaping (Int64, Int64) -> Void) async throws -> HTTPURLResponse {
        let d = ProgressDownload(dest: dest, progress: progress)
        defer { d.session.finishTasksAndInvalidate() }
        let task = d.session.downloadTask(with: url)
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (c: CheckedContinuation<HTTPURLResponse, Error>) in
                d.lock.lock(); d.cont = c; d.lock.unlock()
                if Task.isCancelled { task.cancel() } else { task.resume() }
            }
        } onCancel: { task.cancel() }
    }

    private func finish(_ r: Result<HTTPURLResponse, Error>) {
        lock.lock(); let c = cont; cont = nil; lock.unlock()
        c?.resume(with: r)
    }

    func urlSession(_ s: URLSession, downloadTask: URLSessionDownloadTask, didWriteData _: Int64, totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        progress(totalBytesWritten, max(totalBytesExpectedToWrite, 0))
    }

    func urlSession(_ s: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        do {
            try? FileManager.default.removeItem(at: dest)
            try FileManager.default.moveItem(at: location, to: dest)
        } catch { moveError = error }
    }

    func urlSession(_ s: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let e = error ?? moveError { finish(.failure(e)); return }
        guard let r = task.response as? HTTPURLResponse else { finish(.failure(URLError(.badServerResponse))); return }
        finish(.success(r))
    }
}
