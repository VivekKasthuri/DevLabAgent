import Foundation

// ── App-wide state ────────────────────────────────────────────────────────────
@Observable
class AppState {
    var projectPath: String = NSHomeDirectory() {
        didSet { persistSession() }
    }
    // No project chosen yet → show the welcome / project picker screen
    var projectSelected: Bool = false
    var showFolderPicker: Bool = false
    var activeFile: FileNode? = nil
    var openFiles: [FileNode] = []
    var fileTree: [FileNode] = []
    var terminal: TerminalService = TerminalService()
    var editorRenderVersion: Int = 0

    // Recently opened projects (most recent first)
    var recentProjects: [String] = []
    // Path of the last session's project, offered as "Continue" on the welcome screen
    var lastProjectPath: String? = nil

    // Paths waiting to be re-opened after a relaunch (restored session)
    var pendingRestoreFilePaths: [String] = []
    var pendingActiveFilePath: String? = nil

    private enum SessionKeys {
        static let projectPath    = "session.projectPath"
        static let openFiles      = "session.openFilePaths"
        static let activeFile     = "session.activeFilePath"
        static let recentProjects = "session.recentProjects"
    }

    init() {
        let defaults = UserDefaults.standard
        if let saved = defaults.string(forKey: SessionKeys.projectPath),
           FileManager.default.fileExists(atPath: saved) {
            lastProjectPath = saved
        }
        recentProjects = (defaults.stringArray(forKey: SessionKeys.recentProjects) ?? [])
            .filter { FileManager.default.fileExists(atPath: $0) }
        pendingRestoreFilePaths = (defaults.stringArray(forKey: SessionKeys.openFiles) ?? [])
            .filter { FileManager.default.fileExists(atPath: $0) }
        pendingActiveFilePath = defaults.string(forKey: SessionKeys.activeFile)
    }

    // Choose a folder/project and enter the editor
    func selectProject(_ path: String, restoreSession: Bool = false) {
        projectPath = path
        projectSelected = true
        if !restoreSession {
            // Fresh project: don't restore another project's tabs
            pendingRestoreFilePaths = []
            pendingActiveFilePath = nil
            openFiles = []
            activeFile = nil
        }
        recentProjects.removeAll { $0 == path }
        recentProjects.insert(path, at: 0)
        if recentProjects.count > 8 { recentProjects = Array(recentProjects.prefix(8)) }
        persistSession()
    }

    @discardableResult
    func openFile(_ node: FileNode) -> FileNode {
        if let existing = openFiles.first(where: { $0.path == node.path }) {
            activeFile = existing
            persistSession()
            return existing
        }
        openFiles.append(node)
        activeFile = node
        persistSession()
        return node
    }

    func closeFile(_ node: FileNode) {
        openFiles.removeAll { $0.path == node.path }
        if activeFile?.path == node.path {
            activeFile = openFiles.last
        }
        persistSession()
    }

    // Save the current session so the next launch restores this folder + open files
    func persistSession() {
        let defaults = UserDefaults.standard
        defaults.set(projectPath, forKey: SessionKeys.projectPath)
        defaults.set(openFiles.map(\.path), forKey: SessionKeys.openFiles)
        defaults.set(activeFile?.path, forKey: SessionKeys.activeFile)
        defaults.set(recentProjects, forKey: SessionKeys.recentProjects)
    }

    func refreshEditor() {
        editorRenderVersion &+= 1
    }
}

// ── File tree node ────────────────────────────────────────────────────────────
@Observable
class FileNode: Identifiable, Hashable {
    let id = UUID()
    let name: String
    let path: String
    let isDirectory: Bool
    var children: [FileNode]
    var isExpanded: Bool = false
    var content: String = ""
    var isModified: Bool = false

    init(name: String, path: String, isDirectory: Bool, children: [FileNode] = []) {
        self.name = name
        self.path = path
        self.isDirectory = isDirectory
        self.children = children
    }

    static func == (lhs: FileNode, rhs: FileNode) -> Bool { lhs.path == rhs.path }
    func hash(into hasher: inout Hasher) { hasher.combine(path) }

