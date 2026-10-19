// Headless lifecycle tests. No shell commands, clipboard access or input injection.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

class ShellLifecycleTest {
    sealed class HeldReader : TextReader {
        readonly TextWriter evidence;
        bool sent;
        internal HeldReader(TextWriter evidence) { this.evidence = evidence; }
        public override string ReadLine() {
            if (!sent) { sent = true; return "{"; }
            evidence.WriteLine("INPUT_BLOCKED"); evidence.Flush();
            // Model a pipe whose writer is still inherited/open after parent death.
            new ManualResetEvent(false).WaitOne();
            return null;
        }
    }
    sealed class ObservedReader : TextReader {
        readonly TextReader input;
        readonly TextWriter evidence;
        readonly bool fail;
        internal ObservedReader(TextReader input, TextWriter evidence, bool fail) { this.input = input; this.evidence = evidence; this.fail = fail; }
        public override string ReadLine() {
            string line = input.ReadLine();
            if (line == null) {
                evidence.WriteLine("EOF_OBSERVED"); evidence.Flush();
                if (fail) throw new IOException("Controlled input pipe failure");
            }
            return line;
        }
    }
    sealed class BlockedWriter : TextWriter {
        readonly TextWriter evidence;
        public override Encoding Encoding { get { return Encoding.UTF8; } }
        internal BlockedWriter(TextWriter evidence) { this.evidence = evidence; }
        public override void WriteLine(string value) {
            evidence.WriteLine("UI_BLOCKED"); evidence.Flush();
            // Deliberately stop the real host's UI thread in its response writer.
            // The malformed request reaches no shell/clipboard/window-show code.
            new ManualResetEvent(false).WaitOne();
        }
    }
    static void Check(bool success, string name) {
        if (!success) throw new Exception(name);
        Console.WriteLine("PASS " + name);
    }
    static void ButtonTests() {
        int key = 0;
        Func<int, short> held = value => { key = value; return unchecked((short)0x8000); };
        Check(NativeDragInput.PrimaryDown(held, false) && key == 1, "normal primary is physical left");
        Check(NativeDragInput.PrimaryDown(held, true) && key == 2, "swapped primary is physical right");
        Check(!NativeDragInput.PrimaryDown(value => 1, false), "low recently-pressed bit is not held");
        Check(!NativeDragInput.PrimaryDown(value => 0, true), "unavailable physical state fails closed");
    }
    static void DragTests() {
        bool down = false, disconnected = false;
        int commits = 0;
        Func<DropSource> create = () => new DropSource(() => down, () => disconnected, () => commits++);
        var source = create();
        Check(!source.CanStart(), "released gesture cannot start");
        down = true;
        Check(!source.CanStart(), "a cancelled gesture cannot revive after a new press");
        source = create();
        Check(source.CanStart(), "held gesture can start");
        down = false;
        Check(!source.CanStart(), "release during preparation prevents OLE entry");
        down = true;
        source = create();
        Check(source.CanStart(), "preflight arms a live gesture");
        down = false;
        Check(source.QueryContinueDrag(false, 0) == 0x40100 && commits == 1, "normal release needs no initial OLE held callback");
        commits = 0;
        down = true;
        source = create();
        Check(source.QueryContinueDrag(false, 1 | 4 | 8) == 0, "held with shift/control continues");
        down = false;
        Check(source.QueryContinueDrag(false, 1) == 0x40101 && commits == 0, "stale OLE held state cancels, never drops");
        down = true;
        Check(source.QueryContinueDrag(false, 0) == 0x40101, "cancellation is latched");
        source = create();
        Check(source.QueryContinueDrag(false, 1) == 0, "next source starts held");
        down = false;
        Check(source.QueryContinueDrag(false, 0) == 0x40100 && commits == 1, "normal OLE release commits once");
        Check(source.QueryContinueDrag(false, 0) == 0x40100 && commits == 1, "commit phase is not re-emitted");
        down = true;
        source = create();
        Check(source.QueryContinueDrag(true, 0) == 0x40101, "Escape wins over release");
        source = create();
        source.QueryContinueDrag(false, 1);
        disconnected = true;
        Check(source.QueryContinueDrag(false, 0) == 0x40101 && commits == 1, "parent disconnect wins over release");
        Check(!create().CanStart(), "disconnected parent cannot start a gesture");
    }
    static void WatchdogTests() {
        int exits = 0, commits = 0;
        Action exit = () => exits++;
        Func<DropSource> create = () => new DropSource(() => true, () => false, () => commits++);
        var source = create();
        source.QueryContinueDrag(false, 1);
        source.PollRelease(0, false, true, exit);
        source.PollRelease(999, false, true, exit);
        Check(source.QueryContinueDrag(false, 1) == 0 && exits == 0, "grace period allows normal input delivery");
        source.PollRelease(1000, false, true, exit);
        Check(source.QueryContinueDrag(false, 0) == 0x40101 && commits == 0, "watchdog cancellation cannot become a drop");
        source.PollRelease(1999, false, true, exit);
        Check(exits == 0, "cancel has a grace period before forced exit");
        source.PollRelease(2000, false, true, exit);
        Check(exits == 1, "sustained release and capture triggers helper exit");
        source.Finish();
        source.QueryContinueDrag(false, 0);
        source.PollRelease(100000, false, true, exit);
        Check(exits == 1, "completed gesture cannot terminate later work");
        source = create();
        source.PollRelease(0, false, true, exit);
        source.PollRelease(1900, true, true, exit);
        source.PollRelease(2000, false, true, exit);
        source.PollRelease(3900, true, false, exit);
        source.PollRelease(4000, false, true, exit);
        Check(exits == 1, "held button resets the timer");
        source.Finish();
        source = create();
        source.QueryContinueDrag(false, 1);
        source.PollRelease(0, false, true, exit);
        Check(source.QueryContinueDrag(false, 0) == 0x40100, "normal drop can commit within grace");
        source.PollRelease(100000, false, true, exit);
        Check(exits == 1 && commits == 1, "arbitrarily long target transfer is exempt");
        source.Finish();
        source = create();
        source.CanStart();
        source.PollRelease(0, false, false, exit);
        source.PollRelease(2000, false, false, exit);
        Check(exits == 2, "uncommitted OLE hang is retired even after capture was lost");
        source.Finish();
    }
    static void RaceTests() {
        for (int attempt = 0; attempt < 100; ++attempt) {
            int exits = 0, commits = 0, result = 0;
            var source = new DropSource(() => true, () => false, () => Interlocked.Increment(ref commits));
            source.QueryContinueDrag(false, 1);
            source.PollRelease(0, false, true, () => {});
            using (var start = new ManualResetEvent(false)) {
                var poll = new Thread(() => { start.WaitOne(); source.PollRelease(2000, false, true, () => Interlocked.Increment(ref exits)); });
                var release = new Thread(() => { start.WaitOne(); result = source.QueryContinueDrag(false, 0); });
                poll.Start(); release.Start(); start.Set();
                if (!poll.Join(2000) || !release.Join(2000)) throw new Exception("race did not finish");
            }
            if (!((result == 0x40100 && commits == 1 && exits == 0) || (result == 0x40101 && commits == 0 && exits == 1))) {
                throw new Exception("watchdog must not race a committed drop");
            }
            source.Finish();
        }
        Check(true, "100 competing watchdog/drop transitions remain mutually exclusive");
    }
    static void QueueTests(bool failRead, bool cancelQueued) {
        var posted = new Queue<Action>();
        var processed = new List<string>();
        int closed = 0, exited = 0, read = 0;
        bool nested = false, processing = false;
        var lifetime = new ShellLifetime(action => posted.Enqueue(action), line => {
            if (processing) nested = true;
            processing = true;
            // Simulate a native modal loop dispatching all pending UI callbacks.
            while (posted.Count > 0) posted.Dequeue()();
            processed.Add(line);
            processing = false;
        }, () => { if (processing) nested = true; closed++; }, () => Interlocked.Increment(ref exited));
        lifetime.Read(() => {
            if (read++ == 0) return "first";
            if (read == 2) return "second";
            if (!cancelQueued) posted.Dequeue()();
            if (failRead) throw new IOException("Controlled broken input pipe");
            return null;
        });
        Check(lifetime.IsDisconnected && posted.Count == 1, "disconnect schedules one serial drain");
        posted.Dequeue()();
        Check(!nested && String.Join(",", processed) == (cancelQueued ? "" : "first,second"),
            cancelQueued ? "disconnect cancels queued clipboard work before it starts" : "FIFO survives nested message pumping");
        Check(closed == 1 && exited == 0, "shutdown does not reenter active work");
        lifetime.Disconnect();
        Check(posted.Count == 0 && closed == 1, "disconnect is idempotent");
    }
    static void ProgressTests() {
        var saved = Console.Out;
        var output = new StringWriter();
        using (var host = (ShellHost)Activator.CreateInstance(typeof(ShellHost), true)) {
            var phase = typeof(ShellHost).GetMethod("Phase", BindingFlags.Instance | BindingFlags.NonPublic);
            try {
                Console.SetOut(output);
                phase.Invoke(host, new object[] { new Request { id = "legacy" }, "interactive" });
                if (output.ToString().Length != 0) throw new Exception("progress must be opt-in");
                var request = new Request { id = "request-1", reportProgress = true };
                phase.Invoke(host, new object[] { request, "interactive" });
                phase.Invoke(host, new object[] { request, "committing" });
            } finally { Console.SetOut(saved); }
        }
        string[] lines = output.ToString().Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
        Check(lines.Length == 2, "two opt-in progress frames");
        for (int index = 0; index < lines.Length; ++index) {
            var frame = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(lines[index]);
            Check(frame.Count == 2 && (string)frame["id"] == "request-1" && (string)frame["phase"] == (index == 0 ? "interactive" : "committing"),
                "progress frame preserves request identity without final-response fields");
        }
    }
    static int ParentFixture() {
        string executable = Assembly.GetExecutingAssembly().Location;
        using (var child = Process.Start(new ProcessStartInfo(executable, "parent-host") {
            UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true
        })) {
            Console.WriteLine("HELPER_ID " + child.Id); Console.Out.Flush();
            string line;
            while ((line = child.StandardOutput.ReadLine()) != null) {
                Console.WriteLine(line); Console.Out.Flush();
                if (line == "READY") { child.StandardInput.WriteLine("{"); child.StandardInput.Flush(); }
            }
            child.WaitForExit();
            return child.ExitCode;
        }
    }
    static void ParentDeathTest() {
        string executable = Assembly.GetExecutingAssembly().Location;
        using (var parent = Process.Start(new ProcessStartInfo(executable, "fixture-parent") {
            UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true
        })) {
            Process child = null;
            try {
                string line = parent.StandardOutput.ReadLine();
                Check(line != null && line.StartsWith("HELPER_ID "), "fixture reports its exact child");
                child = Process.GetProcessById(Int32.Parse(line.Substring(10)));
                IntPtr pinned = child.Handle; // Hold identity before terminating the fixture parent.
                Check(String.Equals(child.MainModule.FileName, executable, StringComparison.OrdinalIgnoreCase), "only the private fixture executable is observed");
                bool uiBlocked = false, inputBlocked = false;
                while (!(uiBlocked && inputBlocked) && (line = parent.StandardOutput.ReadLine()) != null) {
                    uiBlocked |= line == "UI_BLOCKED"; inputBlocked |= line == "INPUT_BLOCKED";
                }
                Check(uiBlocked && inputBlocked, "actual host STA and stdin reader are blocked");
                parent.Kill(); parent.WaitForExit();
                Check(child.WaitForExit(4500), "parent death exits helper without waiting for stdin EOF");
                Check(child.ExitCode == 0, "parent death uses normal shutdown exit code");
            } finally {
                if (!parent.HasExited) { parent.Kill(); parent.WaitForExit(); }
                if (child != null) {
                    if (!child.HasExited) { child.Kill(); child.WaitForExit(); }
                    child.Dispose();
                }
            }
        }
    }
    [STAThread] static int Main(string[] args) {
        try { return Run(args); }
        catch (Exception error) { Console.Error.WriteLine(error); return 1; }
    }
    static int Run(string[] args) {
        if (args[0] == "parent-death") { ParentDeathTest(); return 0; }
        if (args[0] == "fixture-parent") return ParentFixture();
        if (args[0] == "buttons") { ButtonTests(); return 0; }
        if (args[0] == "drag") { DragTests(); return 0; }
        if (args[0] == "watchdog") { WatchdogTests(); return 0; }
        if (args[0] == "races") { RaceTests(); return 0; }
        if (args[0] == "progress") { ProgressTests(); return 0; }
        if (args[0].StartsWith("queue")) { QueueTests(args[0].EndsWith("error"), args[0].Contains("cancel")); return 0; }
        if (args[0] == "first-released") {
            int result = new DropSource().QueryContinueDrag(false, 0);
            Console.WriteLine("first released callback: 0x" + result.ToString("x"));
            return result == 0x40101 ? 0 : 1;
        }
        var evidence = TextWriter.Synchronized(new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true });
        var failSafe = new Thread(() => {
            Thread.Sleep(7000);
            try { evidence.WriteLine("TEST_DEADLINE"); } catch (IOException) { }
            Environment.Exit(124);
        });
        failSafe.IsBackground = true;
        failSafe.Start();
        if (args[0] == "blocked-shutdown") {
            var lifetime = new ShellLifetime(action => action(), line => {}, () => {
                evidence.WriteLine("SHUTDOWN_BLOCKED");
                new ManualResetEvent(false).WaitOne();
            }, () => Environment.Exit(0));
            lifetime.Read(() => null);
            return 1;
        }
        if (args[0] == "lost-release") {
            var source = new DropSource(() => false, () => false, () => { throw new Exception("Unexpected commit"); });
            // Fake physical/capture readings only; no OLE loop or global input.
            source.WatchRelease(() => false, DropSource.ExitCancelledDrag);
            new ManualResetEvent(false).WaitOne();
            return 1;
        }
        EventHandler ready = null;
        System.Windows.Forms.Timer crash = null;
        if (args[0] == "thread-exception") {
            // Prevent a default modal dialog on the unfixed baseline. The real
            // host must add its own terminating handler, not swallow the fault.
            Application.ThreadException += (sender, eventArgs) => evidence.WriteLine("THREAD_EXCEPTION_DISPATCHED");
        }
        ready = (sender, eventArgs) => {
            Application.Idle -= ready;
            if (args[0] == "thread-exception") {
                crash = new System.Windows.Forms.Timer { Interval = 20 };
                crash.Tick += (s, e) => {
                    crash.Stop(); evidence.WriteLine("THREAD_EXCEPTION_THROWN");
                    throw new InvalidOperationException("Controlled UI callback failure");
                };
                crash.Start();
                evidence.WriteLine("READY");
                return;
            }
            Console.SetIn(args[0] == "parent-host" ? (TextReader)new HeldReader(evidence) : new ObservedReader(Console.In, evidence, args[0] == "blocked-host-error"));
            Console.SetOut(new BlockedWriter(evidence));
            evidence.WriteLine("READY");
        };
        Application.Idle += ready;
        typeof(ShellHost).GetMethod("Main", BindingFlags.Static | BindingFlags.NonPublic).Invoke(null, new object[] { new string[0] });
        return 0;
    }
}
