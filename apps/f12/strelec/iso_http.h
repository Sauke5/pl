#ifndef PL_STRELEC_ISO_HTTP_H
#define PL_STRELEC_ISO_HTTP_H

#include <windows.h>
#include <winhttp.h>
#include <stdint.h>

#define F12_READ_LIMIT (4U * 1024U * 1024U)

struct ISO {
    HINTERNET session;
    HINTERNET server;
    wchar_t path[96];
    uint64_t size;
};

void media_log(const char *format, ...);
BOOL iso_open(struct ISO *iso, const wchar_t *url_file);
BOOL iso_read(const struct ISO *iso, uint64_t offset, DWORD length, void *buffer);
void iso_close(struct ISO *iso);

#endif
