// PresenceHealthKitModule.m
//
// Objective-C bridge macro registration for PresenceHealthKit Swift module.
// Swift class is in PresenceHealthKitModule.swift.

#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(PresenceHealthKit, NSObject)

RCT_EXTERN_METHOD(isAvailable:
                  (RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(requestPermissions:
                  (RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(getHeartRateSamples:
                  (NSDictionary *)options
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(getStepCount:
                  (NSDictionary *)options
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)

@end
