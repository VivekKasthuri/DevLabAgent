import SwiftUI
import AppKit

struct EditorView: View {
    @Environment(AppState.self) var appState
    @Environment(AgentService.self) var agentService

    var body: some View {
        @Bindable var appState = appState
        VStack(spacing: 0) {
            // Editor content
            Group {
                if let activeFile = appState.activeFile {
                    CodeEditorView(file: activeFile)
                        .id("\(activeFile.id.uuidString)-\(activeFile.content.isEmpty ? "empty" : "filled")-\(appState.editorRenderVersion)")
                } else {
                    EmptyEditorView()
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            Divider().background(Color.appBorder)

            // Terminal panel
            TerminalPanel(terminal: appState.terminal)
        }
        .background(Color.appBackground)
        .onAppear {
            let cwd = FileManager.default.fileExists(atPath: appState.projectPath)
                ? appState.projectPath : NSHomeDirectory()
            appState.terminal.start(cwd: cwd)
        }
        .onChange(of: appState.projectPath) { _, newPath in
            let cwd = FileManager.default.fileExists(atPath: newPath)
                ? newPath : NSHomeDirectory()
            appState.terminal.restart(cwd: cwd)
        }
    }
}

// ── Tab bar ───────────────────────────────────────────────────────────────────
struct TabBarView: View {
    @Environment(AppState.self) var appState

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 0) {
                ForEach(appState.openFiles) { file in
                    TabItemView(file: file)
                }
            }
        }
        .frame(height: 36)
        .background(Color.appSurface)
    }
}

struct TabItemView: View {
    var file: FileNode
    @Environment(AppState.self) var appState
    @Environment(AgentService.self) var agentService
    @State private var isHovering = false

    var isActive: Bool { appState.activeFile?.path == file.path }

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: file.icon)
                .font(.system(size: 11))
                .foregroundColor(file.iconColor)

            Text(file.name)
                .font(.system(size: 12))
                .foregroundColor(isActive ? .appText : .appTextDim)

            if file.isModified {
                Circle().fill(Color.appAccent).frame(width: 5, height: 5)
            } else if isHovering || isActive {
                Button(action: { appState.closeFile(file) }) {
                    Image(systemName: "xmark")
                        .font(.system(size: 9, weight: .bold))
                        .foregroundColor(.appTextDim)
                }
                .buttonStyle(.plain)
                .frame(width: 14, height: 14)
            }
        }
        .padding(.horizontal, 12)
        .frame(height: 36)
        .background(
            VStack(spacing: 0) {
                Color.clear
                if isActive {
                    Color.appAccent.frame(height: 2)
                }
            }
        )
        .background(isActive ? Color.appBackground : Color.clear)
        .overlay(
            Rectangle()
                .fill(Color.appBorder)
                .frame(width: 1),
            alignment: .trailing
        )
        .onTapGesture { appState.activeFile = file }
        .onHover { isHovering = $0 }
        .contextMenu {
            Button("Close") { appState.closeFile(file) }
            Button("Close Others") {
                let others = appState.openFiles.filter { $0.path != file.path }
                others.forEach { appState.closeFile($0) }
            }
            Divider()
            Button("Copy Path") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(file.path, forType: .string)
            }
        }
    }
}

// ── Code editor using NSTextView ──────────────────────────────────────────────
struct CodeEditorView: NSViewRepresentable {
    var file: FileNode
    @Environment(AgentService.self) var agentService
    @Environment(AppState.self) var appState
    private let codeFont = NSFont.monospacedSystemFont(ofSize: 13, weight: .regular)
    private let codeTextColor = NSColor(red: 0.96, green: 0.97, blue: 0.99, alpha: 1)
    private let codeBackgroundColor = NSColor(red: 0.059, green: 0.059, blue: 0.059, alpha: 1)
    private var sourceLanguage: SourceLanguage { SourceLanguage(path: file.path) }

