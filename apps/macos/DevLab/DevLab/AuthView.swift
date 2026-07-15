import SwiftUI
import AppKit

// ── Sign In / Sign Up window ──────────────────────────────────────────────────
struct AuthView: View {
    @Environment(AuthService.self) var auth
    @State private var mode: AuthMode = .signIn

    enum AuthMode { case signIn, signUp }

    var body: some View {
        ZStack {
            // Background gradient
            LinearGradient(
                colors: [
                    Color(nsColor: NSColor(red: 0.06, green: 0.06, blue: 0.10, alpha: 1)),
                    Color(nsColor: NSColor(red: 0.04, green: 0.04, blue: 0.08, alpha: 1))
                ],
                startPoint: .topLeading, endPoint: .bottomTrailing
            )
            .ignoresSafeArea()

            // Subtle grid overlay
            GeometryReader { geo in
                Canvas { ctx, size in
                    let spacing: CGFloat = 40
                    var path = Path()
                    var x: CGFloat = 0
                    while x < size.width { path.move(to: CGPoint(x: x, y: 0)); path.addLine(to: CGPoint(x: x, y: size.height)); x += spacing }
                    var y: CGFloat = 0
                    while y < size.height { path.move(to: CGPoint(x: 0, y: y)); path.addLine(to: CGPoint(x: size.width, y: y)); y += spacing }
                    ctx.stroke(path, with: .color(Color.white.opacity(0.03)), lineWidth: 0.5)
                }
            }
            .ignoresSafeArea()

            VStack(spacing: 0) {
                Spacer()

                // Card
                VStack(spacing: 28) {
                    // Logo & branding
                    BrandHeader()

                    // Mode tabs
                    ModePicker(mode: $mode)

                    // Form
                    if mode == .signIn {
                        SignInForm()
                    } else {
                        SignUpForm()
                    }
                }
                .padding(36)
                .frame(width: 420)
                .background(
                    RoundedRectangle(cornerRadius: 16)
                        .fill(Color(nsColor: NSColor(red: 0.09, green: 0.09, blue: 0.13, alpha: 1)))
                        .overlay(
                            RoundedRectangle(cornerRadius: 16)
                                .strokeBorder(Color.white.opacity(0.08), lineWidth: 1)
                        )
                )
                .shadow(color: .black.opacity(0.5), radius: 40, x: 0, y: 20)

                Spacer()
            }
        }
    }
}

// ── Brand header ──────────────────────────────────────────────────────────────
private struct BrandHeader: View {
    var body: some View {
        VStack(spacing: 10) {
            ZStack {
                RoundedRectangle(cornerRadius: 14)
                    .fill(LinearGradient(
                        colors: [Color(red: 0.42, green: 0.36, blue: 1.0),
                                 Color(red: 0.20, green: 0.60, blue: 1.0)],
                        startPoint: .topLeading, endPoint: .bottomTrailing))
                    .frame(width: 52, height: 52)
                Image(systemName: "cpu.fill")
                    .font(.system(size: 24, weight: .semibold))
                    .foregroundColor(.white)
            }
            Text("DevLab")
                .font(.system(size: 22, weight: .bold, design: .default))
                .foregroundColor(.appAccent)
            Text("Your autonomous AI coding assistant")
                .font(.system(size: 13))
                .foregroundColor(Color.white.opacity(0.45))
        }
    }
}

// ── Mode picker (Sign In / Sign Up) ──────────────────────────────────────────
private struct ModePicker: View {
    @Binding var mode: AuthView.AuthMode
    var body: some View {
        HStack(spacing: 0) {
            ForEach([AuthView.AuthMode.signIn, .signUp], id: \.self) { m in
                Button(action: { withAnimation(.easeInOut(duration: 0.15)) { mode = m } }) {
                    Text(m == .signIn ? "Sign In" : "Create Account")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundColor(mode == m ? .white : Color.white.opacity(0.45))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 8)
                        .background(
                            mode == m
                                ? RoundedRectangle(cornerRadius: 8)
                                    .fill(Color(red: 0.42, green: 0.36, blue: 1.0).opacity(0.3))
                                    .overlay(RoundedRectangle(cornerRadius: 8)
                                        .strokeBorder(Color(red: 0.42, green: 0.36, blue: 1.0).opacity(0.5), lineWidth: 1))
                                : nil
                        )
                }
                .buttonStyle(.plain)
            }
        }
        .padding(4)
        .background(RoundedRectangle(cornerRadius: 10)
            .fill(Color.white.opacity(0.05)))
    }
}

// ── Sign-in form ──────────────────────────────────────────────────────────────
private struct SignInForm: View {
    @Environment(AuthService.self) var auth
    @State private var email = ""
    @State private var password = ""
    @State private var showPassword = false
    @State private var provider: ProviderOption = .github
    @State private var enterpriseURL = ""
    @State private var enterpriseUsername = ""
    @State private var enterpriseToken = ""
    @State private var showEnterpriseToken = false

