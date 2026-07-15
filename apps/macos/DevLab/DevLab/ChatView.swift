import SwiftUI

struct ChatView: View {
    @Environment(AgentService.self) var agentService
    @State private var inputText: String = ""
    @State private var scrollProxy: ScrollViewProxy? = nil
    @State private var showProfile = false
    @State private var showServerSettings = false
    @State private var headerDashPhase: CGFloat = 0
    @State private var thinkingStartedAt = Date()
    @State private var thinkingElapsed = 0
    @State private var voiceInput = VoiceInputService()
    @State private var voiceBaseText = ""

    var body: some View {
        VStack(spacing: 0) {
            // Header
            HStack {
                Image(systemName: "brain")
                    .foregroundColor(.appAccent)
                    .font(.system(size: 13))
                Text("CHATS")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundColor(.appTextDim)
                    .tracking(1)
                Spacer()
                Button(action: agentService.newSession) {
                    Label("New", systemImage: "plus.square")
                        .font(.system(size: 11))
                        .foregroundColor(.appTextDim)
                }
                .buttonStyle(.plain)
                .help("New session (⌘⇧N)")

                Button(action: agentService.clearContext) {
                    Image(systemName: "trash")
                        .font(.system(size: 11))
                        .foregroundColor(.appTextDim)
                }
                .buttonStyle(.plain)
                .help("Clear context")

                Button(action: { showServerSettings.toggle() }) {
                    Image(systemName: "server.rack")
                        .font(.system(size: 11))
                        .foregroundColor(.appTextDim)
                }
                .buttonStyle(.plain)
                .help("Server settings (local or hosted)")
                .popover(isPresented: $showServerSettings, arrowEdge: .top) {
                    ServerSettingsView()
                        .environment(\.colorScheme, .dark)
                }

                Button(action: { showProfile.toggle() }) {
                    Image(systemName: "person.crop.circle")
                        .font(.system(size: 13))
                        .foregroundColor(.appTextDim)
                }
                .buttonStyle(.plain)
                .help("Profile settings")
                .popover(isPresented: $showProfile, arrowEdge: .top) {
                    AgentProfileView()
                        .frame(width: 300)
                        .padding(12)
                        .background(Color.appSurface)
                        .environment(\.colorScheme, .dark)   // dark surface → white text
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(Color.appSurface)
            .overlay(
                RoundedRectangle(cornerRadius: 8)
                    .stroke(
                        Color.appAccent.opacity(agentService.isThinking ? 0.7 : 0),
                        style: StrokeStyle(lineWidth: 1.2, dash: [6, 4], dashPhase: headerDashPhase)
                    )
                    .padding(.horizontal, 6)
                    .padding(.vertical, 3)
            )

            Divider().background(Color.appBorder)

            // Messages
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 10) {
                        ForEach(agentService.messages) { msg in
                            MessageBubble(message: msg)
                                .id(msg.id)
                        }

                        if agentService.isThinking {
                            ThinkingBubble()
                                .id("thinking")
                        }
                        Color.clear
                            .frame(height: 1)
                            .id("bottom-anchor")
                    }
                    .padding(12)
                }
                .background(Color.appBackground)
                .onAppear {
                    scrollToBottom(proxy: proxy, animated: false)
                }
                .onChange(of: messageSignature) { _, _ in
                    scrollToBottom(proxy: proxy, animated: true)
                }
                .onChange(of: agentService.isThinking) { _, thinking in
                    if thinking {
                        thinkingStartedAt = Date()
                        thinkingElapsed = 0
                        headerDashPhase = 0
                        withAnimation(.linear(duration: 1.0).repeatForever(autoreverses: false)) {
                            headerDashPhase = -20
                        }
                        scrollToBottom(proxy: proxy, animated: true)
                    } else {
                        headerDashPhase = 0
                        scrollToBottom(proxy: proxy, animated: true)
                    }
                }
                .onReceive(Timer.publish(every: 1, on: .main, in: .common).autoconnect()) { _ in
                    guard agentService.isThinking else { return }
                    thinkingElapsed = Int(Date().timeIntervalSince(thinkingStartedAt))
                }
            }

            Divider().background(Color.appBorder)

            // Input area
            VStack(spacing: 8) {
                HStack(alignment: .bottom, spacing: 8) {
                    TextField("Ask anything about your code or use voice input…", text: $inputText)
                        .font(.system(size: 13))
                        .foregroundColor(.appText)
                        .textFieldStyle(.plain)
                        .padding(.horizontal, 10)
                        .frame(minHeight: 80)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 9)
                        .onSubmit(send)
                    .background(Color.appSurface2)
                    .cornerRadius(8)
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.appBorder, lineWidth: 1))

