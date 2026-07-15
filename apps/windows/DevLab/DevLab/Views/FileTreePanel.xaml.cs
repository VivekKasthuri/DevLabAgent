using System;
using System.Collections.Generic;
using System.Windows;
using System.Windows.Controls;
using DevLab.Models;
using DevLab.Services;

namespace DevLab.Views
{
    public partial class FileTreePanel : UserControl
    {
        public event Action<FileNode>? FileOpened;

        public FileTreePanel() => InitializeComponent();

        public void SetNodes(List<FileNode> nodes, string projectPath)
        {
            FileTree.ItemsSource = nodes;
            ProjectLabel.Text = System.IO.Path.GetFileName(projectPath);
        }

        private void OnSelectedItemChanged(object sender, RoutedPropertyChangedEventArgs<object> e)
        {
            if (e.NewValue is FileNode node && !node.IsDirectory)
                FileOpened?.Invoke(node);
        }

        private void OnRefresh(object sender, RoutedEventArgs e)
        {
            // Trigger parent to reload — parent subscribes via PropertyChanged or direct call
        }
    }
}
