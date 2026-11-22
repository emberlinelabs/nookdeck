import Foundation

public enum Version {
    /// "v0.3.0" -> "0.3.0"
    public static func bare(_ s: String) -> String { s.hasPrefix("v") || s.hasPrefix("V") ? String(s.dropFirst()) : s }

    /// Negative when a < b. A pre-release (0.4.0-beta) sorts before its release.
    public static func compare(_ a: String, _ b: String) -> Int {
        func split(_ v: String) -> (nums: [Int], pre: String?) {
            let parts = bare(v).split(separator: "-", maxSplits: 1).map(String.init)
            let nums = (parts.first ?? "").split(separator: ".").map { Int($0) ?? 0 }
            return (nums, parts.count > 1 ? parts[1] : nil)
        }
        let x = split(a), y = split(b)
        for i in 0..<max(x.nums.count, y.nums.count) {
            let p = i < x.nums.count ? x.nums[i] : 0, q = i < y.nums.count ? y.nums[i] : 0
            if p != q { return p < q ? -1 : 1 }
        }
        if x.pre != nil && y.pre == nil { return -1 }
        if x.pre == nil && y.pre != nil { return 1 }
        return 0
    }

    /// `nookdeck --version` prints "nookdeck 0.3.0" or just "0.3.0": the first dotted number in the text.
    public static func parse(_ output: String) -> String? {
        output.range(of: "[0-9]+\\.[0-9]+\\.[0-9]+(-[0-9A-Za-z.]+)?", options: .regularExpression).map { String(output[$0]) }
    }
}
