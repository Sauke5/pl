/* Read one source-scoped optical image. The PE never follows redirects or uses a proxy. */
#include "iso_http.h"
#include <stdio.h>
#include <string.h>
#include <wchar.h>

#define F12_SIZE_LIMIT (UINT64_C(32) << 30)

static BOOL read_location(const wchar_t *file, wchar_t host[16], wchar_t path[96])
{
    char line[161];
    DWORD size = 0;
    HANDLE input = CreateFileW(file, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING,
                               FILE_ATTRIBUTE_NORMAL, NULL);
    if (input == INVALID_HANDLE_VALUE)
        return FALSE;
    BOOL ok = ReadFile(input, line, sizeof(line) - 1, &size, NULL);
    CloseHandle(input);
    if (!ok || size >= sizeof(line) - 1 || memchr(line, '\0', size))
        return FALSE;
    if (size && line[size - 1] == '\n') {
        --size;
        if (size && line[size - 1] == '\r')
            --size;
    }
    line[size] = '\0';
    if (strncmp(line, "http://", 7))
        return FALSE;

    const char *at = line + 7;
    for (int i = 0; i < 4; ++i) {
        const char *begin = at;
        unsigned int value = 0;
        while (*at >= '0' && *at <= '9') {
            value = value * 10 + (unsigned int)(*at++ - '0');
            if (at - begin > 3 || value > 255)
                return FALSE;
        }
        if (at == begin || (at - begin > 1 && *begin == '0'))
            return FALSE;
        if (i < 3 && *at++ != '.')
            return FALSE;
    }
    if (strncmp(at, ":18080/media/", 13))
        return FALSE;
    const char *digest = at + 13;
    if (strlen(digest) != 68 || strcmp(digest + 64, "/iso"))
        return FALSE;
    for (int i = 0; i < 64; ++i)
        if (!((digest[i] >= '0' && digest[i] <= '9') ||
              (digest[i] >= 'a' && digest[i] <= 'f')))
            return FALSE;
    size_t n = (size_t)(at - (line + 7));
    for (size_t i = 0; i < n; ++i) host[i] = (wchar_t)line[7 + i];
    host[n] = L'\0';
    return MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, at + 6, -1, path, 96) > 0;
}

static BOOL header(HINTERNET req, DWORD name, wchar_t *text, DWORD chars)
{
    DWORD bytes = chars * sizeof(*text);
    return WinHttpQueryHeaders(req, name, WINHTTP_HEADER_NAME_BY_INDEX, text, &bytes,
                               WINHTTP_NO_HEADER_INDEX);
}

static BOOL content_length(HINTERNET req, uint64_t *length)
{
    wchar_t text[32];
    if (!header(req, WINHTTP_QUERY_CONTENT_LENGTH, text, ARRAYSIZE(text)) || !text[0])
        return FALSE;
    uint64_t value = 0;
    for (const wchar_t *p = text; *p; ++p) {
        if (*p < L'0' || *p > L'9') return FALSE;
        value = value * 10 + (unsigned)(*p - L'0');
        if (value > F12_SIZE_LIMIT) return FALSE;
    }
    *length = value;
    return TRUE;
}

static HINTERNET request(const struct ISO *iso, const wchar_t *method,
                         const wchar_t *extra, DWORD *status)
{
    HINTERNET req = WinHttpOpenRequest(iso->server, method, iso->path, NULL,
                                       WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, 0);
    *status = 0;
    if (!req) return NULL;
    DWORD disable = WINHTTP_DISABLE_REDIRECTS | WINHTTP_DISABLE_COOKIES;
    DWORD bytes = sizeof(*status);
    if (!WinHttpSetOption(req, WINHTTP_OPTION_DISABLE_FEATURE, &disable, sizeof(disable)) ||
        !WinHttpSendRequest(req, extra, extra ? (DWORD)-1L : 0, NULL, 0, 0, 0) ||
        !WinHttpReceiveResponse(req, NULL) ||
        !WinHttpQueryHeaders(req, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                             WINHTTP_HEADER_NAME_BY_INDEX, status, &bytes, WINHTTP_NO_HEADER_INDEX)) {
        DWORD error = GetLastError();
        WinHttpCloseHandle(req);
        SetLastError(error);
        return NULL;
    }
    return req;
}

BOOL iso_open(struct ISO *iso, const wchar_t *url_file)
{
    wchar_t host[16];
    if (!read_location(url_file, host, iso->path)) {
        media_log("Invalid or missing pl-f12.url");
        return FALSE;
    }
    iso->session = WinHttpOpen(L"PL-F12/1", WINHTTP_ACCESS_TYPE_NO_PROXY,
                               WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
    if (!iso->session || !WinHttpSetTimeouts(iso->session, 3000, 4000, 5000, 8000))
        return FALSE;
    iso->server = WinHttpConnect(iso->session, host, 18080, 0);
    if (!iso->server) return FALSE;
    ULONGLONG start = GetTickCount64();
    for (;;) {
        DWORD status = 0;
        HINTERNET req = request(iso, L"HEAD", NULL, &status);
        if (req) {
            BOOL ok = status == 200 && content_length(req, &iso->size) && iso->size > 0;
            WinHttpCloseHandle(req);
            if (!ok) media_log("Invalid ISO response, HTTP %lu", status);
            return ok;
        }
        DWORD error = GetLastError();
        if ((error != ERROR_WINHTTP_CANNOT_CONNECT && error != ERROR_WINHTTP_TIMEOUT &&
             error != ERROR_WINHTTP_CONNECTION_ERROR) || GetTickCount64() - start >= 30000) {
            media_log("ISO network unavailable, WinHTTP %lu", error);
            return FALSE;
        }
        Sleep(400);
    }
}

BOOL iso_read(const struct ISO *iso, uint64_t offset, DWORD length, void *buffer)
{
    if (!length || length > F12_READ_LIMIT || offset > iso->size || length > iso->size - offset)
        return FALSE;
    wchar_t range[96], expected[96], actual[96];
    unsigned long long last = offset + length - 1;
    swprintf(range, ARRAYSIZE(range), L"Range: bytes=%llu-%llu\r\n",
             (unsigned long long)offset, last);
    swprintf(expected, ARRAYSIZE(expected), L"bytes %llu-%llu/%llu",
             (unsigned long long)offset, last, (unsigned long long)iso->size);
    DWORD status;
    HINTERNET req = request(iso, L"GET", range, &status);
    if (!req) {
        media_log("ISO read failed, WinHTTP %lu", GetLastError());
        return FALSE;
    }
    uint64_t received_length;
    BOOL ok = status == 206 && content_length(req, &received_length) && received_length == length &&
              header(req, WINHTTP_QUERY_CONTENT_RANGE, actual, ARRAYSIZE(actual)) &&
              wcscmp(actual, expected) == 0;
    DWORD filled = 0;
    while (ok && filled < length) {
        DWORD n = 0;
        ok = WinHttpReadData(req, (BYTE *)buffer + filled, length - filled, &n) && n != 0;
        filled += n;
    }
    WinHttpCloseHandle(req);
    if (!ok)
        media_log("ISO range unavailable, HTTP %lu, offset %llu, length %lu", status,
                  (unsigned long long)offset, length);
    return ok;
}

void iso_close(struct ISO *iso)
{
    if (iso->server) WinHttpCloseHandle(iso->server);
    if (iso->session) WinHttpCloseHandle(iso->session);
}