    enum ProviderOption: String, CaseIterable, Identifiable {
        case github = "GitHub"
        case enterprise = "GitHub Enterprise"
        var id: String { rawValue }
    }

    var body: some View {
        @Bindable var auth = auth
        VStack(spacing: 14) {
            AuthField(label: "GitHub OAuth Client ID", placeholder: "Iv1.xxxxxxxx",
                      text: $auth.githubOAuthClientId, icon: "key.horizontal")

            AuthField(label: "Email", placeholder: "you@example.com",
                      text: $email, icon: "envelope")
            AuthField(label: "Password", placeholder: "••••••••",
                      text: $password, icon: "lock",
                      isSecure: !showPassword,
                      trailingIcon: showPassword ? "eye.slash" : "eye") {
                showPassword.toggle()
            }

            if let err = auth.errorMessage {
                ErrorBanner(message: err)
            }

            // Sign in button
            PrimaryButton(label: "Sign In", isLoading: auth.isLoading) {
                Task { await auth.signIn(email: email, password: password) }
            }
            .disabled(email.isEmpty || password.isEmpty || auth.isLoading)

            HStack {
                Rectangle().fill(Color.white.opacity(0.1)).frame(height: 1)
                Text("or")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundColor(Color.white.opacity(0.4))
                Rectangle().fill(Color.white.opacity(0.1)).frame(height: 1)
            }
            .padding(.vertical, 4)

            VStack(alignment: .leading, spacing: 8) {
                Text("Git Provider")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundColor(Color.white.opacity(0.55))
                HStack(spacing: 8) {
                    ForEach(ProviderOption.allCases) { option in
                        Button {
                            withAnimation(.easeInOut(duration: 0.15)) { provider = option }
                        } label: {
                            Text(option.rawValue)
                                .font(.system(size: 12, weight: .semibold))
                                .foregroundColor(provider == option ? .white : Color.white.opacity(0.6))
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 8)
                                .background(
                                    RoundedRectangle(cornerRadius: 8)
                                        .fill(provider == option ? Color.appAccent.opacity(0.3) : Color.white.opacity(0.04))
                                        .overlay(
                                            RoundedRectangle(cornerRadius: 8)
                                                .strokeBorder(provider == option ? Color.appAccent.opacity(0.65) : Color.white.opacity(0.12), lineWidth: 1)
                                        )
                                )
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .disabled(auth.isLoading)

            if provider == .enterprise {
                VStack(spacing: 10) {
                    AuthField(label: "Enterprise URL", placeholder: "https://github.yourcompany.com",
                              text: $enterpriseURL, icon: "globe")
                    AuthField(label: "Username", placeholder: "octocat",
                              text: $enterpriseUsername, icon: "person")
                    AuthField(label: "Personal Access Token", placeholder: "ghp_xxx...",
                              text: $enterpriseToken, icon: "key",
                              isSecure: !showEnterpriseToken,
                              trailingIcon: showEnterpriseToken ? "eye.slash" : "eye") {
                        showEnterpriseToken.toggle()
                    }
                    SecondaryButton(label: "Continue with GitHub Enterprise", icon: "checkmark.seal") {
                        Task {
                            await auth.signInWithGitHubEnterprise(
                                serverURL: enterpriseURL,
                                username: enterpriseUsername,
                                token: enterpriseToken
                            )
                        }
                    }
                    .disabled(enterpriseURL.isEmpty || enterpriseUsername.isEmpty || enterpriseToken.isEmpty || auth.isLoading)
                }
                .transition(.opacity.combined(with: .move(edge: .top)))
            } else {
                SecondaryButton(label: "Continue with GitHub", icon: "chevron.left.forwardslash.chevron.right") {
                    Task { await auth.signInWithGitHub() }
                }
                .disabled(auth.githubOAuthClientId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || auth.isLoading)
            }
        }
    }
}

// ── Sign-up form ──────────────────────────────────────────────────────────────
private struct SignUpForm: View {
    @Environment(AuthService.self) var auth
    @State private var name = ""
    @State private var email = ""
    @State private var password = ""
    @State private var showPassword = false

    var body: some View {
        @Bindable var auth = auth
        VStack(spacing: 14) {
            AuthField(label: "Full Name", placeholder: "Jane Smith",
                      text: $name, icon: "person")
            AuthField(label: "Email", placeholder: "you@example.com",
                      text: $email, icon: "envelope")
            AuthField(label: "Password", placeholder: "Min 8 characters",
                      text: $password, icon: "lock",
                      isSecure: !showPassword,
                      trailingIcon: showPassword ? "eye.slash" : "eye") {
                showPassword.toggle()
            }

            // Password strength indicator
            if !password.isEmpty {
                PasswordStrength(password: password)
            }

            if let err = auth.errorMessage {
                ErrorBanner(message: err)
            }

            PrimaryButton(label: "Create Account", isLoading: auth.isLoading) {
                Task { await auth.signUp(name: name, email: email, password: password) }
            }
            .disabled(name.isEmpty || email.isEmpty || password.count < 8 || auth.isLoading)
        }
    }
}

// ── Reusable field ────────────────────────────────────────────────────────────
private struct AuthField: View {
    let label: String
    let placeholder: String
    @Binding var text: String
    var icon: String
    var isSecure: Bool = false
    var trailingIcon: String? = nil
    var trailingAction: (() -> Void)? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label)
                .font(.system(size: 12, weight: .medium))
                .foregroundColor(Color.white.opacity(0.55))
            HStack(spacing: 10) {
                Image(systemName: icon)
                    .font(.system(size: 13))
                    .foregroundColor(Color.white.opacity(0.35))
                    .frame(width: 16)
                if isSecure {
                    SecureField(placeholder, text: $text)
                        .textFieldStyle(.plain)
                        .font(.system(size: 14))
                        .foregroundColor(.white)
                } else {
                    TextField(placeholder, text: $text)
                        .textFieldStyle(.plain)
                        .font(.system(size: 14))
                        .foregroundColor(.white)
                }
                if let ti = trailingIcon {
                    Button(action: { trailingAction?() }) {
                        Image(systemName: ti)
                            .font(.system(size: 12))
                            .foregroundColor(Color.white.opacity(0.35))
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(
                RoundedRectangle(cornerRadius: 8)
                    .fill(Color.white.opacity(0.05))
                    .overlay(RoundedRectangle(cornerRadius: 8)
                        .strokeBorder(Color.white.opacity(0.10), lineWidth: 1))
            )
        }
    }
}

// ── Primary CTA button ────────────────────────────────────────────────────────
private struct PrimaryButton: View {
    let label: String
    var isLoading: Bool = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if isLoading {
                    ProgressView()
                        .progressViewStyle(.circular)
                        .scaleEffect(0.7)
                        .tint(.white)
                }
                Text(label)
                    .font(.system(size: 14, weight: .semibold))
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 11)
            .background(
                LinearGradient(
                    colors: [Color(red: 0.42, green: 0.36, blue: 1.0),
                             Color(red: 0.20, green: 0.60, blue: 1.0)],
                    startPoint: .leading, endPoint: .trailing)
            )
            .foregroundColor(.white)
            .cornerRadius(9)
        }
        .buttonStyle(.plain)
        .padding(.top, 4)
    }
}

