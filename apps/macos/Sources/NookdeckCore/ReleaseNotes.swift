import Foundation

/// "What's new" for the update alert. GitHub's `releases/latest` body is the whole .github/release-notes.md: sections
/// "## Nookdeck X.Y.Z" or "## Nookdeck X.Y.Z: title", newest first. The alert shows the ones newer than the running app.
public enum ReleaseNotes {
    public struct Section: Equatable {
        public let version: String
        public let title: String?
        /// the section's markdown, without its heading and without the "Upgrading: ..." line
        public let markdown: String
    }

    /// Every "## Nookdeck X.Y.Z[: title]" section of `body`, in the order written.
    public static func sections(_ body: String) -> [Section] {
        var out: [Section] = []
        var cur: (version: String, title: String?)?
        var lines: [String] = []
        func flush() {
            guard let c = cur else { return }
            let text = lines.filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("Upgrading:") }
                .joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
            out.append(Section(version: c.version, title: c.title, markdown: text))
        }
        for raw in body.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n") {
            if let h = heading(raw) {
                flush()
                cur = h
                lines = []
            } else if isOtherH2(raw) {
                // "## Install", "## Files" (a GitHub release body): not part of the notes
                flush()
                cur = nil
                lines = []
            } else if cur != nil {
                lines.append(raw)
            }
        }
        flush()
        return out
    }

    static func isOtherH2(_ line: String) -> Bool {
        let s = line.trimmingCharacters(in: .whitespaces)
        return (s.hasPrefix("## ") || s == "##") && heading(line) == nil
    }

    /// "## Nookdeck 0.6.0: Linux, and updates" -> ("0.6.0", "Linux, and updates"). Nil for any other line.
    static func heading(_ line: String) -> (version: String, title: String?)? {
        let s = line.trimmingCharacters(in: .whitespaces)
        guard s.hasPrefix("## "), !s.hasPrefix("### ") else { return nil }
        let rest = s.dropFirst(3).trimmingCharacters(in: .whitespaces)
        guard let r = rest.range(of: "^Nookdeck\\s+v?([0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.]+)?)", options: [.regularExpression, .caseInsensitive]) else { return nil }
        let head = String(rest[r])
        let version = head.components(separatedBy: CharacterSet.whitespaces).last.map(Version.bare) ?? ""
        var tail = rest[r.upperBound...].trimmingCharacters(in: .whitespaces)
        if tail.hasPrefix(":") { tail = String(tail.dropFirst()).trimmingCharacters(in: .whitespaces) }
        return (version, tail.isEmpty ? nil : tail)
    }

    /// The sections with current < version <= `upTo` (the version being offered: the latest release body can already
    /// hold a newer section than what is on offer), newest first, at most `limit`; prereleases (0.7.0-beta.1) are left
    /// out. `more` is true when there were more of them than shown.
    public static func newer(_ body: String, current: String, upTo: String? = nil, limit: Int = 3) -> (shown: [Section], more: Bool) {
        let all = sections(body)
            .filter { !$0.version.contains("-") && Version.compare($0.version, current) > 0 && (upTo == nil || Version.compare($0.version, upTo!) <= 0) }
            .sorted { Version.compare($0.version, $1.version) > 0 }
        return (Array(all.prefix(limit)), all.count > limit)
    }

    /// The same from GitHub `releases?per_page=10`, where each release body holds only its own section: published
    /// releases (no drafts, no prereleases) with current < tag <= `upTo`, newest first, at most `limit`, each read
    /// with `sections` (the one matching its tag; the first section if none matches). Nil when the JSON is not a list.
    public static func fromReleases(json: Data, current: String, upTo: String, limit: Int = 3) -> (shown: [Section], more: Bool)? {
        guard let list = (try? JSONSerialization.jsonObject(with: json)) as? [[String: Any]] else { return nil }
        var byVersion: [String: Section] = [:]
        for r in list {
            guard (r["draft"] as? Bool) != true, (r["prerelease"] as? Bool) != true, let tag = r["tag_name"] as? String else { continue }
            let v = Version.bare(tag)
            guard !v.contains("-"), Version.compare(v, current) > 0, Version.compare(v, upTo) <= 0, byVersion[v] == nil else { continue }
            let secs = sections((r["body"] as? String) ?? "")
            guard let s = secs.first(where: { Version.compare($0.version, v) == 0 }) ?? secs.first else { continue }
            byVersion[v] = Section(version: v, title: s.title, markdown: s.markdown)
        }
        let all = byVersion.values.sorted { Version.compare($0.version, $1.version) > 0 }
        return (Array(all.prefix(limit)), all.count > limit)
    }
}

