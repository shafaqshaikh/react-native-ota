#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface OTABsPatch : NSObject

/**
 * Apply a bsdiff patch. Returns YES on success, NO on failure with `error` set.
 * - basePath:  existing bundle file (read-only input)
 * - patchPath: bsdiff patch file (read-only input)
 * - outPath:   destination for the reconstructed bundle (overwritten)
 */
+ (BOOL)applyPatchAtBase:(NSString *)basePath
                   patch:(NSString *)patchPath
                  output:(NSString *)outPath
                   error:(NSError **)error;

@end

NS_ASSUME_NONNULL_END
