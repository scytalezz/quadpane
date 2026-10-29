using System;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;

// One request per process, with paths only in UTF-8 JSON on stdin. Keep the same
// no-replacement APIs as the PowerShell fallback without paying for a shell host.
internal static class FileMover
{
    public sealed class Request
    {
        public string source { get; set; }
        public string destination { get; set; }
        public string mode { get; set; }
    }

    [STAThread]
    private static int Main()
    {
        // Match modern PowerShell's .NET path handling for paths beyond MAX_PATH.
        AppContext.SetSwitch("Switch.System.IO.UseLegacyPathHandling", false);
        AppContext.SetSwitch("Switch.System.IO.BlockLongPaths", false);
        try
        {
            // A winexe has inherited pipes but no console. Do not set console code pages.
            using (var input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false, true)))
            using (var output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)))
            {
                output.Write(Respond(input.ReadToEnd()));
            }
            return 0;
        }
        catch (Exception)
        {
            // Broken pipes and runtime failure leave the mutation outcome uncertain.
            return 1;
        }
    }

    private static string Respond(string input)
    {
        var json = new JavaScriptSerializer();
        try
        {
            var request = json.Deserialize<Request>(input);
            if (request == null) throw new ArgumentException("Missing move request");
            switch (request.mode)
            {
                case "file":
                    File.Move(ExtendedPath(request.source), ExtendedPath(request.destination));
                    break;
                case "directory":
                    Directory.Move(ExtendedPath(request.source), ExtendedPath(request.destination));
                    break;
                default:
                    throw new ArgumentException("Invalid move mode");
            }
            return "{\"ok\":true}";
        }
        catch (Exception error)
        {
            while (error.InnerException != null) error = error.InnerException;
            return json.Serialize(new {
                ok = false, win32 = error.HResult & 65535, message = error.Message
            });
        }
    }

    private static string ExtendedPath(string path)
    {
        if (String.IsNullOrEmpty(path) || !Path.IsPathRooted(path))
            throw new ArgumentException("Expected an absolute path");
        // The JavaScript boundary has already rejected device paths and aliases.
        return path.StartsWith(@"\\") ? @"\\?\UNC\" + path.Substring(2) : @"\\?\" + path;
    }
}
