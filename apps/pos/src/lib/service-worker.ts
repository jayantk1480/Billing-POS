/**
 * Registers the service worker that keeps the app on the device, so the POS opens without the internet. Only in a
 * production build: the development server's files change all the time, so there any worker left from a production
 * build on this address is removed instead. Browsers allow service workers only over HTTPS and on localhost.
 */
export function registerServiceWorker(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  if (process.env.NODE_ENV !== 'production') {
    void navigator.serviceWorker.getRegistrations().then((registrations) => registrations.forEach((registration) => void registration.unregister()), () => undefined);
    return;
  }
  const build = process.env.POS_BUILD_ID ?? 'build';
  navigator.serviceWorker.register(`/sw.js?v=${encodeURIComponent(build)}`, { scope: '/', updateViaCache: 'none' }).catch(() => undefined);
}
