#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(PresenceQRScanner, NSObject)

RCT_EXTERN_METHOD(isSupported:
                  (RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(scanQRCode:
                  (RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)

@end
