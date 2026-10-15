// Headless lifecycle tests. No shell commands, clipboard access or input injection.
using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

class ShellLifecycleTest {
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
        source.PollRelease(3900, false, false, exit);
        source.PollRelease(4000, false, true, exit);
        Check(exits == 1, "held button or absent capture resets the timer");
        source.Finish();
        source = create();
        source.QueryContinueDrag(false, 1);
        source.PollRelease(0, false, true, exit);
        Check(source.QueryContinueDrag(false, 0) == 0x40100, "normal drop can commit within grace");
        source.PollRelease(100000, false, true, exit);
        Check(exits == 1 && commits == 1, "arbitrarily long target transfer is exempt");
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
    static void QueueTests(bool failRead) {
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
        }, () => { if (processing || processed.Count != 2) nested = true; closed++; }, () => Interlocked.Increment(ref exited));
        lifetime.Read(() => {
            if (read++ == 0) return "first";
            if (read == 2) return "second";
            if (failRead) throw new IOException("Controlled broken input pipe");
            return null;
        });
        Check(lifetime.IsDisconnected && posted.Count == 1, "disconnect schedules one serial drain");
        posted.Dequeue()();
        Check(!nested && String.Join(",", processed) == "first,second", "FIFO survives nested message pumping");
        Check(closed == 1 && exited == 0, "graceful shutdown waits until all requests return");
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
    [STAThread] static int Main(string[] args) {
        try { return Run(args); }
        catch (Exception error) { Console.Error.WriteLine(error); return 1; }
    }
    static int Run(string[] args) {
        if (args[0] == "buttons") { ButtonTests(); return 0; }
        if (args[0] == "drag") { DragTests(); return 0; }
        if (args[0] == "watchdog") { WatchdogTests(); return 0; }
        if (args[0] == "races") { RaceTests(); return 0; }
        if (args[0] == "progress") { ProgressTests(); return 0; }
        if (args[0] == "queue" || args[0] == "queue-error") { QueueTests(args[0] == "queue-error"); return 0; }
        if (args[0] == "first-released") {
            int result = new DropSource().QueryContinueDrag(false, 0);
            Console.WriteLine("first released callback: 0x" + result.ToString("x"));
            return result == 0x40101 ? 0 : 1;
        }
        var evidence = TextWriter.Synchronized(new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true });
        var failSafe = new Thread(() => { Thread.Sleep(7000); evidence.WriteLine("TEST_DEADLINE"); Environment.Exit(124); });
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
            source.WatchRelease(() => true, () => Environment.Exit(23));
            new ManualResetEvent(false).WaitOne();
            return 1;
        }
        EventHandler ready = null;
        ready = (sender, eventArgs) => {
            Application.Idle -= ready;
            Console.SetIn(new ObservedReader(Console.In, evidence, args[0] == "blocked-host-error"));
            Console.SetOut(new BlockedWriter(evidence));
            evidence.WriteLine("READY");
        };
        Application.Idle += ready;
        typeof(ShellHost).GetMethod("Main", BindingFlags.Static | BindingFlags.NonPublic).Invoke(null, null);
        return 0;
    }
}
