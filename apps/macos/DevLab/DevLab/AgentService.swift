import Foundation
import Network

extension Notification.Name {
    static let devlabFilesChanged = Notification.Name("devlab.filesChanged")
}

// ── Provider model (replaces [[String: Any]] for type safety) ─────────────────
struct ProviderInfo: Identifiable {
    let id: String
    let name: String
    var models: [ModelInfo]
}

struct ModelInfo: Identifiable {
    let id: String
    let label: String
}

@Observable
class AgentService {
    // ── State ──────────────────────────────────────────────────────────────────
    var isConnected: Bool = false
    var isThinking: Bool = false
    var messages: [ChatMessage] = []
    var serverStatus: String = "Starting…"
    var selectedProvider: String = "groq"
    var selectedModel: String = ""
    var providers: [ProviderInfo] = []
    var queuedCount: Int = 0

    // ── Server configuration (Settings → persisted in UserDefaults) ───────────
    // Empty serverURL = local mode: the app spawns `node index.js ui` itself.
    // A remote URL (e.g. https://devlab.corp.com) = hosted mode: connect only,
    // never spawn, send the API key on every request.
    var serverURL: String = UserDefaults.standard.string(forKey: "devlab.serverURL") ?? "" {
        didSet { UserDefaults.standard.set(serverURL, forKey: "devlab.serverURL") }
    }
    var apiKey: String = UserDefaults.standard.string(forKey: "devlab.apiKey") ?? "" {
        didSet { UserDefaults.standard.set(apiKey, forKey: "devlab.apiKey") }
    }

    private var serverProcess: Process?
    private var webSocketTask: URLSessionWebSocketTask?
    private var session: URLSession = .shared
    private let port = 4321
    private var reconnectTimer: Timer?
    private var queuedMessages: [String] = []

    var isRemote: Bool {
        let url = serverURL.trimmingCharacters(in: .whitespaces)
        guard !url.isEmpty else { return false }
        return !(url.contains("localhost") || url.contains("127.0.0.1"))
    }

    var baseURL: String {
        let url = serverURL.trimmingCharacters(in: .whitespaces)
        if url.isEmpty { return "http://localhost:\(port)" }
        return url.hasSuffix("/") ? String(url.dropLast()) : url
    }

    var wsURL: String {
        var ws = baseURL
            .replacingOccurrences(of: "https://", with: "wss://")
            .replacingOccurrences(of: "http://", with: "ws://")
        // Server accepts ?api_key= for WebSocket auth (headers unreliable on WS)
        if !apiKey.isEmpty { ws += "?api_key=\(apiKey.urlEncoded)" }
        return ws
    }

    // ── Authenticated requests ─────────────────────────────────────────────────
    private func makeRequest(_ path: String, method: String = "GET",
                             body: [String: Any]? = nil) -> URLRequest? {
        guard let url = URL(string: "\(baseURL)\(path)") else { return nil }
        var req = URLRequest(url: url)
        req.httpMethod = method
        if !apiKey.isEmpty {
            req.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        }
        return req
    }

    private func fetchJSON(_ path: String, method: String = "GET",
                           body: [String: Any]? = nil) async -> Any? {
        guard let req = makeRequest(path, method: method, body: body) else { return nil }
        guard let (data, res) = try? await URLSession.shared.data(for: req) else { return nil }
        if let http = res as? HTTPURLResponse, http.statusCode == 401 {
            await MainActor.run { self.serverStatus = "Unauthorized — set API key in Settings" }
            return nil
        }
        return try? JSONSerialization.jsonObject(with: data)
    }

