import Foundation
import Testing
@testable import OpenClaw

@Suite struct MacNodeBootstrapInputTests {
    private func withCode(
        endpoint: String = "ws://127.0.0.1:19791",
        mode: Int = 0o600,
        run: (URL, [String]) throws -> Void)
        throws
    {
        let fs = FileManager.default
        let directory = fs.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try fs.createDirectory(at: directory, withIntermediateDirectories: false,
                               attributes: [.posixPermissions: 0o700])
        defer { try? fs.removeItem(at: directory) }
        let file = directory.appendingPathComponent("node-setup")
        let code: [String: Any] = [
            "url": endpoint,
            "expiresAtMs": Int(Date.now.addingTimeInterval(60).timeIntervalSince1970 * 1000),
            "bootstrapToken": "throwaway-node-setup",
        ]
        try JSONSerialization.data(withJSONObject: code).write(to: file)
        try fs.setAttributes([.posixPermissions: mode], ofItemAtPath: file.path)
        try run(file, ["OpenClaw", "--attach-only", "--node-bootstrap-file", file.path])
    }

    @Test func privateCodeIsRemovedAndSuppliesOnlyPinnedEndpoint() throws {
        try self.withCode { file, arguments in
            let loaded = try MacNodeBootstrapInput.load(arguments: arguments, profile: "nate-test")
            let input = try #require(loaded)
            #expect(!FileManager.default.fileExists(atPath: file.path))
            let credentials = try input.credentials(for: #require(URL(string: "ws://127.0.0.1:19791")))
            #expect(credentials.bootstrapToken == "throwaway-node-setup")
            #expect(credentials.token == nil)
            #expect(credentials.password == nil)
            #expect(throws: MacNodeBootstrapInput.Refusal.self) {
                try input.credentials(for: #require(URL(string: "ws://127.0.0.1:19792")))
            }
            #expect(throws: MacNodeBootstrapInput.Refusal.self) {
                try input.credentials(for: #require(URL(string: "ws://127.0.0.1:19791")),
                                      now: Date.now.addingTimeInterval(120))
            }
        }
    }

    @Test func defaultProfileOrdinaryLaunchAndWideFileAreRefused() throws {
        #expect(try MacNodeBootstrapInput.load(arguments: ["OpenClaw"], profile: nil) == nil)
        try self.withCode { file, arguments in
            #expect(throws: MacNodeBootstrapInput.Refusal.self) {
                try MacNodeBootstrapInput.load(arguments: arguments, profile: nil)
            }
            #expect(throws: MacNodeBootstrapInput.Refusal.self) {
                try MacNodeBootstrapInput.load(arguments: arguments.filter { $0 != "--attach-only" }, profile: "test")
            }
            #expect(FileManager.default.fileExists(atPath: file.path))
        }
        try self.withCode(mode: 0o640) { file, arguments in
            #expect(throws: MacNodeBootstrapInput.Refusal.self) {
                try MacNodeBootstrapInput.load(arguments: arguments, profile: "nate-test")
            }
            #expect(FileManager.default.fileExists(atPath: file.path))
        }
    }
}
