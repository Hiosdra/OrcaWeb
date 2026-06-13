#pragma once
// Stub OpenSSL MD5 — no-op implementation for WASM builds.
#include <cstring>
#include <cstddef>

#define MD5_DIGEST_LENGTH 16
#define MD5_LONG unsigned int
#define MD5_LBLOCK 16
#define MD5_CBLOCK 64

typedef struct {
    MD5_LONG A, B, C, D;
    MD5_LONG Nl, Nh;
    MD5_LONG data[MD5_LBLOCK];
    unsigned int num;
} MD5_CTX;

inline int MD5_Init(MD5_CTX* c)                                  { (void)c; return 1; }
inline int MD5_Update(MD5_CTX* c, const void* d, std::size_t n)  { (void)c; (void)d; (void)n; return 1; }
inline int MD5_Final(unsigned char* md, MD5_CTX* c)              { (void)c; memset(md, 0, MD5_DIGEST_LENGTH); return 1; }
inline unsigned char* MD5(const unsigned char* d, std::size_t n,
                          unsigned char* md)
{
    (void)d; (void)n;
    if (md) memset(md, 0, MD5_DIGEST_LENGTH);
    return md;
}
