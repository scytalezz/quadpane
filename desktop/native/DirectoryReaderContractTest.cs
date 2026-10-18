using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;

internal static class DirectoryReaderContractTest
{
    private static void Check(bool condition, string message)
    {
        if (!condition) throw new Exception(message);
    }

    private static int Main()
    {
        Check(Marshal.SizeOf(typeof(DirectoryReader.FindData)) == 592, "WIN32_FIND_DATAW layout");
        Check(Marshal.SizeOf(typeof(DirectoryReader.FileInformation)) == 52, "BY_HANDLE_FILE_INFORMATION layout");
        DirectoryReader.FindData data = new DirectoryReader.FindData();
        data.Name = "synthetic";
        data.SizeHigh = 1;
        data.SizeLow = 17;
        Dictionary<string, object> entry = DirectoryReader.ToEntry(data);
        Check((ulong)entry["size"] == 4294967313UL, "size high DWORD");
        Check(entry["modified"] == null, "unsupported timestamp");
        Check(!(bool)entry["hidden"], "visible attribute");
        Check(!entry.ContainsKey("isSymbolicLink"), "ordinary file");

        long ticks = new DateTime(2025, 2, 3, 4, 5, 6, 789, DateTimeKind.Utc).ToFileTimeUtc();
        data.WriteTime.Low = (uint)ticks;
        data.WriteTime.High = (uint)((ulong)ticks >> 32);
        data.Attributes = 0x12;
        entry = DirectoryReader.ToEntry(data);
        Check((string)entry["modified"] == "2025-02-03T04:05:06.789Z", "UTC timestamp");
        Check((string)entry["type"] == "folder" && entry["size"] == null, "folder size");
        Check((bool)entry["hidden"], "hidden attribute");
        data.WriteTime.High = UInt32.MaxValue;
        Check(DirectoryReader.ToEntry(data)["modified"] == null, "overflow timestamp");
        data.WriteTime.High = 0x7FFFFFFF;
        Check(DirectoryReader.ToEntry(data)["modified"] == null, "out-of-range timestamp");

        foreach (uint tag in new uint[] { 0xA0000003, 0xA000000C, 0x9000001A, 0x9000101A, 0x80000013, 0 })
        {
            data.Attributes = 0x400;
            data.ReparseTag = tag;
            entry = DirectoryReader.ToEntry(data);
            bool link = tag == 0xA0000003 || tag == 0xA000000C;
            Check(entry.ContainsKey("isSymbolicLink") == link, "only mount points/symlinks: " + tag);
            if (link) Check((bool)entry["isSymbolicLink"], "never serialize false");
            data.Attributes = 0;
            Check(!DirectoryReader.ToEntry(data).ContainsKey("isSymbolicLink"), "ignore tag without reparse attribute");
        }

        foreach (string path in new string[] { @"\\?\C:\", @"\\?\d:\long path\", @"\\?\UNC\server\share", @"\\?\UNC\server\share\folder" })
            Check(DirectoryReader.IsExtendedDirectoryPath(path), "valid path: " + path);
        foreach (string path in new string[] { null, "", @"C:\", @"\\server\share", @"\\?\C:relative", @"\\?\UNC\server", @"\\?\UNC\\share", @"\\?\UNC\server\\share", @"\\?\C:\*", @"\\?\C:\a?b", @"\\?\C:\a:b", "\\\\?\\C:\\a\0b" })
            Check(!DirectoryReader.IsExtendedDirectoryPath(path), "invalid path: " + path);

        foreach (string path in new string[] { @"\\?\UNC\server\share", @"\\?\UNC\server\share\", @"\\?\unc\server\공유\" })
            Check(DirectoryReader.IsUncShareRoot(path), "share root: " + path);
        foreach (string path in new string[] { null, @"\\?\C:\", @"\\?\UNC\server", @"\\?\UNC\server\share\folder", @"\\?\UNC\server\share\folder\" })
            Check(!DirectoryReader.IsUncShareRoot(path), "not a share root: " + path);
        // Exercise the directory-handle API locally even without an SMB fixture.
        string localDirectory = AppDomain.CurrentDomain.BaseDirectory;
        DirectoryReader.ValidateShareRoot(localDirectory);
        try
        {
            DirectoryReader.ValidateShareRoot(System.IO.Path.Combine(localDirectory, "missing-" + Guid.NewGuid()));
            throw new Exception("missing directory accepted by handle validation");
        }
        catch (System.ComponentModel.Win32Exception error)
        {
            Check(error.NativeErrorCode == 2 || error.NativeErrorCode == 3, "preserve missing native error");
        }

        string metadataFile = Path.Combine(localDirectory, "metadata-" + Guid.NewGuid() + ".txt");
        DateTime expectedTime = new DateTime(2025, 2, 3, 4, 5, 6, 789, DateTimeKind.Utc);
        try
        {
            File.WriteAllBytes(metadataFile, new byte[] { 1, 2, 3, 4, 5 });
            File.SetAttributes(metadataFile, FileAttributes.Normal);
            File.SetLastWriteTimeUtc(metadataFile, expectedTime);
            data = new DirectoryReader.FindData();
            data.Name = Path.GetFileName(metadataFile);
            data.Attributes = 0x12; // Deliberately stale folder + Hidden metadata.
            entry = DirectoryReader.ReadEntry(localDirectory, data, false);
            Check((string)entry["type"] == "folder" && (bool)entry["hidden"], "fast snapshot retained");
            entry = DirectoryReader.ReadEntry(localDirectory, data, true);
            Check((string)entry["type"] == "file" && (ulong)entry["size"] == 5, "handle type/size replace snapshot");
            Check((string)entry["modified"] == "2025-02-03T04:05:06.789Z", "handle timestamp replaces snapshot");
            Check(!(bool)entry["hidden"], "ordinary Hidden comes from handle");
            Check(!entry.ContainsKey("unavailable") && !entry.ContainsKey("isSymbolicLink"), "available ordinary entry");

            data.Attributes = 0x402; // Source Hidden must survive a visible target.
            data.ReparseTag = 0xA000000C;
            foreach (bool accurate in new bool[] { false, true })
            {
                entry = DirectoryReader.ReadEntry(localDirectory, data, accurate);
                Check((bool)entry["hidden"] && (bool)entry["isSymbolicLink"], "source link attributes retained");
                Check((ulong)entry["size"] == 5, "links always read handle metadata");
            }
            data.Name = "missing-" + Guid.NewGuid();
            entry = DirectoryReader.ReadEntry(localDirectory, data, false);
            Check((bool)entry["unavailable"] && (bool)entry["isSymbolicLink"], "missing link target marked unavailable");
            Check((bool)entry["hidden"] && entry["modified"] == null && (ulong)entry["size"] == 0, "failed link retains raw metadata");
            data.Attributes = 0;
            entry = DirectoryReader.ReadEntry(localDirectory, data, false);
            Check(!entry.ContainsKey("unavailable"), "ordinary fast entry does not open a handle");
            entry = DirectoryReader.ReadEntry(localDirectory, data, true);
            Check((bool)entry["unavailable"] && !entry.ContainsKey("isSymbolicLink"), "missing ordinary entry marked unavailable");
            Check(entry.Count == 6 && entry["modified"] == null && (ulong)entry["size"] == 0, "failed ordinary entry retains raw metadata");
            data.Attributes = 0x400;
            data.ReparseTag = 0x9000001A;
            entry = DirectoryReader.ReadEntry(localDirectory, data, false);
            Check(!entry.ContainsKey("unavailable") && !entry.ContainsKey("isSymbolicLink"), "cloud placeholder does not open a fast-mode handle");
        }
        finally { File.Delete(metadataFile); }

        foreach (System.Reflection.AssemblyName reference in typeof(DirectoryReader).Assembly.GetReferencedAssemblies())
            Check(reference.Name != "System.Windows.Forms" && reference.Name != "System.Drawing", "no UI dependency");
        Console.WriteLine("Native reader contracts passed");
        return 0;
    }
}
