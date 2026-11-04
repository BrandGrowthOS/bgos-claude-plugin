/**
 * The entry of every node:test worker (scripts/run-test-files.mjs): it runs one
 * test file, then says the file's body finished.
 *
 * Exit codes alone cannot say that. Under `--test` Node drops a load error once
 * a file has registered a test, and a handler in the code under test can reset
 * the exit code to 0 after a top level throw. In both cases the tests that did
 * register pass, the tally is clean, and the rest of the file is simply gone. So
 * the runner asks for positive proof: this line comes only after the last
 * top level statement of the file has run.
 */
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { FILE_BODY_FINISHED } from './run-test-files.mjs'

// Held now because a test may replace process.stderr.write.
const say = process.stderr.write.bind(process.stderr)
const file = resolve(process.argv[2])
// The file sees the argv of `node file`, so a main() that reads argv.slice(2) finds nothing extra.
process.argv.splice(1, 2, file)
await import(pathToFileURL(file).href)
// On its own line, whatever the file left unterminated on stderr.
say(`\n${FILE_BODY_FINISHED}\n`)
