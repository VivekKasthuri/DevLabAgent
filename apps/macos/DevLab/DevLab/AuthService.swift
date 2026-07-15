import Foundation
import AppKit
import AuthenticationServices

// ── Auth state persisted in Keychain ─────────────────────────────────────────
@Observable
final class AuthService {
    var isSignedIn: Bool = false
    var currentUser: UserProfile? = nil
    var isLoading: Bool = false
    var errorMessage: String? = nil

    private let keychainKey = "com.devlab.auth.token"
    private let userDefaultsKey = "com.devlab.user"
    var githubOAuthClientId: String = "" {
        didSet {
            UserDefaults.standard.set(githubOAuthClientId.trimmingCharacters(in: .whitespacesAndNewlines), forKey: githubOAuthClientIdKey)
        }
    }

    private let githubOAuthClientIdKey = "github.oauth.clientId"
    private var oauthSession: ASWebAuthenticationSession?

    init() {
        let savedClientId = UserDefaults.standard.string(forKey: githubOAuthClientIdKey)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let envClientId = ProcessInfo.processInfo.environment["GITHUB_OAUTH_CLIENT_ID"]?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        self.githubOAuthClientId = savedClientId.isEmpty ? envClientId : savedClientId

        // Restore session on launch
        if let token = loadToken(), !token.isEmpty,
           let data = UserDefaults.standard.data(forKey: userDefaultsKey),
           let user = try? JSONDecoder().decode(UserProfile.self, from: data) {
            self.currentUser = user
            self.isSignedIn = true
        }
    }

    // ── Sign In ───────────────────────────────────────────────────────────────
    @MainActor
    func signIn(email: String, password: String) async {
        guard !email.isEmpty, !password.isEmpty else {
            errorMessage = "Email and password are required."; return
        }
        isLoading = true; errorMessage = nil

        // Simulate auth (replace with real API call)
        do {
            let user = try await authenticateUser(email: email, password: password)
            persistSession(user: user)
            currentUser = user
            isSignedIn = true
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }

    @MainActor
    func signInWithGitHub() async {
        isLoading = true; errorMessage = nil
        do {
            let user = try await authenticateGitHubOAuthUser()
            persistSession(user: user)
            currentUser = user
            isSignedIn = true
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }

    @MainActor
    func signInWithGitHubEnterprise(serverURL: String, username: String, token: String) async {
        guard !serverURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !username.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            errorMessage = "Enterprise URL, username, and token are required."
            return
        }

        isLoading = true; errorMessage = nil
        do {
            let user = try await authenticateGitHubEnterpriseUser(serverURL: serverURL, username: username, token: token)
            persistSession(user: user)
            currentUser = user
            isSignedIn = true
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }

    // ── Sign Up ───────────────────────────────────────────────────────────────
    @MainActor
    func signUp(name: String, email: String, password: String) async {
        guard !name.isEmpty, !email.isEmpty, !password.isEmpty else {
            errorMessage = "All fields are required."; return
        }
        guard password.count >= 8 else {
            errorMessage = "Password must be at least 8 characters."; return
        }
        isLoading = true; errorMessage = nil

        do {
            let user = try await registerUser(name: name, email: email, password: password)
            persistSession(user: user)
            currentUser = user
            isSignedIn = true
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }

    // ── Sign Out ──────────────────────────────────────────────────────────────
    func signOut() {
        deleteToken()
        UserDefaults.standard.removeObject(forKey: userDefaultsKey)
        currentUser = nil
        isSignedIn = false
    }

    // ── Persist ───────────────────────────────────────────────────────────────
    private func persistSession(user: UserProfile) {
        saveToken(user.token)
        if let data = try? JSONEncoder().encode(user) {
            UserDefaults.standard.set(data, forKey: userDefaultsKey)
        }
    }

    // ── Keychain helpers ──────────────────────────────────────────────────────
    private func saveToken(_ token: String) {
        let data = Data(token.utf8)
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrAccount: keychainKey,
            kSecValueData: data
        ]
        SecItemDelete(query as CFDictionary)
        SecItemAdd(query as CFDictionary, nil)
    }

    private func loadToken() -> String? {
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrAccount: keychainKey,
            kSecReturnData: true,
            kSecMatchLimit: kSecMatchLimitOne
        ]
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private func deleteToken() {
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrAccount: keychainKey
        ]
        SecItemDelete(query as CFDictionary)
    }

    // ── Auth API (stub — replace with your backend) ───────────────────────────
    private func authenticateUser(email: String, password: String) async throws -> UserProfile {
        // Replace URL with your actual auth endpoint
        // For now: accept any well-formed input locally
        try await Task.sleep(nanoseconds: 600_000_000)   // 0.6s simulate network
        guard email.contains("@") else {
            throw AuthError.invalidCredentials
        }
        let name = email.components(separatedBy: "@").first?.capitalized ?? "User"
        return UserProfile(id: UUID().uuidString, name: name, email: email,
                           avatarInitials: String(name.prefix(2)).uppercased(),
                           token: UUID().uuidString)
    }

    private func registerUser(name: String, email: String, password: String) async throws -> UserProfile {
        try await Task.sleep(nanoseconds: 800_000_000)
        guard email.contains("@") else { throw AuthError.invalidEmail }
        return UserProfile(id: UUID().uuidString, name: name, email: email,
                           avatarInitials: String(name.prefix(2)).uppercased(),
                           token: UUID().uuidString)
    }

    private func authenticateGitHubOAuthUser() async throws -> UserProfile {
        guard let callback = try await startGitHubOAuth() else {
            throw AuthError.oauthFailed
        }

        let items = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems ?? []
        guard let code = items.first(where: { $0.name == "code" })?.value, !code.isEmpty else {
            throw AuthError.oauthFailed
        }
        let login = items.first(where: { $0.name == "login" })?.value
            ?? NSFullUserName().replacingOccurrences(of: " ", with: "").lowercased()
        let display = login.isEmpty ? "GitHub User" : login

        // Stubbed exchange: in production call your backend to exchange `code` for token/user.
        return UserProfile(
            id: UUID().uuidString,
            name: display,
            email: "\(login.isEmpty ? "github" : login)@users.noreply.github.com",
            avatarInitials: String(display.prefix(2)).uppercased(),
            token: "github_oauth_\(code.prefix(12))",
            authProvider: "github"
        )
    }

    private func startGitHubOAuth() async throws -> URL? {
        let callbackScheme = "devlab"
        let redirectURI = "\(callbackScheme)://auth/github/callback"
        let clientId = githubOAuthClientId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clientId.isEmpty else { throw AuthError.githubOAuthNotConfigured }

        var comps = URLComponents(string: "https://github.com/login/oauth/authorize")
        comps?.queryItems = [
            URLQueryItem(name: "client_id", value: clientId),
            URLQueryItem(name: "redirect_uri", value: redirectURI),
            URLQueryItem(name: "scope", value: "read:user user:email"),
            URLQueryItem(name: "state", value: UUID().uuidString)
        ]
        guard let authURL = comps?.url else { throw AuthError.oauthFailed }

        return try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(url: authURL, callbackURLScheme: callbackScheme) { [weak self] callbackURL, error in
                self?.oauthSession = nil
                if let error {
                    let nsErr = error as NSError
                    if nsErr.domain == ASWebAuthenticationSessionError.errorDomain,
                       nsErr.code == ASWebAuthenticationSessionError.canceledLogin.rawValue {
                        continuation.resume(throwing: AuthError.oauthCancelled)
                        return
                    }
                    continuation.resume(throwing: error)
                    return
                }
                continuation.resume(returning: callbackURL)
            }
            session.prefersEphemeralWebBrowserSession = true
            self.oauthSession = session
            if !session.start() {
                self.oauthSession = nil
                continuation.resume(throwing: AuthError.oauthFailed)
            }
        }
    }

