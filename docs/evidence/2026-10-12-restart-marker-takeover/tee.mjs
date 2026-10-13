// tee.mjs: preloaded into the launcher (node --import) so its console output is
// also appended to RESTARTMK_TEE_LOG, with a timestamp. Changes nothing else.
import { appendFileSync } from 'node:fs'

const file = process.env.RESTARTMK_TEE_LOG
if (file) {
  for (const [name, stream] of [['out', process.stdout], ['err', process.stderr]]) {
    const write = stream.write.bind(stream)
    stream.write = (chunk, ...rest) => {
      try {
        appendFileSync(file, `${new Date().toISOString()} pid=${process.pid} [${name}] ${String(chunk).replace(/\r?\n$/, '')}\n`)
      } catch {}
      return write(chunk, ...rest)
    }
  }
  appendFileSync(file, `${new Date().toISOString()} pid=${process.pid} [tee] launcher argv=${JSON.stringify(process.argv)}\n`)
  process.on('exit', (code) => {
    try {
      appendFileSync(file, `${new Date().toISOString()} pid=${process.pid} [tee] launcher exit code=${code}\n`)
    } catch {}
  })
}
