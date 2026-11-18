// Read-only WinPE adapter for one published F12 ISO. ImDisk stream protocol
// reference: https://github.com/LTRData/ImDisk/blob/master/inc/imdproxy.h
using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.IO.Pipes;
using System.Net;
using System.Net.Sockets;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

internal static class F12Media
{
    private const string PipeName = "pl-f12-iso";
    private const string MediaDrive = "Y:";
    private const int ReadLimit = 4 * 1024 * 1024;
    private const long SizeLimit = 32L * 1024 * 1024 * 1024;

    private static Uri Location(string value)
    {
        IPAddress ip;
        var match = Regex.Match(value, @"\Ahttp://([0-9.]+):18080/media/[a-f0-9]{64}/iso\z");
        if (!match.Success || !IPAddress.TryParse(match.Groups[1].Value, out ip) ||
            ip.AddressFamily != AddressFamily.InterNetwork || ip.ToString() != match.Groups[1].Value)
            throw new ArgumentException("Expected the segment URL of a published F12 ISO.");
        return new Uri(value);
    }

    private static HttpWebRequest Request(Uri url, string method)
    {
        var request = (HttpWebRequest)WebRequest.Create(url);
        request.Method = method;
        request.AllowAutoRedirect = false;
        request.Proxy = null;
        request.Timeout = 8000;
        request.ReadWriteTimeout = 8000;
        return request;
    }

    private static long MediaSize(Uri url)
    {
        using (var response = (HttpWebResponse)Request(url, "HEAD").GetResponse())
        {
            long size = response.ContentLength;
            if (response.StatusCode != HttpStatusCode.OK || size <= 0 || size > SizeLimit)
                throw new IOException("Unexpected ISO length or HTTP status.");
            return size;
        }
    }

    private static long WaitForNetwork(Uri url)
    {
        var timer = Stopwatch.StartNew();
        for (;;)
        {
            try { return MediaSize(url); }
            catch (WebException error)
            {
                // Permit the PE adapter to finish DHCP. A gateway response, including
                // withdrawal of the publication, is final.
                if (error.Response != null)
                {
                    error.Response.Close();
                    throw;
                }
                if (timer.ElapsedMilliseconds >= 30000) throw;
                Thread.Sleep(500);
            }
        }
    }

    private static byte[] ReadSectors(Uri url, long size, ulong offset, ulong length)
    {
        if (length == 0 || length > ReadLimit || offset > (ulong)size || length > (ulong)size - offset)
            throw new IOException("Read outside the ISO.");
        long first = (long)offset, last = first + (long)length - 1;
        var request = Request(url, "GET");
        request.AddRange(first, last);
        using (var response = (HttpWebResponse)request.GetResponse())
        {
            string range = string.Format(CultureInfo.InvariantCulture, "bytes {0}-{1}/{2}", first, last, size);
            if (response.StatusCode != HttpStatusCode.PartialContent ||
                response.ContentLength != (long)length || response.Headers["Content-Range"] != range)
                throw new IOException("F12 returned a different range.");
            var data = new byte[(int)length];
            using (var stream = response.GetResponseStream())
            {
                int collected = 0;
                while (collected < data.Length)
                {
                    int n = stream.Read(data, collected, data.Length - collected);
                    if (n == 0) throw new EndOfStreamException("Short ISO range.");
                    collected += n;
                }
            }
            return data;
        }
    }

    private static void Reply(Stream pipe, params ulong[] fields)
    {
        var header = new byte[fields.Length * sizeof(ulong)];
        Buffer.BlockCopy(fields, 0, header, 0, header.Length);
        pipe.Write(header, 0, header.Length);
    }