    // ── Server lifecycle ───────────────────────────────────────────────────────
    func startServer() {
        serverStatus = isRemote ? "Connecting to \(baseURL)…" : "Starting agent server…"

        Task {
            if await isPortOpen() {
                await MainActor.run {
                    self.serverStatus = self.isRemote ? "Connected to remote" : "Server ready"
                    self.connectWebSocket()
                    Task { await self.loadProviders() }
                }
                return
            }
            if self.isRemote {
                // Hosted mode: never spawn — the server is managed by the client/vendor
                await MainActor.run {
                    self.serverStatus = "Cannot reach \(self.baseURL) — check URL/API key/VPN"
                }
                return
            }
            await MainActor.run { self.spawnServer() }
        }
    }

    // Apply new settings: tear down and reconnect (spawned local server kept alive)
    func reconnect() {
        connectGeneration += 1               // invalidate any in-flight receive loop
        webSocketTask?.cancel(with: .goingAway, reason: nil)
        webSocketTask = nil
        isConnected = false
        startServer()
    }

    private func isPortOpen() async -> Bool {
        guard let req = makeRequest("/api/providers") else { return false }
        guard let (_, res) = try? await URLSession.shared.data(for: req) else { return false }
        let code = (res as? HTTPURLResponse)?.statusCode ?? 0
        return code == 200 || code == 401   // 401 = reachable, key wrong — still "open"
    }

    private func spawnServer() {
        // ── 1. Try bundled devlab binary (distribution mode — no source code needed) ──
        // When built as a release app the binary lives at:
        //   DevLab.app/Contents/Resources/devlab
        let bundledBinary = Bundle.main.path(forResource: "devlab", ofType: nil)
            ?? Bundle.main.resourcePath.map { $0 + "/devlab" }

        if let binary = bundledBinary, FileManager.default.isExecutableFile(atPath: binary) {
            launchBinary(binary, args: ["serve", "--no-open", "--port", "\(port)"])
            return
        }

        // ── 2. Try global 'devlab' CLI (installed via npm link / install-cli.sh) ──
        let globalBinary = findInPath("devlab")
        if let binary = globalBinary {
            launchBinary(binary, args: ["serve", "--no-open", "--port", "\(port)"])
            return
        }

        // ── 3. Fall back: node index.js (developer / source mode) ──────────────
        let nodePaths = [
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
            "/usr/bin/node",
            "\(NSHomeDirectory())/.nvm/versions/node/\(nvmCurrentVersion())/bin/node",
            "\(NSHomeDirectory())/.asdf/shims/node"
        ]
        guard let nodePath = nodePaths.first(where: { FileManager.default.fileExists(atPath: $0) }) else {
            serverStatus = "Node.js not found. Install from nodejs.org or download the DevLab CLI."
            return
        }
        guard let agentRoot = findAgentRoot() else {
            serverStatus = "DevLab not found. Place devlab binary in app bundle or install globally."
            return
        }
        launchProcess(executablePath: nodePath,
                      args: ["index.js", "serve", agentRoot, "--no-open", "--port", "\(port)"],
                      workingDirectory: agentRoot)
    }

    private func launchBinary(_ binaryPath: String, args: [String]) {
        launchProcess(executablePath: binaryPath, args: args, workingDirectory: nil)
    }

