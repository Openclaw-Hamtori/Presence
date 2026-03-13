import { NativeModules, Platform } from "react-native";

interface PresenceQRScannerNative {
  isSupported(): Promise<boolean>;
  scanQRCode(): Promise<string>;
}

function getNativeModule(): PresenceQRScannerNative | null {
  if (Platform.OS !== "ios") return null;
  return (NativeModules.PresenceQRScanner as PresenceQRScannerNative) ?? null;
}

export async function isQrScannerSupported(): Promise<boolean> {
  const native = getNativeModule();
  if (!native) return false;
  try {
    return await native.isSupported();
  } catch {
    return false;
  }
}

export async function scanQrCode(): Promise<string> {
  const native = getNativeModule();
  if (!native) {
    throw new Error("QR scanner native module not available");
  }
  return native.scanQRCode();
}
