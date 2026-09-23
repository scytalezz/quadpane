// Standalone native contract check: never reads or writes the user's clipboard.
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;
class ClipboardContractTest : IDataObject {
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClipboardFormatName(uint format, StringBuilder name, int count);
    [DllImport("kernel32.dll")] static extern IntPtr GlobalLock(IntPtr memory);
    [DllImport("kernel32.dll")] static extern bool GlobalUnlock(IntPtr memory);
    readonly List<string> calls = new List<string>();
    public void SetData(ref FORMATETC format, ref STGMEDIUM medium, bool release) {
        if (release || medium.tymed != TYMED.TYMED_HGLOBAL) throw new Exception("Invalid medium ownership");
        var name = new StringBuilder(128);
        GetClipboardFormatName(unchecked((ushort)format.cfFormat), name, name.Capacity);
        IntPtr pointer = GlobalLock(medium.unionmember);
        calls.Add(name + "=" + Marshal.ReadInt32(pointer)); GlobalUnlock(medium.unionmember);
    }
    [STAThread] static int Main() {
        var target = new ClipboardContractTest();
        ShellHost.ReportOptimizedPaste(target);
        if (String.Join(",", target.calls) != "Performed DropEffect=0,Paste Succeeded=2") throw new Exception("Unsafe optimized move acknowledgement");
        Console.WriteLine("Optimized paste: Performed NONE then Paste Succeeded MOVE; source must not delete again.");
        return 0;
    }
    public void GetData(ref FORMATETC format, out STGMEDIUM medium) { throw new NotImplementedException(); }
    public void GetDataHere(ref FORMATETC format, ref STGMEDIUM medium) { throw new NotImplementedException(); }
    public int QueryGetData(ref FORMATETC format) { return 1; }
    public int GetCanonicalFormatEtc(ref FORMATETC input, out FORMATETC output) { output = input; return 1; }
    public IEnumFORMATETC EnumFormatEtc(DATADIR direction) { throw new NotImplementedException(); }
    public int DAdvise(ref FORMATETC format, ADVF flags, IAdviseSink sink, out int connection) { connection = 0; return 1; }
    public void DUnadvise(int connection) { }
    public int EnumDAdvise(out IEnumSTATDATA data) { data = null; return 1; }
}
