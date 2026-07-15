import SwiftUI
import AppKit

// ── Terminal panel ────────────────────────────────────────────────────────────
struct TerminalPanel: View {
    @Bindable var terminal: TerminalService
    @State private var isCollapsed: Bool = false
    @State private var panelHeight: CGFloat = 240

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "terminal.fill")
                    .font(.system(size: 11))
                    .foregroundColor(.appAccent)
                Text(URL(fileURLWithPath: terminal.workingDirectory).lastPathComponent)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundColor(.appTextDim.opacity(0.6))
                    .lineLimit(1)
                Spacer()
                Circle()
                    .fill(terminal.isRunning ? Color.green : Color.red)
                    .frame(width: 6, height: 6)
                TerminalToolbarBtn(label: "\u{2303}C") { terminal.sendCtrlC() }.help("Ctrl+C")
                TerminalToolbarBtn(label: "\u{2303}Z") { terminal.sendCtrlZ() }.help("Ctrl+Z")
                TerminalToolbarBtn(icon: "trash")          { terminal.clear() }.help("Clear buffer")
                TerminalToolbarBtn(icon: "arrow.clockwise") { terminal.restart(cwd: terminal.workingDirectory) }.help("Restart")
                TerminalToolbarBtn(icon: isCollapsed ? "chevron.up" : "chevron.down") {
                    withAnimation(.easeInOut(duration: 0.15)) { isCollapsed.toggle() }
                }.help(isCollapsed ? "Expand" : "Collapse")
            }
            .padding(.horizontal, 12)
            .frame(height: 32)
            .background(Color.appSurface)

            if !isCollapsed {
                Divider().background(Color.appBorder)
                PTYView(terminal: terminal)
                    .frame(height: panelHeight)
                    .background(Color(nsColor: NSColor(red: 0.05, green: 0.05, blue: 0.05, alpha: 1)))
                ResizeHandle()
                    .gesture(DragGesture().onChanged { v in
                        panelHeight = max(80, min(600, panelHeight - v.translation.height))
                    })
            }
        }
        .background(Color.appSurface)
    }
}

// ── PTYView ───────────────────────────────────────────────────────────────────
struct PTYView: NSViewRepresentable {
    let terminal: TerminalService

    func makeNSView(context: Context) -> NSScrollView {
        let bg = NSColor(red: 0.05, green: 0.05, blue: 0.05, alpha: 1)
        let tv = PTYTextView()
        tv.onWrite = { [weak terminal] s in terminal?.write(s) }
        tv.onCtrlC = { [weak terminal] in terminal?.sendCtrlC() }
        tv.onCtrlD = { [weak terminal] in terminal?.sendCtrlD() }
        tv.onCtrlZ = { [weak terminal] in terminal?.sendCtrlZ() }
        tv.onCtrlL = { [weak terminal] in terminal?.sendCtrlL() }
        tv.isEditable              = true
        tv.isSelectable            = true
        tv.isRichText              = true
        tv.backgroundColor         = bg
        tv.insertionPointColor     = NSColor(red: 0.655, green: 0.545, blue: 0.98, alpha: 1)
        tv.font                    = NSFont.monospacedSystemFont(ofSize: 12.5, weight: .regular)
        tv.textContainerInset      = NSSize(width: 10, height: 10)
        tv.isVerticallyResizable   = true
        tv.isHorizontallyResizable = false
        tv.autoresizingMask        = .width
        tv.maxSize                 = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        tv.textContainer?.widthTracksTextView = true
        tv.textContainer?.lineBreakMode       = .byCharWrapping

        let sv = NSScrollView()
        sv.hasVerticalScroller   = true
        sv.hasHorizontalScroller = false
        sv.autohidesScrollers    = true
        sv.backgroundColor       = bg
        sv.documentView          = tv
        context.coordinator.textView = tv
        return sv
    }

    func updateNSView(_ sv: NSScrollView, context: Context) {
        guard let tv = context.coordinator.textView else { return }
        if tv.attributedString() != terminal.output {
            let atBottom = tv.isNearBottom
            tv.textStorage?.setAttributedString(terminal.output)
            if atBottom { tv.scrollToEndOfDocument(nil) }
        }
        let charW = tv.font?.maximumAdvancement.width ?? 7.5
        let lineH = (tv.font?.ascender ?? 12) + (tv.font?.descender.magnitude ?? 3)
        let cols = max(20, Int((sv.frame.width - 20) / charW))
        let rows = max(5, Int((sv.frame.height - 20) / lineH))
        // Defer — mutating observable state during a SwiftUI update is undefined
        if cols != terminal.cols || rows != terminal.rows {
            DispatchQueue.main.async { [weak terminal] in
                terminal?.resize(cols: cols, rows: rows)
            }
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator() }
    class Coordinator { weak var textView: PTYTextView? }
}

// ── PTYTextView ───────────────────────────────────────────────────────────────
final class PTYTextView: NSTextView {
    var onWrite: ((String) -> Void)?
    var onCtrlC: (() -> Void)?
    var onCtrlD: (() -> Void)?
    var onCtrlZ: (() -> Void)?
    var onCtrlL: (() -> Void)?

