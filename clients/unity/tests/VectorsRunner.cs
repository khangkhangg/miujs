// Console harness for MiuRealtime.cs outside Unity (any .NET: csc / mcs / dotnet).
//
//   VectorsRunner vectors ../../protocol-vectors.json      → prints OK, or FAIL lines (exit code = failures)
//   VectorsRunner live ws://localhost:3000/rooms/x/r1 <ticket>
//       joins, presents the ticket, sends "tap", drops the connection, resumes, taps again,
//       and prints one JSON line with what happened.
//
// In Unity, call MiuRealtime.RunVectors(json) from an EditMode test instead.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Threading;
using MiuJS;

public static class VectorsRunner
{
    public static int Main(string[] args)
    {
        if (args.Length >= 2 && args[0] == "vectors")
        {
            List<string> failures = MiuRealtime.RunVectors(File.ReadAllText(args[1]));
            foreach (string f in failures) Console.WriteLine("FAIL " + f);
            Console.WriteLine(failures.Count == 0 ? "OK" : failures.Count + " failures");
            return failures.Count;
        }
        if (args.Length >= 3 && args[0] == "live") return Live(args[1], args[2]);
        Console.WriteLine("usage: VectorsRunner vectors <protocol-vectors.json> | live <roomUrl> <ticket>");
        return 2;
    }

    private static bool WaitFor(Func<bool> cond, int ms)
    {
        var sw = Stopwatch.StartNew();
        while (!cond())
        {
            if (sw.ElapsedMilliseconds > ms) return false;
            Thread.Sleep(5);
        }
        return true;
    }

    private static double Taps(object state)
    {
        var s = state as Dictionary<string, object>;
        if (s == null || !s.ContainsKey("taps")) return -1;
        var taps = s["taps"] as Dictionary<string, object>;
        object v;
        return taps != null && taps.TryGetValue("u1", out v) ? Convert.ToDouble(v) : -1;
    }

    private static int Live(string url, string ticket)
    {
        var result = new Dictionary<string, object>();
        var room = new MiuRealtime(url, "Unity") { Ticket = ticket, MinDelayMs = 50, PingIntervalMs = 0 };
        int seated = 0, resumedWelcomes = 0, reconnecting = 0;
        var errors = new List<object>();
        room.OnSeated += delegate (Dictionary<string, object> seat) { seated++; result["seat"] = seat; };
        room.OnWelcome += delegate (Dictionary<string, object> w) { if (w.ContainsKey("resumed") && (bool)w["resumed"]) resumedWelcomes++; };
        room.OnReconnecting += delegate (int attempt, int delay) { reconnecting++; };
        room.OnError += delegate (string code, string m, string fix) { errors.Add(code); };
        room.ConnectAsync().Wait(5000);
        bool ok = WaitFor(delegate { return seated == 1 && room.State != null; }, 5000);
        room.Send("tap", null);
        ok = ok && WaitFor(delegate { return Taps(room.State) == 1; }, 5000);
        string firstToken = room.ResumeToken;
        room.DropConnectionForTest();
        ok = ok && WaitFor(delegate { return resumedWelcomes == 1 && room.Joined; }, 5000);
        room.Send("tap", null);
        ok = ok && WaitFor(delegate { return Taps(room.State) == 2; }, 5000);
        room.Ping();
        ok = ok && WaitFor(delegate { return room.Pongs >= 1; }, 5000);
        result["ok"] = ok;
        result["taps"] = Taps(room.State);
        result["seatedEvents"] = (double)seated;
        result["resumed"] = resumedWelcomes == 1;
        result["reconnecting"] = (double)reconnecting;
        result["sameToken"] = firstToken == room.ResumeToken;
        result["errors"] = errors;
        room.Close();
        Console.WriteLine(MiniJson.Serialize(result));
        return ok ? 0 : 1;
    }
}
