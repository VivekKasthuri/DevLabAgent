import Foundation
import AppKit

// ── Real PTY terminal ─────────────────────────────────────────────────────────
// Uses forkpty (via TerminalHelper.c) so interactive programs (vim, top,
// git interactive, npm scripts) work exactly like macOS Terminal.app.
@Observable
final class TerminalService {
    var output: NSAttributedString = NSAttributedString()
    var isRunning: Bool = false
    var workingDirectory: String = NSHomeDirectory()
    var cols: Int = 220
    var rows: Int = 50

    private var masterFd: Int32 = -1
    private var childPID: pid_t  = -1
    private var readTask: Task<Void, Never>?
    private let ansi = ANSIParser()

    // ── Start ─────────────────────────────────────────────────────────────────
    func start(cwd: String? = nil) {
        guard !isRunning else { return }
        workingDirectory = cwd ?? NSHomeDirectory()

        var fd: Int32 = -1
        let pid = pty_spawn(&fd, Int32(cols), Int32(rows), workingDirectory)

        guard pid > 0, fd >= 0 else {
            appendError("Failed to start PTY shell\n")
            return
        }

        masterFd = fd
        childPID = pid
        isRunning = true

        readTask = Task.detached(priority: .utility) { [weak self] in
            await self?.readLoop()
        }
    }

    func stop() {
        readTask?.cancel()
        readTask = nil
        if childPID > 0 { kill(childPID, SIGTERM); childPID = -1 }
        if masterFd >= 0 { Darwin.close(masterFd); masterFd = -1 }
        isRunning = false
    }

    func restart(cwd: String? = nil) {
        stop()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
            self?.start(cwd: cwd)
        }
    }

    func clear() { output = NSAttributedString() }

    func resize(cols: Int, rows: Int) {
        guard cols != self.cols || rows != self.rows else { return }
        self.cols = cols; self.rows = rows
        guard masterFd >= 0 else { return }
        pty_resize(masterFd, Int32(cols), Int32(rows))
    }

    // ── Write raw bytes to PTY master ─────────────────────────────────────────
    func write(_ text: String) {
        guard masterFd >= 0, let data = text.data(using: .utf8) else { return }
        data.withUnsafeBytes { _ = Darwin.write(masterFd, $0.baseAddress, $0.count) }
    }

    func sendCtrlC() { writeByte(0x03) }
    func sendCtrlD() { writeByte(0x04) }
    func sendCtrlZ() { writeByte(0x1A) }
    func sendCtrlL() { write("\u{0C}") }   // form-feed = clear screen in shell

    private func writeByte(_ byte: UInt8) {
        guard masterFd >= 0 else { return }
        var b = byte
        Darwin.write(masterFd, &b, 1)
    }

    // ── Read loop — runs on background task ──────────────────────────────────
    private var pendingCR = false

    private func readLoop() async {
        var buf = [UInt8](repeating: 0, count: 8192)
        while !Task.isCancelled {
            let n = Darwin.read(masterFd, &buf, buf.count)
            if n <= 0 { break }
            let text = String(bytes: buf[0..<n], encoding: .utf8)
                    ?? String(bytes: buf[0..<n], encoding: .isoLatin1)
                    ?? ""
            // Parse into Sendable spans before crossing actor boundary
            let spans = ansi.parseSpans(text)
            await MainActor.run { [weak self] in
                guard let self else { return }
                let combined = NSMutableAttributedString(attributedString: output)
                for (s, fg, bold) in spans {
                    let font = bold
                        ? NSFont.monospacedSystemFont(ofSize: 12, weight: .bold)
                        : NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)
                    self.appendTerminalText(combined, s,
                        attributes: [.foregroundColor: fg, .font: font])
                }
                // Keep last 5000 lines to avoid unbounded growth
                let lines = combined.string.components(separatedBy: "\n")
                if lines.count > 5000 {
                    output = ansi.makeDefault(lines.suffix(4000).joined(separator: "\n"))
                } else {
                    output = combined
                }
            }
        }
        await MainActor.run { [weak self] in self?.isRunning = false }
    }

    // Emulates the control characters shells actually use for in-place updates:
    //  \r   → next printable char overwrites the current line (progress bars, prompts)
    //  \b   → erase previous character
    private func appendTerminalText(_ combined: NSMutableAttributedString,
                                    _ text: String,
                                    attributes: [NSAttributedString.Key: Any]) {
        for ch in text {
            switch ch {
            case "\r":
                pendingCR = true
            case "\n":
                pendingCR = false
                combined.append(NSAttributedString(string: "\n", attributes: attributes))
            case "\u{08}":
                let len = combined.length
                if len > 0 {
                    let last = (combined.string as NSString).substring(from: len - 1)
                    if last != "\n" { combined.deleteCharacters(in: NSRange(location: len - 1, length: 1)) }
                }
            default:
                if pendingCR {
                    pendingCR = false
                    let ns = combined.string as NSString
                    let r = ns.range(of: "\n", options: .backwards)
                    let lineStart = r.location == NSNotFound ? 0 : r.location + 1
                    combined.deleteCharacters(in: NSRange(location: lineStart,
                                                          length: combined.length - lineStart))
                }
                combined.append(NSAttributedString(string: String(ch), attributes: attributes))
            }
        }
    }

    private func appendError(_ msg: String) {
        let a = NSAttributedString(string: msg, attributes: [
            .foregroundColor: NSColor.systemRed,
            .font: NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)
        ])
        let m = NSMutableAttributedString(attributedString: output)
        m.append(a); output = m
    }
}

