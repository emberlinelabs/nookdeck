import AppKit
import NookdeckCore

/// The menu bar template icons (apps/shared/icons/macos, copied into Resources/icons). The state shows in the dot's shape.
enum MenuIcons {
    static func image(for status: AgentStatus) -> NSImage {
        let name: String
        switch status {
        case .running: name = "nookdeck-runningTemplate"
        case .stopped, .notInstalled: name = "nookdeck-stoppedTemplate"
        case .needsPermission: name = "nookdeck-attentionTemplate"
        case .installing, .unknown: name = "nookdeckTemplate"
        }
        if let img = loadTemplate(name) { return img }
        let fallback = NSImage(systemSymbolName: "rectangle.grid.2x2", accessibilityDescription: "Nookdeck") ?? NSImage()
        fallback.isTemplate = true
        return fallback
    }

    /// The @1x and @2x PNGs as one image (the PDFs lose their cut-outs in conversion), 18 pt, template.
    static func loadTemplate(_ name: String, bundle: Bundle = .main) -> NSImage? {
        let img = NSImage(size: NSSize(width: 18, height: 18))
        for (suffix, _) in [("", 1), ("@2x", 2)] {
            guard let url = bundle.url(forResource: name + suffix, withExtension: "png", subdirectory: "icons"),
                  let data = try? Data(contentsOf: url), let rep = NSBitmapImageRep(data: data) else { continue }
            rep.size = NSSize(width: 18, height: 18)
            img.addRepresentation(rep)
        }
        guard !img.representations.isEmpty else { return nil }
        img.isTemplate = true
        return img
    }

    /// The coloured dot before the status line.
    static func dot(for status: AgentStatus) -> NSImage {
        let color: NSColor
        switch status {
        case .running: color = .systemGreen
        case .needsPermission: color = .systemOrange
        case .stopped, .notInstalled: color = .systemGray
        case .installing, .unknown: color = .systemBlue
        }
        let img = NSImage(size: NSSize(width: 10, height: 10), flipped: false) { r in
            color.setFill()
            NSBezierPath(ovalIn: r.insetBy(dx: 1, dy: 1)).fill()
            return true
        }
        img.isTemplate = false
        return img
    }
}