    var icon: String {
        if isDirectory { return isExpanded ? "folder.fill" : "folder" }
        let ext = URL(fileURLWithPath: path).pathExtension.lowercased()
        switch ext {
        case "swift":  return "swift"
        case "kt":     return "k.square.fill"
        case "js","ts","jsx","tsx": return "j.square.fill"
        case "py":     return "p.square.fill"
        case "dart":   return "d.square.fill"
        case "json","yaml","yml","toml": return "doc.text.fill"
        case "md":     return "doc.richtext"
        case "html","css","scss": return "globe"
        case "sh","bash": return "terminal.fill"
        default:       return "doc.fill"
        }
    }

    var iconColor: Color {
        let ext = URL(fileURLWithPath: path).pathExtension.lowercased()
        switch ext {
        case "swift":  return .orange
        case "kt":     return Color(red: 0.45, green: 0.3, blue: 0.9)
        case "js","jsx": return .yellow
        case "ts","tsx": return .blue
        case "py":     return Color(red: 0.2, green: 0.6, blue: 0.9)
        case "dart":   return .cyan
        case "json":   return .green
        case "md":     return .gray
        case "html":   return .orange
        case "css","scss": return .purple
        default:       return .secondary
        }
    }
}

// ── Chat message ──────────────────────────────────────────────────────────────
struct ChatMessage: Identifiable {
    let id = UUID()
    let role: Role
    var content: String
    var toolCalls: [ToolCall] = []
    let timestamp = Date()

    enum Role { case user, agent, tool, error }
}

struct ToolCall: Identifiable {
    let id = UUID()
    let name: String
    let args: String
    var result: String = ""
    var done: Bool = false
}

import SwiftUI
extension Color {
    // DevLab design tokens — must match ui/design-tokens.json (shared with the
    // web UI and the Windows app so all three surfaces look identical).
    static let appBackground   = Color(nsColor: .init(red: 0.059, green: 0.059, blue: 0.059, alpha: 1)) // #0f0f0f
    static let appSurface      = Color(nsColor: .init(red: 0.086, green: 0.086, blue: 0.086, alpha: 1)) // #161616
    static let appSurface2     = Color(nsColor: .init(red: 0.110, green: 0.110, blue: 0.110, alpha: 1)) // #1c1c1c
    static let appSurface3     = Color(nsColor: .init(red: 0.141, green: 0.141, blue: 0.141, alpha: 1)) // #242424
    static let appHover        = Color(nsColor: .init(red: 0.165, green: 0.165, blue: 0.165, alpha: 1)) // #2a2a2a
    static let appBorder       = Color(nsColor: .init(red: 0.180, green: 0.180, blue: 0.180, alpha: 1)) // #2e2e2e
    static let appAccent       = Color(nsColor: .init(red: 0.655, green: 0.545, blue: 0.980, alpha: 1)) // #a78bfa
    static let appAccentDim    = Color(nsColor: .init(red: 0.486, green: 0.361, blue: 0.749, alpha: 1)) // #7c5cbf
    static let appGreen        = Color(nsColor: .init(red: 0.290, green: 0.871, blue: 0.502, alpha: 1)) // #4ade80
    static let appRed          = Color(nsColor: .init(red: 0.973, green: 0.443, blue: 0.443, alpha: 1)) // #f87171
    static let appYellow       = Color(nsColor: .init(red: 0.984, green: 0.749, blue: 0.141, alpha: 1)) // #fbbf24
    // Adaptive: white-ish on dark/grey backgrounds, black-ish on white backgrounds
    static let appText = Color(nsColor: NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.darkAqua, .aqua]) == .aqua
            ? NSColor(red: 0.10, green: 0.10, blue: 0.12, alpha: 1)
            : NSColor(red: 0.831, green: 0.831, blue: 0.831, alpha: 1)   // #d4d4d4
    })
    static let appTextDim = Color(nsColor: NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.darkAqua, .aqua]) == .aqua
            ? NSColor(red: 0.35, green: 0.38, blue: 0.42, alpha: 1)
            : NSColor(red: 0.604, green: 0.604, blue: 0.604, alpha: 1)   // #9a9a9a (muted)
    })
}