    func makeNSView(context: Context) -> NSScrollView {
        let scrollView = NSTextView.scrollableTextView()
        guard let textView = scrollView.documentView as? NSTextView else { return scrollView }
        let initialContent = file.content.isEmpty ? (localFileFallback(path: file.path) ?? "") : file.content
        if file.content.isEmpty, !initialContent.isEmpty {
            file.content = initialContent
            file.isModified = false
            appState.refreshEditor()
        }

        textView.font = codeFont
        textView.textColor = codeTextColor
        textView.backgroundColor = codeBackgroundColor
        textView.insertionPointColor = NSColor(red: 0.655, green: 0.545, blue: 0.98, alpha: 1)
        textView.selectedTextAttributes = [
            .foregroundColor: NSColor.white,
            .backgroundColor: NSColor(red: 0.26, green: 0.34, blue: 0.52, alpha: 1)
        ]
        textView.typingAttributes = [
            .font: codeFont,
            .foregroundColor: codeTextColor
        ]
        textView.isRichText = false
        textView.isAutomaticQuoteSubstitutionEnabled = false
        textView.isAutomaticDashSubstitutionEnabled = false
        textView.isAutomaticSpellingCorrectionEnabled = false
        textView.isGrammarCheckingEnabled = false
        textView.allowsUndo = true
        textView.isEditable = true
        textView.isSelectable = true
        textView.usesFindPanel = true
        textView.usesAdaptiveColorMappingForDarkAppearance = false
        textView.textContainerInset = NSSize(width: 12, height: 12)
        textView.delegate = context.coordinator

        textView.minSize = NSSize(width: 0, height: scrollView.contentSize.height)
        textView.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = false
        textView.autoresizingMask = .width
        textView.textContainer?.containerSize = NSSize(width: scrollView.contentSize.width, height: CGFloat.greatestFiniteMagnitude)
        textView.textContainer?.widthTracksTextView = true
        applyThemeAndContent(textView, content: initialContent, language: sourceLanguage)

        scrollView.hasVerticalScroller = true
        scrollView.autohidesScrollers = true
        scrollView.backgroundColor = codeBackgroundColor
        scrollView.drawsBackground = true

        // Line numbers (must be created after the text view is inside the scroll view)
        let ruler = LineNumberRulerView(textView: textView)
        scrollView.verticalRulerView = ruler
        scrollView.hasVerticalRuler = true
        scrollView.rulersVisible = true

        // Fallback: if file content is still empty when the editor is created
        // (async open/load race), fetch once here so the view doesn't stay blank.
        if file.content.isEmpty {
            Task {
                let remote = try? await agentService.loadFile(path: file.path)
                let local = localFileFallback(path: file.path)
                if let content = remote ?? local {
                    await MainActor.run {
                        file.content = content
                        file.isModified = false
                        appState.refreshEditor()
                        applyThemeAndContent(textView, content: content, language: sourceLanguage)
                    }
                }
            }
        }
        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        guard let textView = scrollView.documentView as? NSTextView else { return }
        let resolvedContent = file.content.isEmpty ? (localFileFallback(path: file.path) ?? file.content) : file.content
        if file.content.isEmpty, !resolvedContent.isEmpty {
            file.content = resolvedContent
            file.isModified = false
            appState.refreshEditor()
        }
        applyThemeAndContent(textView, content: resolvedContent, language: sourceLanguage, replaceContent: textView.string != resolvedContent)
        if textView.string != resolvedContent {
            applyThemeAndContent(textView, content: resolvedContent, language: sourceLanguage)
        }
        if resolvedContent.isEmpty {
            Task {
                let remote = try? await agentService.loadFile(path: file.path)
                let local = localFileFallback(path: file.path)
                if let content = remote ?? local {
                    await MainActor.run {
                        if file.content.isEmpty {
                            file.content = content
                            file.isModified = false
                            appState.refreshEditor()
                            applyThemeAndContent(textView, content: content, language: sourceLanguage)
                        }
                    }
                }
            }
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator(file: file) }

    private func localFileFallback(path: String) -> String? {
        if path.hasPrefix("/") {
            return try? String(contentsOfFile: path, encoding: .utf8)
        }
        let full = URL(fileURLWithPath: appState.projectPath).appendingPathComponent(path).path
        return try? String(contentsOfFile: full, encoding: .utf8)
    }

    private func applyThemeAndContent(_ textView: NSTextView, content: String, language: SourceLanguage, replaceContent: Bool = true) {
        textView.font = codeFont
        textView.textColor = codeTextColor
        textView.backgroundColor = codeBackgroundColor
        textView.selectedTextAttributes = [
            .foregroundColor: NSColor.white,
            .backgroundColor: NSColor(red: 0.26, green: 0.34, blue: 0.52, alpha: 1)
        ]
        textView.typingAttributes = [
            .font: codeFont,
            .foregroundColor: codeTextColor
        ]

        guard replaceContent else { return }
        let selectedRange = textView.selectedRange()
        let attributed = highlightedText(content: content, language: language)
        textView.textStorage?.setAttributedString(attributed)
        let maxLoc = min(selectedRange.location, textView.string.count)
        textView.setSelectedRange(NSRange(location: maxLoc, length: 0))
    }

    private func highlightedText(content: String, language: SourceLanguage) -> NSAttributedString {
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineHeightMultiple = 1.15
        let baseAttributes: [NSAttributedString.Key: Any] = [
            .font: codeFont,
            .foregroundColor: codeTextColor,
            .paragraphStyle: paragraph
        ]
        let mutable = NSMutableAttributedString(string: content, attributes: baseAttributes)
        let fullRange = NSRange(location: 0, length: mutable.length)

        let keywordColor = NSColor(red: 0.75, green: 0.63, blue: 0.99, alpha: 1)
        let typeColor = NSColor(red: 0.47, green: 0.80, blue: 0.97, alpha: 1)
        let stringColor = NSColor(red: 0.97, green: 0.74, blue: 0.43, alpha: 1)
        let numberColor = NSColor(red: 0.55, green: 0.85, blue: 0.70, alpha: 1)
        let commentColor = NSColor(red: 0.48, green: 0.73, blue: 0.46, alpha: 1)

        apply(pattern: language.keywordPattern, color: keywordColor, to: mutable, fullRange: fullRange)
        apply(pattern: language.typePattern, color: typeColor, to: mutable, fullRange: fullRange)
        apply(pattern: #"\b\d+(\.\d+)?\b"#, color: numberColor, to: mutable, fullRange: fullRange)
        apply(pattern: #""(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'"#, color: stringColor, to: mutable, fullRange: fullRange)
        for (pattern, multiline) in language.commentPatterns {
            apply(pattern: pattern, color: commentColor, to: mutable, fullRange: fullRange, multiline: multiline)
        }
        if language == .json {
            apply(pattern: #""[^"]+"\s*:"#, color: typeColor, to: mutable, fullRange: fullRange)
        }
        if language == .html {
            apply(pattern: #"</?[A-Za-z][^>]*>"#, color: typeColor, to: mutable, fullRange: fullRange, multiline: true)
        }
        if language == .css {
            apply(pattern: #"\b[a-zA-Z-]+(?=\s*:)"#, color: typeColor, to: mutable, fullRange: fullRange)
        }
        return mutable
    }

    private func apply(
        pattern: String?,
        color: NSColor,
        to text: NSMutableAttributedString,
        fullRange: NSRange,
        multiline: Bool = false
    ) {
        guard let pattern, !pattern.isEmpty else { return }
        let options: NSRegularExpression.Options = multiline ? [.dotMatchesLineSeparators, .anchorsMatchLines] : [.anchorsMatchLines]
        guard let regex = try? NSRegularExpression(pattern: pattern, options: options) else { return }
        regex.enumerateMatches(in: text.string, options: [], range: fullRange) { match, _, _ in
            guard let range = match?.range else { return }
            text.addAttribute(.foregroundColor, value: color, range: range)
        }
    }

    private enum SourceLanguage: Equatable {
        case swift, kotlin, javascript, typescript, python, dart, json, html, css, shell, markdown, plain

        init(path: String) {
            switch URL(fileURLWithPath: path).pathExtension.lowercased() {
            case "swift": self = .swift
            case "kt", "kts": self = .kotlin
            case "ts", "tsx": self = .typescript
            case "js", "jsx": self = .javascript
            case "py": self = .python
            case "dart": self = .dart
            case "json": self = .json
            case "html", "xml": self = .html
            case "css", "scss": self = .css
            case "sh", "bash", "zsh": self = .shell
            case "md": self = .markdown
            default: self = .plain
            }
        }

        var keywordPattern: String? {
            switch self {
            case .swift:
                return #"\b(import|class|struct|enum|protocol|extension|func|var|let|if|else|guard|return|defer|do|catch|throw|try|for|while|switch|case|default|where|in|async|await|public|private|internal|fileprivate|open|static|nil|true|false)\b"#
            case .kotlin:
                return #"\b(package|import|class|object|interface|fun|val|var|if|else|when|for|while|return|try|catch|throw|suspend|data|sealed|private|public|internal|protected|null|true|false)\b"#
            case .javascript, .typescript:
                return #"\b(import|from|export|default|class|function|const|let|var|if|else|for|while|switch|case|break|continue|return|try|catch|throw|async|await|new|null|true|false|undefined|interface|type|extends|implements)\b"#
            case .python:
                return #"\b(import|from|class|def|if|elif|else|for|while|try|except|finally|return|yield|lambda|with|as|async|await|None|True|False)\b"#
            case .dart:
                return #"\b(import|class|mixin|extension|enum|typedef|void|final|var|const|if|else|for|while|switch|case|break|continue|return|try|catch|throw|async|await|new|null|true|false)\b"#
            case .shell:
                return #"\b(if|then|else|fi|for|do|done|case|esac|function|return|local|export)\b"#
            default:
                return nil
            }
        }

        var typePattern: String? {
            switch self {
            case .swift:
                return #"(?<!\.)\b[A-Z][A-Za-z0-9_]*\b"#
            case .kotlin, .typescript, .javascript, .dart:
                return #"\b[A-Z][A-Za-z0-9_]*\b"#
            default:
                return nil
            }
        }

        var commentPatterns: [(String, Bool)] {
            switch self {
            case .swift, .kotlin, .javascript, .typescript, .dart, .css:
                return [(#"//.*$"#, false), (#"/\*[\s\S]*?\*/"#, true)]
            case .python, .shell:
                return [(#"#.*$"#, false)]
            case .html:
                return [(#"<!--[\s\S]*?-->"#, true)]
            case .markdown:
                return [(#"<!--[\s\S]*?-->"#, true)]
            default:
                return []
            }
        }
    }

    class Coordinator: NSObject, NSTextViewDelegate {
        let file: FileNode
        init(file: FileNode) { self.file = file }

        func textDidChange(_ notification: Notification) {
            guard let tv = notification.object as? NSTextView else { return }
            file.content = tv.string
            file.isModified = true
        }

        func textView(_ textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
            // Auto-indent on newline
            if commandSelector == #selector(NSResponder.insertNewline(_:)) {
                let range = textView.selectedRange()
                if range.location > 0 {
                    let text = textView.string as NSString
                    let lineRange = text.lineRange(for: NSRange(location: range.location - 1, length: 1))
                    let line = text.substring(with: lineRange)
                    let indent = String(line.prefix(while: { $0 == " " || $0 == "\t" }))
                    textView.insertText("\n" + indent, replacementRange: range)
                    return true
                }
            }
            return false
        }
    }
}

// ── Cmd+S-aware NSTextView subclass ───────────────────────────────────────────
class SaveAwareTextView: NSTextView {
    var onSave: (() -> Void)?

    override func keyDown(with event: NSEvent) {
        if event.modifierFlags.contains(.command),
           event.charactersIgnoringModifiers == "s" {
            onSave?()
            return
        }
        super.keyDown(with: event)
    }
}

// ── Line number ruler ─────────────────────────────────────────────────────────
class LineNumberRulerView: NSRulerView {
    weak var textView: NSTextView?

    init(textView: NSTextView) {
        self.textView = textView
        super.init(scrollView: textView.enclosingScrollView, orientation: .verticalRuler)
        self.clientView = textView
        self.ruleThickness = 44
        NotificationCenter.default.addObserver(self, selector: #selector(redraw), name: NSView.frameDidChangeNotification, object: textView)
        NotificationCenter.default.addObserver(self, selector: #selector(redraw), name: NSText.didChangeNotification, object: textView)
    }

    required init(coder: NSCoder) { fatalError() }

    @objc func redraw() { needsDisplay = true }

    override func draw(_ dirtyRect: NSRect) {
        NSColor(red: 0.086, green: 0.086, blue: 0.086, alpha: 1).setFill()
        dirtyRect.fill()

        guard let tv = textView,
              let layoutManager = tv.layoutManager,
              let textContainer = tv.textContainer else { return }

        let visibleRect = tv.visibleRect
        let glyphRange = layoutManager.glyphRange(forBoundingRect: visibleRect, in: textContainer)
        let charRange = layoutManager.characterRange(forGlyphRange: glyphRange, actualGlyphRange: nil)
        let text = tv.string as NSString
        var lineNumber = 1

        text.enumerateSubstrings(in: NSRange(location: 0, length: charRange.location),
                                 options: [.byLines, .substringNotRequired]) { _, _, _, _ in lineNumber += 1 }

        var lineIndex = lineNumber
        var glyphIndex = glyphRange.location
        while glyphIndex < NSMaxRange(glyphRange) {
            var lineGlyphRange = NSRange()
            layoutManager.lineFragmentRect(forGlyphAt: glyphIndex, effectiveRange: &lineGlyphRange)
            let lineRect = layoutManager.lineFragmentRect(forGlyphAt: glyphIndex, effectiveRange: nil)
            let yPos = lineRect.minY - visibleRect.minY + tv.textContainerInset.height + convert(NSPoint.zero, from: tv).y

            let attrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.monospacedSystemFont(ofSize: 11, weight: .regular),
                .foregroundColor: NSColor(red: 0.35, green: 0.35, blue: 0.35, alpha: 1)
            ]
            let str = "\(lineIndex)" as NSString
            let size = str.size(withAttributes: attrs)
            str.draw(at: NSPoint(x: ruleThickness - size.width - 8, y: yPos + 1), withAttributes: attrs)

            glyphIndex = NSMaxRange(lineGlyphRange)
            lineIndex += 1
        }
    }
}

// ── Empty editor ──────────────────────────────────────────────────────────────
struct EmptyEditorView: View {
    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "chevron.left.forwardslash.chevron.right")
                .font(.system(size: 52))
                .foregroundColor(.appTextDim.opacity(0.4))
            Text("Open a file from the explorer")
                .font(.system(size: 14))
                .foregroundColor(.appTextDim)
            Text("or ask the AI to create one")
                .font(.system(size: 12))
                .foregroundColor(.appTextDim.opacity(0.6))
            HStack(spacing: 8) {
                KeyboardShortcutBadge("⌘O", "Open folder")
                KeyboardShortcutBadge("⌘N", "New session")
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.appBackground)
    }
}

struct KeyboardShortcutBadge: View {
    let shortcut: String
    let label: String
    init(_ shortcut: String, _ label: String) { self.shortcut = shortcut; self.label = label }
    var body: some View {
        HStack(spacing: 6) {
            Text(shortcut)
                .font(.system(size: 11, design: .monospaced))
                .padding(.horizontal, 6).padding(.vertical, 2)
                .background(Color.appSurface2)
                .cornerRadius(4)
                .overlay(RoundedRectangle(cornerRadius: 4).stroke(Color.appBorder, lineWidth: 1))
            Text(label).font(.system(size: 11)).foregroundColor(.appTextDim)
        }
    }
}
