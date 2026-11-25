import AppKit
import SwiftUI
import NookdeckCore

struct MenuContent: View {
    @ObservedObject var model: AppModel
    @Environment(\.openWindow) private var openWindow

    var statusText: String {
        if let b = model.busy { return model.t(b) }
        switch model.status {
        case .running: return model.t("status.running")
        case .stopped, .notInstalled: return model.t("status.stopped")
        case .needsPermission: return model.t("status.needsPermission")
        case .installing: return model.t("status.settingUp")
        case .unknown: return model.t("status.unreachable")
        }
    }

    var running: Bool { model.status == .running || model.status == .needsPermission }

    var body: some View {
        // status line: a coloured dot and the state; disabled, it is information
        Button { } label: { Label { Text(statusText) } icon: { Image(nsImage: MenuIcons.dot(for: model.status)) } }.disabled(true)
        if let e = model.error { Button(e) { model.error = nil } }
        if model.status == .needsPermission, let p = model.doctor?.problems.first {
            Button(p.title) { model.openManage() }
        }
        if running { Text(model.strings.phones(model.phones, model.lang)).disabled(true) }
        Divider()
        Button(model.t("menu.pair")) {
            NSApp.activate(ignoringOtherApps: true)
            openWindow(id: "pair")
        }.disabled(!running)
        Button(model.t("menu.openManage")) { model.openManage() }.disabled(!running)
        Divider()
        if running {
            Button(model.t("menu.restart")) { Task { await model.restartAgent() } }.disabled(model.busy != nil)
            Button(model.t("menu.stop")) { Task { await model.stopAgent() } }.disabled(model.busy != nil)
        } else {
            Button(model.t("menu.start")) { Task { await model.startAgent() } }.disabled(model.busy != nil || model.status == .installing)
        }
        Divider()
        updateItems
        Toggle(model.t("menu.openAtLogin"), isOn: Binding(get: { model.loginEnabled }, set: { model.setLogin($0) }))
        Menu(model.t("menu.help")) {
            Button(model.t("menu.help.permissions")) { model.openManage() }.disabled(!running)
            Button(model.t("menu.help.logs")) { model.openLogs() }
            Button(model.t("menu.help.docs")) { model.openDocs() }
            Button(model.t("menu.help.website")) { model.openWebsite() }
        }
        Divider()
        Button(model.t("menu.star")) { model.openGitHub() }
        Button(model.t("menu.kofi")) { model.openKofi() }
        Divider()
        Text(model.t("menu.version", ["version": model.appVersion])).disabled(true)
        Button(model.t("menu.quit")) { NSApp.terminate(nil) }
            .keyboardShortcut("q")
            .help(model.t("menu.quit.hint"))
    }

    @ViewBuilder var updateItems: some View {
        if let v = model.appUpdate {
            Button(model.t("menu.updateAvailable", ["version": v])) { model.openReleasePage() }
        } else if let u = model.update, u.available, let latest = u.latest {
            Button(model.t("menu.updateAvailable", ["version": latest])) { Task { await model.updateNow() } }.disabled(model.busy != nil)
        }
        Button(model.checkingUpdates ? model.t("menu.checking") : (model.updateNote ?? model.t("menu.checkUpdates"))) { Task { await model.refreshUpdates(force: true) } }
            .disabled(model.checkingUpdates)
    }
}
