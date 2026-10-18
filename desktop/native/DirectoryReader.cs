using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

// Redirected UTF-8 JSON lines, deliberately independent of the shell/UI helper.
internal static class DirectoryReader
{
    private const uint DirectoryAttribute = 0x10;
    private const uint HiddenAttribute = 0x2;
    private const uint ReparsePointAttribute = 0x400;
    private const uint MountPointTag = 0xA0000003;
    private const uint SymlinkTag = 0xA000000C;
    private const int FileNotFound = 2;
    private const int NoMoreFiles = 18;
    private const int InvalidParameter = 87;
    private const int NotDirectory = 267;
    private const uint LargeFetch = 2;
    private static readonly IntPtr InvalidHandle = new IntPtr(-1);

    [StructLayout(LayoutKind.Sequential)]
    internal struct FileTime
    {
        internal uint Low;
        internal uint High;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    internal struct FindData
    {
        internal uint Attributes;
        internal FileTime CreationTime;
        internal FileTime AccessTime;
        internal FileTime WriteTime;
        internal uint SizeHigh;
        internal uint SizeLow;
        internal uint ReparseTag;
        internal uint Reserved1;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        internal string Name;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 14)]
        internal string AlternateName;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct FileInformation
    {
        internal uint Attributes;
        internal FileTime CreationTime;
        internal FileTime AccessTime;
        internal FileTime WriteTime;
        internal uint VolumeSerialNumber;
        internal uint SizeHigh;
        internal uint SizeLow;
        internal uint NumberOfLinks;
        internal uint FileIndexHigh;
        internal uint FileIndexLow;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern uint GetFileAttributesW(string path);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(string path, uint access, uint share,
        IntPtr security, uint disposition, uint flags, IntPtr template);

    [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInformation information);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern IntPtr FindFirstFileExW(string pattern, int infoLevel, out FindData data,
        int searchOperation, IntPtr filter, uint flags);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool FindNextFileW(IntPtr handle, out FindData data);

    [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool FindClose(IntPtr handle);

    [DllImport("kernel32.dll", ExactSpelling = true)]
    private static extern uint SetErrorMode(uint mode);

    private static int Main(string[] args)
    {
        const uint noDriveErrorDialogs = 0x0001 | 0x8000;
        uint previousMode = SetErrorMode(noDriveErrorDialogs);
        SetErrorMode(previousMode | noDriveErrorDialogs);
        if (args.Length != 0) return 1;

        try
        {
            // Console.In/Out can be null streams for /target:winexe. Open the
            // inherited handles explicitly; do not allocate or attach a console.
            using (StreamReader input = new StreamReader(Console.OpenStandardInput(),
                new UTF8Encoding(false, true), false, 4096))
            using (StreamWriter output = new StreamWriter(Console.OpenStandardOutput(),
                new UTF8Encoding(false), 4096))
            {
                output.NewLine = "\n";
                output.AutoFlush = true;
                JavaScriptSerializer json = new JavaScriptSerializer();
                json.MaxJsonLength = Int32.MaxValue;
                string line;
                while ((line = input.ReadLine()) != null)
                {
                    // Serialize before writing, so a failed request never emits
                    // a partial success response. EOF ends the service naturally.
                    output.WriteLine(json.Serialize(Respond(line, json)));
                }
            }
            return 0;
        }
        catch (Exception)
        {
            // Broken pipes, invalid UTF-8, or a fatal runtime failure end the
            // service without an unhandled-exception dialog or protocol chatter.
            return 1;
        }
    }

    private static object Error(long id, int code)
    {
        return new { id = id, ok = false, error = new { win32Code = code } };
    }

    private static object Respond(string line, JavaScriptSerializer json)
    {
        long id = 0;
        try
        {
            Dictionary<string, object> request = json.DeserializeObject(line) as Dictionary<string, object>;
            object value;
            if (request == null || !request.TryGetValue("id", out value) ||
                (!(value is int) && !(value is long)))
                return Error(0, InvalidParameter);
            id = Convert.ToInt64(value, CultureInfo.InvariantCulture);
            if (id <= 0) return Error(0, InvalidParameter);
            if (!request.TryGetValue("path", out value) || !IsExtendedDirectoryPath(value as string))
                return Error(id, InvalidParameter);
            string path = (string)value;
            bool accurate = false;
            if (request.TryGetValue("accurate", out value))
            {
                if (!(value is bool)) return Error(id, InvalidParameter);
                accurate = (bool)value;
            }
            return new { id = id, ok = true, entries = ReadDirectory(path, accurate) };
        }
        catch (Win32Exception error) { return Error(id, error.NativeErrorCode); }
        catch (ArgumentException) { return Error(id, InvalidParameter); }
        catch (InvalidOperationException) { return Error(id, InvalidParameter); }
    }

    internal static bool IsExtendedDirectoryPath(string path)
    {
        if (String.IsNullOrEmpty(path) || !path.StartsWith(@"\\?\", StringComparison.Ordinal) ||
            path.IndexOf('\0') >= 0 || path.IndexOf('/') >= 0 || path.IndexOf('*') >= 0 ||
            path.IndexOf('?', 4) >= 0)
            return false;
        if (path.Length >= 7 && ((path[4] >= 'A' && path[4] <= 'Z') ||
            (path[4] >= 'a' && path[4] <= 'z')) && path[5] == ':' && path[6] == '\\')
            return path.IndexOf(':', 6) < 0;
        if (!path.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase) || path.IndexOf(':') >= 0)
            return false;
        int serverEnd = path.IndexOf('\\', 8);
        return serverEnd > 8 && serverEnd + 1 < path.Length && path[serverEnd + 1] != '\\';
    }

    private static void ValidateDirectory(string path)
    {
        if (IsUncShareRoot(path))
        {
            ValidateShareRoot(path);
            return;
        }
        uint attributes = GetFileAttributesW(path);
        if (attributes == UInt32.MaxValue) throw new Win32Exception(Marshal.GetLastWin32Error());
        if ((attributes & DirectoryAttribute) == 0) throw new Win32Exception(NotDirectory);
    }

    internal static bool IsUncShareRoot(string path)
    {
        if (!IsExtendedDirectoryPath(path) || !path.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase))
            return false;
        int serverEnd = path.IndexOf('\\', 8);
        int shareEnd = path.IndexOf('\\', serverEnd + 1);
        return shareEnd < 0 || shareEnd == path.Length - 1;
    }

    internal static void ValidateShareRoot(string path)
    {
        // GetFileAttributesW documents ERROR_BAD_NETPATH for a share root.
        // Opening the root with FILE_FLAG_BACKUP_SEMANTICS validates existence
        // without reading contents. OPEN_EXISTING preserves missing-share errors;
        // zero desired access avoids requiring file-data read permission.
        // https://learn.microsoft.com/windows/win32/api/fileapi/nf-fileapi-createfilew
        using (SafeFileHandle handle = CreateFileW(path.TrimEnd('\\'), 0, 1 | 2 | 4,
            IntPtr.Zero, 3, 0x02000000, IntPtr.Zero))
        {
            if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
        }
    }

    private static List<Dictionary<string, object>> ReadDirectory(string path, bool accurate)
    {
        ValidateDirectory(path);
        string directoryPrefix = path.EndsWith(@"\", StringComparison.Ordinal) ? path : path + @"\";
        string pattern = directoryPrefix + "*";
        List<Dictionary<string, object>> entries = new List<Dictionary<string, object>>();
        FindData data;
        IntPtr handle = FindFirstFileExW(pattern, 1, out data, 0, IntPtr.Zero, LargeFetch);
        int error = handle == InvalidHandle ? Marshal.GetLastWin32Error() : 0;
        if (handle == InvalidHandle && error == InvalidParameter)
        {
            // Some redirectors do not implement FIND_FIRST_EX_LARGE_FETCH.
            handle = FindFirstFileExW(pattern, 1, out data, 0, IntPtr.Zero, 0);
            error = handle == InvalidHandle ? Marshal.GetLastWin32Error() : 0;
        }
        if (handle == InvalidHandle)
        {
            if (error != FileNotFound && error != NoMoreFiles) throw new Win32Exception(error);
            // A missing directory must not become an empty result if it was
            // removed between validation and FindFirstFileExW.
            ValidateDirectory(path);
            return entries;
        }

        try
        {
            do
            {
                if (data.Name != "." && data.Name != "..") entries.Add(ReadEntry(directoryPrefix, data, accurate));
            }
            while (FindNextFileW(handle, out data));
            error = Marshal.GetLastWin32Error();
            if (error != NoMoreFiles) throw new Win32Exception(error);
        }
        finally
        {
            FindClose(handle);
        }
        return entries;
    }

    internal static Dictionary<string, object> ReadEntry(string directoryPrefix, FindData data, bool accurate)
    {
        Dictionary<string, object> entry = ToEntry(data);
        bool link = entry.ContainsKey("isSymbolicLink");
        // Fast mode uses the enumeration snapshot, which can be stale on NTFS
        // after writes through another hard-link name. Explicit refresh requests
        // accurate:true to read current handle metadata for ordinary entries too.
        if (!link && !accurate) return entry;

        // Follow links (no FILE_FLAG_OPEN_REPARSE_POINT). All potentially blocking
        // target I/O stays in this process so the parent's timeout can kill it.
        // Zero access, read/write/delete sharing, OPEN_EXISTING, BACKUP_SEMANTICS.
        using (SafeFileHandle handle = CreateFileW(directoryPrefix + data.Name, 0, 1 | 2 | 4,
            IntPtr.Zero, 3, 0x02000000, IntPtr.Zero))
        {
            FileInformation information;
            if (handle.IsInvalid || !GetFileInformationByHandle(handle, out information))
            {
                // The parent drops and counts this entry. Preserve the complete
                // enumeration record, including link identity, for that decision.
                entry.Add("unavailable", true);
                return entry;
            }
            bool folder = (information.Attributes & DirectoryAttribute) != 0;
            entry["type"] = folder ? "folder" : "file";
            entry["size"] = folder ? null : (object)(((ulong)information.SizeHigh << 32) | information.SizeLow);
            entry["modified"] = Modified(information.WriteTime);
            if (!link) entry["hidden"] = (information.Attributes & HiddenAttribute) != 0;
        }
        return entry;
    }

    internal static Dictionary<string, object> ToEntry(FindData data)
    {
        bool folder = (data.Attributes & DirectoryAttribute) != 0;
        Dictionary<string, object> entry = new Dictionary<string, object>();
        entry.Add("name", data.Name);
        entry.Add("type", folder ? "folder" : "file");
        entry.Add("size", folder ? null : (object)(((ulong)data.SizeHigh << 32) | data.SizeLow));
        entry.Add("modified", Modified(data.WriteTime));
        entry.Add("hidden", (data.Attributes & HiddenAttribute) != 0);
        // Cloud placeholders and other reparse points are not symbolic links.
        // Only accurate mode requests handle metadata for those entries.
        if ((data.Attributes & ReparsePointAttribute) != 0 &&
            (data.ReparseTag == SymlinkTag || data.ReparseTag == MountPointTag))
            entry.Add("isSymbolicLink", true);
        return entry;
    }

    private static string Modified(FileTime time)
    {
        ulong ticks = ((ulong)time.High << 32) | time.Low;
        if (ticks == 0 || ticks > Int64.MaxValue) return null;
        try
        {
            return DateTime.FromFileTimeUtc((long)ticks).ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);
        }
        catch (ArgumentOutOfRangeException) { return null; }
    }
}