    private static void Attach(NamedPipeServerStream pipe)
    {
        foreach (string drive in Environment.GetLogicalDrives())
            if (string.Equals(drive, MediaDrive + @"\", StringComparison.OrdinalIgnoreCase))
                throw new IOException(MediaDrive + " is already in use.");

        var command = new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "imdisk.exe"),
            @"-a -t proxy -o cd,ro -f \\.\pipe\" + PipeName + " -m " + MediaDrive);
        command.UseShellExecute = false;
        command.CreateNoWindow = true;
        var connected = pipe.BeginWaitForConnection(null, null);
        using (var handle = connected.AsyncWaitHandle)
        using (var mount = Process.Start(command))
        {
            var timer = Stopwatch.StartNew();
            while (!handle.WaitOne(200))
            {
                if (mount.HasExited && mount.ExitCode != 0)
                    throw new IOException("ImDisk exited before connecting: " + mount.ExitCode);
                if (timer.ElapsedMilliseconds >= 30000)
                {
                    if (!mount.HasExited) mount.Kill();
                    throw new TimeoutException("ImDisk did not connect.");
                }
            }
            pipe.EndWaitForConnection(connected);
        }
        Console.WriteLine("ImDisk connected for " + MediaDrive);
    }

    private static void Serve(Uri url, long size, bool attach)
    {
        var acl = new PipeSecurity();
        acl.SetAccessRuleProtection(true, false);
        acl.AddAccessRule(new PipeAccessRule(
            new SecurityIdentifier(WellKnownSidType.NetworkSid, null),
            PipeAccessRights.FullControl, AccessControlType.Deny));
        acl.AddAccessRule(new PipeAccessRule(
            new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
            PipeAccessRights.FullControl, AccessControlType.Allow));
        acl.AddAccessRule(new PipeAccessRule(WindowsIdentity.GetCurrent().User,
            PipeAccessRights.FullControl, AccessControlType.Allow));
        using (var pipe = new NamedPipeServerStream(PipeName, PipeDirection.InOut, 1,
            PipeTransmissionMode.Byte, attach ? PipeOptions.Asynchronous : PipeOptions.None, 65536, 65536, acl))
        {
            Console.WriteLine("Ready: local pipe, read-only ISO, {0} bytes", size);
            if (attach) Attach(pipe);
            else pipe.WaitForConnection();
            using (var input = new BinaryReader(pipe))
            {
                long bytes = 0, reads = 0;
                try
                {
                    for (;;)
                    {
                        ulong code;
                        try { code = input.ReadUInt64(); }
                        catch (EndOfStreamException) { return; }
                        if (code == 5) return; // CLOSE
                        if (code == 1) // INFO: size, alignment, read-only flag
                        {
                            Reply(pipe, (ulong)size, 1, 1);
                            continue;
                        }
                        if (code != 2)
                        {
                            throw new IOException("Unexpected ImDisk operation: " + code);
                        }
                        ulong offset = input.ReadUInt64(), length = input.ReadUInt64();
                        byte[] data;
                        try { data = ReadSectors(url, size, offset, length); }
                        catch
                        {
                            Reply(pipe, 5, 0);
                            throw;
                        }
                        Reply(pipe, 0, length);
                        pipe.Write(data, 0, data.Length);
                        bytes += data.Length;
                        ++reads;
                        if (reads == 1 || reads % 64 == 0)
                            Console.WriteLine("HTTP ranges {0}, bytes {1}", reads, bytes);
                    }
                }
                finally { Console.WriteLine("Finished: {0} HTTP ranges, {1} bytes", reads, bytes); }
            }
        }
    }

    private static int Main(string[] args)
    {
        try
        {
            if (args.Length != 1) throw new ArgumentException("Expected --mount or one published ISO URL.");
            if (args[0] == "--mount")
            {
                var log = new StreamWriter(new FileStream(Path.Combine(
                    AppDomain.CurrentDomain.BaseDirectory, "media.log"), FileMode.Create, FileAccess.Write, FileShare.Read));
                log.AutoFlush = true;
                Console.SetOut(log);
                Console.SetError(log);
                string[] lines = File.ReadAllLines(Path.Combine(Environment.SystemDirectory, "pl-f12.url"), Encoding.ASCII);
                if (lines.Length != 1) throw new IOException("Expected one media URL.");
                Uri url = Location(lines[0]);
                Serve(url, WaitForNetwork(url), true);
            }
            else
            {
                Uri url = Location(args[0]);
                Serve(url, MediaSize(url), false);
            }
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.GetType().Name + ": " + error.Message);
            return 1;
        }
    }
}
