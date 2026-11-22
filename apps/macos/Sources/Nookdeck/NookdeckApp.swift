import SwiftUI
import NookdeckCore

@main
struct NookdeckApp: App {
    @StateObject private var model = AppModel()

    var body: some Scene {
        MenuBarExtra {
            MenuContent(model: model)
        } label: {
            Image(nsImage: MenuIcons.image(for: model.status))
        }
        Window(model.t("pair.title"), id: "pair") {
            PairingView(model: model)
        }
        .windowResizability(.contentSize)
    }
}
