import { useSyncExternalStore } from 'react';

/** Who is acting in this browser (used to attribute acknowledgements and resolutions). */
const KEY = 'netwatch:operator';
let name = (() => {
  try {
    return localStorage.getItem(KEY) || 'Sara Mitchell';
  } catch {
    return 'Sara Mitchell';
  }
})();
const listeners = new Set<() => void>();

export const useOperator = () => useSyncExternalStore((l) => (listeners.add(l), () => listeners.delete(l)), () => name);
export const getOperator = () => name;
export function setOperator(n: string) {
  name = n;
  try {
    localStorage.setItem(KEY, n);
  } catch {
    /* ignore */
  }
  listeners.forEach((l) => l());
}