    private func authenticateGitHubEnterpriseUser(serverURL: String, username: String, token: String) async throws -> UserProfile {
        try await Task.sleep(nanoseconds: 600_000_000)
        guard let normalized = normalizeEnterpriseURL(serverURL) else {
            throw AuthError.invalidEnterpriseURL
        }
        guard token.count >= 8 else {
            throw AuthError.invalidCredentials
        }
        let host = URL(string: normalized)?.host ?? "enterprise.local"
        let name = username.trimmingCharacters(in: .whitespacesAndNewlines)
        return UserProfile(
            id: UUID().uuidString,
            name: name,
            email: "\(name)@\(host)",
            avatarInitials: String(name.prefix(2)).uppercased(),
            token: token,
            authProvider: "github-enterprise:\(normalized)"
        )
    }

    private func normalizeEnterpriseURL(_ raw: String) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let candidate = trimmed.hasPrefix("http://") || trimmed.hasPrefix("https://") ? trimmed : "https://\(trimmed)"
        guard let url = URL(string: candidate), url.host != nil else { return nil }
        return candidate
    }
}

// ── Models ────────────────────────────────────────────────────────────────────
struct UserProfile: Codable {
    let id: String
    let name: String
    let email: String
    let avatarInitials: String
    let token: String
    let authProvider: String?

    init(id: String, name: String, email: String, avatarInitials: String, token: String, authProvider: String? = nil) {
        self.id = id
        self.name = name
        self.email = email
        self.avatarInitials = avatarInitials
        self.token = token
        self.authProvider = authProvider
    }
}

extension UserProfile {
    var authProviderLabel: String {
        guard let authProvider, !authProvider.isEmpty else { return "Provider: Email" }
        if authProvider == "github" { return "Provider: GitHub" }
        if authProvider.hasPrefix("github-enterprise:") { return "Provider: GitHub Enterprise" }
        return "Provider: \(authProvider)"
    }
}

enum AuthError: LocalizedError {
    case invalidCredentials, invalidEmail, networkError, invalidEnterpriseURL
    case githubOAuthNotConfigured, oauthCancelled, oauthFailed
    var errorDescription: String? {
        switch self {
        case .invalidCredentials: return "Invalid email or password."
        case .invalidEmail:       return "Please enter a valid email address."
        case .networkError:       return "Network error. Please try again."
        case .invalidEnterpriseURL: return "Please enter a valid GitHub Enterprise URL."
        case .githubOAuthNotConfigured: return "GitHub OAuth client ID is missing. Enter it in the sign-in form."
        case .oauthCancelled: return "GitHub sign-in was cancelled."
        case .oauthFailed: return "GitHub sign-in failed. Please try again."
        }
    }
}
