using System.Windows;
using System.Windows.Media;
using DevLab.Services;

namespace DevLab
{
    public partial class App : Application
    {
        public static AgentService AgentService { get; } = new();

        protected override void OnStartup(StartupEventArgs e)
        {
            base.OnStartup(e);
            ApplyAdaptiveTextColors();
            // Find the agent root relative to this exe
            var agentRoot = FindAgentRoot();
            AgentService.StartServer(agentRoot);
        }

        // Text color is derived from the background luminance:
        // dark/grey background → white text, light/white background → black text.
        private void ApplyAdaptiveTextColors()
        {
            if (Resources["BgBrush"] is not SolidColorBrush bg) return;
            bool lightBackground = Luminance(bg.Color) > 0.5;

            Resources["TextBrush"] = new SolidColorBrush(lightBackground
                ? Color.FromRgb(0x1A, 0x1A, 0x1E)    // near-black on white bg
                : Color.FromRgb(0xCC, 0xCC, 0xCC));  // white-ish on dark bg
            Resources["TextDimBrush"] = new SolidColorBrush(lightBackground
                ? Color.FromRgb(0x5A, 0x5E, 0x66)
                : Color.FromRgb(0x9D, 0x9D, 0x9D));
        }

        private static double Luminance(Color c) =>
            (0.2126 * c.R + 0.7152 * c.G + 0.0722 * c.B) / 255.0;

        protected override void OnExit(ExitEventArgs e)
        {
            AgentService.Dispose();
            base.OnExit(e);
        }

        private static string FindAgentRoot()
        {
            // In production: bundled in same directory as the exe
            var exeDir = AppContext.BaseDirectory;
            var bundled = System.IO.Path.Combine(exeDir, "agent", "index.js");
            if (System.IO.File.Exists(bundled))
                return System.IO.Path.GetDirectoryName(bundled)!;

            // Development: up several directories from the csproj
            var dev = new System.IO.DirectoryInfo(exeDir);
            for (int i = 0; i < 8; i++)
            {
                if (System.IO.File.Exists(System.IO.Path.Combine(dev.FullName, "index.js")))
                    return dev.FullName;
                dev = dev.Parent ?? dev;
            }
            return exeDir;
        }
    }
}
