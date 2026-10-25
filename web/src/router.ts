import { useSyncExternalStore } from 'react';

/** Minimal hash router: #/incidents/12 -> ['incidents', '12']. Deep links survive reloads. */
const parse = () => window.location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
let current = parse();
const listeners = new Set<() => void>();
window.addEventListener('hashchange', () => {
  current = parse();
  listeners.forEach((l) => l());
});

export const useRoute = () => useSyncExternalStore((l) => (listeners.add(l), () => listeners.delete(l)), () => current);
export const go = (path: string) => {
  window.location.hash = '/' + path.replace(/^\//, '');
};
