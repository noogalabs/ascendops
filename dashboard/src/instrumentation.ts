export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { initWatcher } = await import('./lib/watcher');
    initWatcher();
  }
}
