import AVFoundation
import Foundation
import Observation
import Speech

@Observable
final class VoiceInputService {
    var isListening = false
    var lastError: String?

    private let audioEngine = AVAudioEngine()
    private let speechRecognizer = SFSpeechRecognizer()
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?

    func start(onTranscript: @escaping (String) -> Void) {
        Task { @MainActor in
            do {
                try await requestPermissions()
                try beginRecognition(onTranscript: onTranscript)
            } catch {
                stop()
                lastError = error.localizedDescription
            }
        }
    }

    func stop() {
        recognitionTask?.cancel()
        recognitionTask = nil

        recognitionRequest?.endAudio()
        recognitionRequest = nil

        if audioEngine.isRunning {
            audioEngine.stop()
            audioEngine.inputNode.removeTap(onBus: 0)
        }

        isListening = false
    }

    @MainActor
    private func beginRecognition(onTranscript: @escaping (String) -> Void) throws {
        stop()
        lastError = nil

        guard let speechRecognizer, speechRecognizer.isAvailable else {
            throw VoiceInputError.unavailable
        }

        let recognitionRequest = SFSpeechAudioBufferRecognitionRequest()
        recognitionRequest.shouldReportPartialResults = true
        self.recognitionRequest = recognitionRequest

        let inputNode = audioEngine.inputNode
        let format = inputNode.outputFormat(forBus: 0)
        inputNode.removeTap(onBus: 0)
        inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            self?.recognitionRequest?.append(buffer)
        }

        audioEngine.prepare()
        try audioEngine.start()
        isListening = true

        recognitionTask = speechRecognizer.recognitionTask(with: recognitionRequest) { [weak self] result, error in
            guard let self else { return }

            if let result {
                Task { @MainActor in
                    onTranscript(result.bestTranscription.formattedString)
                    if result.isFinal {
                        self.stop()
                    }
                }
            }

            if let error {
                Task { @MainActor in
                    self.lastError = error.localizedDescription
                    self.stop()
                }
            }
        }
    }

    @MainActor
    private func requestPermissions() async throws {
        let speechStatus = await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
        }
        guard speechStatus == .authorized else {
            throw VoiceInputError.permissionDenied("Speech recognition permission is required")
        }

        let microphoneGranted = await withCheckedContinuation { continuation in
            AVCaptureDevice.requestAccess(for: .audio) { granted in
                continuation.resume(returning: granted)
            }
        }
        guard microphoneGranted else {
            throw VoiceInputError.permissionDenied("Microphone permission is required")
        }
    }
}

private enum VoiceInputError: LocalizedError {
    case unavailable
    case permissionDenied(String)

    var errorDescription: String? {
        switch self {
        case .unavailable:
            return "Speech recognition is unavailable right now"
        case .permissionDenied(let message):
            return message
        }
    }
}
