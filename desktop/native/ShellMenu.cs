// Classic Explorer context menus, hosted out of process on an STA message loop.
// Keep this process alive: shell clipboard objects and asynchronous property sheets
// can outlive InvokeCommand. No command line is constructed from file names.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

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
    public int QueryContinueDrag(bool escape, uint keys) { return escape ? 0x40101 : (keys & 1) == 0 ? 0x40100 : 0; }
    public int GiveFeedback(uint effect) { return 0x40102; }
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
        if (clipboardSnapshot != null) { Marshal.ReleaseComObject(clipboardSnapshot); clipboardSnapshot = null; }
        for (int attempt = 0; attempt < 3; ++attempt) {
            uint before = GetClipboardSequenceNumber();
            System.Runtime.InteropServices.ComTypes.IDataObject data;
            Marshal.ThrowExceptionForHR(OleGetClipboard(out data));
            if (data == null) return new { sources = new string[0], operation = "copy", sequence = before };
            var wrapper = new DataObject(data);
            var paths = wrapper.GetData(DataFormats.FileDrop) as string[] ?? new string[0];
            var stream = wrapper.GetData("Preferred DropEffect") as MemoryStream;
            var bytes = stream == null ? null : stream.ToArray();
            if (before != GetClipboardSequenceNumber()) { Marshal.ReleaseComObject(data); continue; }
            clipboardSnapshot = data; clipboardSequence = before; clipboardPaths = paths;
            return new { sources = paths, operation = bytes != null && bytes.Length >= 4 && BitConverter.ToUInt32(bytes, 0) == 2 ? "move" : "copy", sequence = before };
        }
        throw new InvalidOperationException("Clipboard changed during snapshot");
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
                        // Shell data object negotiates optimized moves with Explorer.
                        // Never delete sources ourselves: the target owns the transfer.
                        int result = DoDragDrop((System.Runtime.InteropServices.ComTypes.IDataObject)data, new DropSource(), 3, out effect);
                        Marshal.ThrowExceptionForHR(result);
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
            IntPtr owner = new IntPtr(Int64.Parse(request.owner));
            SetWindowLongPtr(Handle, -8, owner); // GWLP_HWNDPARENT: owned top-level window
            Location = new System.Drawing.Point(request.x, request.y);
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
    [STAThread] static void Main() {
        Console.InputEncoding = new UTF8Encoding(false); Console.OutputEncoding = new UTF8Encoding(false);
        SetProcessDpiAwarenessContext(new IntPtr(-4));
        Application.EnableVisualStyles();
        Application.OleRequired();
        using (var host = new ShellHost()) {
            IntPtr handle = host.Handle;
            var reader = new Thread(() => {
                string line;
                while ((line = Console.ReadLine()) != null) {
                    string captured = line;
                    host.Invoke(new Action(() => host.Process(captured)));
                }
                host.BeginInvoke(new Action(() => { OleFlushClipboard(); Application.ExitThread(); }));
            });
            reader.IsBackground = true;
            host.BeginInvoke(new Action(() => reader.Start()));
            Application.Run();
        }
    }
}
