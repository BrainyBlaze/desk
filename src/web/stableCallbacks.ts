import { useRef } from 'react';

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyFunctionMap = Record<string, (...args: any[]) => any>;

/**
 * Identity-stable wrappers around per-render callbacks. App re-renders every
 * pulse tick (the header consumes live system metrics), recreating its ~30
 * handler closures; passing those straight into memoized children would
 * defeat the memo. The returned object and every function in it keep their
 * identity for the component's lifetime while always invoking the LATEST
 * implementation. The key set must not change between renders.
 */
export function useStableCallbacks<T extends AnyFunctionMap>(callbacks: T): T {
  const latestRef = useRef(callbacks);
  latestRef.current = callbacks;
  const stableRef = useRef<T | null>(null);
  if (stableRef.current === null) {
    const stable: AnyFunctionMap = {};
    for (const key of Object.keys(callbacks)) {
      stable[key] = (...args: unknown[]) => latestRef.current[key](...args);
    }
    stableRef.current = stable as T;
  }
  return stableRef.current;
}
