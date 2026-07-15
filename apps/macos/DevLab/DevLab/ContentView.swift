import SwiftUI

struct ContentView: View {
    @Environment(AgentService.self) var agentService
    @Environment(AppState.self) var appState
    @State private var columnVisibility = NavigationSplitViewVisibility.all

    var body: some View {
        @Bindable var agentService = agentService
        @Bindable var appState = appState
        Group {
            if appState.projectSelected {
                mainEditor
            } else {
                WelcomeView()
            }
        }
        .fileImporter(
            isPresented: $appState.showFolderPicker,
            allowedContentTypes: [.folder]
        ) { result in
            if case .success(let url) = result {
                appState.selectProject(url.path)
                Task {
                    let nodes = (try? await agentService.loadFileTree(projectPath: url.path)) ?? []
                    appState.fileTree = nodes
                }
            }
        }
    }

    private var mainEditor: some View {
        @Bindable var agentService = agentService
        @Bindable var appState = appState
        return VStack(spacing: 0) {
            // Top file tabs (visible for multi-file workflows)
            TabBarView()
            Divider().background(Color.appBorder)

            NavigationSplitView(columnVisibility: $columnVisibility) {
                // ── Sidebar: file tree ────────────────────────────────────────
                FileTreeView()
                    .navigationSplitViewColumnWidth(min: 160, ideal: 220, max: 360)
            } content: {
                // ── Center: code editor ───────────────────────────────────────
                EditorView()
                    .navigationSplitViewColumnWidth(min: 400, ideal: 700)
            } detail: {
                // ── Right: chat panel ─────────────────────────────────────────
                ChatView()
                    .navigationSplitViewColumnWidth(min: 300, ideal: 340, max: 500)
            }
        }
        .background(Color.appBackground)
        .toolbarBackground(Color.appSurface, for: .windowToolbar)
        .toolbar {
            ToolbarItemGroup(placement: .navigation) {
                Button(action: { appState.showFolderPicker = true }) {
                    Label("Open Project", systemImage: "folder")
                }
                .help("Open project folder (⌘O)")
            }
            ToolbarItemGroup(placement: .primaryAction) {
                // DevLab Coder badge
                Text("DevLab Coder")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundColor(.accentColor)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(Color(white: 0.18))
                    .cornerRadius(5)

                Divider()

                // Status dot
                Circle()
                    .fill(agentService.isConnected ? Color.green : Color.orange)
                    .frame(width: 8, height: 8)

                Text(agentService.serverStatus)
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
        }
        .onAppear {
            Task {
                let nodes = (try? await agentService.loadFileTree(projectPath: appState.projectPath)) ?? []
                appState.fileTree = nodes
                await restorePreviousSession()
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .devlabFilesChanged)) { _ in
            Task { await syncOpenFilesFromServer() }
        }
    }

    // Re-open the files from the previous session (saved when the app was closed)
    private func restorePreviousSession() async {
        let paths = appState.pendingRestoreFilePaths
        guard !paths.isEmpty else { return }
        appState.pendingRestoreFilePaths = []

        for path in paths {
            let node = FileNode(
                name: URL(fileURLWithPath: path).lastPathComponent,
                path: path,
                isDirectory: false
            )
            let activeNode = appState.openFile(node)
            let remote = try? await agentService.loadFile(path: path)
            let local = localFileFallback(path: path)
            if let content = remote ?? local {
                await MainActor.run {
                    activeNode.content = content
                    activeNode.isModified = false
                    appState.refreshEditor()
                }
            }
        }
        if let activePath = appState.pendingActiveFilePath,
           let node = appState.openFiles.first(where: { $0.path == activePath }) {
            appState.activeFile = node
        }
        appState.pendingActiveFilePath = nil
    }

    private func syncOpenFilesFromServer() async {
        let tree = (try? await agentService.loadFileTree(projectPath: appState.projectPath)) ?? []
        await MainActor.run {
            appState.fileTree = tree
        }

        let openPaths = await MainActor.run { appState.openFiles.map(\.path) }
        guard !openPaths.isEmpty else { return }
        for path in openPaths {
            let remote = try? await agentService.loadFile(path: path)
            let local = localFileFallback(path: path)
            guard let content = remote ?? local else { continue }
            await MainActor.run {
                if let node = appState.openFiles.first(where: { $0.path == path }) {
                    node.content = content
                    node.isModified = false
                    appState.refreshEditor()
                    if appState.activeFile?.path == path {
                        appState.activeFile = node
                    }
                }
            }
        }
    }

    private func localFileFallback(path: String) -> String? {
        if path.hasPrefix("/") {
            return try? String(contentsOfFile: path, encoding: .utf8)
        }
        let full = URL(fileURLWithPath: appState.projectPath).appendingPathComponent(path).path
        return try? String(contentsOfFile: full, encoding: .utf8)
    }
}

// ── Welcome / project picker screen (shown on launch) ───────────────────────
struct WelcomeView: View {
    @Environment(AppState.self) var appState

