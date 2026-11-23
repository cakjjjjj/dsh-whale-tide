/**
 * M1：定时任务的 prompt 不该进记忆库。
 *
 * 背景：dsh 的 schedule 投递消息带 source.kind = 'schedule'，
 * 之前 messageText() 只排除了 runtime-context / system-prompt，
 * 于是「鲸鲸心跳 · 轻唤醒…」会被当作对话切片存进去。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { messageText, isNoise, sanitize } from '../lib/memory/text.js'

const msg = (kind, text, role = 'user') => ({
  role,
  source: { kind },
  content: [{ type: 'text', text }],
})

test('定时任务投递的 prompt 不进记忆', () => {
  assert.equal(messageText(msg('schedule', '鲸鲸心跳 · 轻唤醒。在 /var/lib/... 下先跑 node tools/tick.mjs --json')), '')
})

test('heartbeat 和鲸梦两种任务都不进', () => {
  assert.equal(messageText(msg('schedule', '鲸梦 · 一天收尾。依次做六件事……')), '')
})

test('运行时上下文仍然不进', () => {
  assert.equal(messageText(msg('runtime-context', 'working-directory:current')), '')
})

test('系统提示仍然不进', () => {
  assert.equal(messageText(msg('system-prompt', 'You are …')), '')
})

test('用户真实消息照常入库', () => {
  const text = '今天有点累，先不折腾了'
  assert.equal(messageText(msg('user', text)), text)
})

test('鲸鲸自己的回复照常入库（不是任务轮）', () => {
  const text = '那就早点歇着，剩下的事明天再说'
  assert.equal(messageText(msg('agent-message', text, 'assistant')), text)
})

test('六类系统注入都不进记忆（P1-2）', () => {
  const kinds = ['runtime-context', 'system-prompt', 'schedule', 'time-context', 'agent-instructions', 'skill-catalog']
  for (const kind of kinds) {
    assert.equal(messageText(msg(kind, '## 性格\n你是一只小鲸鱼')), '', `${kind} 不该进记忆`)
  }
})

test('真正的用户发言照常保留', () => {
  assert.match(messageText(msg(undefined, '鲸鲸，今天中午吃什么好呢，人有点饿了')), /中午/)
})
