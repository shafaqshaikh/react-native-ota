#import "OTABsPatch.h"
#include "bspatch.h"
#import <bzlib.h>
#import <stdint.h>
#import <stdio.h>
#import <string.h>

typedef struct {
    BZFILE* bz;
    FILE* fp;
} bz_stream_state;

static int bz_read(const struct bspatch_stream* stream, void* buffer, int length) {
    bz_stream_state* s = (bz_stream_state*)stream->opaque;
    int bzerror = BZ_OK;
    int n = BZ2_bzRead(&bzerror, s->bz, buffer, length);
    if (bzerror != BZ_OK && bzerror != BZ_STREAM_END) return -1;
    return n;
}

@implementation OTABsPatch

+ (BOOL)applyPatchAtBase:(NSString *)basePath
                   patch:(NSString *)patchPath
                  output:(NSString *)outPath
                   error:(NSError **)error {
    NSData* baseData = [NSData dataWithContentsOfFile:basePath];
    if (!baseData) {
        if (error) *error = [NSError errorWithDomain:@"OTABsPatch" code:1
            userInfo:@{NSLocalizedDescriptionKey: @"Cannot read base bundle"}];
        return NO;
    }

    FILE* pf = fopen([patchPath UTF8String], "rb");
    if (!pf) {
        if (error) *error = [NSError errorWithDomain:@"OTABsPatch" code:2
            userInfo:@{NSLocalizedDescriptionKey: @"Cannot open patch file"}];
        return NO;
    }

    uint8_t header[32];
    if (fread(header, 1, 32, pf) != 32) {
        fclose(pf);
        if (error) *error = [NSError errorWithDomain:@"OTABsPatch" code:3
            userInfo:@{NSLocalizedDescriptionKey: @"Short patch header"}];
        return NO;
    }
    if (memcmp(header, "ENDSLEY/BSDIFF43", 16) != 0) {
        fclose(pf);
        if (error) *error = [NSError errorWithDomain:@"OTABsPatch" code:4
            userInfo:@{NSLocalizedDescriptionKey: @"Bad patch magic"}];
        return NO;
    }

    int64_t newsize = 0;
    for (int i = 0; i < 8; i++) newsize |= ((int64_t)header[24 + i]) << (i * 8);
    if (newsize < 0) {
        fclose(pf);
        if (error) *error = [NSError errorWithDomain:@"OTABsPatch" code:5
            userInfo:@{NSLocalizedDescriptionKey: @"Negative new size"}];
        return NO;
    }

    int bzerror = BZ_OK;
    BZFILE* bz = BZ2_bzReadOpen(&bzerror, pf, 0, 0, NULL, 0);
    if (bzerror != BZ_OK) {
        fclose(pf);
        if (error) *error = [NSError errorWithDomain:@"OTABsPatch" code:6
            userInfo:@{NSLocalizedDescriptionKey: @"bzReadOpen failed"}];
        return NO;
    }

    bz_stream_state state = { bz, pf };
    struct bspatch_stream stream = { &state, bz_read };

    NSMutableData* outData = [NSMutableData dataWithLength:(NSUInteger)newsize];
    int rc = bspatch((const uint8_t*)baseData.bytes, baseData.length,
                     (uint8_t*)outData.mutableBytes, newsize, &stream);

    BZ2_bzReadClose(&bzerror, bz);
    fclose(pf);

    if (rc != 0) {
        if (error) *error = [NSError errorWithDomain:@"OTABsPatch" code:7
            userInfo:@{NSLocalizedDescriptionKey: @"bspatch returned non-zero"}];
        return NO;
    }

    NSError* writeErr = nil;
    if (![outData writeToFile:outPath options:NSDataWritingAtomic error:&writeErr]) {
        if (error) *error = writeErr;
        return NO;
    }

    return YES;
}

@end