    var body: some View {
        ZStack {
            Color.appBackground.ignoresSafeArea()

            VStack(spacing: 28) {
                Spacer()

                // Logo + title
                VStack(spacing: 12) {
                    Image(systemName: "chevron.left.forwardslash.chevron.right")
                        .font(.system(size: 44, weight: .semibold))
                        .foregroundStyle(Color.accentColor)
                    Text("DevLab")
                        .font(.system(size: 30, weight: .bold))
                        .foregroundColor(.appAccent)
                    Text("Open a folder or project to get started")
                        .font(.subheadline)
                        .foregroundColor(.secondary)
                }

                // Primary actions
                VStack(spacing: 10) {
                    WelcomeActionButton(
                        icon: "folder.badge.plus",
                        title: "Open Folder or Project…",
                        subtitle: "Choose any directory to work in",
                        isPrimary: true
                    ) {
                        appState.showFolderPicker = true
                    }

                    if let last = appState.lastProjectPath {
                        WelcomeActionButton(
                            icon: "clock.arrow.circlepath",
                            title: "Continue Last Session",
                            subtitle: last.abbreviatingHome,
                            isPrimary: false
                        ) {
                            appState.selectProject(last, restoreSession: true)
                        }
                    }
                }
                .frame(maxWidth: 420)

                // Recent projects
                if !recentsExcludingLast.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("RECENT PROJECTS")
                            .font(.caption2.weight(.semibold))
                            .foregroundColor(.secondary)
                            .padding(.leading, 4)
                        ForEach(recentsExcludingLast, id: \.self) { path in
                            Button {
                                appState.selectProject(path)
                            } label: {
                                HStack(spacing: 8) {
                                    Image(systemName: "folder")
                                        .foregroundColor(.secondary)
                                    Text(URL(fileURLWithPath: path).lastPathComponent)
                                        .fontWeight(.medium)
                                    Text(path.abbreviatingHome)
                                        .font(.caption)
                                        .foregroundColor(.secondary)
                                        .lineLimit(1)
                                        .truncationMode(.middle)
                                    Spacer()
                                }
                                .padding(.horizontal, 10)
                                .padding(.vertical, 6)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .background(Color.appSurface.opacity(0.6))
                            .cornerRadius(6)
                        }
                    }
                    .frame(maxWidth: 420)
                }

                Spacer()
                Spacer()
            }
            .padding(40)
        }
    }

    private var recentsExcludingLast: [String] {
        Array(appState.recentProjects.filter { $0 != appState.lastProjectPath }.prefix(5))
    }
}

private struct WelcomeActionButton: View {
    let icon: String
    let title: String
    let subtitle: String
    let isPrimary: Bool
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: icon)
                    .font(.system(size: 20))
                    .frame(width: 32)
                    .foregroundStyle(isPrimary ? Color.white : Color.accentColor)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .fontWeight(.semibold)
                        .foregroundColor(isPrimary ? .white : .primary)
                    Text(subtitle)
                        .font(.caption)
                        .foregroundColor(isPrimary ? .white.opacity(0.8) : .secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.caption)
                    .foregroundColor(isPrimary ? .white.opacity(0.7) : .secondary)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .background(
                RoundedRectangle(cornerRadius: 10)
                    .fill(isPrimary ? Color.accentColor : Color.appSurface)
                    .opacity(hovering ? 0.85 : 1)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
    }
}

private extension String {
    var abbreviatingHome: String {
        let home = NSHomeDirectory()
        return hasPrefix(home) ? "~" + dropFirst(home.count) : self
    }
}
