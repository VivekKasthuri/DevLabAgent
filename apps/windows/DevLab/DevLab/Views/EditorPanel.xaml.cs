using System;
using System.Collections.Generic;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Shapes;
using DevLab.Models;

namespace DevLab.Views
{
    public partial class EditorPanel : UserControl
    {
        public event Action<FileNode>? FileSaved;

        private readonly List<FileNode> _openFiles = new();
        private FileNode? _activeFile;
        private bool _suppressChange;

        public EditorPanel() => InitializeComponent();

        public IReadOnlyList<FileNode> OpenFiles => _openFiles;
        public FileNode? ActiveFile => _activeFile;

        public void OpenFile(FileNode node)
        {
            if (!_openFiles.Contains(node)) _openFiles.Add(node);
            ActivateTab(node);
            RenderTabs();
        }

        public void RefreshFileContent(string path, string content)
        {
            var node = _openFiles.Find(f => string.Equals(f.Path, path, StringComparison.OrdinalIgnoreCase));
            if (node == null) return;

            node.Content = content;
            node.IsModified = false;

            if (_activeFile == node)
            {
                _suppressChange = true;
                EditorBox.Text = content;
                _suppressChange = false;
            }
            RenderTabs();
        }

        private void ActivateTab(FileNode node)
        {
            _activeFile = node;
            _suppressChange = true;
            EditorBox.Text = node.Content;
            _suppressChange = false;
            EmptyState.Visibility = Visibility.Collapsed;
            EditorBox.Visibility = Visibility.Visible;
        }

        private void RenderTabs()
        {
            TabBar.Children.Clear();
            foreach (var f in _openFiles)
            {
                var border = new Border
                {
                    BorderBrush = new SolidColorBrush(Color.FromRgb(0x2E, 0x2E, 0x2E)),
                    BorderThickness = new Thickness(0, 0, 1, 0),
                    Cursor = Cursors.Hand,
                    Background = _activeFile == f
                        ? new SolidColorBrush(Color.FromRgb(0x0F, 0x0F, 0x0F))
                        : Brushes.Transparent,
                };
                var file = f; // capture
                border.MouseLeftButtonDown += (_, _) => { ActivateTab(file); RenderTabs(); };

                var inner = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(12, 0, 12, 0) };

                if (f.IsModified)
                    inner.Children.Add(new Ellipse { Width = 5, Height = 5, Fill = new SolidColorBrush(Color.FromRgb(0xA7, 0x8B, 0xFA)), Margin = new Thickness(0, 0, 5, 0), VerticalAlignment = VerticalAlignment.Center });

                inner.Children.Add(new TextBlock
                {
                    Text = f.Icon + "  " + f.Name,
                    FontSize = 12,
                    Foreground = _activeFile == f
                        ? new SolidColorBrush(Color.FromRgb(0xD4, 0xD4, 0xD4))
                        : new SolidColorBrush(Color.FromRgb(0x6B, 0x6B, 0x6B)),
                    VerticalAlignment = VerticalAlignment.Center,
                });

                var closeBtn = new Button
                {
                    Content = "✕", Background = Brushes.Transparent, BorderThickness = new Thickness(0),
                    Foreground = new SolidColorBrush(Color.FromRgb(0x6B, 0x6B, 0x6B)),
                    FontSize = 9, Margin = new Thickness(6, 0, 0, 0), Cursor = Cursors.Hand,
                    VerticalAlignment = VerticalAlignment.Center, Padding = new Thickness(2),
                };
                closeBtn.Click += (_, e) => { e.Handled = true; CloseTab(file); };
                inner.Children.Add(closeBtn);

                // Accent bottom bar
                var activeBar = new Border
                {
                    Height = 2, Background = new SolidColorBrush(Color.FromRgb(0xA7, 0x8B, 0xFA)),
                    VerticalAlignment = VerticalAlignment.Bottom,
                    Visibility = _activeFile == f ? Visibility.Visible : Visibility.Collapsed,
                };

                var container = new Grid { Height = 36 };
                container.Children.Add(border);
                border.Child = inner;
                container.Children.Add(activeBar);
                TabBar.Children.Add(container);
            }
        }

        private void CloseTab(FileNode node)
        {
            _openFiles.Remove(node);
            if (_activeFile == node)
            {
                _activeFile = _openFiles.Count > 0 ? _openFiles[^1] : null;
                if (_activeFile != null) ActivateTab(_activeFile);
                else
                {
                    EditorBox.Visibility = Visibility.Collapsed;
                    EmptyState.Visibility = Visibility.Visible;
                }
            }
            RenderTabs();
        }

        private void OnTextChanged(object sender, TextChangedEventArgs e)
        {
            if (_suppressChange || _activeFile == null) return;
            _activeFile.Content = EditorBox.Text;
            _activeFile.IsModified = true;
            RenderTabs();
        }

        private void OnKeyDown(object sender, KeyEventArgs e)
        {
            if (e.Key == Key.S && (Keyboard.Modifiers & ModifierKeys.Control) == ModifierKeys.Control)
            {
                e.Handled = true;
                OnSave(sender, e);
            }
        }

        private void OnSave(object sender, RoutedEventArgs e)
        {
            if (_activeFile == null) return;
            FileSaved?.Invoke(_activeFile);
        }
    }
}
