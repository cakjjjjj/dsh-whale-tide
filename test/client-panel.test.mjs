/**
 * 面板源码级守卫：这些键必须真的被 `save()` 提交。
 *
 * 背景：`scheduleSync` 曾经只出现在 checkbox 上——勾了、点了保存，后端根本收不到，
 * 于是「用配置接管任务」永远打不开，已经打开的也关不掉。前端组件不好做行为测试，
 * 这里退一步守源码：每个关键键都必须出现在 `save({ ... })` 的 patch 里。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

/** 把每个 save({ ... }) 的实参截出来（到下一个 `})` 为止），拼成一个字符串。 */
function savePatches(text) {
  const out = []
  const re = /save\(\{/g
  let match
  while ((match = re.exec(text)) !== null) {
    const start = match.index + 'save('.length
    const end = text.indexOf('})', start)
    if (end > start) out.push(text.slice(start, end))
  }
  return out.join('\n')
}

const patch = savePatches(src)

test('面板保存时必须提交 scheduleSync（否则接管开关无效）', () => {
  assert.match(patch, /scheduleSync:\s*Boolean\(cfg\.scheduleSync\)/, 'scheduleSync 没进 save patch')
})

test('面板保存时必须提交额度相关的键', () => {
  for (const key of ['dailyGrant', 'maxBalance', 'maxReachPerDay']) {
    assert.match(patch, new RegExp(`${key}:`), `${key} 没被提交`)
  }
})

test('面板保存时必须提交梦境相关的键', () => {
  for (const key of ['dreamAt', 'dreamTasks', 'dreamPrune', 'memoryArchive']) {
    assert.match(patch, new RegExp(`${key}:`), `${key} 没被提交`)
  }
})
