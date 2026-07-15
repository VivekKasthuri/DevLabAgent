using System;
using System.Speech.Recognition;

namespace DevLab.Services
{
    public sealed class VoiceInputService : IDisposable
    {
        private SpeechRecognitionEngine? _engine;

        public bool IsListening { get; private set; }
        public string? LastError { get; private set; }

        public event Action<string>? TranscriptReceived;
        public event Action? StateChanged;

        public void Start()
        {
            try
            {
                if (_engine == null)
                {
                    _engine = new SpeechRecognitionEngine();
                    _engine.LoadGrammar(new DictationGrammar());
                    _engine.SetInputToDefaultAudioDevice();
                    _engine.SpeechRecognized += OnSpeechRecognized;
                    _engine.RecognizeCompleted += OnRecognizeCompleted;
                }

                if (IsListening) return;

                LastError = null;
                IsListening = true;
                StateChanged?.Invoke();
                _engine.RecognizeAsync(RecognizeMode.Multiple);
            }
            catch (Exception ex)
            {
                LastError = ex.Message;
                IsListening = false;
                StateChanged?.Invoke();
            }
        }

        public void Stop()
        {
            if (_engine == null || !IsListening) return;
            IsListening = false;
            StateChanged?.Invoke();
            _engine.RecognizeAsyncStop();
        }

        private void OnSpeechRecognized(object? sender, SpeechRecognizedEventArgs e)
        {
            if (e.Result == null || e.Result.Confidence < 0.35) return;
            var transcript = e.Result.Text?.Trim();
            if (!string.IsNullOrEmpty(transcript))
            {
                TranscriptReceived?.Invoke(transcript);
            }
        }

        private void OnRecognizeCompleted(object? sender, RecognizeCompletedEventArgs e)
        {
            IsListening = false;
            if (e.Error != null)
            {
                LastError = e.Error.Message;
            }
            StateChanged?.Invoke();
        }

        public void Dispose()
        {
            if (_engine == null) return;
            _engine.SpeechRecognized -= OnSpeechRecognized;
            _engine.RecognizeCompleted -= OnRecognizeCompleted;
            _engine.Dispose();
            _engine = null;
        }
    }
}
