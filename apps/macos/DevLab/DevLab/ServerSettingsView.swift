import SwiftUI

// ── Server settings: local (spawned) vs hosted (client/VPC/SaaS) ─────────────
// Empty URL = local mode — the app runs `node index.js ui` itself.
// A URL like https://devlab.corp.com = hosted mode — connect only, Bearer auth.
struct ServerSettingsView: View {
    @Environment(AgentService.self) var agentService
    @Environment(\.dismiss) private var dismiss
    @State private var url: String = ""
    @State private var key: String = ""
    @State private var testResult: String? = nil
    @State private var testing = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Image(systemName: "server.rack")
                    .foregroundColor(.appAccent)
                Text("Server")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundColor(.appText)
                Spacer()
            }

            VStack(alignment: .leading, spacing: 4) {
                Text("Server URL")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundColor(.appTextDim)
                TextField("Empty = run locally (localhost:4321)", text: $url)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(size: 12, design: .monospaced))
                Text("e.g. https://devlab.corp.com — leave empty for local mode")
                    .font(.system(size: 10))
                    .foregroundColor(.appTextDim.opacity(0.7))
            }

            VStack(alignment: .leading, spacing: 4) {
                Text("API Key")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundColor(.appTextDim)
                SecureField("DEVLAB_API_KEY (empty if server is open)", text: $key)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(size: 12, design: .monospaced))
            }

            if let result = testResult {
                HStack(spacing: 6) {
                    Image(systemName: result.hasPrefix("✓") ? "checkmark.circle.fill" : "xmark.circle.fill")
                        .foregroundColor(result.hasPrefix("✓") ? .green : .red)
                    Text(result)
                        .font(.system(size: 11))
                        .foregroundColor(.appText)
                }
            }

            HStack {
                Button(action: testConnection) {
                    if testing { ProgressView().controlSize(.small) }
                    else { Text("Test Connection") }
                }
                .disabled(testing)

                Spacer()

                Button("Cancel") { dismiss() }
                Button("Save & Connect") {
                    agentService.serverURL = url.trimmingCharacters(in: .whitespaces)
                    agentService.apiKey = key.trimmingCharacters(in: .whitespaces)
                    agentService.reconnect()
                    dismiss()
                }
                .keyboardShortcut(.defaultAction)
            }
        }
        .padding(16)
        .frame(width: 380)
        .background(Color.appSurface)
        .onAppear {
            url = agentService.serverURL
            key = agentService.apiKey
        }
    }

    private func testConnection() {
        testing = true
        testResult = nil
        let base = url.trimmingCharacters(in: .whitespaces).isEmpty
            ? "http://localhost:4321"
            : url.trimmingCharacters(in: .whitespaces)
        let trimmed = base.hasSuffix("/") ? String(base.dropLast()) : base

        Task {
            defer { testing = false }
            guard let u = URL(string: "\(trimmed)/api/providers") else {
                testResult = "✗ Invalid URL"
                return
            }
            var req = URLRequest(url: u)
            req.timeoutInterval = 8
            let k = key.trimmingCharacters(in: .whitespaces)
            if !k.isEmpty { req.setValue("Bearer \(k)", forHTTPHeaderField: "Authorization") }
            do {
                let (_, res) = try await URLSession.shared.data(for: req)
                switch (res as? HTTPURLResponse)?.statusCode ?? 0 {
                case 200: testResult = "✓ Connected"
                case 401: testResult = "✗ Reachable, but API key rejected"
                case let c: testResult = "✗ Server returned HTTP \(c)"
                }
            } catch {
                testResult = "✗ Unreachable: \(error.localizedDescription)"
            }
        }
    }
}
