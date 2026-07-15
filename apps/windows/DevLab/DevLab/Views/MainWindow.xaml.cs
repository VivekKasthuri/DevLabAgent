using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Microsoft.Win32;
using System.Windows;
using System.Windows.Media;
using DevLab.Models;
using DevLab.Services;

namespace DevLab.Views
{
    public partial class MainWindow : Window
    {
        private readonly AgentService _agent = App.AgentService;
        private string _projectPath = System.Environment.GetFolderPath(System.Environment.SpecialFolder.UserProfile);

        public MainWindow()
        {
            InitializeComponent();
            BindAgentEvents();

            // Wire panels
            FileTreePanel.FileOpened += OnFileOpened;
            EditorPanel.FileSaved   += OnFileSaved;
        }

        // ── Event binding ──────────────────────────────────────────────────────
        private void BindAgentEvents()
        {
            _agent.PropertyChanged += (s, e) =>
            {
                switch (e.PropertyName)
                {
                    case nameof(AgentService.IsConnected):
                        StatusDot.Fill = _agent.IsConnected
                            ? new SolidColorBrush(Color.FromRgb(0x4A, 0xDE, 0x80))
                            : new SolidColorBrush(Color.FromRgb(0xFB, 0xBF, 0x24));
                        break;
                    case nameof(AgentService.ServerStatus):
                        StatusText.Text = _agent.ServerStatus;
                        break;
                }
            };

            _agent.FilesChanged += async () => await RefreshOpenFilesAsync();
        }

        // ── Toolbar ────────────────────────────────────────────────────────────
        private void OnOpenFolder(object sender, RoutedEventArgs e)
        {
            var dialog = new OpenFolderDialog
            {
                Title = "Select project folder",
                InitialDirectory = _projectPath,
            };
            if (dialog.ShowDialog() == true)
            {
                _projectPath = dialog.FolderName;
                _ = LoadFileTree(_projectPath);
            }
        }

        private async Task LoadFileTree(string path)
        {
            var nodes = await _agent.LoadFileTreeAsync(path);
            FileTreePanel.SetNodes(nodes, path);
        }

        // ── File events ────────────────────────────────────────────────────────
        private async void OnFileOpened(FileNode node)
        {
            var content = await _agent.LoadFileAsync(node.Path) ?? LocalFileFallback(node.Path);
            if (content != null)
            {
                node.Content = content;
                EditorPanel.OpenFile(node);
                BreadcrumbText.Text = node.Path;
            }
        }

        private async void OnFileSaved(FileNode node)
        {
            var ok = await _agent.SaveFileAsync(node.Path, node.Content);
            if (ok) node.IsModified = false;
        }

        private async Task RefreshOpenFilesAsync()
        {
            if (string.IsNullOrWhiteSpace(_projectPath)) return;

            var openPaths = EditorPanel.OpenFiles.Select(f => f.Path).ToList();
            if (openPaths.Count == 0) return;

            var nodes = await _agent.LoadFileTreeAsync(_projectPath);
            await Dispatcher.InvokeAsync(() => FileTreePanel.SetNodes(nodes, _projectPath));

            foreach (var path in openPaths)
            {
                var content = await _agent.LoadFileAsync(path) ?? LocalFileFallback(path);
                if (content == null) continue;

                await Dispatcher.InvokeAsync(() =>
                {
                    EditorPanel.RefreshFileContent(path, content);
                    if (EditorPanel.ActiveFile?.Path == path) BreadcrumbText.Text = path;
                });
            }
        }

        private string? LocalFileFallback(string path)
        {
            try
            {
                var fullPath = System.IO.Path.IsPathRooted(path)
                    ? path
                    : System.IO.Path.Combine(_projectPath, path);
                return System.IO.File.Exists(fullPath) ? System.IO.File.ReadAllText(fullPath) : null;
            }
            catch
            {
                return null;
            }
        }
    }
}
