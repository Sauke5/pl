/* Attach the original PE medium using the ImDisk shipped in the user's WIM.
 * Stream layout: https://github.com/LTRData/ImDisk/blob/master/inc/imdproxy.h */
#include "iso_http.h"
#include <sddl.h>
#include <stdarg.h>
#include <stdio.h>
#include <wchar.h>

static wchar_t system_dir[MAX_PATH];
static HANDLE logfile = INVALID_HANDLE_VALUE;

static BOOL join_path(wchar_t dest[MAX_PATH], const wchar_t *dir, const wchar_t *name)
{
    size_t a = wcslen(dir), b = wcslen(name);
    if (a + b + 2 > MAX_PATH) return FALSE;
    memcpy(dest, dir, a * sizeof(*dest));
    dest[a++] = L'\\';
    memcpy(dest + a, name, (b + 1) * sizeof(*dest));
    return TRUE;
}

void media_log(const char *format, ...)
{
    DWORD error = GetLastError(), wrote;
    char line[512];
    int prefix = snprintf(line, sizeof(line), "[%lu:%lu] ", GetCurrentProcessId(), GetTickCount());
    va_list args;
    va_start(args, format);
    int n = vsnprintf(line + prefix, sizeof(line) - (size_t)prefix - 2, format, args);
    va_end(args);
    size_t used = n < 0 ? (size_t)prefix : (size_t)(prefix + n);
    if (used > sizeof(line) - 3) used = sizeof(line) - 3;
    memcpy(line + used, "\r\n", 3);
    OutputDebugStringA(line);
    if (logfile != INVALID_HANDLE_VALUE) {
        WriteFile(logfile, line, (DWORD)used + 2, &wrote, NULL);
        FlushFileBuffers(logfile);
    }
    HANDLE out = GetStdHandle(STD_OUTPUT_HANDLE);
    if (out && out != INVALID_HANDLE_VALUE)
        WriteFile(out, line, (DWORD)used + 2, &wrote, NULL);
    SetLastError(error);
}

