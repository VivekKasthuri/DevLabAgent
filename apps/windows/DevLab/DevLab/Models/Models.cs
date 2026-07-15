using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Runtime.CompilerServices;

namespace DevLab.Models
{
    // ── File tree ─────────────────────────────────────────────────────────────
    public class FileNode : INotifyPropertyChanged
    {
        private bool _isExpanded;
        private bool _isModified;
        private string _content = "";
        private bool _isSelected;

        public string Name { get; set; } = "";
        public string Path { get; set; } = "";
        public bool IsDirectory { get; set; }
        public ObservableCollection<FileNode> Children { get; set; } = new();
        public string Extension => System.IO.Path.GetExtension(Path).TrimStart('.').ToLower();

        public bool IsExpanded
        {
            get => _isExpanded;
            set { _isExpanded = value; OnPropertyChanged(); }
        }
        public bool IsModified
        {
            get => _isModified;
            set { _isModified = value; OnPropertyChanged(); }
        }
        public string Content
        {
            get => _content;
            set { _content = value; OnPropertyChanged(); }
        }
        public bool IsSelected
        {
            get => _isSelected;
            set { _isSelected = value; OnPropertyChanged(); }
        }

        public string Icon => IsDirectory ? (IsExpanded ? "📂" : "📁") : GetFileIcon(Extension);

        private static string GetFileIcon(string ext) => ext switch
        {
            "cs"   => "🔷", "csproj" => "🔷",
            "swift" => "🧡", "kt" => "🟣",
            "js" or "jsx" => "🟨", "ts" or "tsx" => "💙",
            "py"   => "🐍", "dart" => "💙",
            "html" => "🌐", "css" or "scss" => "🎨",
            "json" or "yaml" or "yml" => "📋",
            "md"   => "📝", "sh" or "bash" => "⚙️",
            _      => "📄"
        };

        public event PropertyChangedEventHandler? PropertyChanged;
        protected void OnPropertyChanged([CallerMemberName] string? name = null)
            => PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));
    }

    // ── Chat messages ──────────────────────────────────────────────────────────
    public enum MessageRole { User, Agent, Tool, Error }

    public class ChatMessage : INotifyPropertyChanged
    {
        private string _content = "";
        public Guid Id { get; } = Guid.NewGuid();
        public MessageRole Role { get; set; }
        public DateTime Timestamp { get; } = DateTime.Now;
        public ObservableCollection<ToolCallEntry> ToolCalls { get; set; } = new();

        public string Content
        {
            get => _content;
            set { _content = value; OnPropertyChanged(); }
        }

        public string RoleLabel => Role switch
        {
            MessageRole.User  => "YOU",
            MessageRole.Agent => "DEVLAB",
            MessageRole.Tool  => "TOOL",
            MessageRole.Error => "ERROR",
            _ => ""
        };

        public event PropertyChangedEventHandler? PropertyChanged;
        protected void OnPropertyChanged([CallerMemberName] string? name = null)
            => PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));
    }

    public class ToolCallEntry : INotifyPropertyChanged
    {
        private string _result = "";
        private bool _isDone;
        public Guid Id { get; } = Guid.NewGuid();
        public string Name { get; set; } = "";
        public string Args { get; set; } = "";

        public string Result
        {
            get => _result;
            set { _result = value; OnPropertyChanged(); }
        }
        public bool IsDone
        {
            get => _isDone;
            set { _isDone = value; OnPropertyChanged(); }
        }

        public event PropertyChangedEventHandler? PropertyChanged;
        protected void OnPropertyChanged([CallerMemberName] string? name = null)
            => PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));
    }

    // ── Provider / model ───────────────────────────────────────────────────────
    public class Provider
    {
        public string Name { get; set; } = "";
        public string Label { get; set; } = "";
        public List<ModelEntry> Models { get; set; } = new();
    }

    public class ModelEntry
    {
        public string Id { get; set; } = "";
        public string Label { get; set; } = "";
    }
}