                    Button(action: toggleVoiceInput) {
                        Image(systemName: voiceInput.isListening ? "stop.circle.fill" : "mic.circle")
                            .font(.system(size: 28))
                            .foregroundColor(voiceInput.isListening ? .red : .appTextDim)
                    }
                    .buttonStyle(.plain)
                    .disabled(!agentService.isConnected || agentService.isThinking)
                    .help(voiceInput.isListening ? "Stop voice input" : "Start voice input")

                    Button(action: send) {
                        ZStack {
                            if agentService.isThinking {
                                AnalyzingSendGlyph()
                            } else {
                                Image(systemName: "arrow.up.circle.fill")
                                    .font(.system(size: 28))
                                    .foregroundColor(canSend ? .appAccent : .appTextDim.opacity(0.4))
                            }
                        }
                        .frame(width: 28, height: 28)
                    }
                    .buttonStyle(.plain)
                    .disabled(!canSend)
                    .keyboardShortcut(.return, modifiers: .command)
                }

                HStack {
                    Circle()
                        .fill(agentService.isConnected ? Color.green : Color.orange)
                        .frame(width: 6, height: 6)
                    Text(agentService.serverStatus)
                        .font(.system(size: 11))
                        .foregroundColor(.appTextDim)
                    Spacer()
                    if voiceInput.isListening {
                        Text("Listening… speak your prompt")
                            .font(.system(size: 11))
                            .foregroundColor(.red)
                    } else if let voiceError = voiceInput.lastError {
                        Text(voiceError)
                            .font(.system(size: 11))
                            .foregroundColor(.orange)
                            .lineLimit(1)
                    } else if agentService.isThinking {
                        Text("Analyzing… \(thinkingElapsed)s")
                            .font(.system(size: 11))
                            .foregroundColor(.appAccent)
                    } else if agentService.queuedCount > 0 {
                        Text("Queued… \(agentService.queuedCount)")
                            .font(.system(size: 11))
                            .foregroundColor(.appAccent)
                    }
                }
            }
            .padding(10)
            .background(Color.appSurface)
        }
        .background(Color.appSurface)
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(
                    Color.appAccent.opacity(agentService.isThinking ? 0.65 : 0),
                    style: StrokeStyle(lineWidth: 1.3, dash: [7, 4], dashPhase: headerDashPhase)
                )
                .padding(4)
        )
        .onDisappear {
            voiceInput.stop()
        }
    }

    var canSend: Bool {
        !inputText.trimmingCharacters(in: .whitespaces).isEmpty &&
        agentService.isConnected
    }

    func send() {
        let text = inputText.trimmingCharacters(in: .whitespaces)
        guard canSend else { return }
        agentService.sendMessage(text)
        inputText = ""
    }

    func toggleVoiceInput() {
        if voiceInput.isListening {
            voiceInput.stop()
            return
        }

        voiceBaseText = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        voiceInput.start { transcript in
            let spokenText = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
            inputText = [voiceBaseText, spokenText]
                .filter { !$0.isEmpty }
                .joined(separator: voiceBaseText.isEmpty || spokenText.isEmpty ? "" : " ")
        }
    }

    var messageSignature: String {
        agentService.messages.map { "\($0.id.uuidString):\($0.content.count):\($0.toolCalls.count)" }.joined(separator: "|")
            + "#thinking:\(agentService.isThinking)#queued:\(agentService.queuedCount)"
    }

    private func scrollToBottom(proxy: ScrollViewProxy, animated: Bool) {
        if animated {
            withAnimation(.easeOut(duration: 0.2)) {
                proxy.scrollTo("bottom-anchor", anchor: .bottom)
            }
        } else {
            proxy.scrollTo("bottom-anchor", anchor: .bottom)
        }
    }
}