    override var acceptsFirstResponder: Bool { true }
    override func becomeFirstResponder() -> Bool { true }

    override func keyDown(with event: NSEvent) {
        let mods = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        let key  = event.charactersIgnoringModifiers ?? ""

        if mods.contains(.control) {
            switch key.lowercased() {
            case "c": onCtrlC?(); return
            case "d": onCtrlD?(); return
            case "z": onCtrlZ?(); return
            case "l": onCtrlL?(); return
            case "a": onWrite?("\u{01}"); return
            case "e": onWrite?("\u{05}"); return
            case "k": onWrite?("\u{0B}"); return
            case "u": onWrite?("\u{15}"); return
            case "w": onWrite?("\u{17}"); return
            case "r": onWrite?("\u{12}"); return
            default:
                if let ch = event.characters, let s = ch.unicodeScalars.first {
                    onWrite?(String(UnicodeScalar(s.value & 0x1F)!)); return
                }
            }
        }

        switch event.keyCode {
        case 36, 76: onWrite?("\r");         return
        case 51:     onWrite?("\u{7F}");     return
        case 48:     onWrite?("\t");         return
        case 53:     onWrite?("\u{1B}");     return
        case 126:    onWrite?("\u{1B}[A");   return
        case 125:    onWrite?("\u{1B}[B");   return
        case 124:    onWrite?("\u{1B}[C");   return
        case 123:    onWrite?("\u{1B}[D");   return
        case 117:    onWrite?("\u{1B}[3~");  return
        case 115:    onWrite?("\u{1B}[H");   return
        case 119:    onWrite?("\u{1B}[F");   return
        case 116:    onWrite?("\u{1B}[5~");  return
        case 121:    onWrite?("\u{1B}[6~");  return
        case 122:    onWrite?("\u{1B}OP");   return
        case 120:    onWrite?("\u{1B}OQ");   return
        case 99:     onWrite?("\u{1B}OR");   return
        case 118:    onWrite?("\u{1B}OS");   return
        default:
            if let chars = event.characters, !chars.isEmpty { onWrite?(chars) }
        }
    }

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        let mods = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        let key  = event.charactersIgnoringModifiers?.lowercased() ?? ""
        if mods.contains(.command) {
            switch key {
            case "c": NSApp.sendAction(#selector(NSText.copy(_:)), to: nil, from: self); return true
            case "v":
                if let s = NSPasteboard.general.string(forType: .string) { onWrite?(s) }
                return true
            default: break
            }
        }
        return super.performKeyEquivalent(with: event)
    }

    override func insertText(_ string: Any, replacementRange: NSRange) { }
    override func paste(_ sender: Any?) {
        if let s = NSPasteboard.general.string(forType: .string) { onWrite?(s) }
    }
    override func deleteBackward(_ sender: Any?) { onWrite?("\u{7F}") }
    override func insertNewline(_ sender: Any?)  { onWrite?("\r") }
    override func insertTab(_ sender: Any?)      { onWrite?("\t") }
    override var isOpaque: Bool { true }
}

extension NSTextView {
    var isNearBottom: Bool {
        guard let sv = enclosingScrollView else { return true }
        return sv.documentVisibleRect.maxY >= (sv.documentView ?? self).bounds.maxY - 40
    }
}

// ── Toolbar button ────────────────────────────────────────────────────────────
struct TerminalToolbarBtn: View {
    var label: String? = nil
    var icon:  String? = nil
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            if let icon  { Image(systemName: icon).font(.system(size: 11)) }
            else if let l = label { Text(l).font(.system(size: 10, design: .monospaced)) }
        }
        .buttonStyle(_TBStyle())
    }
}
private struct _TBStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundColor(configuration.isPressed ? .appText : .appTextDim)
            .padding(.horizontal, 5).padding(.vertical, 3)
            .background(configuration.isPressed ? Color.appSurface2 : Color.clear)
            .cornerRadius(4).contentShape(Rectangle())
    }
}

// ── Resize handle ─────────────────────────────────────────────────────────────
struct ResizeHandle: View {
    var body: some View {
        Rectangle()
            .fill(Color.appBorder).frame(height: 4)
            .onHover { hovering in
                if hovering { NSCursor.resizeUpDown.push() } else { NSCursor.pop() }
            }
    }
}
