import Foundation

/// The app's newest GitHub release, with the two files the in-place update needs.
public struct AppRelease: Equatable {
    public let version: String
    public let dmg: URL
    public let sha256: URL
    /// the release body: the whole release notes file (ReleaseNotes picks the sections newer than the running app)
    public let notes: String
    /// the release page on GitHub (html_url); nil when the JSON has none
    public let page: URL?

    public init(version: String, dmg: URL, sha256: URL, notes: String = "", page: URL? = nil) {
        self.version = version; self.dmg = dmg; self.sha256 = sha256; self.notes = notes; self.page = page
    }

    /// Reads GitHub's `releases/latest` JSON. Nil when it is not newer than `current` or misses Nookdeck.dmg or its .sha256.
    public static func newer(json: Data, current: String) -> AppRelease? {
        guard let o = (try? JSONSerialization.jsonObject(with: json)) as? [String: Any],
              let tag = o["tag_name"] as? String, Version.compare(tag, current) > 0 else { return nil }
        var urls: [String: URL] = [:]
        for a in (o["assets"] as? [[String: Any]]) ?? [] {
            if let n = a["name"] as? String, let s = a["browser_download_url"] as? String, let u = URL(string: s) { urls[n] = u }
        }
        guard let dmg = urls["Nookdeck.dmg"], let sha = urls["Nookdeck.dmg.sha256"] else { return nil }
        return AppRelease(version: Version.bare(tag), dmg: dmg, sha256: sha, notes: (o["body"] as? String) ?? "",
                          page: (o["html_url"] as? String).flatMap(URL.init(string:)))
    }
}

public enum SelfUpdate {
    /// The hex digest in a `shasum` style line ("<64 hex>  Nookdeck.dmg").
    public static func expectedDigest(_ text: String) -> String? {
        guard let first = text.split(whereSeparator: { $0 == " " || $0 == "\n" || $0 == "\t" }).first else { return nil }
        let hex = first.lowercased()
        return hex.count == 64 && hex.allSatisfy({ $0.isHexDigit }) ? hex : nil
    }

    /// The app can only replace itself when it runs from a real .app on disk: not a dev build, not straight from the
    /// mounted dmg, not a translocated copy (macOS runs a quarantined app from a random read-only path).
    public static func replaceable(bundlePath: String) -> Bool {
        bundlePath.hasSuffix(".app") && !bundlePath.hasPrefix("/Volumes/") && !bundlePath.contains("/AppTranslocation/")
    }

    /// Runs after the app quits: waits for it to exit, swaps the bundle (putting the old one back if the copy fails),
    /// opens the app again and removes the download. If the app has not quit after 20 s it changes nothing (an `open`
    /// would only bring the old copy forward). Arguments: pid, target .app, staged .app, work dir, log file.
    public static let swapScript = """
    exec >>"$5" 2>&1
    echo "$(date) update: $2"
    i=0
    while kill -0 "$1" 2>/dev/null && [ "$i" -lt 100 ]; do sleep 0.2; i=$((i+1)); done
    if kill -0 "$1" 2>/dev/null; then echo "the app is still running, not replacing it"; rm -rf "$4"; exit 1; fi
    rm -rf "$2.old"
    if mv "$2" "$2.old"; then
      if ditto "$3" "$2"; then rm -rf "$2.old"; echo "replaced"; else echo "copy failed, restoring"; rm -rf "$2"; mv "$2.old" "$2"; fi
    else
      echo "could not move the old app"
    fi
    open "$2"
    rm -rf "$4"
    """
}
