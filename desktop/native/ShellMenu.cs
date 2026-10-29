// Classic Explorer context menus, hosted out of process on an STA message loop.
// Keep this process alive: shell clipboard objects and asynchronous property sheets
// can outlive InvokeCommand. No command line is constructed from file names.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32.SafeHandles;

[ComImport, Guid("000214e4-0000-0000-c000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IContextMenu {
    [PreserveSig] int QueryContextMenu(IntPtr menu, uint index, uint first, uint last, uint flags);
    [PreserveSig] int InvokeCommand(ref InvokeInfo info);
    [PreserveSig] int GetCommandString(UIntPtr id, uint flags, IntPtr reserved, IntPtr text, uint length);
}
[ComImport, Guid("000214f4-0000-0000-c000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IContextMenu2 {
    [PreserveSig] int QueryContextMenu(IntPtr menu, uint index, uint first, uint last, uint flags);
    [PreserveSig] int InvokeCommand(ref InvokeInfo info);
    [PreserveSig] int GetCommandString(UIntPtr id, uint flags, IntPtr reserved, IntPtr text, uint length);
    [PreserveSig] int HandleMenuMsg(uint message, IntPtr wParam, IntPtr lParam);
}
[ComImport, Guid("bcfce0a0-ec17-11d0-8d10-00a0c90f2719"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IContextMenu3 {
    [PreserveSig] int QueryContextMenu(IntPtr menu, uint index, uint first, uint last, uint flags);
    [PreserveSig] int InvokeCommand(ref InvokeInfo info);
    [PreserveSig] int GetCommandString(UIntPtr id, uint flags, IntPtr reserved, IntPtr text, uint length);
    [PreserveSig] int HandleMenuMsg(uint message, IntPtr wParam, IntPtr lParam);
    [PreserveSig] int HandleMenuMsg2(uint message, IntPtr wParam, IntPtr lParam, out IntPtr result);
}
// Only the first method is used; it occupies the first slot after IUnknown.
[ComImport, Guid("b63ea76d-1f85-456f-a19c-48159efa858b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IShellItemArray {
    void BindToHandler(IntPtr context, ref Guid handler, ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object result);
}
[ComVisible(true), Guid("00000121-0000-0000-c000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IDropSource {
    [PreserveSig] int QueryContinueDrag([MarshalAs(UnmanagedType.Bool)] bool escape, uint keys);
    [PreserveSig] int GiveFeedback(uint effect);
}
[ComVisible(true), ClassInterface(ClassInterfaceType.None)]
public class DropSource : IDropSource {
    const int Drop = 0x40100, Cancel = 0x40101;
    enum Phase { Dragging, Cancelled, Committing, Finished }
    readonly object gate = new object();
    readonly Func<bool> buttonDown, disconnected;
    readonly Func<long> milliseconds;
    readonly Action committing;
    Phase phase;
    bool armed;
    long releasedSince = -1;
    long staleKeysSince = -1;
    const int ReleaseCallbackGrace = 250;
    public DropSource() : this(NativeDragInput.PrimaryDown, () => false, () => {}) { }
    internal DropSource(Func<bool> buttonDown, Func<bool> disconnected, Action committing)
        : this(buttonDown, disconnected, committing, null) { }
    internal DropSource(Func<bool> buttonDown, Func<bool> disconnected, Action committing, Func<long> milliseconds) {
        this.buttonDown = buttonDown; this.disconnected = disconnected; this.committing = committing;
        var clock = Stopwatch.StartNew();
        this.milliseconds = milliseconds ?? (() => clock.ElapsedMilliseconds);
    }
    internal bool CanStart() {
        lock (gate) {
            if (phase != Phase.Dragging) return false;
            if (!disconnected() && buttonDown()) { armed = true; return true; }
            phase = Phase.Cancelled;
            return false;
        }
    }
    public int QueryContinueDrag(bool escape, uint keys) {
        lock (gate) {
            if (phase == Phase.Committing) return Drop;
            if (phase != Phase.Dragging) return Cancel;
            if (escape || disconnected()) { phase = Phase.Cancelled; return Cancel; }
            long now = milliseconds();
            // A new press cannot revive the old gesture, including when OLE
            // delivers the old release before it delivers that new press.
            if (staleKeysSince >= 0 && (now - staleKeysSince >= ReleaseCallbackGrace || buttonDown())) {
                phase = Phase.Cancelled; return Cancel;
            }
            if ((keys & 1) == 0) {
                // An unarmed source must never manufacture a drop. Preflight
                // can arm it: OLE need not call us before the first release.
                if (!armed) { phase = Phase.Cancelled; return Cancel; }
                phase = Phase.Committing; // Disable the watchdog BEFORE Drop can run.
            } else {
                // Physical state can run ahead of OLE's queued release callback.
                // Allow a bounded delivery grace, but only OLE may authorize DROP.
                if (!buttonDown()) {
                    if (!armed) { phase = Phase.Cancelled; return Cancel; }
                    if (staleKeysSince < 0) staleKeysSince = now;
                    return 0;
                }
                // A new press must not extend/revive the ambiguous old gesture.
                if (staleKeysSince >= 0) { phase = Phase.Cancelled; return Cancel; }
                armed = true;
                return 0;
            }
        }
        committing();
        return Drop;
    }
    public int GiveFeedback(uint effect) { return 0x40102; }
    internal void PollRelease(long milliseconds, bool down, bool captured, Action exit) {
        lock (gate) {
            if (phase == Phase.Committing || phase == Phase.Finished) return;
            if (down) { releasedSince = -1; return; }
            if (releasedSince < 0) releasedSince = milliseconds;
            if (milliseconds - releasedSince >= 1000) phase = Phase.Cancelled;
            // Let a responsive OLE loop observe CANCEL first. If no input is
            // delivered, retire this helper even if OLE already lost capture.
            // An uncommitted call can otherwise leave the service busy forever.
            // The shared gate excludes a concurrent transition to committing.
            if (milliseconds - releasedSince >= 2000) exit();
        }
    }
    internal void WatchRelease(Func<bool> captured, Action exit) {
        var clock = Stopwatch.StartNew();
        var watcher = new Thread(() => {
            while (true) {
                lock (gate) { if (phase == Phase.Committing || phase == Phase.Finished) return; }
                PollRelease(clock.ElapsedMilliseconds, buttonDown(), captured(), exit);
                Thread.Sleep(100);
            }
        });
        watcher.IsBackground = true;
        watcher.Start();
    }
    internal void Finish() { lock (gate) { phase = Phase.Finished; } }
    // Reserved protocol exit: only an uncommitted drag reaches this watchdog.
    // The service must keep other nonzero exits classified as helper failures.
    internal static void ExitCancelledDrag() { Environment.Exit(2); }
}
static class NativeDragInput {
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int metric);
    [DllImport("kernel32.dll")] internal static extern uint GetCurrentThreadId();
    [StructLayout(LayoutKind.Sequential)] struct GuiThreadInfo {
        public uint size, flags;
        public IntPtr active, focus, capture, menuOwner, moveSize, caret;
        public int left, top, right, bottom;
    }
    [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint thread, ref GuiThreadInfo info);
    internal static bool PrimaryDown(Func<int, short> read, bool swapped) {
        // GetAsyncKeyState reports physical buttons, unlike OLE's logical
        // MK_LBUTTON. Only the high bit is current state; the low bit is shared.
        return (read(swapped ? 2 : 1) & 0x8000) != 0;
    }
    internal static bool PrimaryDown() { return PrimaryDown(GetAsyncKeyState, GetSystemMetrics(23) != 0); }
    internal static bool HasCapture(uint thread) {
        var info = new GuiThreadInfo { size = (uint)Marshal.SizeOf(typeof(GuiThreadInfo)) };
        return GetGUIThreadInfo(thread, ref info) && info.capture != IntPtr.Zero;
    }
}

// Pipe EOF is insufficient when a descendant inherits the writer. Hold a
// waitable process handle so parent death is independent of pipes and the STA.
static class ParentProcessWatch {
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct ProcessEntry {
        public uint size, usage, id;
        public UIntPtr heap;
        public uint module, threads, parent;
        public int priority;
        public uint flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string name;
    }
    [DllImport("kernel32.dll", SetLastError=true)] static extern SafeFileHandle CreateToolhelp32Snapshot(uint flags, uint process);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool Process32FirstW(SafeFileHandle snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool Process32NextW(SafeFileHandle snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll", SetLastError=true)] static extern SafeFileHandle OpenProcess(uint access, bool inherit, uint process);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(SafeFileHandle process, out long created, out long exited, out long kernel, out long user);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(SafeFileHandle handle, uint milliseconds);
    static SafeFileHandle OpenParent() {
        using (var current = Process.GetCurrentProcess())
        using (var snapshot = CreateToolhelp32Snapshot(2, 0)) { // TH32CS_SNAPPROCESS
            if (snapshot.IsInvalid) throw new System.ComponentModel.Win32Exception();
            var entry = new ProcessEntry { size = (uint)Marshal.SizeOf(typeof(ProcessEntry)) };
            if (!Process32FirstW(snapshot, ref entry)) throw new System.ComponentModel.Win32Exception();
            do {
                if (entry.id != (uint)current.Id) continue;
                // SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION; no terminate right.
                var parent = OpenProcess(0x101000, false, entry.parent);
                if (parent.IsInvalid) {
                    int error = Marshal.GetLastWin32Error();
                    parent.Dispose();
                    if (error == 87) return null; // Parent already exited.
                    throw new System.ComponentModel.Win32Exception(error);
                }
                try {
                    long created, exited, kernel, user;
                    if (!GetProcessTimes(parent, out created, out exited, out kernel, out user)) throw new System.ComponentModel.Win32Exception();
                    // Reject a recycled PID before starting the permanent handle wait.
                    if (created > current.StartTime.ToUniversalTime().ToFileTimeUtc()) { parent.Dispose(); return null; }
                    return parent;
                } catch { parent.Dispose(); throw; }
            } while (Process32NextW(snapshot, ref entry));
            throw new InvalidOperationException("Cannot identify shell helper parent");
        }
    }
    internal static void Start(Action disconnected) {
        SafeFileHandle parent = OpenParent();
        if (parent == null) { disconnected(); return; }
        var watcher = new Thread(() => {
            using (parent) {
                if (WaitForSingleObject(parent, UInt32.MaxValue) != 0) Environment.Exit(1);
            }
            disconnected();
        });
        watcher.IsBackground = true;
        try { watcher.Start(); } catch { parent.Dispose(); throw; }
    }
}

// One reader keeps observing pipe closure even while the STA is blocked. A
// single drain owns the queue across nested OLE/menu loops, preventing reentry.
sealed class ShellLifetime {
    readonly object gate = new object();
    readonly Queue<string> requests = new Queue<string>();
    readonly Action<Action> post;
    readonly Action<string> process;
    readonly Action shutdown;
    readonly Action exit;
    bool scheduled;
    volatile bool disconnected;
    internal bool IsDisconnected { get { return disconnected; } }
    internal ShellLifetime(Action<Action> post, Action<string> process, Action shutdown, Action exit) {
        this.post = post; this.process = process; this.shutdown = shutdown; this.exit = exit;
    }
    internal void Read(Func<string> readLine) {
        try {
            string line;
            while ((line = readLine()) != null) {
                bool schedule;
                lock (gate) {
                    if (disconnected) return;
                    requests.Enqueue(line);
                    schedule = !scheduled;
                    scheduled = true;
                }
                if (schedule) post(Drain);
            }
        } catch (IOException) {
        } catch (ObjectDisposedException) {
        } catch (InvalidOperationException) {
            // The UI handle may already be shutting down.
        } finally { Disconnect(); }
    }
    internal void Disconnect() {
        bool schedule;
        lock (gate) {
            if (disconnected) return;
            disconnected = true;
            requests.Clear(); // Never start queued clipboard/shell work after cancellation.
            schedule = !scheduled;
            scheduled = true;
        }
        // A dedicated thread does not depend on the STA, stdout or thread pool.
        // Also bounds a hung clipboard flush or form disposal during shutdown.
        var watchdog = new Thread(() => { Thread.Sleep(2000); exit(); });
        watchdog.IsBackground = true;
        watchdog.Start();
        if (schedule) {
            try { post(Drain); } catch (InvalidOperationException) { }
        }
    }
    void Drain() {
        while (true) {
            string line = null;
            bool closing;
            lock (gate) {
                closing = disconnected;
                if (requests.Count != 0) line = requests.Dequeue();
                else scheduled = false;
            }
            if (line == null) { if (closing) shutdown(); return; }
            try { process(line); }
            catch (IOException) { Disconnect(); return; }
        }
    }
}
[ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IShellItem {
    void BindToHandler(IntPtr context, ref Guid handler, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out IContextMenu result);
}
[StructLayout(LayoutKind.Sequential)] struct Point { public int x, y; }
[StructLayout(LayoutKind.Sequential)] struct InvokeInfo {
    public uint size, mask;
    public IntPtr owner, verb, parameters, directory;
    public int show;
    public uint hotkey;
    public IntPtr icon, title, verbW, parametersW, directoryW, titleW;
    public Point point;
}
class Request {
    public string id { get; set; }
    public string parent { get; set; }
    public string owner { get; set; }
    public string mode { get; set; }
    public string[] paths { get; set; }
    public int x { get; set; }
    public int y { get; set; }
    public bool extended { get; set; }
    public string operation { get; set; }
    public uint sequence { get; set; }
    public string[] completed { get; set; }
    public bool reportProgress { get; set; }
}
class ShellHost : Form {
    [DllImport("shell32.dll", CharSet=CharSet.Unicode, PreserveSig=false)] static extern void SHParseDisplayName(string name, IntPtr context, out IntPtr pidl, uint mask, out uint attributes);
    [DllImport("shell32.dll", PreserveSig=false)] static extern void SHCreateShellItemArrayFromIDLists(uint count, IntPtr[] pidls, out IShellItemArray array);
    [DllImport("shell32.dll", CharSet=CharSet.Unicode, PreserveSig=false)] static extern void SHCreateItemFromParsingName(string name, IntPtr context, ref Guid iid, out IShellItem item);
    [DllImport("user32.dll")] static extern IntPtr CreatePopupMenu();
    [DllImport("user32.dll")] static extern bool DestroyMenu(IntPtr menu);
    [DllImport("user32.dll")] static extern uint TrackPopupMenuEx(IntPtr menu, uint flags, int x, int y, IntPtr owner, IntPtr parameters);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr owner);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern IntPtr SetWindowLongPtr(IntPtr window, int index, IntPtr value);
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr window, uint message, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] static extern int GetMenuItemCount(IntPtr menu);
    [DllImport("user32.dll")] static extern uint GetMenuItemID(IntPtr menu, int index);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetMenuString(IntPtr menu, uint position, StringBuilder text, int size, uint flags);
    [DllImport("ole32.dll")] static extern int OleFlushClipboard();
    [DllImport("ole32.dll")] static extern int OleGetClipboard(out System.Runtime.InteropServices.ComTypes.IDataObject data);
    [DllImport("user32.dll")] static extern uint GetClipboardSequenceNumber();
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern uint RegisterClipboardFormat(string format);
    [DllImport("kernel32.dll")] static extern IntPtr GlobalAlloc(uint flags, UIntPtr bytes);
    [DllImport("kernel32.dll")] static extern IntPtr GlobalLock(IntPtr memory);
    [DllImport("kernel32.dll")] static extern bool GlobalUnlock(IntPtr memory);
    [DllImport("kernel32.dll")] static extern IntPtr GlobalFree(IntPtr memory);
    [DllImport("user32.dll")] static extern bool OpenClipboard(IntPtr owner);
    [DllImport("user32.dll")] static extern bool CloseClipboard();
    [DllImport("user32.dll")] static extern bool EmptyClipboard();
    [DllImport("user32.dll")] static extern IntPtr SetClipboardData(uint format, IntPtr memory);
    [DllImport("ole32.dll")] static extern void ReleaseStgMedium(ref System.Runtime.InteropServices.ComTypes.STGMEDIUM medium);
    [DllImport("ole32.dll")] static extern int DoDragDrop(System.Runtime.InteropServices.ComTypes.IDataObject data, IDropSource source, uint allowed, out uint effect);
    IContextMenu current;
    IContextMenu2 menu2;
    IContextMenu3 menu3;
    readonly JavaScriptSerializer json = new JavaScriptSerializer();
    System.Runtime.InteropServices.ComTypes.IDataObject clipboardSnapshot;
    string[] clipboardPaths;
    uint clipboardSequence;
    object clipboardValue;
    ShellLifetime lifetime;
    bool ParentDisconnected { get { return lifetime != null && lifetime.IsDisconnected; } }
    static object CancelledDrag() { return new { action = "cancel", effect = 0u, sourceRetained = false }; }
    void Phase(Request request, string phase) {
        if (!request.reportProgress) return;
        Console.WriteLine(json.Serialize(new { id = request.id, phase }));
        Console.Out.Flush();
    }

    IntPtr ClipboardMemory(byte[] bytes) {
        IntPtr memory = GlobalAlloc(0x42, new UIntPtr((uint)bytes.Length));
        if (memory == IntPtr.Zero) throw new OutOfMemoryException();
        IntPtr pointer = GlobalLock(memory);
        if (pointer == IntPtr.Zero) { GlobalFree(memory); throw new OutOfMemoryException(); }
        Marshal.Copy(bytes, 0, pointer, bytes.Length); GlobalUnlock(memory);
        return memory;
    }
    bool ReplaceCutClipboard(uint expectedSequence, string[] remaining) {
        IntPtr files = IntPtr.Zero, effect = IntPtr.Zero;
        bool opened = false;
        try {
            if (remaining.Length != 0) {
                byte[] names = Encoding.Unicode.GetBytes(String.Join("\0", remaining) + "\0\0");
                byte[] drop = new byte[20 + names.Length]; // DROPFILES, followed by double-NUL UTF-16 paths
                BitConverter.GetBytes(20).CopyTo(drop, 0); BitConverter.GetBytes(1).CopyTo(drop, 16);
                names.CopyTo(drop, 20);
                files = ClipboardMemory(drop); effect = ClipboardMemory(BitConverter.GetBytes(2u));
            }
            opened = OpenClipboard(Handle);
            if (!opened) throw new InvalidOperationException("Clipboard is busy");
            // Compare and replace under the Windows clipboard lock, so a newer
            // clipboard cannot be overwritten between the sequence check and write.
            if (GetClipboardSequenceNumber() != expectedSequence) return false;
            if (!EmptyClipboard()) throw new InvalidOperationException("Cannot clear completed cut clipboard");
            if (remaining.Length != 0) {
                if (SetClipboardData(15, files) == IntPtr.Zero) throw new InvalidOperationException("Cannot retain pending files");
                files = IntPtr.Zero;
                if (SetClipboardData(RegisterClipboardFormat("Preferred DropEffect"), effect) == IntPtr.Zero) throw new InvalidOperationException("Cannot retain cut effect");
                effect = IntPtr.Zero;
            }
            return true;
        } finally {
            if (opened) CloseClipboard();
            if (files != IntPtr.Zero) GlobalFree(files);
            if (effect != IntPtr.Zero) GlobalFree(effect);
        }
    }

    static void ClipboardEffect(System.Runtime.InteropServices.ComTypes.IDataObject data, string name, uint value) {
        var format = new System.Runtime.InteropServices.ComTypes.FORMATETC {
            cfFormat = unchecked((short)RegisterClipboardFormat(name)), dwAspect = System.Runtime.InteropServices.ComTypes.DVASPECT.DVASPECT_CONTENT,
            lindex = -1, tymed = System.Runtime.InteropServices.ComTypes.TYMED.TYMED_HGLOBAL
        };
        var medium = new System.Runtime.InteropServices.ComTypes.STGMEDIUM {
            tymed = System.Runtime.InteropServices.ComTypes.TYMED.TYMED_HGLOBAL, unionmember = GlobalAlloc(0x42, new UIntPtr(4))
        };
        if (medium.unionmember == IntPtr.Zero) throw new OutOfMemoryException();
        try {
            IntPtr pointer = GlobalLock(medium.unionmember);
            if (pointer == IntPtr.Zero) throw new OutOfMemoryException();
            Marshal.WriteInt32(pointer, unchecked((int)value)); GlobalUnlock(medium.unionmember);
            data.SetData(ref format, ref medium, false);
        } finally { ReleaseStgMedium(ref medium); }
    }
    internal static void ReportOptimizedPaste(System.Runtime.InteropServices.ComTypes.IDataObject data) {
        ClipboardEffect(data, "Performed DropEffect", 0);
        ClipboardEffect(data, "Paste Succeeded", 2);
    }
    object ReadClipboardSnapshot() {
        return ReadClipboardSnapshot(GetClipboardSequenceNumber, OleGetClipboard,
            data => new DataObject(data), data => Marshal.ReleaseComObject(data), Thread.Sleep);
    }
    internal delegate int ClipboardRead(out System.Runtime.InteropServices.ComTypes.IDataObject data);
    // Injectable boundaries keep contract tests away from the system clipboard.
    internal object ReadClipboardSnapshot(Func<uint> sequence, ClipboardRead read,
        Func<System.Runtime.InteropServices.ComTypes.IDataObject, System.Windows.Forms.IDataObject> wrap,
        Action<System.Runtime.InteropServices.ComTypes.IDataObject> release, Action<int> pause) {
        uint currentSequence = sequence();
        // Reuse only a fully materialized, known generation. Zero means the
        // generation could not be read and must never validate cached content.
        // Do not cache an empty/temporarily unavailable delayed-render result.
        if (currentSequence != 0 && clipboardSnapshot != null && clipboardPaths.Length != 0 && currentSequence == clipboardSequence) return clipboardValue;
        ClearClipboardSnapshot(release);
        const int attempts = 5, cantOpen = unchecked((int)0x800401d0);
        for (int attempt = 0; attempt < attempts; ++attempt) {
            uint before = sequence();
            System.Runtime.InteropServices.ComTypes.IDataObject data = null;
            try {
                int result = read(out data);
                if (result != cantOpen || attempt == attempts - 1) Marshal.ThrowExceptionForHR(result);
                if (result >= 0) {
                    string[] paths = new string[0];
                    byte[] bytes = null;
                    if (data != null) {
                        var wrapper = wrap(data);
                        paths = wrapper.GetData(DataFormats.FileDrop) as string[] ?? new string[0];
                        var stream = wrapper.GetData("Preferred DropEffect") as MemoryStream;
                        bytes = stream == null ? null : stream.ToArray();
                    }
                    if (before == sequence()) {
                        var value = new { sources = paths, operation = bytes != null && bytes.Length >= 4 && BitConverter.ToUInt32(bytes, 0) == 2 ? "move" : "copy", sequence = before };
                        clipboardSnapshot = data; clipboardSequence = before; clipboardPaths = paths; clipboardValue = value;
                        data = null; // Ownership transferred only after a coherent read.
                        return value;
                    }
                }
            } finally { if (data != null) release(data); }
            // Retry acquisition/changing generations only, never a provider
            // exception or any clipboard/file mutation. No message-loop reentry.
            if (attempt < attempts - 1) pause(50);
        }
        throw new InvalidOperationException("Clipboard changed during snapshot");
    }
    void ClearClipboardSnapshot(Action<System.Runtime.InteropServices.ComTypes.IDataObject> release) {
        var previous = clipboardSnapshot;
        clipboardSnapshot = null; clipboardPaths = null; clipboardSequence = 0; clipboardValue = null;
        if (previous != null) release(previous);
    }
    protected override void Dispose(bool disposing) {
        try { if (disposing) ClearClipboardSnapshot(data => Marshal.ReleaseComObject(data)); }
        finally { base.Dispose(disposing); }
    }

    ShellHost() {
        ShowInTaskbar = false; FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.Manual; Size = new Size(1, 1); Opacity = 0;
    }
    protected override void WndProc(ref Message m) {
        if (m.Msg == 0x117 || m.Msg == 0x2b || m.Msg == 0x2c || m.Msg == 0x120) {
            IntPtr result;
            if (menu3 != null && menu3.HandleMenuMsg2((uint)m.Msg, m.WParam, m.LParam, out result) == 0) { m.Result = result; return; }
            if (menu2 != null && m.Msg != 0x120 && menu2.HandleMenuMsg((uint)m.Msg, m.WParam, m.LParam) == 0) { m.Result = IntPtr.Zero; return; }
        }
        base.WndProc(ref m);
    }
    string Verb(uint offset) {
        IntPtr buffer = Marshal.AllocCoTaskMem(1024);
        try {
            Marshal.WriteInt16(buffer, 0);
            return current.GetCommandString(new UIntPtr(offset), 4, IntPtr.Zero, buffer, 512) == 0 ? Marshal.PtrToStringUni(buffer) : "";
        } finally { Marshal.FreeCoTaskMem(buffer); }
    }
    object ShowShellMenu(Request request) {
        // Validate the gesture before potentially slow filesystem/COM work, and
        // again immediately before entering OLE. Never start UI after EOF.
        if (request.mode == "drag" && (ParentDisconnected || !NativeDragInput.PrimaryDown())) return CancelledDrag();
        if (request.mode == "show" && ParentDisconnected) return new { action = "cancel" };
        if (request.mode == "readClipboard") {
            return ReadClipboardSnapshot();
        }
        if (request.mode == "completePaste") {
            if (clipboardSnapshot == null || request.sequence != clipboardSequence || request.sequence != GetClipboardSequenceNumber()) return new { changed = false };
            var completed = new HashSet<string>(request.completed ?? new string[0], StringComparer.OrdinalIgnoreCase);
            var remaining = new List<string>();
            foreach (string filename in clipboardPaths) if (!completed.Contains(filename)) remaining.Add(filename);
            if (remaining.Count == clipboardPaths.Length) return new { changed = false };
            if (remaining.Count == 0) {
                // The target already moved originals: optimized MOVE reports
                // Performed DropEffect NONE, then Paste Succeeded MOVE. Reporting
                // MOVE for both tells a source to delete its originals again.
                try { ReportOptimizedPaste(clipboardSnapshot); } catch (COMException) { }
            }
            return new { changed = ReplaceCutClipboard(request.sequence, remaining.ToArray()) };
        }
        if (request.paths == null || request.paths.Length > 1000 || !Directory.Exists(request.parent)) throw new ArgumentException("Invalid folder or selection");
        foreach (string filename in request.paths) {
            if (!Path.IsPathRooted(filename) || !String.Equals(Path.GetDirectoryName(filename), request.parent, StringComparison.OrdinalIgnoreCase)
                || (!File.Exists(filename) && !Directory.Exists(filename))) throw new ArgumentException("Selection must exist in the same folder");
        }
        if (request.mode == "writeClipboard") {
            if (request.operation != "copy" && request.operation != "move") throw new ArgumentException("Invalid clipboard operation");
            var data = new DataObject();
            var files = new System.Collections.Specialized.StringCollection();
            files.AddRange(request.paths);
            data.SetFileDropList(files);
            data.SetData("Preferred DropEffect", new MemoryStream(BitConverter.GetBytes(request.operation == "move" ? 2u : 1u)));
            Clipboard.SetDataObject(data, true);
            return new { sources = request.paths, operation = request.operation };
        }
        var pidls = new List<IntPtr>();
        object items = null;
        IntPtr popup = IntPtr.Zero;
        try {
            Guid iid = typeof(IContextMenu).GUID;
            if (request.paths.Length == 0) {
                Guid itemID = typeof(IShellItem).GUID;
                IShellItem item;
                SHCreateItemFromParsingName(request.parent, IntPtr.Zero, ref itemID, out item);
                items = item;
                Guid view = new Guid("3981e226-f559-11d3-8e3a-00c04f6837d5"); // BHID_SFViewObject / CreateViewObject
                item.BindToHandler(IntPtr.Zero, ref view, ref iid, out current);
            } else {
                foreach (string filename in request.paths) {
                    IntPtr pidl; uint attributes;
                    SHParseDisplayName(filename, IntPtr.Zero, out pidl, 0, out attributes);
                    pidls.Add(pidl);
                }
                IShellItemArray array;
                SHCreateShellItemArrayFromIDLists((uint)pidls.Count, pidls.ToArray(), out array);
                items = array;
                if (request.mode == "drag" || request.mode == "inspectDrag") {
                    Guid dataHandler = new Guid("b8c0bd9f-ed24-455c-83e6-d5390c4fe8c4"); // BHID_DataObject
                    Guid dataID = typeof(System.Runtime.InteropServices.ComTypes.IDataObject).GUID;
                    object data;
                    array.BindToHandler(IntPtr.Zero, ref dataHandler, ref dataID, out data);
                    try {
                        if (request.mode == "inspectDrag") return new { paths = new DataObject(data).GetData(DataFormats.FileDrop), allowedEffects = 3 };
                        uint effect;
                        var source = new DropSource(NativeDragInput.PrimaryDown, () => ParentDisconnected,
                            () => Phase(request, "committing"));
                        if (!source.CanStart()) return CancelledDrag();
                        Phase(request, "interactive");
                        // Shell data object negotiates optimized moves with Explorer.
                        // Never delete sources ourselves: the target owns the transfer.
                        int result;
                        uint thread = NativeDragInput.GetCurrentThreadId();
                        try {
                            source.WatchRelease(() => NativeDragInput.HasCapture(thread), DropSource.ExitCancelledDrag);
                            if (!source.CanStart()) return CancelledDrag();
                            result = DoDragDrop((System.Runtime.InteropServices.ComTypes.IDataObject)data, source, 3, out effect);
                        } finally { source.Finish(); }
                        Marshal.ThrowExceptionForHR(result);
                        if (result == 0x40101) return CancelledDrag();
                        var performedStream = new DataObject(data).GetData("Performed DropEffect") as MemoryStream;
                        var performedBytes = performedStream == null ? null : performedStream.ToArray();
                        bool sourceRetained = effect == 2 && performedBytes != null && performedBytes.Length >= 4
                            && BitConverter.ToUInt32(performedBytes, 0) == 2;
                        return new { action = result == 0x40101 ? "cancel" : "drop", effect, sourceRetained };
                    } finally { Marshal.ReleaseComObject(data); }
                }
                Guid ui = new Guid("3981e225-f559-11d3-8e3a-00c04f6837d5"); // BHID_SFUIObject / GetUIObjectOf
                object contextMenu;
                array.BindToHandler(IntPtr.Zero, ref ui, ref iid, out contextMenu);
                current = (IContextMenu)contextMenu;
            }
            menu2 = current as IContextMenu2; menu3 = current as IContextMenu3;
            popup = CreatePopupMenu();
            if (popup == IntPtr.Zero) throw new InvalidOperationException("CreatePopupMenu failed");
            // CMF_CANRENAME: the host handles this view-dependent verb itself.
            Marshal.ThrowExceptionForHR(current.QueryContextMenu(popup, 0, 1, 0x7fff, (request.paths.Length == 1 ? 0x10u : 0u) | (request.extended ? 0x100u : 0u)));
            if (request.mode == "inspect") {
                var entries = new List<object>();
                for (int i = 0; i < GetMenuItemCount(popup); ++i) {
                    var label = new StringBuilder(512);
                    GetMenuString(popup, (uint)i, label, label.Capacity, 0x400);
                    uint id = GetMenuItemID(popup, i);
                    entries.Add(new { label = label.ToString(), verb = id > 0 && id <= 0x7fff ? Verb(id - 1) : "" });
                }
                return new { entries, contextMenu2 = menu2 != null, contextMenu3 = menu3 != null };
            }
            if (request.mode != "show") throw new ArgumentException("Unknown mode");
            if (ParentDisconnected) return new { action = "cancel" };
            IntPtr owner = new IntPtr(Int64.Parse(request.owner));
            SetWindowLongPtr(Handle, -8, owner); // GWLP_HWNDPARENT: owned top-level window
            Location = new System.Drawing.Point(request.x, request.y);
            Phase(request, "interactive");
            Show(); SetForegroundWindow(Handle);
            uint command = TrackPopupMenuEx(popup, 0x100 | 0x2, request.x, request.y, Handle, IntPtr.Zero);
            PostMessage(Handle, 0, IntPtr.Zero, IntPtr.Zero);
            if (command == 0) return new { action = "cancel" };
            string verb = Verb(command - 1);
            if (verb == "rename" || verb == "refresh") return new { action = verb };
            var info = new InvokeInfo();
            info.size = (uint)Marshal.SizeOf(typeof(InvokeInfo));
            info.mask = 0x4000 | 0x20000000 | 0x100; // UNICODE, PTINVOKE, NOASYNC
            info.owner = Handle; info.verb = info.verbW = new IntPtr(command - 1);
            info.show = 1; info.point = new Point { x = request.x, y = request.y };
            if (ParentDisconnected) return new { action = "cancel" };
            Phase(request, "committing");
            Marshal.ThrowExceptionForHR(current.InvokeCommand(ref info));
            return new { action = "invoked", verb };
        } finally {
            // Never hide the shared owner: older modeless property sheets may
            // still be owned by it. It is transparent and absent from the taskbar.
            long ownerValue;
            if (GetForegroundWindow() == Handle && Int64.TryParse(request.owner, out ownerValue)) SetForegroundWindow(new IntPtr(ownerValue));
            menu2 = null; menu3 = null;
            if (popup != IntPtr.Zero) DestroyMenu(popup);
            if (current != null) { Marshal.ReleaseComObject(current); current = null; }
            if (items != null) Marshal.ReleaseComObject(items);
            foreach (IntPtr pidl in pidls) Marshal.FreeCoTaskMem(pidl);
        }
    }
    void Process(string line) {
        Request request = null;
        try {
            request = json.Deserialize<Request>(line);
            Console.WriteLine(json.Serialize(new { id = request.id, ok = true, value = ShowShellMenu(request) }));
        } catch (Exception error) {
            Console.WriteLine(json.Serialize(new { id = request == null ? null : request.id, ok = false, error = error.Message }));
        }
        Console.Out.Flush();
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true)]
    static extern uint GetFileAttributesW(string filename);
    static int ReadHiddenAttributes() {
        try {
            Console.InputEncoding = new UTF8Encoding(false, true);
            Console.OutputEncoding = new UTF8Encoding(false);
            // Directory batches can exceed the serializer's default 2 MiB limit.
            var serializer = new JavaScriptSerializer { MaxJsonLength = Int32.MaxValue };
            var paths = serializer.DeserializeObject(Console.In.ReadToEnd()) as object[];
            if (paths == null) return 1;
            var hidden = new bool?[paths.Length];
            for (int index = 0; index < paths.Length; index++) {
                var filename = paths[index] as string;
                if (filename == null) return 1;
                // Avoid native NUL truncation; invalid/unreadable paths have no metadata.
                uint attributes = filename.IndexOf('\0') < 0 ? GetFileAttributesW(filename) : UInt32.MaxValue;
                hidden[index] = attributes == UInt32.MaxValue ? (bool?)null : (attributes & 2) != 0;
            }
            Console.WriteLine(serializer.Serialize(hidden));
            return 0;
        } catch (Exception) { return 1; }
    }
    [STAThread] static void Main(string[] args) {
        // This one-shot metadata mode must never initialize the interactive shell host.
        if (args.Length > 0 && args[0] == "--read-hidden-attributes") {
            Environment.ExitCode = args.Length == 1 ? ReadHiddenAttributes() : 1;
            return;
        }
        Console.InputEncoding = new UTF8Encoding(false); Console.OutputEncoding = new UTF8Encoding(false);
        // A hidden helper cannot offer WinForms' default exception dialog. Retire
        // the failed process; never continue with a wedged queue/modal loop.
        Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
        Application.ThreadException += (sender, error) => Environment.Exit(1);
        SetProcessDpiAwarenessContext(new IntPtr(-4));
        Application.EnableVisualStyles();
        Application.OleRequired();
        using (var host = new ShellHost()) {
            IntPtr handle = host.Handle;
            host.lifetime = new ShellLifetime(action => host.BeginInvoke(action), host.Process,
                () => { OleFlushClipboard(); Application.ExitThread(); }, () => Environment.Exit(0));
            ParentProcessWatch.Start(host.lifetime.Disconnect);
            var reader = new Thread(() => host.lifetime.Read(Console.ReadLine));
            reader.IsBackground = true;
            reader.Start();
            Application.Run();
        }
    }
}
