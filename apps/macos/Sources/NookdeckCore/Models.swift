import Foundation

public struct Device: Codable, Equatable {
    public var id: String
    public var name: String?
    public var online: Bool?
}

public struct PairingAddress: Codable, Equatable {
    public var id: String
    public var kind: String?
    public var host: String
    public var label: String?
    public var note: String?
    public var url: String
}

public struct Pairing: Codable, Equatable {
    public var addresses: [PairingAddress]
    public var defaultAddress: String?
    public var pin: String
    public var url: String
    public var port: Int?
}

public struct DoctorItem: Codable, Equatable {
    public var id: String
    public var title: String
    public var status: String
    public var detail: String?
}

public struct DoctorReport: Codable, Equatable {
    public var version: String?
    public var asService: Bool?
    public var items: [DoctorItem]
    /// a check the user must act on (missing or denied); "unknown" and "n/a" are not nagged about
    public var needsAttention: Bool { items.contains { $0.status == "missing" || $0.status == "denied" } }
    public var problems: [DoctorItem] { items.filter { $0.status == "missing" || $0.status == "denied" } }
}

public struct UpdateInfo: Codable, Equatable {
    public var current: String
    public var latest: String?
    public var available: Bool
    public var enabled: Bool?
    public var error: String?
}
