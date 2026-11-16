import { registerHooks } from 'node:module'
const shim = 'data:text/javascript,' + encodeURIComponent(`
  import { win32 } from 'node:path'
  export const { dirname, join, isAbsolute, normalize, relative, sep, basename } = win32
  export const resolve = (...args) => win32.resolve('C:\\\\', ...args)
`)
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'node:path' && /\/(test\/thread-lanes\.test\.ts|lib\/thread-lanes\.ts|test\/marketplace-attach\.test\.ts|lib\/marketplace-attach\.ts|lib\/agent-credentials\.ts|lib\/attach-scope\.mjs)$/.test(context.parentURL ?? '')) {
      return { url: shim, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  }
})
