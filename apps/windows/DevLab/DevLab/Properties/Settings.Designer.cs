namespace DevLab.Properties
{
    // Minimal settings container used by AgentService.
    // This keeps local build/runtime stable when a generated Settings.settings
    // file is not present in source control.
    internal sealed class Settings
    {
        private static readonly Settings _default = new();
        public static Settings Default => _default;

        public string ServerUrl { get; set; } = "";
        public string ApiKey { get; set; } = "";

        public void Save()
        {
            // No-op in this fallback implementation.
        }
    }
}