private struct SecondaryButton: View {
    let label: String
    let icon: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Image(systemName: icon)
                    .font(.system(size: 12, weight: .semibold))
                Text(label)
                    .font(.system(size: 13, weight: .semibold))
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 10)
            .background(
                RoundedRectangle(cornerRadius: 9)
                    .fill(Color.white.opacity(0.05))
                    .overlay(
                        RoundedRectangle(cornerRadius: 9)
                            .strokeBorder(Color.white.opacity(0.14), lineWidth: 1)
                    )
            )
            .foregroundColor(.white)
        }
        .buttonStyle(.plain)
    }
}

// ── Error banner ──────────────────────────────────────────────────────────────
private struct ErrorBanner: View {
    let message: String
    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 12))
                .foregroundColor(.orange)
            Text(message)
                .font(.system(size: 12))
                .foregroundColor(Color.orange.opacity(0.9))
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 7)
            .fill(Color.orange.opacity(0.12))
            .overlay(RoundedRectangle(cornerRadius: 7)
                .strokeBorder(Color.orange.opacity(0.25), lineWidth: 1)))
    }
}

// ── Password strength ─────────────────────────────────────────────────────────
private struct PasswordStrength: View {
    let password: String

    private var score: Int {
        var s = 0
        if password.count >= 8  { s += 1 }
        if password.count >= 12 { s += 1 }
        if password.range(of: "[A-Z]", options: .regularExpression) != nil { s += 1 }
        if password.range(of: "[0-9]", options: .regularExpression) != nil { s += 1 }
        if password.range(of: "[^A-Za-z0-9]", options: .regularExpression) != nil { s += 1 }
        return s
    }
    private var label: String { ["Very Weak","Weak","Fair","Good","Strong"][min(score, 4)] }
    private var color: Color  { [.red,.orange,.yellow, Color(red:0.4,green:0.8,blue:0.4),.green][min(score, 4)] }

    var body: some View {
        HStack(spacing: 4) {
            ForEach(0..<5) { i in
                Capsule()
                    .fill(i < score ? color : Color.white.opacity(0.12))
                    .frame(height: 3)
            }
            Text(label)
                .font(.system(size: 11))
                .foregroundColor(color)
                .frame(width: 60, alignment: .trailing)
        }
    }
}
