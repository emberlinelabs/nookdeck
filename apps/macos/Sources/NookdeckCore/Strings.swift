import Foundation

/// en / vi / zh copy from apps/shared/strings.json ({_meta, en, vi, zh}; flat keys like menu.pair; {name} placeholders;
/// plurals menu.phones.none / .one / .other). The build copies the file into the app's Resources; a missing key falls back
/// to English, then to the key itself, so a gap shows up as text and never as a crash.
public final class Strings {
    public enum Lang: String, CaseIterable { case en, vi, zh }

    private var tables: [Lang: [String: String]] = [:]

    public init(json: Data? = nil) { if let json { load(json: json) } }

    /// The language to use for a list of preferred languages (Locale.preferredLanguages): vi, zh-* or English.
    public static func pick(_ preferred: [String]) -> Lang {
        for p in preferred {
            let l = p.lowercased()
            if l.hasPrefix("vi") { return .vi }
            if l.hasPrefix("zh") { return .zh }
            if l.hasPrefix("en") { return .en }
        }
        return .en
    }

    /// Merges a table over what is loaded; unknown languages and non-string values are ignored.
    public func load(json: Data) {
        guard let obj = try? JSONSerialization.jsonObject(with: json) as? [String: Any] else { return }
        for lang in Lang.allCases {
            guard let t = obj[lang.rawValue] as? [String: Any] else { continue }
            for (k, v) in t { if let s = v as? String { tables[lang, default: [:]][k] = s } }
        }
    }

    public func has(_ key: String, _ lang: Lang) -> Bool { tables[lang]?[key] != nil }
    public var keys: [String] { (tables[.en] ?? [:]).keys.sorted() }

    /// The text for a key; `{name}` placeholders are filled from `values`.
    public func text(_ key: String, _ lang: Lang, _ values: [String: String] = [:]) -> String {
        var s = tables[lang]?[key] ?? tables[.en]?[key] ?? key
        for (k, v) in values { s = s.replacingOccurrences(of: "{\(k)}", with: v) }
        return s
    }

    /// "No phones connected" / "1 phone connected" / "3 phones connected".
    public func phones(_ count: Int, _ lang: Lang) -> String {
        count == 0 ? text("menu.phones.none", lang) : count == 1 ? text("menu.phones.one", lang) : text("menu.phones.other", lang, ["count": String(count)])
    }
}
