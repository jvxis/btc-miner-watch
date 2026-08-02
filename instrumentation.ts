export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { startPoller } = await import('./lib/poller');
  startPoller();
}
