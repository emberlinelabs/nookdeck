import AppKit
import SwiftUI
import NookdeckCore

struct PairingView: View {
    @ObservedObject var model: AppModel
    @State private var selected = ""
    @State private var copied = false

    var address: PairingAddress? {
        guard let p = model.pairing else { return nil }
        return p.addresses.first { $0.id == selected } ?? p.addresses.first { $0.id == p.defaultAddress } ?? p.addresses.first
    }

    var link: String { address?.url ?? model.pairing?.url ?? "" }

    var hint: String {
        guard let a = address else { return model.t("pair.scan") }
        return a.kind == "tailscale" ? model.t("pair.scan.tailscale") : model.t("pair.scan.wifi")
    }

    var body: some View {
        VStack(spacing: 14) {
            if model.pairing != nil, !link.isEmpty {
                if let cg = qrImage(link, scale: 8) {
                    Image(nsImage: NSImage(cgImage: cg, size: NSSize(width: 220, height: 220)))
                        .interpolation(.none).resizable().frame(width: 220, height: 220)
                        .padding(12).background(Color.white).cornerRadius(12)
                        .accessibilityLabel(model.t("pair.qrLabel"))
                }
                Text(hint).font(.callout).multilineTextAlignment(.center).foregroundStyle(.secondary).frame(maxWidth: 300).fixedSize(horizontal: false, vertical: true)
                VStack(spacing: 2) {
                    Text(model.t("pair.pin")).font(.caption).foregroundStyle(.secondary)
                    Text(grouped(model.pairing?.pin ?? "")).font(.system(size: 34, weight: .semibold, design: .monospaced)).textSelection(.enabled)
                }
                if let p = model.pairing, p.addresses.count > 1 {
                    HStack {
                        Text(model.t("pair.via")).font(.callout)
                        Picker("", selection: Binding(get: { address?.id ?? "" }, set: { selected = $0 })) {
                            ForEach(p.addresses, id: \.id) { a in Text(a.label ?? a.host).tag(a.id) }
                        }.labelsHidden().frame(maxWidth: 250)
                    }
                } else if let a = address {
                    Text("\(model.t("pair.via")) \(a.label ?? a.host)").font(.caption).foregroundStyle(.secondary)
                }
                HStack {
                    Button(model.t("pair.newPin")) { Task { await model.loadPairing(regenerate: true) } }
                    Button(copied ? model.t("pair.copied") : model.t("pair.copyLink")) {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(link, forType: .string)
                        copied = true
                        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { copied = false }
                    }
                }
            } else if model.pairingFailed {
                Text(model.status == .stopped || model.status == .notInstalled ? model.t("pair.notRunning") : model.t("pair.error"))
                    .multilineTextAlignment(.center).frame(maxWidth: 280)
                Button(model.t("common.retry")) { Task { await model.loadPairing() } }
            } else {
                ProgressView(model.t("pair.loading"))
            }
        }
        .padding(24).frame(width: 360)
        .task { await model.loadPairing() }
        .onChange(of: model.pairing) { _ in copied = false }
    }

    /// 123456 -> 123 456
    func grouped(_ pin: String) -> String {
        guard pin.count == 6 else { return pin }
        return String(pin.prefix(3)) + " " + String(pin.suffix(3))
    }
}