struct AgentProfileView: View {
    @Environment(AuthService.self) var authService
    @AppStorage("agent.profile.premium") private var isPremium: Bool = false
    @AppStorage("agent.profile.autoFix") private var autoFixIssues: Bool = true
    @AppStorage("agent.profile.showVerboseLogs") private var showVerboseLogs: Bool = false

    var body: some View {
        Group {
            if authService.isSignedIn, let user = authService.currentUser {
                signedInView(user: user)
            } else {
                signedOutView
            }
        }
        .padding(6)
        .background(Color.appSurface)
    }

    // ── Signed in: user info + settings + sign out ───────────────────────────
    private func signedInView(user: UserProfile) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Circle()
                    .fill(isPremium ? Color.yellow.opacity(0.35) : Color.appSurface2)
                    .frame(width: 34, height: 34)
                    .overlay(
                        Text(user.avatarInitials)
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundColor(.appText)
                    )

                VStack(alignment: .leading, spacing: 2) {
                    Text(user.email)
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundColor(.appText)
                    Text(user.authProviderLabel)
                        .font(.system(size: 11))
                        .foregroundColor(.appAccent)
                    Text(isPremium ? "Premium Plan" : "Free Plan")
                        .font(.system(size: 11))
                        .foregroundColor(isPremium ? .yellow : .appTextDim)
                }
                Spacer()
            }

            Divider().background(Color.appBorder)

            VStack(alignment: .leading, spacing: 8) {
                Text("Settings")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundColor(.appTextDim)

                Toggle("Premium", isOn: $isPremium)
                Toggle("Auto-fix issues", isOn: $autoFixIssues)
                Toggle("Verbose tool logs", isOn: $showVerboseLogs)
            }
            .font(.system(size: 12))

            Divider().background(Color.appBorder)

            Button(role: .destructive) {
                authService.signOut()   // routes app back to the login screen
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "rectangle.portrait.and.arrow.right")
                    Text("Sign Out")
                }
                .font(.system(size: 12, weight: .medium))
                .frame(maxWidth: .infinity)
            }
            .controlSize(.regular)
        }
    }

    // ── Signed out: prompt to log in ─────────────────────────────────────────
    private var signedOutView: some View {
        VStack(spacing: 10) {
            Image(systemName: "person.crop.circle.badge.questionmark")
                .font(.system(size: 28))
                .foregroundColor(.appTextDim)
            Text("Not signed in")
                .font(.system(size: 12, weight: .semibold))
                .foregroundColor(.appText)
            Text("Sign in to sync your settings and unlock premium features.")
                .font(.system(size: 11))
                .foregroundColor(.appTextDim)
                .multilineTextAlignment(.center)

            Button {
                authService.signOut()   // ensures state is cleared → shows AuthView
            } label: {
                Text("Sign In")
                    .font(.system(size: 12, weight: .semibold))
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
        }
        .frame(width: 200)
    }
}

// ── Message bubbles ───────────────────────────────────────────────────────────
struct MessageBubble: View {
    let message: ChatMessage
    @State private var isCopied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            // Role label
            HStack {
                Text(roleLabel)
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundColor(roleColor)
                    .tracking(0.5)
                Spacer()
                Button(action: copyContent) {
                    Image(systemName: isCopied ? "checkmark" : "doc.on.doc")
                        .font(.system(size: 10))
                        .foregroundColor(.appTextDim)
                }
                .buttonStyle(.plain)
                .opacity(0.6)
            }

