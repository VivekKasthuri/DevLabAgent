using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Net.WebSockets;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using DevLab.Models;

namespace DevLab.Services
{
    public class AgentService : INotifyPropertyChanged, IDisposable
    {
        // ── State ──────────────────────────────────────────────────────────────
        private bool _isConnected;
        private bool _isThinking;
        private string _serverStatus = "Starting…";
        private string _selectedProvider = "groq";
        private string _selectedModel = "";

        public bool IsConnected { get => _isConnected; private set { _isConnected = value; OnPropertyChanged(); } }
        public bool IsThinking  { get => _isThinking; private set { _isThinking = value; OnPropertyChanged(); } }
        public string ServerStatus { get => _serverStatus; private set { _serverStatus = value; OnPropertyChanged(); } }
        public string SelectedProvider { get => _selectedProvider; set { _selectedProvider = value; OnPropertyChanged(); } }
        public string SelectedModel    { get => _selectedModel;    set { _selectedModel = value; OnPropertyChanged(); } }

        public ObservableCollection<ChatMessage> Messages { get; } = new();
        public ObservableCollection<Provider> Providers { get; } = new();

        // ── Settings (persist via Properties.Settings or registry) ────────────
        private const string DefaultPort = "4321";
        private string ServerUrl
        {
            get => Properties.Settings.Default.ServerUrl is { Length: > 0 } s ? s : $"http://localhost:{DefaultPort}";
            set { Properties.Settings.Default.ServerUrl = value; Properties.Settings.Default.Save(); }
        }
        private string ApiKey
        {
            get => Properties.Settings.Default.ApiKey ?? "";
            set { Properties.Settings.Default.ApiKey = value; Properties.Settings.Default.Save(); }
        }

        private string BaseUrl => ServerUrl.TrimEnd('/');
        private string WsUrl   => BaseUrl.Replace("https://", "wss://").Replace("http://", "ws://");
        private bool IsHostedMode => !BaseUrl.Contains("localhost") && !BaseUrl.Contains("127.0.0.1");

        private Process? _serverProcess;
        private ClientWebSocket? _ws;
        private CancellationTokenSource _cts = new();
        private readonly HttpClient _http = new();
        private int _currentAgentMsgIndex = -1;
        private bool _didConnect = false;
        private readonly Queue<string> _queuedMessages = new();

        public event PropertyChangedEventHandler? PropertyChanged;
        public event Action? FilesChanged;

