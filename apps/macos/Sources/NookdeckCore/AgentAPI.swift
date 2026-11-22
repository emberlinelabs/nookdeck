import Foundation

public enum APIError: Error, Equatable {
    case unreachable
    case status(Int)
    case badBody
}

/// One HTTP exchange; tests swap it for a fake.
public protocol Transport {
    func send(_ request: URLRequest) async throws -> (Data, Int)
}

public struct URLSessionTransport: Transport {
    let session: URLSession
    public init() {
        let c = URLSessionConfiguration.ephemeral
        c.timeoutIntervalForRequest = 4
        c.waitsForConnectivity = false
        session = URLSession(configuration: c)
    }
    public func send(_ request: URLRequest) async throws -> (Data, Int) {
        do {
            let (d, r) = try await session.data(for: request)
            return (d, (r as? HTTPURLResponse)?.statusCode ?? 0)
        } catch { throw APIError.unreachable }
    }
}

/// The agent's local API (spec A5): 127.0.0.1 with the x-nookdeck header. No other channel.
public struct AgentAPI {
    public let base: URL
    let transport: Transport

    public init(base: URL, transport: Transport = URLSessionTransport()) { self.base = base; self.transport = transport }

    func request(_ path: String, method: String = "GET", query: [URLQueryItem] = []) -> URLRequest {
        var c = URLComponents(url: base, resolvingAgainstBaseURL: false)!
        c.path = path
        if !query.isEmpty { c.queryItems = query }
        var r = URLRequest(url: c.url!)
        r.httpMethod = method
        r.setValue("1", forHTTPHeaderField: "x-nookdeck")
        if method != "GET" { r.httpBody = Data("{}".utf8); r.setValue("application/json", forHTTPHeaderField: "content-type") }
        return r
    }

    func get<T: Decodable>(_ type: T.Type, _ req: URLRequest) async throws -> T {
        let (data, code) = try await transport.send(req)
        guard (200..<300).contains(code) else { throw APIError.status(code) }
        do { return try JSONDecoder().decode(T.self, from: data) } catch { throw APIError.badBody }
    }

    public func devices() async throws -> [Device] { try await get([Device].self, request("/api/devices")) }
    public func pairing(all: Bool = false) async throws -> Pairing { try await get(Pairing.self, request("/api/pairing", query: all ? [URLQueryItem(name: "all", value: "1")] : [])) }
    public func regeneratePin() async throws -> Pairing { try await get(Pairing.self, request("/api/pairing/regenerate", method: "POST")) }
    public func doctor() async throws -> DoctorReport { try await get(DoctorReport.self, request("/api/doctor")) }
    public func update(refresh: Bool = false) async throws -> UpdateInfo { try await get(UpdateInfo.self, request("/api/update", query: refresh ? [URLQueryItem(name: "refresh", value: "1")] : [])) }
}