            // Content
            Text(message.content)
                .font(.system(size: 13))
                .foregroundColor(.appText)
                .textSelection(.enabled)
                .padding(10)
                .background(bubbleBg)
                .cornerRadius(8)
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(bubbleBorder, lineWidth: 1))

            // Tool calls
            ForEach(message.toolCalls) { tool in
                ToolCallView(tool: tool)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    var roleLabel: String {
        switch message.role {
        case .user:  return "YOU"
        case .agent: return "DEVLAB"
        case .tool:  return "TOOL"
        case .error: return "ERROR"
        }
    }

    var roleColor: Color {
        switch message.role {
        case .user:  return .appAccent
        case .agent: return .green
        case .tool:  return .yellow
        case .error: return .red
        }
    }

    var bubbleBg: Color {
        switch message.role {
        case .user:  return Color.appSurface2
        case .error: return Color.red.opacity(0.1)
        default:     return Color.appSurface
        }
    }

    var bubbleBorder: Color {
        switch message.role {
        case .user:  return Color.appAccent.opacity(0.4)
        case .error: return Color.red.opacity(0.5)
        default:     return Color.appBorder
        }
    }

    func copyContent() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(message.content, forType: .string)
        isCopied = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { isCopied = false }
    }
}

struct ToolCallView: View {
    let tool: ToolCall
    @State private var isExpanded = false

    var body: some View {
        DisclosureGroup(isExpanded: $isExpanded) {
            if !tool.result.isEmpty {
                Text(tool.result.prefix(600) + (tool.result.count > 600 ? "…" : ""))
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundColor(.appTextDim)
                    .textSelection(.enabled)
                    .padding(.top, 4)
            }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: tool.done ? "checkmark.circle.fill" : "gear")
                    .foregroundColor(tool.done ? .green : .yellow)
                    .font(.system(size: 11))
                Text(tool.name)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundColor(.yellow)
                Spacer()
            }
        }
        .padding(8)
        .background(Color.appBackground)
        .cornerRadius(6)
        .overlay(RoundedRectangle(cornerRadius: 6)
            .stroke(Color.yellow.opacity(0.3), lineWidth: 1))
    }
}

struct ThinkingBubble: View {
    @State private var phase: Double = 0
    @State private var startedAt = Date()
    @State private var elapsed = 0

    var body: some View {
        HStack(spacing: 6) {
            Text("Loading context · analyzing code… \(elapsed)s")
                .font(.system(size: 12))
                .foregroundColor(.appTextDim)
            HStack(spacing: 4) {
                ForEach(0..<3, id: \.self) { i in
                    Circle()
                        .fill(Color.appAccent)
                        .frame(width: 5, height: 5)
                        .opacity(phase == Double(i) ? 1.0 : 0.25)
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .onAppear {
            startedAt = Date()
            elapsed = 0
            withAnimation(.linear(duration: 0.4).repeatForever()) {
                phase = (phase + 1).truncatingRemainder(dividingBy: 3)
            }
        }
        .onReceive(Timer.publish(every: 1, on: .main, in: .common).autoconnect()) { _ in
            elapsed = Int(Date().timeIntervalSince(startedAt))
        }
    }
}

struct AnalyzingSendGlyph: View {
    @State private var spin = false
    @State private var pulse = false

    var body: some View {
        ZStack {
            Circle()
                .stroke(Color.appAccent.opacity(0.25), lineWidth: 1.2)
                .frame(width: 24, height: 24)
                .scaleEffect(pulse ? 1.05 : 0.85)
                .opacity(pulse ? 1 : 0.4)

            Image(systemName: "sparkles")
                .font(.system(size: 12, weight: .semibold))
                .foregroundColor(.appAccent)
                .rotationEffect(.degrees(spin ? 360 : 0))
        }
        .onAppear {
            spin = false
            pulse = false
            withAnimation(.linear(duration: 1.0).repeatForever(autoreverses: false)) { spin = true }
            withAnimation(.easeInOut(duration: 0.7).repeatForever(autoreverses: true)) { pulse = true }
        }
    }
}
