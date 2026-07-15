using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using DevLab.Models;

namespace DevLab.Views
{
    public partial class MessageBubbleView : UserControl
    {
        public MessageBubbleView()
        {
            InitializeComponent();
            DataContextChanged += (s, e) => Refresh();
        }

        private void Refresh()
        {
            if (DataContext is not ChatMessage msg) return;

            ContentText.Text = msg.Content;
            RoleLabel.Text = msg.RoleLabel;

            switch (msg.Role)
            {
                case MessageRole.User:
                    RoleLabel.Foreground = new SolidColorBrush(Color.FromRgb(0xA7, 0x8B, 0xFA));
                    BubbleBorder.Background = new SolidColorBrush(Color.FromRgb(0x24, 0x24, 0x24));
                    BubbleBorder.BorderBrush = new SolidColorBrush(Color.FromArgb(0x60, 0xA7, 0x8B, 0xFA));
                    break;
                case MessageRole.Agent:
                    RoleLabel.Foreground = new SolidColorBrush(Color.FromRgb(0x4A, 0xDE, 0x80));
                    break;
                case MessageRole.Error:
                    RoleLabel.Foreground = new SolidColorBrush(Color.FromRgb(0xF8, 0x71, 0x71));
                    BubbleBorder.BorderBrush = new SolidColorBrush(Color.FromArgb(0x80, 0xF8, 0x71, 0x71));
                    break;
                case MessageRole.Tool:
                    RoleLabel.Foreground = new SolidColorBrush(Color.FromRgb(0xFB, 0xBF, 0x24));
                    ContentText.FontFamily = new FontFamily("Cascadia Code, Consolas");
                    ContentText.FontSize = 11;
                    break;
            }
        }
    }
}
