import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tokenizeOptions } from '../src/worker.ts'
import { parsePageSizeToken, queueOfJobId } from '../src/cups.ts'
import { parseEnvFile } from '../src/config.ts'

test('tokenizeOptions accepts CUPS options and rejects shell junk', () => {
  assert.deepEqual(tokenizeOptions('-o fit-to-page -o media=Custom.102x152mm -o sides=one-sided -n 2'), ['-o', 'fit-to-page', '-o', 'media=Custom.102x152mm', '-o', 'sides=one-sided', '-n', '2'])
  assert.deepEqual(tokenizeOptions(''), [])
  assert.throws(() => tokenizeOptions('-o fit-to-page; rm -rf /'))
  assert.throws(() => tokenizeOptions('$(reboot)'))
})
test('page size tokens', () => {
  assert.deepEqual(parsePageSizeToken('Custom.3.5x1.7cm'), { w: 35, h: 17 })
  assert.deepEqual(parsePageSizeToken('w288h432'), { w: 101.6, h: 152.4 })
  assert.deepEqual(parsePageSizeToken('A4'), { w: 210, h: 297 })
  assert.equal(parsePageSizeToken('nope'), null)
})
test('queue of job id', () => { assert.equal(queueOfJobId('labelprinter-1-123'), 'labelprinter-1') })
test('env file', () => { assert.deepEqual(parseEnvFile('# c\nA=1\nB="x y"\n\nbad\n'), { A: '1', B: 'x y' }) })
