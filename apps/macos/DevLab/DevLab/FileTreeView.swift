import SwiftUI

struct FileTreeView: View {
    @Environment(AppState.self) var appState
    @Environment(AgentService.self) var agentService
    @State private var searchText = ""

    var body: some View {
        VStack(spacing: 0) {
            // Header
            HStack {
                Text("EXPLORER")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundColor(.appTextDim)
                    .tracking(1)
                Spacer()
                Button(action: { appState.showFolderPicker = true }) {
                    Image(systemName: "folder.badge.plus")
                        .foregroundColor(.appTextDim)
                }
                .buttonStyle(.plain)
                .help("Open project folder")

                Button(action: refreshTree) {
                    Image(systemName: "arrow.clockwise")
                        .foregroundColor(.appTextDim)
                }
                .buttonStyle(.plain)
                .help("Refresh")
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(Color.appSurface)

            Divider().background(Color.appBorder)

            // Project label
            if !appState.projectPath.isEmpty {
                HStack {
                    Image(systemName: "folder.fill")
                        .foregroundColor(.appAccent)
                        .font(.caption)
                    Text(URL(fileURLWithPath: appState.projectPath).lastPathComponent)
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundColor(.appText)
                        .lineLimit(1)
                    Spacer()
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
            }

            Divider().background(Color.appBorder)

            // File tree
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(appState.fileTree) { node in
                        FileNodeRow(node: node, depth: 0)
                    }
                }
            }
        }
        .background(Color.appSurface)
    }

    private func refreshTree() {
        Task {
            let nodes = (try? await agentService.loadFileTree(projectPath: appState.projectPath)) ?? []
            appState.fileTree = nodes
        }
    }
}

struct FileNodeRow: View {
    var node: FileNode
    @Environment(AppState.self) var appState
    @Environment(AgentService.self) var agentService
    let depth: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 4) {
                // Indent
                Spacer().frame(width: CGFloat(depth) * 14 + 8)

                if node.isDirectory {
                    Image(systemName: node.isExpanded ? "chevron.down" : "chevron.right")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundColor(.appTextDim)
                        .frame(width: 10)
                }

                Image(systemName: node.icon)
                    .font(.system(size: 12))
                    .foregroundColor(node.iconColor)
                    .frame(width: 16)

                Text(node.name)
                    .font(.system(size: 13))
                    .foregroundColor(appState.activeFile?.path == node.path ? .appText : .appTextDim)
                    .lineLimit(1)

                if node.isModified {
                    Circle().fill(Color.appAccent).frame(width: 5, height: 5)
                }

                Spacer()
            }
            .padding(.vertical, 3)
            .background(
                RoundedRectangle(cornerRadius: 4)
                    .fill(appState.activeFile?.path == node.path
                          ? Color.appAccent.opacity(0.15)
                          : Color.clear)
            )
            .contentShape(Rectangle())
            .onTapGesture {
                if node.isDirectory {
                    node.isExpanded.toggle()
                } else {
                    openFile(node)
                }
            }
            .contextMenu {
                Button("Copy Path") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(node.path, forType: .string)
                }
                if !node.isDirectory {
                    Button("Ask Agent About This File") {
                        agentService.sendMessage("Explain the file at path: \(node.path)")
                    }
                }
            }

            // Children
            if node.isDirectory && node.isExpanded {
                ForEach(node.children) { child in
                    FileNodeRow(node: child, depth: depth + 1)
                }
            }
        }
        .padding(.horizontal, 4)
    }

    private func openFile(_ node: FileNode) {
        let activeNode = appState.openFile(node)
        if activeNode.content.isEmpty, let local = localFileFallback(path: activeNode.path) {
            activeNode.content = local
            activeNode.isModified = false
            appState.activeFile = activeNode
            appState.refreshEditor()
        }
        Task {
            let remote = try? await agentService.loadFile(path: activeNode.path)
            let local = localFileFallback(path: activeNode.path)
            if let content = remote ?? local {
                await MainActor.run {
                    activeNode.content = content
                    activeNode.isModified = false
                    // Ensure SwiftUI refreshes the editor after async content load.
                    appState.activeFile = activeNode
                    appState.refreshEditor()
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