        // ── Public settings helpers ────────────────────────────────────────────
        public string GetServerUrl() => ServerUrl;
        public string GetApiKey()    => ApiKey;
        public void SetServerUrl(string url) { ServerUrl = url; }
        public void SetApiKey(string key)    { ApiKey = key; _http.DefaultRequestHeaders.Authorization =
            string.IsNullOrEmpty(key) ? null : new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", key); }

        // ── Server lifecycle ───────────────────────────────────────────────────
        public void StartServer(string agentRoot)
        {
            if (IsHostedMode)
            {
                ServerStatus = "Connecting to hosted server…";
                _ = ConnectWebSocketAsync();
                _ = LoadProvidersAsync();
                return;
            }

            ServerStatus = "Starting agent server…";

            // Prefer 'devlab' global command; fall back to 'node index.js'
            var (cmd, args) = ResolveServerCommand(agentRoot);
            if (cmd == null) { ServerStatus = "Node.js not found. Install from nodejs.org"; return; }

            var process = new Process
            {
                StartInfo = new ProcessStartInfo
                {
                    FileName = cmd,
                    Arguments = args,
                    WorkingDirectory = agentRoot,
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    CreateNoWindow = true,
                    Environment = { ["UI_PORT"] = DefaultPort }
                }
            };

            process.OutputDataReceived += (_, e) =>
            {
                if (_didConnect || e.Data == null) return;
                if (e.Data.Contains("DevLab Server Ready") || e.Data.Contains("running at") || e.Data.Contains("localhost:"))
                {
                    _didConnect = true;
                    App.Current.Dispatcher.Invoke(() =>
                    {
                        ServerStatus = "Server ready";
                        _ = ConnectWebSocketAsync();
                        _ = LoadProvidersAsync();
                    });
                }
            };

            process.Start();
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
            _serverProcess = process;
        }

        private (string? cmd, string args) ResolveServerCommand(string agentRoot)
        {
            // 1. Bundled binary inside app package (distribution mode — no source needed)
            //    Place devlab-win-x64.exe in the same folder as the app EXE
            var appDir = AppDomain.CurrentDomain.BaseDirectory;
            var bundled = Path.Combine(appDir, "devlab.exe");
            if (File.Exists(bundled))
                return (bundled, $"serve --no-open --port {DefaultPort}");

            // Also check Resources subfolder
            var bundledRes = Path.Combine(appDir, "Resources", "devlab.exe");
            if (File.Exists(bundledRes))
                return (bundledRes, $"serve --no-open --port {DefaultPort}");

            // 2. Try global 'devlab' command (installed via npm link / install-cli.ps1)
            var devlab = FindInPath("devlab.cmd") ?? FindInPath("devlab");
            if (devlab != null)
                return (devlab, $"serve --no-open --port {DefaultPort}");

            // 3. Fall back to node index.js (developer / source mode)
            var node = FindNode();
            if (node != null)
                return (node, $"index.js serve \"{agentRoot}\" --no-open --port {DefaultPort}");

            return (null, "");
        }

        private string? FindNode()
        {
            foreach (var p in new[] { @"C:\Program Files\nodejs\node.exe", @"C:\Program Files (x86)\nodejs\node.exe" })
                if (File.Exists(p)) return p;
            return FindInPath("node.exe") ?? FindInPath("node");
        }

        private static string? FindInPath(string name)
        {
            try
            {
                var result = Process.Start(new ProcessStartInfo("where", name)
                    { RedirectStandardOutput = true, UseShellExecute = false, CreateNoWindow = true });
                result?.WaitForExit(2000);
                var path = result?.StandardOutput.ReadLine()?.Trim();
                return string.IsNullOrEmpty(path) ? null : path;
            }
            catch { return null; }
        }

        public async Task TestConnectionAsync()
        {
            try
            {
                var req = new HttpRequestMessage(HttpMethod.Get, $"{BaseUrl}/api/project");
                if (!string.IsNullOrEmpty(ApiKey))
                    req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", ApiKey);
                var resp = await _http.SendAsync(req);
                ServerStatus = resp.IsSuccessStatusCode ? "Connected ✓" : $"Error {(int)resp.StatusCode}";
            }
            catch (Exception ex) { ServerStatus = $"Failed: {ex.Message}"; }
        }

        public void Reconnect()
        {
            _cts.Cancel();
            _cts = new CancellationTokenSource();
            _ws?.Dispose();
            _ws = null;
            _didConnect = false;
            IsConnected = false;
            _ = ConnectWebSocketAsync();
            _ = LoadProvidersAsync();
        }

        // ── WebSocket ──────────────────────────────────────────────────────────
        private async Task ConnectWebSocketAsync()
        {
            while (!_cts.IsCancellationRequested)
            {
                try
                {
                    _ws = new ClientWebSocket();
                    var wsUri = string.IsNullOrEmpty(ApiKey) ? new Uri(WsUrl) : new Uri($"{WsUrl}?api_key={Uri.EscapeDataString(ApiKey)}");
                    await _ws.ConnectAsync(wsUri, _cts.Token);
                    IsConnected = true;
                    _ = ReceiveLoopAsync();
                    return;
                }
                catch
                {
                    IsConnected = false;
                    await Task.Delay(2000, _cts.Token);
                }
            }
        }

        private async Task ReceiveLoopAsync()
        {
            var buffer = new byte[64 * 1024];
            while (_ws?.State == WebSocketState.Open && !_cts.IsCancellationRequested)
            {
                try
                {
                    var result = await _ws.ReceiveAsync(buffer, _cts.Token);
                    if (result.MessageType == WebSocketMessageType.Close) break;
                    var text = Encoding.UTF8.GetString(buffer, 0, result.Count);
                    App.Current.Dispatcher.Invoke(() => HandleWsMessage(text));
                }
                catch { break; }
            }
            IsConnected = false;
            if (!_cts.IsCancellationRequested)
                await Task.Delay(2000).ContinueWith(_ => ConnectWebSocketAsync());
        }

        private void HandleWsMessage(string text)
        {
            using var doc = JsonDocument.Parse(text);
            var root = doc.RootElement;
            var type = root.GetProperty("type").GetString();

            switch (type)
            {
                case "connected":
                    ServerStatus = "Connected";
                    break;

                case "thinking":
                    IsThinking = true;
                    AddThinkingIndicator();
                    break;

                case "token":
                    RemoveThinkingIndicator();
                    var content = root.TryGetProperty("text", out var t) ? t.GetString() ?? "" : "";
                    AppendOrUpdateAgentMessage(content);
                    break;

                case "tool_call":
                    var tName = root.TryGetProperty("name", out var tn) ? tn.GetString() ?? "" : "";
                    var tArgs = root.TryGetProperty("args", out var ta) ? ta.ToString() : "";
                    AppendToolCall(tName, tArgs);
                    break;

                case "tool_result":
                    var rName = root.TryGetProperty("name", out var rn) ? rn.GetString() ?? "" : "";
                    var rResult = root.TryGetProperty("resultStr", out var rr) ? rr.GetString() ?? "" : "";
                    UpdateToolResult(rName, rResult);
                    if (ShouldTriggerFileRefresh(rName, rResult)) FilesChanged?.Invoke();
                    break;

                case "done":
                    IsThinking = false;
                    RemoveThinkingIndicator();
                    FilesChanged?.Invoke();
                    DispatchNextQueuedMessageIfNeeded();
                    break;

                case "error":
                    IsThinking = false;
                    RemoveThinkingIndicator();
                    var err = root.TryGetProperty("text", out var et) ? et.GetString() ?? "Error" : "Error";
                    Messages.Add(new ChatMessage { Role = MessageRole.Error, Content = err });
                    DispatchNextQueuedMessageIfNeeded();
                    break;

                case "cleared":
                case "session_cleared":
                    Messages.Clear();
                    _queuedMessages.Clear();
                    break;
            }
        }

        // ── Send ──────────────────────────────────────────────────────────────
        public async Task SendMessageAsync(string text)
        {
            if (string.IsNullOrWhiteSpace(text) || _ws?.State != WebSocketState.Open) return;
            Messages.Add(new ChatMessage { Role = MessageRole.User, Content = text });
            if (IsThinking)
            {
                _queuedMessages.Enqueue(text);
                Messages.Add(new ChatMessage
                {
                    Role = MessageRole.Agent,
                    Content = $"Queued request #{_queuedMessages.Count}. Running after current response…"
                });
                return;
            }

            await SendNowAsync(text);
        }

        private async Task SendNowAsync(string text)
        {
            IsThinking = true;
            var routedText = EnrichPromptForTicketImplementation(text);
            var payload = JsonSerializer.Serialize(new
            {
                type = "chat",
                text = routedText,
                provider = SelectedProvider,
                model = SelectedModel
            });
            var bytes = Encoding.UTF8.GetBytes(payload);
            await _ws.SendAsync(bytes, WebSocketMessageType.Text, true, _cts.Token);
        }

        private void DispatchNextQueuedMessageIfNeeded()
        {
            if (_queuedMessages.Count == 0 || _ws?.State != WebSocketState.Open) return;
            var next = _queuedMessages.Dequeue();
            _ = SendNowAsync(next);
        }

        public async Task NewSessionAsync()
        {
            if (_ws?.State != WebSocketState.Open) return;
            var bytes = Encoding.UTF8.GetBytes("{\"type\":\"new_session\"}");
            await _ws.SendAsync(bytes, WebSocketMessageType.Text, true, _cts.Token);
            Messages.Clear();
            _queuedMessages.Clear();
        }

        public async Task ClearContextAsync()
        {
            if (_ws?.State != WebSocketState.Open) return;
            var bytes = Encoding.UTF8.GetBytes("{\"type\":\"clear\"}");
            await _ws.SendAsync(bytes, WebSocketMessageType.Text, true, _cts.Token);
            _queuedMessages.Clear();
        }

        // ── REST (auth helper) ─────────────────────────────────────────────────
        private HttpRequestMessage AuthRequest(HttpMethod method, string url)
        {
            var req = new HttpRequestMessage(method, url);
            if (!string.IsNullOrEmpty(ApiKey))
                req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", ApiKey);
            return req;
        }

        private async Task<string> GetJsonAsync(string url)
        {
            var req = AuthRequest(HttpMethod.Get, url);
            var resp = await _http.SendAsync(req);
            return await resp.Content.ReadAsStringAsync();
        }

        private async Task<HttpResponseMessage> PostJsonAsync(string url, object payload)
        {
            var req = AuthRequest(HttpMethod.Post, url);
            req.Content = new StringContent(JsonSerializer.Serialize(payload), Encoding.UTF8, "application/json");
            return await _http.SendAsync(req);
        }

        // ── REST ───────────────────────────────────────────────────────────────
        public async Task LoadProvidersAsync()
        {
            try
            {
                var json = await GetJsonAsync($"{BaseUrl}/api/providers");
                using var doc = JsonDocument.Parse(json);
                Providers.Clear();
                foreach (var p in doc.RootElement.EnumerateArray())
                {
                    var provider = new Provider
                    {
                        Name  = p.TryGetProperty("name",  out var n) ? n.GetString() ?? "" : "",
                        Label = p.TryGetProperty("label", out var l) ? l.GetString() ?? "" : "",
                    };
                    if (p.TryGetProperty("models", out var models))
                        foreach (var m in models.EnumerateArray())
                            provider.Models.Add(new ModelEntry
                            {
                                Id    = m.TryGetProperty("id",    out var mid)    ? mid.GetString()    ?? "" : "",
                                Label = m.TryGetProperty("label", out var mlabel) ? mlabel.GetString() ?? "" : "",
                            });
                    Providers.Add(provider);
                }
                if (Providers.Count > 0)
                {
                    SelectedProvider = Providers[0].Name;
                    if (Providers[0].Models.Count > 0) SelectedModel = Providers[0].Models[0].Id;
                }
            }
            catch { /* server not ready yet */ }
        }

        public async Task<string?> LoadFileAsync(string path)
        {
            try
            {
                var json = await GetJsonAsync($"{BaseUrl}/api/file?path={Uri.EscapeDataString(path)}");
                using var doc = JsonDocument.Parse(json);
                return doc.RootElement.TryGetProperty("content", out var c) ? c.GetString() : null;
            }
            catch { return null; }
        }

        public async Task<bool> SaveFileAsync(string path, string content)
        {
            try
            {
                var res = await PostJsonAsync($"{BaseUrl}/api/file", new { path, content });
                return res.IsSuccessStatusCode;
            }
            catch { return false; }
        }

        public async Task<List<FileNode>> LoadFileTreeAsync(string projectPath)
        {
            try
            {
                await SetWorkspaceAsync(projectPath);
                var json = await GetJsonAsync($"{BaseUrl}/api/files?path=.");
                using var doc = JsonDocument.Parse(json);
                if (doc.RootElement.TryGetProperty("files", out var files))
                    return ParseNodes(files);
            }
            catch { }
            return new();
        }

        private async Task SetWorkspaceAsync(string path)
        {
            if (string.IsNullOrEmpty(path)) return;
            try { await PostJsonAsync($"{BaseUrl}/api/workspace", new { path }); }
            catch { }
        }

        private static List<FileNode> ParseNodes(JsonElement arr)
        {
            var result = new List<FileNode>();
            foreach (var el in arr.EnumerateArray())
            {
                var node = new FileNode
                {
                    Name = el.TryGetProperty("name", out var n) ? n.GetString() ?? "" : "",
                    Path = el.TryGetProperty("path", out var p) ? p.GetString() ?? "" : "",
                    IsDirectory = el.TryGetProperty("type", out var t) && t.GetString() == "dir",
                };
                if (el.TryGetProperty("children", out var ch))
                    foreach (var child in ParseNodes(ch)) node.Children.Add(child);
                result.Add(node);
            }
            return result;
        }

        // ── Message helpers ────────────────────────────────────────────────────
        private void AddThinkingIndicator()
        {
            Messages.Add(new ChatMessage { Role = MessageRole.Agent, Content = "…" });
            _currentAgentMsgIndex = Messages.Count - 1;
        }

        private void RemoveThinkingIndicator()
        {
            if (_currentAgentMsgIndex >= 0 && _currentAgentMsgIndex < Messages.Count &&
                Messages[_currentAgentMsgIndex].Content == "…")
            {
                Messages.RemoveAt(_currentAgentMsgIndex);
                _currentAgentMsgIndex = -1;
            }
        }

        private void AppendOrUpdateAgentMessage(string content)
        {
            if (_currentAgentMsgIndex >= 0 && _currentAgentMsgIndex < Messages.Count)
                Messages[_currentAgentMsgIndex].Content = content;
            else
            {
                Messages.Add(new ChatMessage { Role = MessageRole.Agent, Content = content });
                _currentAgentMsgIndex = Messages.Count - 1;
            }
        }

        private void AppendToolCall(string name, string args)
        {
            var tool = new ToolCallEntry { Name = name, Args = args };
            if (_currentAgentMsgIndex >= 0 && _currentAgentMsgIndex < Messages.Count)
                Messages[_currentAgentMsgIndex].ToolCalls.Add(tool);
            else
            {
                var msg = new ChatMessage { Role = MessageRole.Tool };
                msg.ToolCalls.Add(tool);
                Messages.Add(msg);
            }
        }

        private void UpdateToolResult(string name, string result)
        {
            for (int i = Messages.Count - 1; i >= 0; i--)
                foreach (var tc in Messages[i].ToolCalls)
                    if (tc.Name == name && !tc.IsDone)
                    { tc.Result = result; tc.IsDone = true; return; }
        }

        private static bool ShouldTriggerFileRefresh(string toolName, string result)
        {
            var name = (toolName ?? "").ToLowerInvariant();
            if (name.Contains("edit") || name.Contains("write") || name.Contains("apply_patch") ||
                name.Contains("fix") || name.Contains("create") || name.Contains("delete"))
            {
                return true;
            }

            var text = (result ?? "").ToLowerInvariant();
            return text.Contains("updated") || text.Contains("modified") || text.Contains("created") ||
                   text.Contains("deleted") || text.Contains("patched");
        }

        private static string EnrichPromptForTicketImplementation(string text)
        {
            var lower = (text ?? "").ToLowerInvariant();
            var hasJiraKey = Regex.IsMatch(text ?? "", @"\b[A-Z][A-Z0-9]+-\d+\b");
            var signals = new[] { "ticket", "jira", "issue", "bug", "story", "task", "implement", "develop", "fix" };
            if (!hasJiraKey)
            {
                var matchedSignal = false;
                foreach (var signal in signals)
                {
                    if (!lower.Contains(signal)) continue;
                    matchedSignal = true;
                    break;
                }
                if (!matchedSignal) return text;
            }
            return text + "\n\nImplement this request directly in the project files.\nIf a Jira key is provided (like ABC-123), treat it as the primary ticket reference.\nChoose the correct existing files for the change, edit them, and keep changes minimal and production-safe.\nAfter editing, summarize what files were changed and what was implemented.";
        }

        protected void OnPropertyChanged([CallerMemberName] string? name = null)
            => PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));

        public void Dispose()
        {
            _cts.Cancel();
            _ws?.Dispose();
            _serverProcess?.Kill();
            _http.Dispose();
        }
    }
}
