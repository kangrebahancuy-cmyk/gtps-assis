/**
 * Test stand-in for zustand (the real package is not installed in this environment): the same `create`/`persist`
 * call shape and hook/getState/setState API. `persist` does NOT persist here, so localStorage persistence of the
 * workspace is not exercised by these tests.
 */
import { useSyncExternalStore } from "react";

type Setter<T> = (partial: Partial<T> | ((state: T) => Partial<T>)) => void;

export function create<T>() {
  return (initializer: (set: Setter<T>, get: () => T) => T) => {
    let state: T;
    const listeners = new Set<() => void>();
    const get = () => state;
    const set: Setter<T> = (partial) => {
      const next = typeof partial === "function" ? partial(state) : partial;
      state = { ...state, ...next };
      for (const l of listeners) l();
    };
    state = initializer(set, get);
    const subscribe = (l: () => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    };
    const hook = <S = T>(selector: (s: T) => S = (s) => s as unknown as S): S => useSyncExternalStore(subscribe, () => selector(state), () => selector(state));
    return Object.assign(hook, { getState: get, setState: set });
  };
}