/// The small markdown subset the release notes use: ### headings, - lists (nested by indent), paragraphs, and inside
/// them **bold**, `code` and [links](url). Anything else is shown as plain text.
public enum NotesMarkdown {
    public enum Inline: Equatable {
        case text(String)
        case bold(String)
        case code(String)
        case link(String, URL)
    }

    public enum Block: Equatable {
        case heading(level: Int, [Inline])
        /// depth 0 for a top-level item, 1 for an item indented under it, ...
        case bullet(depth: Int, [Inline])
        case paragraph([Inline])
    }

    public static func blocks(_ md: String) -> [Block] {
        var out: [Block] = []
        var para: [String] = []
        func endPara() {
            if !para.isEmpty { out.append(.paragraph(inlines(para.joined(separator: " ")))) }
            para = []
        }
        for raw in md.components(separatedBy: "\n") {
            let line = raw.replacingOccurrences(of: "\t", with: "    ")
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty { endPara(); continue }
            if let m = trimmed.range(of: "^#{1,6}\\s+", options: .regularExpression) {
                endPara()
                let level = trimmed[m].filter { $0 == "#" }.count
                out.append(.heading(level: level, inlines(String(trimmed[m.upperBound...]))))
                continue
            }
            if trimmed.hasPrefix("- ") || trimmed.hasPrefix("* ") {
                endPara()
                let indent = line.prefix(while: { $0 == " " }).count
                out.append(.bullet(depth: min(indent / 2, 4), inlines(String(trimmed.dropFirst(2)))))
                continue
            }
            // a wrapped line right under a list item continues that item
            if para.isEmpty, case .bullet(let d, let inl)? = out.last, line.hasPrefix(" ") {
                out[out.count - 1] = .bullet(depth: d, merge(inl, inlines(" " + trimmed)))
                continue
            }
            para.append(trimmed)
        }
        endPara()
        return out
    }

    private static func merge(_ a: [Inline], _ b: [Inline]) -> [Inline] {
        guard case .text(let x)? = a.last, case .text(let y)? = b.first else { return a + b }
        return Array(a.dropLast()) + [.text(x + y)] + Array(b.dropFirst())
    }

    /// **bold**, `code`, [text](url); unmatched markers stay as text.
    public static func inlines(_ s: String) -> [Inline] {
        var out: [Inline] = []
        var buf = ""
        func flush() { if !buf.isEmpty { out.append(.text(buf)); buf = "" } }
        let c = Array(s)
        var i = 0
        func find(_ needle: [Character], from: Int) -> Int? {
            guard needle.count > 0, from <= c.count - needle.count else { return nil }
            var j = from
            while j <= c.count - needle.count {
                if Array(c[j..<j + needle.count]) == needle { return j }
                j += 1
            }
            return nil
        }
        while i < c.count {
            if c[i] == "*", i + 1 < c.count, c[i + 1] == "*", let end = find(["*", "*"], from: i + 2), end > i + 2 {
                flush(); out.append(.bold(String(c[(i + 2)..<end]))); i = end + 2; continue
            }
            if c[i] == "`", let end = find(["`"], from: i + 1), end > i + 1 {
                flush(); out.append(.code(String(c[(i + 1)..<end]))); i = end + 1; continue
            }
            if c[i] == "[", let close = find(["]", "("], from: i + 1), let paren = find([")"], from: close + 2),
               let url = URL(string: String(c[(close + 2)..<paren])), let scheme = url.scheme, ["https", "http"].contains(scheme.lowercased()) {
                flush()
                var label = String(c[(i + 1)..<close])
                // a bold or code label ([**x**](u), [`x`](u)) shows its text
                label = label.replacingOccurrences(of: "**", with: "").replacingOccurrences(of: "`", with: "")
                out.append(.link(label, url)); i = paren + 1; continue
            }
            buf.append(c[i]); i += 1
        }
        flush()
        return out
    }
}
