using System;
using System.ComponentModel;
using System.Collections.Specialized;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Threading;
using DevLab.Models;
using DevLab.Services;

namespace DevLab.Views
{
    public partial class ChatPanel : UserControl
    {
        private readonly AgentService _agent = App.AgentService;
        private readonly DispatcherTimer _thinkingTimer = new() { Interval = TimeSpan.FromSeconds(1) };
        private DateTime _thinkingStartedAt = DateTime.MinValue;

        public ChatPanel()
        {
            InitializeComponent();
            MessagesList.ItemsSource = _agent.Messages;
            (_agent.Messages as INotifyCollectionChanged)!.CollectionChanged += OnMessagesCollectionChanged;
            foreach (var msg in _agent.Messages) msg.PropertyChanged += OnMessageChanged;

            _thinkingTimer.Tick += (_, _) =>
            {
                if (!_agent.IsThinking || _thinkingStartedAt == DateTime.MinValue) return;
                var secs = Math.Max(0, (int)(DateTime.Now - _thinkingStartedAt).TotalSeconds);
                ThinkingLabel.Text = $"Thinking… {secs}s";
            };

            _agent.PropertyChanged += (s, e) =>
            {
                switch (e.PropertyName)
                {
                    case nameof(AgentService.IsConnected):
                        ConnDot.Fill = _agent.IsConnected
                            ? new SolidColorBrush(Color.FromRgb(0x4A, 0xDE, 0x80))
                            : new SolidColorBrush(Color.FromRgb(0xFB, 0xBF, 0x24));
                        break;
                    case nameof(AgentService.ServerStatus):
                        StatusLabel.Text = _agent.ServerStatus;
                        break;
                    case nameof(AgentService.IsThinking):
                        ThinkingLabel.Visibility = _agent.IsThinking ? Visibility.Visible : Visibility.Collapsed;
                        SendBtn.IsEnabled = _agent.IsConnected;
                        InputBox.IsEnabled = _agent.IsConnected;
                        SendBtn.Content = _agent.IsThinking ? "⏳" : "➤";
                        if (_agent.IsThinking)
                        {
                            _thinkingStartedAt = DateTime.Now;
                            ThinkingLabel.Text = "Thinking… 0s";
                            StatusLabel.Text = "Agent is thinking…";
                            _thinkingTimer.Start();
                            StartBusyBorderAnimation();
                            ScrollToBottom();
                        }
                        else
                        {
                            _thinkingTimer.Stop();
                            _thinkingStartedAt = DateTime.MinValue;
                            ThinkingLabel.Text = "Thinking…";
                            StopBusyBorderAnimation();
                        }
                        break;
                }
            };
        }

        private void OnSend(object sender, RoutedEventArgs e) => Send();
        private void OnInputKeyDown(object sender, KeyEventArgs e)
        {
            if (e.Key == Key.Return && (Keyboard.Modifiers & ModifierKeys.Control) == ModifierKeys.Control)
            {
                e.Handled = true;
                Send();
            }
        }

        private void Send()
        {
            var text = InputBox.Text.Trim();
            if (string.IsNullOrEmpty(text) || !_agent.IsConnected) return;
            InputBox.Clear();
            _ = _agent.SendMessageAsync(text);
            ScrollToBottom();
        }

        private async void OnNewSession(object sender, RoutedEventArgs e) => await _agent.NewSessionAsync();
        private async void OnClearContext(object sender, RoutedEventArgs e) => await _agent.ClearContextAsync();

        private void ScrollToBottom()
        {
            Dispatcher.InvokeAsync(() =>
            {
                MessagesScroll.ScrollToEnd();
            }, System.Windows.Threading.DispatcherPriority.Background);
        }

        private void OnMessagesCollectionChanged(object? sender, NotifyCollectionChangedEventArgs e)
        {
            if (e.NewItems != null)
            {
                foreach (var item in e.NewItems)
                {
                    if (item is ChatMessage msg) msg.PropertyChanged += OnMessageChanged;
                }
            }
            if (e.OldItems != null)
            {
                foreach (var item in e.OldItems)
                {
                    if (item is ChatMessage msg) msg.PropertyChanged -= OnMessageChanged;
                }
            }
            ScrollToBottom();
        }

        private void OnMessageChanged(object? sender, PropertyChangedEventArgs e)
        {
            if (e.PropertyName == nameof(ChatMessage.Content)) ScrollToBottom();
        }

        private void StartBusyBorderAnimation()
        {
            ChatBusyBorder.Visibility = Visibility.Visible;
            var animation = new DoubleAnimation
            {
                From = 0.2,
                To = 0.9,
                Duration = TimeSpan.FromMilliseconds(700),
                AutoReverse = true,
                RepeatBehavior = RepeatBehavior.Forever
            };
            ChatBusyBorder.BeginAnimation(OpacityProperty, animation);
        }

        private void StopBusyBorderAnimation()
        {
            ChatBusyBorder.BeginAnimation(OpacityProperty, null);
            ChatBusyBorder.Opacity = 0;
            ChatBusyBorder.Visibility = Visibility.Collapsed;
        }
    }
}
