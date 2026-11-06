// Test-only scheduling gate. Real HTTP bytes are fully read before cancellation;
// only the continuation returning those successful bytes to the shim is held.
const originalFetch = globalThis.fetch;
let release;
const gate = new Promise(resolve => { release = resolve; });
process.on('message', message => { if (message === 'release-success') release(); });
globalThis.fetch = async (...args) => {
  const response = await originalFetch(...args);
  const originalText = response.text.bind(response);
  response.text = async () => {
    const text = await originalText();
    if (text.includes('late success')) {
      process.send({ stage: 'success-buffered' });
      await gate;
      process.send({ stage: 'success-released' });
    }
    return text;
  };
  return response;
};
