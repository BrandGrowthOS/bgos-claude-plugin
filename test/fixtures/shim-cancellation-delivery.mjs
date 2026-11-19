// Test-only gate: aborting the original request can free the stdio queue
// before the independent cancellation HTTP request reaches its destination.
const originalFetch = globalThis.fetch;
let release;
const gate = new Promise(resolve => { release = resolve; });
process.on('message', message => { if (message === 'release-cancellation-dispatch') release(); });
globalThis.fetch = async (...args) => {
  const body = args[1]?.body;
  if (typeof body === 'string' && JSON.parse(body).method === 'notifications/cancelled') {
    await gate;
  }
  return originalFetch(...args);
};
