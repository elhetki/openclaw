import Darwin
import Foundation
import OpenClawKit

/// One private setup-code file for the node connection of a named attach-only app instance.
struct MacNodeBootstrapInput {
    static let argument = "--node-bootstrap-file"

    enum Refusal: Error, LocalizedError {
        case invalidInput

        var errorDescription: String? {
            "Mac node setup requires a private, unexpired setup code for this named profile's loopback Gateway."
        }
    }

    private let endpoint: URL
    private let token: String
    private let expiresAtMs: Int64

    static func load(arguments: [String], profile: String?) throws -> Self? {
        let matching = arguments.indices.filter { arguments[$0] == self.argument }
        guard let index = matching.first else { return nil }
        guard matching.count == 1, profile != nil, arguments.contains("--attach-only"),
              index + 1 < arguments.count, arguments[index + 1].hasPrefix("/")
        else { throw Refusal.invalidInput }
        let path = URL(fileURLWithPath: arguments[index + 1])
        let parent = open(path.deletingLastPathComponent().path, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
        guard parent >= 0 else { throw Refusal.invalidInput }
        defer { close(parent) }
        var directory = stat()
        guard fstat(parent, &directory) == 0, directory.st_uid == geteuid(), directory.st_mode & 0o7777 == 0o700,
              self.hasNoACL(parent)
        else { throw Refusal.invalidInput }

        let name = path.lastPathComponent
        let file = openat(parent, name, O_RDONLY | O_NONBLOCK | O_CLOEXEC | O_NOFOLLOW)
        guard file >= 0 else { throw Refusal.invalidInput }
        defer { close(file) }
        var info = stat()
        guard fstat(file, &info) == 0, info.st_uid == geteuid(), info.st_mode & S_IFMT == S_IFREG,
              info.st_mode & 0o7777 == 0o600, info.st_nlink == 1, (1 ... 4096).contains(info.st_size),
              self.hasNoACL(file)
        else { throw Refusal.invalidInput }
        let bytes = try FileHandle(fileDescriptor: file, closeOnDealloc: false).read(upToCount: 4097)
        guard let bytes, bytes.count == Int(info.st_size), let code = String(data: bytes, encoding: .utf8),
              let link = GatewayConnectDeepLink.fromSetupCode(code), let endpoint = link.websocketURL,
              endpoint.scheme == "ws", endpoint.host == "127.0.0.1", endpoint.port != nil,
              endpoint.path.isEmpty || endpoint.path == "/", endpoint.query == nil,
              endpoint.user == nil, endpoint.password == nil, endpoint.fragment == nil,
              link.connectionEndpoints.count == 1, link.token == nil, link.password == nil,
              let token = link.bootstrapToken, !token.isEmpty, let expiresAtMs = link.expiresAtMs
        else { throw Refusal.invalidInput }
        var current = stat()
        guard fstatat(parent, name, &current, AT_SYMLINK_NOFOLLOW) == 0,
              current.st_ino == info.st_ino, current.st_dev == info.st_dev,
              unlinkat(parent, name, 0) == 0
        else { throw Refusal.invalidInput }
        return Self(endpoint: endpoint, token: token, expiresAtMs: expiresAtMs)
    }

    private static func hasNoACL(_ descriptor: Int32) -> Bool {
        if let acl = acl_get_fd_np(descriptor, ACL_TYPE_EXTENDED) {
            acl_free(UnsafeMutableRawPointer(acl))
            return false
        }
        return errno == ENOENT
    }

    func credentials(for endpoint: URL, now: Date = .now) throws -> GatewayNodeSessionCredentials {
        guard endpoint.scheme == self.endpoint.scheme, endpoint.host == self.endpoint.host,
              endpoint.port == self.endpoint.port, endpoint.path.isEmpty || endpoint.path == "/",
              endpoint.query == nil, endpoint.user == nil, endpoint.password == nil, endpoint.fragment == nil,
              now.timeIntervalSince1970 * 1000 < Double(self.expiresAtMs)
        else { throw Refusal.invalidInput }
        return GatewayNodeSessionCredentials(bootstrapToken: self.token)
    }
}
