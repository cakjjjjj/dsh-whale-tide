import { test } from 'node:test'
import assert from 'node:assert/strict'
import { desiredTargetAfterDelivery, resolveTarget } from '../lib/schedule-sync.js'

test('投递后把 new_once 钉到真实会话', () => {
  const task = {
    id: 't1',
    target: { kind: 'new_once', sessionId: 'reserved', create: {} },
    lastDelivery: { targetSessionId: 'actual' },
  }
  assert.deepEqual(desiredTargetAfterDelivery(task), { kind: 'session', sessionId: 'actual' })
})

test('已经钉住就不重复改', () => {
  const task = {
    target: { kind: 'session', sessionId: 'actual' },
    lastDelivery: { targetSessionId: 'actual' },
  }
  assert.equal(desiredTargetAfterDelivery(task), null)
})

test('还没投递过，不动', () => {
  const task = { target: { kind: 'new_once', sessionId: 'reserved' } }
  assert.equal(desiredTargetAfterDelivery(task), null)
})

test('main/session 目标不被误改成别的会话', () => {
  const task = {
    target: { kind: 'session', sessionId: 'mine' },
    lastDelivery: { targetSessionId: 'other' },
  }
  assert.equal(desiredTargetAfterDelivery(task), null)
})

test('每次新建模式（new）投递后也钉住，符合「新建并保持」', () => {
  const task = {
    target: { kind: 'new', create: {} },
    lastDelivery: { targetSessionId: 'fresh' },
  }
  assert.deepEqual(desiredTargetAfterDelivery(task), { kind: 'session', sessionId: 'fresh' })
})

test('background 新建时带上 cwd，避免落到默认工作区', () => {
  const target = resolveTarget({ sessionsRoot: null, mode: 'background', workspaceDir: '/srv/agent-workspace' })
  assert.equal(target.kind, 'new_once')
  assert.equal(target.create.cwd, '/srv/agent-workspace')
})

test('new 模式同样带 cwd', () => {
  const target = resolveTarget({ sessionsRoot: null, mode: 'new', workspaceDir: '/w' })
  assert.equal(target.kind, 'new')
  assert.equal(target.create.cwd, '/w')
})

test('targetMatches 会比较 create.cwd', async () => {
  const { targetMatches } = await import('../lib/schedule-sync.js')
  const want = { kind: 'new_once', create: { cwd: '/w' } }
  assert.equal(targetMatches({ kind: 'new_once', create: {} }, want), false)
  assert.equal(targetMatches({ kind: 'new_once', create: { cwd: '/w' } }, want), true)
  // main/session 不受 cwd 影响
  assert.equal(targetMatches({ kind: 'session', sessionId: 'a' }, { kind: 'session', sessionId: 'a' }), true)
})