    private func launchProcess(executablePath: String, args: [String], workingDirectory: String?) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executablePath)
        process.arguments = args
        if let cwd = workingDirectory {
            process.currentDirectoryURL = URL(fileURLWithPath: cwd)
        }
        process.environment = ProcessInfo.processInfo.environment.merging(
            ["UI_PORT": "\(port)", "TERM": "xterm-256color"],
            uniquingKeysWith: { $1 }
        )

        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe

        var didConnect = false
        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty, let line = String(data: data, encoding: .utf8) else { return }
            DispatchQueue.main.async {
                if let last = line.split(separator: "\n").last.map(String.init),
                   !last.trimmingCharacters(in: .whitespaces).isEmpty,
                   self?.isConnected != true {
                    self?.serverStatus = last.trimmingCharacters(in: .whitespaces)
                }
            }
            if !didConnect, line.contains("DevLab Server Ready") || line.contains("running at") || line.contains("localhost:") {
                didConnect = true
                DispatchQueue.main.async {
                    self?.serverStatus = "Server ready"
                    self?.connectWebSocket()
                    Task { await self?.loadProviders() }
                }
            }
        }

        do {
            try process.run()
            serverProcess = process
        } catch {
            serverStatus = "Failed to start: \(error.localizedDescription)"
        }
    }

    private func findInPath(_ name: String) -> String? {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/which")
        p.arguments = [name]
        let pipe = Pipe()
        p.standardOutput = pipe
        try? p.run(); p.waitUntilExit()
        let out = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return out.isEmpty ? nil : out
    }

    func stopServer() {
        webSocketTask?.cancel(with: .goingAway, reason: nil)
        serverProcess?.terminate()
        serverProcess = nil
    }

    private func findAgentRoot() -> String? {
        // 1. Bundled inside .app
        if let bundled = Bundle.main.path(forResource: "agent", ofType: nil),
           FileManager.default.fileExists(atPath: bundled + "/index.js") {
            return bundled
        }
        // 2. Development: walk up from source file at compile time
        let devFromSource = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .path
        if FileManager.default.fileExists(atPath: devFromSource + "/index.js") {
            return devFromSource
        }
        // 3. Known development location
        let known = "\(NSHomeDirectory())/Agent"
        if FileManager.default.fileExists(atPath: known + "/index.js") {
            return known
        }
        return nil
    }

    private func nvmCurrentVersion() -> String {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/bash")
        p.arguments = ["-c", "cat ~/.nvm/alias/default 2>/dev/null | tr -d '\n'"]
        let pipe = Pipe()
        p.standardOutput = pipe
        try? p.run(); p.waitUntilExit()
        return String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
    }

    // ── WebSocket ──────────────────────────────────────────────────────────────
    private var connectGeneration = 0

    func connectWebSocket() {
        // Guard against duplicate connects (spawn log handler, reconnect races) —
        // every extra connection resets the server-side agent session.
        if isConnected, webSocketTask != nil { return }
        guard let url = URL(string: wsURL) else { return }
        webSocketTask?.cancel(with: .goingAway, reason: nil)
        connectGeneration += 1
        let generation = connectGeneration
        webSocketTask = session.webSocketTask(with: url)
        webSocketTask?.resume()
        isConnected = true
        Task { await receiveMessages(generation: generation) }
    }

    private func receiveMessages(generation: Int) async {
        guard let ws = webSocketTask else { return }
        do {
            while true {
                let message = try await ws.receive()
                if case .string(let text) = message {
                    await MainActor.run { handleWSMessage(text) }
                }
            }
        } catch {
            // A stale loop (superseded connection) must not trigger reconnects
            guard generation == connectGeneration else { return }
            await MainActor.run {
                isConnected = false
                serverStatus = "Reconnecting…"
            }
            try? await Task.sleep(for: .seconds(2))
            guard generation == connectGeneration else { return }
            connectWebSocket()
        }
    }

    @MainActor
    private func handleWSMessage(_ text: String) {
        guard let data = text.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = json["type"] as? String else { return }

        switch type {
        case "connected":
            serverStatus = "Connected"

        case "thinking":
            isThinking = true
            addThinkingIndicator()

        case "token":
            removeThinkingIndicator()
            appendOrCreateAgentMessage(json["text"] as? String ?? "")

        case "tool_call":
            let name = json["name"] as? String ?? ""
            let argsData = (try? JSONSerialization.data(withJSONObject: json["args"] ?? "")) ?? Data()
            let args = String(data: argsData, encoding: .utf8) ?? ""
            appendToolCall(name: name, args: args)

        case "tool_result":
            let toolName = json["name"] as? String ?? ""
            let result = json["resultStr"] as? String ?? ""
            updateToolResult(name: toolName, result: result)
            if shouldTriggerFileRefresh(toolName: toolName, result: result) {
                NotificationCenter.default.post(name: .devlabFilesChanged, object: nil)
            }

        case "done":
            isThinking = false
            removeThinkingIndicator()
            NotificationCenter.default.post(name: .devlabFilesChanged, object: nil)
            dispatchNextQueuedMessageIfNeeded()

        case "error":
            isThinking = false
            removeThinkingIndicator()
            messages.append(ChatMessage(role: .error, content: json["text"] as? String ?? "Unknown error"))
            dispatchNextQueuedMessageIfNeeded()

        case "cleared", "session_cleared":
            messages.removeAll()
            isThinking = false
            currentAgentMessageIndex = nil
            queuedMessages.removeAll()
            queuedCount = 0

        default: break
        }
    }

    // ── Send messages ──────────────────────────────────────────────────────────
    func sendMessage(_ text: String) {
        guard !text.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        messages.append(ChatMessage(role: .user, content: text))
        if isThinking {
            queuedMessages.append(text)
            queuedCount = queuedMessages.count
            messages.append(ChatMessage(role: .agent, content: "Queued request #\(queuedMessages.count). Running after current response…"))
            return
        }
        sendNow(text)
    }

    func newSession() {
        // Reset local chat state immediately for a fresh session
        messages.removeAll()
        isThinking = false
        currentAgentMessageIndex = nil
        queuedMessages.removeAll()
        queuedCount = 0
        Task { try? await wsSend(["type": "new_session"]) }
    }

    func clearContext() {
        queuedMessages.removeAll()
        queuedCount = 0
        Task { try? await wsSend(["type": "clear"]) }
    }

    private func wsSend(_ payload: [String: Any]) async throws {
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let str = String(data: data, encoding: .utf8) else { return }
        try await webSocketTask?.send(.string(str))
    }

    // ── REST API — async/await ─────────────────────────────────────────────────
    @MainActor
    func loadProviders() async {
        guard let providers = try? await fetchProviders() else { return }
        self.providers = providers
        self.selectedProvider = providers.first?.name ?? ""
        self.selectedModel = providers.first?.models.first?.id ?? ""
    }

    func loadFileTree(projectPath: String) async throws -> [FileNode] {
        // Point the server's workspace at the opened project first — otherwise
        // file paths resolve against the agent's own folder and reads get 403.
        await setWorkspace(path: projectPath)
        guard let json = await fetchJSON("/api/files?path=.") as? [String: Any],
              let files = json["files"] as? [[String: Any]] else { return [] }
        return files.map { Self.parseFileNode($0) }
    }

    private func setWorkspace(path: String) async {
        guard !path.isEmpty else { return }
        _ = await fetchJSON("/api/workspace", method: "POST", body: ["path": path])
    }

    func loadFile(path: String) async throws -> String? {
        guard var comps = URLComponents(string: "\(baseURL)/api/file") else { return nil }
        comps.queryItems = [URLQueryItem(name: "path", value: path)]
        guard let url = comps.url else { return nil }
        var req = URLRequest(url: url)
        req.httpMethod = "GET"
        if !apiKey.isEmpty {
            req.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        }
        guard let (data, _) = try? await URLSession.shared.data(for: req),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return json["content"] as? String
    }

    func saveFile(path: String, content: String) async throws -> Bool {
        guard let req = makeRequest("/api/file", method: "POST",
                                    body: ["path": path, "content": content]) else { return false }
        let (_, res) = try await URLSession.shared.data(for: req)
        return (res as? HTTPURLResponse)?.statusCode == 200
    }

    // ── Private fetch helpers ──────────────────────────────────────────────────
    private func fetchProviders() async throws -> [ProviderInfo] {
        guard let list = await fetchJSON("/api/providers") as? [[String: Any]] else { return [] }
        return list.compactMap { dict in
            guard let name = dict["name"] as? String else { return nil }
            let models = (dict["models"] as? [[String: Any]] ?? []).map {
                ModelInfo(id: $0["id"] as? String ?? $0["value"] as? String ?? "",
                          label: $0["label"] as? String ?? $0["id"] as? String ?? "")
            }
            return ProviderInfo(id: name, name: name, models: models)
        }
    }

    static func parseFileNode(_ dict: [String: Any]) -> FileNode {
        let name = dict["name"] as? String ?? ""
        let path = dict["path"] as? String ?? ""
        let isDir = (dict["type"] as? String) == "dir"
        let childDicts = dict["children"] as? [[String: Any]] ?? []
        let children = childDicts.map { parseFileNode($0) }
        return FileNode(name: name, path: path, isDirectory: isDir, children: children)
    }

    // ── Message helpers ────────────────────────────────────────────────────────
    private var currentAgentMessageIndex: Int? = nil

    private func addThinkingIndicator() {
        messages.append(ChatMessage(role: .agent, content: "…"))
        currentAgentMessageIndex = messages.count - 1
    }

    private func removeThinkingIndicator() {
        if let idx = currentAgentMessageIndex, idx < messages.count,
           messages[idx].content == "…" {
            messages.remove(at: idx)
            currentAgentMessageIndex = nil
        }
    }

    private func appendOrCreateAgentMessage(_ content: String) {
        if let idx = currentAgentMessageIndex, idx < messages.count {
            messages[idx].content = content
        } else {
            messages.append(ChatMessage(role: .agent, content: content))
            currentAgentMessageIndex = messages.count - 1
        }
    }

    private func appendToolCall(name: String, args: String) {
        let tool = ToolCall(name: name, args: args)
        if let idx = currentAgentMessageIndex, idx < messages.count {
            messages[idx].toolCalls.append(tool)
        } else {
            var msg = ChatMessage(role: .tool, content: "")
            msg.toolCalls = [tool]
            messages.append(msg)
        }
    }

    private func updateToolResult(name: String, result: String) {
        for i in messages.indices.reversed() {
            if let j = messages[i].toolCalls.indices.last(where: { messages[i].toolCalls[$0].name == name && !messages[i].toolCalls[$0].done }) {
                messages[i].toolCalls[j].result = result
                messages[i].toolCalls[j].done = true
                return
            }
        }
    }

    private func shouldTriggerFileRefresh(toolName: String, result: String) -> Bool {
        let n = toolName.lowercased()
        if n.contains("edit") || n.contains("write") || n.contains("apply_patch") || n.contains("fix") || n.contains("create") || n.contains("delete") {
            return true
        }
        let r = result.lowercased()
        return r.contains("updated") || r.contains("modified") || r.contains("created") || r.contains("deleted") || r.contains("patched")
    }

    private func sendNow(_ text: String) {
        isThinking = true
        let routedText = enrichPromptForTicketImplementation(text)
        Task {
            try? await wsSend(["type": "chat", "text": routedText,
                               "provider": selectedProvider, "model": selectedModel])
        }
    }

    private func dispatchNextQueuedMessageIfNeeded() {
        guard !queuedMessages.isEmpty else {
            queuedCount = 0
            return
        }
        let next = queuedMessages.removeFirst()
        queuedCount = queuedMessages.count
        sendNow(next)
    }

    private func enrichPromptForTicketImplementation(_ text: String) -> String {
        let lower = text.lowercased()
        let ticketSignals = ["ticket", "jira", "issue", "bug", "story", "task", "implement", "develop", "fix"]
        let hasJiraKey = text.range(of: #"\b[A-Z][A-Z0-9]+-\d+\b"#, options: .regularExpression) != nil
        guard hasJiraKey || ticketSignals.contains(where: { lower.contains($0) }) else { return text }
        let guardrails = """

        Implement this request directly in the project files.
        If a Jira key is provided (like ABC-123), treat it as the primary ticket reference.
        Choose the correct existing files for the change, edit them, and keep changes minimal and production-safe.
        After editing, summarize what files were changed and what was implemented.
        """
        return text + guardrails
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
private extension String {
    var urlEncoded: String {
        addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? self
    }
}
