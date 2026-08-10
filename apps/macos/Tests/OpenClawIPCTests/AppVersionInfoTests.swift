import Testing
@testable import OpenClaw

struct AppVersionInfoTests {
    @Test func `product version prefers the explicit machine identity`() {
        let info: [String: Any] = [
            "CFBundleShortVersionString": "2026.8.1",
            "OpenClawProductVersion": "2026.8.1-selfbuild.1",
        ]

        #expect(AppVersionInfo.productVersion(in: info) == "2026.8.1-selfbuild.1")
    }

    @Test func `official bundles keep the existing short version fallback`() {
        let info: [String: Any] = ["CFBundleShortVersionString": "2026.8.1-beta.2"]

        #expect(AppVersionInfo.productVersion(in: info) == "2026.8.1-beta.2")
    }

    @Test func `blank custom identity falls back without changing official behavior`() {
        let info: [String: Any] = [
            "CFBundleShortVersionString": "2026.8.1",
            "OpenClawProductVersion": "  ",
        ]

        #expect(AppVersionInfo.productVersion(in: info) == "2026.8.1")
    }
}
