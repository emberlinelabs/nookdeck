import Foundation

public enum AgentStatus: Equatable {
    case installing
    case notInstalled
    case stopped
    case running
    case needsPermission
    case unknown
}

public func computeStatus(reachable: Bool, serviceInstalled: Bool, busy: Bool, doctor: DoctorReport?) -> AgentStatus {
    if busy { return .installing }
    if !reachable { return serviceInstalled ? .stopped : .notInstalled }
    if let d = doctor, d.needsAttention { return .needsPermission }
    return .running
}