static void open_log(void)
{
    wchar_t temp[MAX_PATH], dir[MAX_PATH], file[MAX_PATH], windows[MAX_PATH];
    UINT n = GetWindowsDirectoryW(windows, ARRAYSIZE(windows));
    if (!n || n >= ARRAYSIZE(windows) || !join_path(temp, windows, L"Temp") ||
        !join_path(dir, temp, L"PLF12") || !join_path(file, dir, L"strelec.log"))
        return;
    CreateDirectoryW(dir, NULL);
    logfile = CreateFileW(file, FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE,
                          NULL, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
}

static HANDLE launch(const wchar_t *exe, const wchar_t *args)
{
    wchar_t command[1024];
    int n = swprintf(command, ARRAYSIZE(command), L"\"%ls\" %ls", exe, args);
    if (n < 0 || (size_t)n >= ARRAYSIZE(command)) return NULL;
    STARTUPINFOW start = {0};
    PROCESS_INFORMATION proc = {0};
    start.cb = sizeof(start);
    if (!CreateProcessW(exe, command, NULL, NULL, FALSE, CREATE_NO_WINDOW, NULL,
                        system_dir, &start, &proc))
        return NULL;
    CloseHandle(proc.hThread);
    return proc.hProcess;
}

static void terminate_own_process(HANDLE process)
{
    if (WaitForSingleObject(process, 0) == WAIT_TIMEOUT) {
        TerminateProcess(process, ERROR_TIMEOUT);
        WaitForSingleObject(process, 2000);
    }
}

static BOOL install_driver(void)
{
#ifdef _WIN64
    const wchar_t *section = L"DefaultInstall.ntamd64";
#else
    const wchar_t *section = L"DefaultInstall.ntx86";
#endif
    wchar_t rundll[MAX_PATH], inf[MAX_PATH], args[512];
    if (!join_path(rundll, system_dir, L"rundll32.exe") ||
        !join_path(inf, system_dir, L"imdisk\\imdisk.inf") ||
        GetFileAttributesW(inf) == INVALID_FILE_ATTRIBUTES)
        return FALSE;
    swprintf(args, ARRAYSIZE(args), L"setupapi.dll,InstallHinfSection %ls 132 %ls", section, inf);
    media_log("Installing the WIM's ImDisk INF section %ls", section);
    HANDLE process = launch(rundll, args);
    if (!process) return FALSE;
    DWORD result = ERROR_TIMEOUT;
    if (WaitForSingleObject(process, 35000) == WAIT_OBJECT_0)
        GetExitCodeProcess(process, &result);
    else
        terminate_own_process(process);
    CloseHandle(process);
    media_log("ImDisk installer returned %lu", result);
    return result == 0;
}

static BOOL prepare_driver(void)
{
    SC_HANDLE manager = OpenSCManagerW(NULL, NULL, SC_MANAGER_CONNECT);
    if (!manager) return FALSE;
    const DWORD access = SERVICE_QUERY_STATUS | SERVICE_START;
    SC_HANDLE service = OpenServiceW(manager, L"ImDisk", access);
    if (!service && GetLastError() == ERROR_SERVICE_DOES_NOT_EXIST && install_driver())
        service = OpenServiceW(manager, L"ImDisk", access);
    BOOL running = FALSE;
    if (service) {
        if (StartServiceW(service, 0, NULL) || GetLastError() == ERROR_SERVICE_ALREADY_RUNNING) {
            ULONGLONG started = GetTickCount64();
            SERVICE_STATUS status;
            while (QueryServiceStatus(service, &status)) {
                if (status.dwCurrentState == SERVICE_RUNNING) {
                    running = TRUE;
                    break;
                }
                if (status.dwCurrentState != SERVICE_START_PENDING || GetTickCount64() - started >= 8000)
                    break;
                Sleep(100);
            }
        }
        CloseServiceHandle(service);
    }
    CloseServiceHandle(manager);
    return running;
}

static BOOL free_letter(wchar_t drive)
{
    wchar_t name[3] = {drive, L':', 0}, mapping[512];
    DWORD used = GetLogicalDrives();
    if (!used || drive < L'D' || drive > L'Z' || drive == L'X' ||
        (used & (1ul << (drive - L'A'))))
        return FALSE;
    if (QueryDosDeviceW(name, mapping, ARRAYSIZE(mapping))) return FALSE;
    return GetLastError() == ERROR_FILE_NOT_FOUND;
}

static BOOL local_security(SECURITY_ATTRIBUTES *attributes)
{
    attributes->nLength = sizeof(*attributes);
    attributes->bInheritHandle = FALSE;
    return ConvertStringSecurityDescriptorToSecurityDescriptorW(
        L"D:P(D;;GA;;;NU)(A;;GA;;;SY)(A;;GA;;;BA)", SDDL_REVISION_1,
        &attributes->lpSecurityDescriptor, NULL);
}

static BOOL transfer(HANDLE pipe, HANDLE event, BOOL write, void *data, DWORD length)
{
    BYTE *at = data;
    while (length) {
        OVERLAPPED overlapped = {0};
        overlapped.hEvent = event;
        ResetEvent(event);
        DWORD n = 0;
        BOOL ok = write ? WriteFile(pipe, at, length, &n, &overlapped)
                        : ReadFile(pipe, at, length, &n, &overlapped);
        if (!ok && GetLastError() == ERROR_IO_PENDING)
            ok = GetOverlappedResult(pipe, &overlapped, &n, TRUE);
        if (!ok || !n) return FALSE;
        at += n;
        length -= n;
    }
    return TRUE;
}

static BOOL attach_pipe(HANDLE pipe, const wchar_t *pipe_name, wchar_t drive)
{
    wchar_t cli[MAX_PATH], args[256];
#ifdef _WIN64
    const wchar_t *tool = L"imdisk\\cli\\amd64\\imdisk.exe";
#else
    const wchar_t *tool = L"imdisk\\cli\\i386\\imdisk.exe";
#endif
    if (!join_path(cli, system_dir, tool) || !free_letter(drive))
        return FALSE;
    swprintf(args, ARRAYSIZE(args), L"-a -t proxy -o cd,ro -f \"%ls\" -m %lc:", pipe_name, drive);
    OVERLAPPED overlapped = {0};
    overlapped.hEvent = CreateEventW(NULL, TRUE, FALSE, NULL);
    if (!overlapped.hEvent) return FALSE;
    BOOL connected = ConnectNamedPipe(pipe, &overlapped);
    DWORD initial_error = connected ? 0 : GetLastError();
    if (connected || initial_error == ERROR_PIPE_CONNECTED)
        SetEvent(overlapped.hEvent);
    HANDLE process = NULL;
    BOOL ok = FALSE;
    if (connected || initial_error == ERROR_PIPE_CONNECTED || initial_error == ERROR_IO_PENDING) {
        process = launch(cli, args);
        if (process) {
            HANDLE waits[] = {overlapped.hEvent, process};
            DWORD wait = WaitForMultipleObjects(2, waits, FALSE, 30000);
            if (wait == WAIT_OBJECT_0 + 1) {
                DWORD code;
                if (GetExitCodeProcess(process, &code) && code == 0)
                    wait = WaitForSingleObject(overlapped.hEvent, 2000);
                else
                    media_log("ImDisk mount command exited with code %lu", code);
            }
            if (wait == WAIT_OBJECT_0) {
                DWORD ignored;
                ok = initial_error != ERROR_IO_PENDING ||
                     GetOverlappedResult(pipe, &overlapped, &ignored, FALSE);
            }
        }
    }
    if (!ok && initial_error == ERROR_IO_PENDING) {
        DWORD ignored;
        CancelIoEx(pipe, &overlapped);
        GetOverlappedResult(pipe, &overlapped, &ignored, TRUE);
    }
    if (process) {
        if (!ok) terminate_own_process(process);
        CloseHandle(process);
    }
    CloseHandle(overlapped.hEvent);
    return ok;
}

static BOOL serve_disk(HANDLE pipe, struct ISO *iso, HANDLE attached)
{
    HANDLE event = CreateEventW(NULL, TRUE, FALSE, NULL);
    BYTE *buffer = HeapAlloc(GetProcessHeap(), 0, F12_READ_LIMIT);
    uint64_t reads = 0, bytes = 0;
    BOOL ok = FALSE;
    if (!event || !buffer) goto done;
    for (;;) {
        uint64_t op;
        if (!transfer(pipe, event, FALSE, &op, sizeof(op))) break;
        if (op == 5) { /* IMDPROXY_REQ_CLOSE */
            ok = TRUE;
            break;
        }
        if (op == 1) { /* INFO: byte size, required alignment, read-only flag */
            uint64_t info[] = {iso->size, 1, 1};
            if (!transfer(pipe, event, TRUE, info, sizeof(info))) break;
            SetEvent(attached);
            continue;
        }
        if (op != 2) {
            media_log("Unsupported ImDisk request %llu", (unsigned long long)op);
            break;
        }
        uint64_t span[2], reply[2] = {ERROR_ACCESS_DENIED, 0};
        if (!transfer(pipe, event, FALSE, span, sizeof(span))) break;
        if (span[1] > F12_READ_LIMIT || !iso_read(iso, span[0], (DWORD)span[1], buffer)) {
            transfer(pipe, event, TRUE, reply, sizeof(reply));
            break;
        }
        reply[0] = 0;
        reply[1] = span[1];
        if (!transfer(pipe, event, TRUE, reply, sizeof(reply)) ||
            !transfer(pipe, event, TRUE, buffer, (DWORD)span[1]))
            break;
        ++reads;
        bytes += span[1];
        if (reads == 1 || reads % 256 == 0)
            media_log("HTTP ranges %llu, bytes %llu", (unsigned long long)reads, (unsigned long long)bytes);
    }
done:
    if (buffer) HeapFree(GetProcessHeap(), 0, buffer);
    if (event) CloseHandle(event);
    media_log("STOPPED: ranges %llu, bytes %llu", (unsigned long long)reads, (unsigned long long)bytes);
    return ok;
}

static BOOL proxy(wchar_t drive, const wchar_t *token, SECURITY_ATTRIBUTES *security)
{
    wchar_t event_name[64], pipe_name[96], url_file[MAX_PATH];
    swprintf(event_name, ARRAYSIZE(event_name), L"Local\\PLF12Strelec-%ls", token);
    swprintf(pipe_name, ARRAYSIZE(pipe_name), L"\\\\.\\pipe\\PL-F12-Strelec-%ls", token);
    HANDLE attached = OpenEventW(EVENT_MODIFY_STATE, FALSE, event_name);
    if (!attached) return FALSE;
    struct ISO iso = {0};
    HANDLE pipe = INVALID_HANDLE_VALUE;
    BOOL ok = FALSE;
    if (!join_path(url_file, system_dir, L"pl-f12.url") || !iso_open(&iso, url_file)) goto done;
    media_log("ISO available, %llu bytes", (unsigned long long)iso.size);
    if (!prepare_driver()) {
        media_log("ImDisk driver unavailable, error %lu", GetLastError());
        goto done;
    }
    pipe = CreateNamedPipeW(pipe_name, PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
        PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
        1, 65536, 65536, 0, security);
    if (pipe == INVALID_HANDLE_VALUE || !attach_pipe(pipe, pipe_name, drive)) {
        media_log("ImDisk could not attach %c:, error %lu", (char)drive, GetLastError());
        goto done;
    }
    ok = serve_disk(pipe, &iso, attached);
done:
    if (pipe != INVALID_HANDLE_VALUE) CloseHandle(pipe);
    iso_close(&iso);
    CloseHandle(attached);
    return ok;
}

static BOOL mount_and_wait(SECURITY_ATTRIBUTES *security)
{
    wchar_t token[17], event_name[64], exe[MAX_PATH], args[64];
    const wchar_t *letters = L"YRSTUVWZDEFGHIJKLMNOPQ";
    while (*letters && !free_letter(*letters)) ++letters;
    if (!*letters) {
        media_log("No free drive letter");
        return FALSE;
    }
    DWORD n = GetModuleFileNameW(NULL, exe, ARRAYSIZE(exe));
    if (!n || n >= ARRAYSIZE(exe)) return FALSE;
    swprintf(token, ARRAYSIZE(token), L"%08lX%08lX", GetCurrentProcessId(), GetTickCount());
    swprintf(event_name, ARRAYSIZE(event_name), L"Local\\PLF12Strelec-%ls", token);
    HANDLE attached = CreateEventW(security, TRUE, FALSE, event_name);
    if (!attached) return FALSE;
    if (GetLastError() == ERROR_ALREADY_EXISTS) {
        CloseHandle(attached);
        return FALSE;
    }
    swprintf(args, ARRAYSIZE(args), L"--serve %lc %ls", *letters, token);
    media_log("Preparing original medium on free drive %c:", (char)*letters);
    HANDLE worker = launch(exe, args);
    BOOL ready = FALSE;
    if (worker) {
        HANDLE waits[] = {attached, worker};
        if (WaitForMultipleObjects(2, waits, FALSE, 95000) == WAIT_OBJECT_0) {
            wchar_t root[] = L"Y:\\", folder[] = L"Y:\\SSTR";
            root[0] = folder[0] = *letters;
            ULONGLONG start = GetTickCount64();
            while (WaitForSingleObject(worker, 120) == WAIT_TIMEOUT && GetTickCount64() - start < 30000) {
                if (GetDriveTypeW(root) != DRIVE_CDROM) continue;
                DWORD flags = GetFileAttributesW(folder);
                if (flags != INVALID_FILE_ATTRIBUTES && (flags & FILE_ATTRIBUTE_DIRECTORY)) {
                    ready = TRUE;
                    break;
                }
            }
        }
        if (!ready) terminate_own_process(worker);
        CloseHandle(worker);
    }
    CloseHandle(attached);
    media_log(ready ? "READY: %c:\\SSTR is readable" : "FAILED: original medium unavailable on %c:", (char)*letters);
    return ready;
}

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE previous, PWSTR args, int show)
{
    (void)instance; (void)previous; (void)show;
    SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOOPENFILEERRORBOX);
    UINT n = GetSystemDirectoryW(system_dir, ARRAYSIZE(system_dir));
    if (!n || n >= ARRAYSIZE(system_dir)) return 1;
    open_log();
    SECURITY_ATTRIBUTES security = {0};
    BOOL result = FALSE;
    if (local_security(&security)) {
        if (!*args) {
            result = mount_and_wait(&security);
        } else if (wcslen(args) == 26 && !wcsncmp(args, L"--serve ", 8) && args[9] == L' ' &&
                   args[8] >= L'D' && args[8] <= L'Z' && args[8] != L'X' &&
                   wcsspn(args + 10, L"0123456789ABCDEF") == 16) {
            result = proxy(args[8], args + 10, &security);
        }
        LocalFree(security.lpSecurityDescriptor);
    }
    if (!result) media_log("Adapter exited with failure, Win32 %lu", GetLastError());
    if (logfile != INVALID_HANDLE_VALUE) CloseHandle(logfile);
    return result ? 0 : 1;
}
