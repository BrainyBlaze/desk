export interface InitialSettingResolution<T> {
  value: T;
  adoptServer: boolean;
  persistCurrent: boolean;
}

export function reconcileInitialSetting<T>(
  serverValue: T | undefined,
  currentValue: T,
  changedSinceRequest: boolean
): InitialSettingResolution<T> {
  if (changedSinceRequest) {
    return { value: currentValue, adoptServer: false, persistCurrent: true };
  }
  if (serverValue !== undefined) {
    return { value: serverValue, adoptServer: true, persistCurrent: false };
  }
  return { value: currentValue, adoptServer: false, persistCurrent: false };
}
