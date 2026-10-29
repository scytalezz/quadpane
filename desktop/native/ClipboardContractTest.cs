// Standalone native contract check: never reads or writes the user's clipboard.
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Runtime.Serialization;
using System.Text;
using System.Web.Script.Serialization;
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
    sealed class Provider : System.Windows.Forms.DataObject {
        internal int reads;
        internal bool fail;
        internal string failFormat;
        internal bool emptyPaths;
        internal Action onRead = () => {};
        public override object GetData(string format) {
            reads++;
            onRead();
            if (fail || format == failFormat) throw new InvalidOperationException("Controlled provider read failure");
            if (emptyPaths && format == System.Windows.Forms.DataFormats.FileDrop) return null;
            return format == System.Windows.Forms.DataFormats.FileDrop
                ? (object)new[] { @"C:\private-fixture\source.txt" }
                : new MemoryStream(BitConverter.GetBytes(2u));
        }
    }
    sealed class SnapshotFixture {
        // No Form construction, native clipboard calls or filesystem access.
        internal readonly ShellHost host = (ShellHost)FormatterServices.GetUninitializedObject(typeof(ShellHost));
        internal readonly ClipboardContractTest token = new ClipboardContractTest();
        internal readonly Provider provider = new Provider();
        internal uint sequence = 17;
        internal int opens, releases, waits, busy;
        internal int error;
        internal bool empty, failWrap;
        internal Action onOpen = () => {};
        int Read(out IDataObject data) {
            opens++;
            onOpen();
            data = null;
            if (busy-- > 0) return unchecked((int)0x800401d0);
            if (error != 0) return error;
            if (!empty) data = token;
            return 0;
        }
        internal object Read() {
            return host.ReadClipboardSnapshot(() => sequence, Read, data => {
                if (failWrap) throw new InvalidOperationException("Controlled wrapper failure");
                return provider;
            }, data => {
                if (!Object.ReferenceEquals(data, token)) throw new Exception("Released foreign object");
                releases++;
            }, milliseconds => {
                if (milliseconds <= 0 || milliseconds > 100) throw new Exception("Unbounded retry delay");
                waits++;
            });
        }
    }
    static void Check(bool success, string message) { if (!success) throw new Exception(message); }
    static void ExpectFailure(Action action) {
        try { action(); } catch (InvalidOperationException) { return; }
        throw new Exception("Expected controlled failure");
    }
    static void SnapshotTests() {
        int failures = 0;
        Action<string, Action> test = (name, run) => {
            try { run(); Console.WriteLine("PASS " + name); }
            catch (Exception error) { failures++; Console.WriteLine("FAIL " + name + ": " + error.Message); }
        };
        test("transient clipboard contention is retried", () => {
            var f = new SnapshotFixture { busy = 1 };
            f.Read();
            Check(f.opens == 2 && f.waits == 1 && f.releases == 0, "one bounded retry then ownership retained");
        });
        test("provider exception releases acquired object", () => {
            var f = new SnapshotFixture(); f.provider.fail = true;
            ExpectFailure(() => f.Read());
            Check(f.releases == 1 && f.opens == 1, "exception leaked clipboard object or retried provider");
        });
        test("wrapper exception releases acquired object", () => {
            var f = new SnapshotFixture { failWrap = true };
            ExpectFailure(() => f.Read());
            Check(f.releases == 1, "wrapper exception leaked clipboard object");
        });
        test("stable sequence reuses fully materialized snapshot", () => {
            var f = new SnapshotFixture();
            string first = new JavaScriptSerializer().Serialize(f.Read());
            string second = new JavaScriptSerializer().Serialize(f.Read());
            Check(first == second && f.opens == 1 && f.provider.reads == 2 && f.releases == 0,
                "stable snapshot re-entered external delayed provider");
        });
        test("busy retry budget is finite and preserves HRESULT", () => {
            var f = new SnapshotFixture { busy = 100 };
            try { f.Read(); throw new Exception("Expected busy clipboard failure"); }
            catch (COMException error) { Check(error.ErrorCode == unchecked((int)0x800401d0), "lost contention HRESULT"); }
            Check(f.opens == 5 && f.waits == 4 && f.releases == 0, "busy retries exceed 200ms budget");
        });
        test("unrelated acquisition failures are not retried", () => {
            var f = new SnapshotFixture { error = unchecked((int)0x80004005) };
            try { f.Read(); throw new Exception("Expected acquisition failure"); }
            catch (COMException error) { Check(error.ErrorCode == f.error, "lost acquisition HRESULT"); }
            Check(f.opens == 1 && f.waits == 0 && f.releases == 0, "permanent error retried");
        });
        test("second format exception releases once and does not cache partial read", () => {
            var f = new SnapshotFixture(); f.provider.failFormat = "Preferred DropEffect";
            ExpectFailure(() => f.Read());
            Check(f.releases == 1 && f.provider.reads == 2, "partial read leaked");
            f.provider.failFormat = null; f.Read();
            Check(f.opens == 2 && f.provider.reads == 4, "partial read entered cache");
        });
        test("clipboard replacement invalidates cached generation", () => {
            var f = new SnapshotFixture(); f.Read(); f.sequence++; f.Read();
            Check(f.opens == 2 && f.releases == 1 && f.provider.reads == 4, "replacement reused old content or leaked old object");
        });
        test("failed replacement cannot fall back to obsolete cached content", () => {
            var f = new SnapshotFixture(); f.Read(); f.sequence++; f.provider.fail = true;
            ExpectFailure(() => f.Read());
            Check(f.releases == 2, "old snapshot or failed replacement leaked");
            f.provider.fail = false; f.Read();
            Check(f.opens == 3, "failure cached obsolete content");
        });
        test("generation changing during delayed rendering releases and retries", () => {
            var f = new SnapshotFixture();
            f.provider.onRead = () => { f.sequence++; f.provider.onRead = () => {}; };
            string value = new JavaScriptSerializer().Serialize(f.Read());
            Check(f.opens == 2 && f.releases == 1 && f.waits == 1 && value.Contains("\"sequence\":18"), "incoherent generation accepted");
        });
        test("generation churn exhausts bounded retries and releases every object", () => {
            var f = new SnapshotFixture(); f.provider.onRead = () => f.sequence++;
            ExpectFailure(() => f.Read());
            Check(f.opens == 5 && f.releases == 5 && f.waits == 4, "generation churn leaked or looped");
        });
        test("unavailable sequence never reuses cache", () => {
            var f = new SnapshotFixture { sequence = 0 }; f.Read(); f.Read();
            Check(f.opens == 2 && f.releases == 1, "zero generation reused cached provider");
        });
        test("empty clipboard returns coherent empty copy without provider access", () => {
            var f = new SnapshotFixture { empty = true };
            string value = new JavaScriptSerializer().Serialize(f.Read());
            Check(value.Contains("\"sources\":[]") && value.Contains("\"operation\":\"copy\"") && f.provider.reads == 0 && f.releases == 0, "empty clipboard read provider");
        });
        test("empty clipboard changing during acquisition is retried", () => {
            var f = new SnapshotFixture { empty = true };
            f.onOpen = () => { f.sequence++; f.onOpen = () => {}; };
            f.Read();
            Check(f.opens == 2 && f.waits == 1, "empty read accepted changed generation");
        });
        test("temporarily empty delayed provider is not cached", () => {
            var f = new SnapshotFixture(); f.provider.emptyPaths = true; f.Read();
            f.provider.emptyPaths = false;
            string value = new JavaScriptSerializer().Serialize(f.Read());
            Check(f.opens == 2 && f.releases == 1 && value.Contains("source.txt"), "temporary empty provider result became permanent");
        });
        if (failures != 0) throw new Exception(failures + " snapshot contracts failed");
    }
    [STAThread] static int Main(string[] args) {
        try { return Run(args); }
        catch (Exception error) { Console.Error.WriteLine(error); return 1; }
    }
    static int Run(string[] args) {
        if (args.Length != 0 && args[0] == "snapshots") { SnapshotTests(); return 0; }
        var target = new ClipboardContractTest();
        ShellHost.ReportOptimizedPaste(target);
        if (String.Join(",", target.calls) != "Performed DropEffect=0,Paste Succeeded=2") throw new Exception("Unsafe optimized move acknowledgement");
        Console.WriteLine("Optimized paste: Performed NONE then Paste Succeeded MOVE; source must not delete again.");
        SnapshotTests();
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
