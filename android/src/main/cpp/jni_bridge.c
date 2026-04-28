#include <jni.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include "bspatch.h"
#include "bzip2/bzlib.h"

typedef struct {
    BZFILE* bz;
    FILE* fp;
} bz_stream_state;

static int bz_read(const struct bspatch_stream* stream, void* buffer, int length) {
    bz_stream_state* s = (bz_stream_state*)stream->opaque;
    int bzerror = BZ_OK;
    int n = BZ2_bzRead(&bzerror, s->bz, buffer, length);
    if (bzerror != BZ_OK && bzerror != BZ_STREAM_END) return -1;
    if (n != length) return -1;
    return 0;
}

static void throw_runtime(JNIEnv* env, const char* msg) {
    jclass cls = (*env)->FindClass(env, "java/lang/RuntimeException");
    if (cls) (*env)->ThrowNew(env, cls, msg);
}

JNIEXPORT void JNICALL
Java_com_otaupdates_OTAUpdatesModule_applyPatchNative(
    JNIEnv* env, jobject thiz,
    jstring jBase, jstring jPatch, jstring jOut)
{
    const char* basePath = NULL;
    const char* patchPath = NULL;
    const char* outPath = NULL;

    int baseFd = -1;
    void* baseMap = MAP_FAILED;
    off_t baseSize = 0;

    FILE* pf = NULL;
    BZFILE* bz = NULL;
    int bzerror = BZ_OK;

    uint8_t* outBuf = NULL;
    FILE* of = NULL;

    const char* errMsg = NULL;

    basePath = (*env)->GetStringUTFChars(env, jBase, NULL);
    patchPath = (*env)->GetStringUTFChars(env, jPatch, NULL);
    outPath = (*env)->GetStringUTFChars(env, jOut, NULL);

    baseFd = open(basePath, O_RDONLY);
    if (baseFd < 0) { errMsg = "Cannot open base"; goto cleanup; }

    struct stat st;
    if (fstat(baseFd, &st) != 0) { errMsg = "Cannot stat base"; goto cleanup; }
    baseSize = st.st_size;

    baseMap = mmap(NULL, (size_t)baseSize, PROT_READ, MAP_SHARED, baseFd, 0);
    if (baseMap == MAP_FAILED) { errMsg = "Cannot mmap base"; goto cleanup; }

    pf = fopen(patchPath, "rb");
    if (!pf) { errMsg = "Cannot open patch"; goto cleanup; }

    uint8_t header[24];
    if (fread(header, 1, 24, pf) != 24) { errMsg = "Short patch header"; goto cleanup; }
    if (memcmp(header, "ENDSLEY/BSDIFF43", 16) != 0) { errMsg = "Bad patch magic"; goto cleanup; }

    int64_t newsize = 0;
    for (int i = 0; i < 8; i++) newsize |= ((int64_t)header[16 + i]) << (i * 8);
    if (newsize < 0) { errMsg = "Negative new size"; goto cleanup; }

    bz = BZ2_bzReadOpen(&bzerror, pf, 0, 0, NULL, 0);
    if (bzerror != BZ_OK) { errMsg = "bzReadOpen failed"; goto cleanup; }

    outBuf = (uint8_t*)malloc((size_t)newsize);
    if (!outBuf) { errMsg = "OOM out buffer"; goto cleanup; }

    bz_stream_state state = { bz, pf };
    struct bspatch_stream stream = { &state, bz_read };
    int rc = bspatch((const uint8_t*)baseMap, (int64_t)baseSize, outBuf, newsize, &stream);
    if (rc != 0) { errMsg = "bspatch returned non-zero"; goto cleanup; }

    of = fopen(outPath, "wb");
    if (!of) { errMsg = "Cannot open output"; goto cleanup; }
    if (fwrite(outBuf, 1, (size_t)newsize, of) != (size_t)newsize) {
        errMsg = "Cannot write output";
        goto cleanup;
    }

cleanup:
    if (of) fclose(of);
    if (outBuf) free(outBuf);
    if (bz) BZ2_bzReadClose(&bzerror, bz);
    if (pf) fclose(pf);
    if (baseMap != MAP_FAILED) munmap(baseMap, (size_t)baseSize);
    if (baseFd >= 0) close(baseFd);

    if (basePath) (*env)->ReleaseStringUTFChars(env, jBase, basePath);
    if (patchPath) (*env)->ReleaseStringUTFChars(env, jPatch, patchPath);
    if (outPath) (*env)->ReleaseStringUTFChars(env, jOut, outPath);

    if (errMsg) throw_runtime(env, errMsg);
}
