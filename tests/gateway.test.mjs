import test from 'node:test'
import assert from 'node:assert/strict'
import { splitText, sessionKey, sessionIdFor } from '../lib/index.mjs'

test('splitText: short text is not split', () => {
  const out = splitText('hello world', 2000)
  assert.deepEqual(out, ['hello world'])
})

test('splitText: exactly-at-limit is not split', () => {
  const text = 'x'.repeat(2000)
  const out = splitText(text, 2000)
  assert.equal(out.length, 1)
  assert.equal(out[0].length, 2000)
})

test('splitText: over-limit splits by characters', () => {
  const out = splitText('y'.repeat(4500), 2000)
  assert.equal(out.length, 3)
  assert.ok(out[1].startsWith('（2/3）'))
  assert.ok(out[2].startsWith('（3/3）'))
})

test('splitText: prefers newline boundary', () => {
  const text = 'a'.repeat(1500) + '\n' + 'b'.repeat(1500)
  const out = splitText(text, 2000)
  assert.equal(out.length, 2)
  assert.ok(out[0].endsWith('\n'))
  assert.ok(out[1].startsWith('（2/2）'))
})

test('splitText: prefers period boundary in Chinese', () => {
  const text = '啊'.repeat(1500) + '。' + '哦'.repeat(1500)
  const out = splitText(text, 2000)
  assert.equal(out.length, 2)
  assert.ok(out[0].endsWith('。'))
})

test('sessionKey: DM is per-user', () => {
  const a = sessionKey({ dmUserId: 'user-1' })
  const b = sessionKey({ dmUserId: 'user-2' })
  assert.notEqual(a, b)
  assert.equal(a, 'discord:dm:user-1')
})

test('sessionKey: guild channel shared, thread adds isolation', () => {
  const ch = sessionKey({ guildId: 'g', channelId: 'c' })
  const th = sessionKey({ guildId: 'g', channelId: 'c', threadId: 't' })
  assert.notEqual(ch, th)
  assert.equal(ch, 'discord:guild:g:c')
  assert.equal(th, 'discord:guild:g:c:thread:t')
})

test('sessionIdFor: stable and prefixed', () => {
  const id1 = sessionIdFor({ guildId: 'g', channelId: 'c' })
  const id2 = sessionIdFor({ guildId: 'g', channelId: 'c' })
  assert.equal(id1, id2)
  assert.ok(String(id1).startsWith('discord-'))
})
