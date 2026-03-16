// PresenceAttestModule.m
//
// Objective-C bridge macro registration for PresenceAttest Swift module.

#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(PresenceAttest, NSObject)

RCT_EXTERN_METHOD(isSupported:
                  (RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(generateAttestKey:
                  (RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(attestKey:
                  (NSString *)keyId
                  challengeHash:(NSString *)challengeHash
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(resetAttestKey:
                  (RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)

@end
