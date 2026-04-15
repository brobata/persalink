/**
 * @file Biometric Authentication (stub)
 * @description No-op implementation for web. Biometric auth is only available
 *   in native Capacitor builds. All functions return safe defaults.
 */

export async function isBiometricAvailable(): Promise<boolean> {
  return false;
}

export async function verifyBiometric(): Promise<boolean> {
  return false;
}

export async function saveCredentials(_token: string, _deviceName: string): Promise<void> {}

export async function getCredentials(): Promise<{ token: string; deviceName: string } | null> {
  return null;
}

export async function clearCredentials(): Promise<void> {}
