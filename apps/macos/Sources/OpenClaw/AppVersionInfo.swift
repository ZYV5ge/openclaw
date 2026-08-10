import Foundation

enum AppVersionInfo {
    static func productVersion(
        in infoDictionary: [String: Any]? = Bundle.main.infoDictionary) -> String?
    {
        for key in ["OpenClawProductVersion", "CFBundleShortVersionString"] {
            guard let raw = infoDictionary?[key] as? String else { continue }
            let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            if !value.isEmpty { return value }
        }
        return nil
    }
}