// ── ANSI SGR parser ───────────────────────────────────────────────────────────
final class ANSIParser {
    private let defaultFg = NSColor(red: 0.83, green: 0.83, blue: 0.83, alpha: 1)
    private let defaultFont = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)
    private let boldFont    = NSFont.monospacedSystemFont(ofSize: 12, weight: .bold)

    private let ansiColors: [Int: NSColor] = [
        30: NSColor(red:0.20,green:0.20,blue:0.20,alpha:1),
        31: NSColor(red:0.94,green:0.43,blue:0.43,alpha:1),
        32: NSColor(red:0.29,green:0.86,blue:0.50,alpha:1),
        33: NSColor(red:0.98,green:0.75,blue:0.14,alpha:1),
        34: NSColor(red:0.38,green:0.65,blue:0.98,alpha:1),
        35: NSColor(red:0.82,green:0.54,blue:0.98,alpha:1),
        36: NSColor(red:0.38,green:0.86,blue:0.95,alpha:1),
        37: NSColor(red:0.83,green:0.83,blue:0.83,alpha:1),
        90: NSColor(red:0.50,green:0.50,blue:0.50,alpha:1),
        91: NSColor(red:1.00,green:0.50,blue:0.50,alpha:1),
        92: NSColor(red:0.50,green:1.00,blue:0.50,alpha:1),
        93: NSColor(red:1.00,green:1.00,blue:0.50,alpha:1),
        94: NSColor(red:0.50,green:0.75,blue:1.00,alpha:1),
        95: NSColor(red:1.00,green:0.50,blue:1.00,alpha:1),
        96: NSColor(red:0.50,green:1.00,blue:1.00,alpha:1),
        97: NSColor(red:1.00,green:1.00,blue:1.00,alpha:1),
    ]
    private var currentFg: NSColor? = nil
    private var isBold = false

    func parseSpans(_ raw: String) -> [(text: String, color: NSColor, bold: Bool)] {
        // Strip sequences we don't render: OSC (window title etc.), charset
        // selection, keypad modes — they'd otherwise appear as garbage text.
        var cleaned = raw.replacingOccurrences(
            of: "\u{1B}\\][^\u{07}\u{1B}]*(\u{07}|\u{1B}\\\\)?",
            with: "", options: .regularExpression)
        cleaned = cleaned.replacingOccurrences(
            of: "\u{1B}[()][A-Za-z0-9]|\u{1B}[=>]",
            with: "", options: .regularExpression)
        let pattern = "\u{1B}\\[\\??([0-9;]*)([A-Za-z])"
        guard let regex = try? NSRegularExpression(pattern: pattern) else {
            return [(cleaned, defaultFg, false)]
        }
        var spans: [(String, NSColor, Bool)] = []
        var cursor = cleaned.startIndex
        for match in regex.matches(in: cleaned, range: NSRange(cleaned.startIndex..., in: cleaned)) {
            if let r = Range(match.range, in: cleaned), r.lowerBound > cursor {
                spans.append((String(cleaned[cursor..<r.lowerBound]), currentFg ?? defaultFg, isBold))
            }
            if let cmd = Range(match.range(at: 2), in: cleaned), cleaned[cmd] == "m",
               let par = Range(match.range(at: 1), in: cleaned) {
                applySGR(String(cleaned[par]))
            }
            if let r = Range(match.range, in: cleaned) { cursor = r.upperBound }
        }
        if cursor < cleaned.endIndex {
            spans.append((String(cleaned[cursor...]), currentFg ?? defaultFg, isBold))
        }
        return spans
    }

    func parse(_ raw: String) -> NSAttributedString {
        let result = NSMutableAttributedString()
        for (text, color, bold) in parseSpans(raw) {
            result.append(NSAttributedString(string: text, attributes: [
                .foregroundColor: color,
                .font: bold ? boldFont : defaultFont
            ]))
        }
        return result
    }

    func makeDefault(_ text: String) -> NSAttributedString {
        NSAttributedString(string: text, attributes: [
            .foregroundColor: defaultFg, .font: defaultFont
        ])
    }

    private func applySGR(_ params: String) {
        let codes = params.isEmpty ? [0] : params.split(separator: ";").compactMap { Int($0) }
        var i = 0
        while i < codes.count {
            let c = codes[i]
            switch c {
            case 0:  currentFg = nil; isBold = false
            case 1:  isBold = true
            case 22: isBold = false
            case 38:
                if i+2 < codes.count, codes[i+1] == 5 {
                    currentFg = color256(codes[i+2]); i += 2
                } else if i+4 < codes.count, codes[i+1] == 2 {
                    currentFg = NSColor(red: CGFloat(codes[i+2])/255,
                                       green: CGFloat(codes[i+3])/255,
                                       blue: CGFloat(codes[i+4])/255, alpha: 1); i += 4
                }
            case 39: currentFg = nil
            case 30...37, 90...97: currentFg = ansiColors[c]
            default: break
            }
            i += 1
        }
    }

    private func color256(_ n: Int) -> NSColor {
        if n < 16 { return ansiColors[n < 8 ? n+30 : n+82] ?? defaultFg }
        if n < 232 {
            let v = n - 16
            let r = CGFloat(v/36); let g = CGFloat((v%36)/6); let b = CGFloat(v%6)
            let f: (CGFloat)->CGFloat = { $0 == 0 ? 0 : (55 + $0*40)/255 }
            return NSColor(red: f(r), green: f(g), blue: f(b), alpha: 1)
        }
        let v = CGFloat(8 + (n-232)*10)/255
        return NSColor(red: v, green: v, blue: v, alpha: 1)
    }
}
