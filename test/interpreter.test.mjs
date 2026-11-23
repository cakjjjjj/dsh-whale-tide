import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classify } from '../lib/emotion/interpreter.js'

/** 一句话判成什么事件。kind 是主要断言，强度另测。 */
const CASES = [
  ['鲸鲸早上好呀', 'none'],
  ['', 'none'],
  ['我想你了', 'affection'],
  ['我好想你！！', 'affection'],
  ['有点想你', 'affection'],
  ['不喜欢你了', 'hurt'],
  ['不想你', 'hurt'],
  ['你真笨', 'rebuke'],
  ['你滚', 'conflict'],
  ['对不起，是我不好', 'apology'],
  ['你会想我吗？', 'none'],
  ['我回来了', 'reunion'],
  ['晚安鲸鲸', 'farewell'],
  ['早点睡，别熬夜', 'care'],
  ['帮我看看这个报错', 'help'],
  ['推荐给你一个视频', 'share'],
  ['你只是个程序', 'hurt'],
  ['真好，厉害', 'praise'],
  ['你那句话说得不对', 'rebuke'],
  ['随便你', 'hurt'],
  ['鲸鲸最厉害了', 'praise'],
  ['在吗鲸鲸？你还好吗', 'care'],
]

for (const [text, expected] of CASES) {
  test(`「${text}」→ ${expected}`, () => {
    const result = classify(text)
    assert.equal(result.kind, expected, `实际 ${result.kind}（命中 ${result.why}）`)
  })
}

test('强度和字数/标点相关', () => {
  assert.equal(classify('我好想你！！').intensity, 'heavy')
  assert.equal(classify('有点想你').intensity, 'light')
  assert.equal(classify('我想你了').intensity, 'normal')
})

test('纯问句不把亲昵当事实', () => {
  const result = classify('你会不会想我呀？')
  assert.equal(result.kind, 'none')
})

test('强情绪在问句里仍然算数', () => {
  // 「你是不是讨厌我」是求确认，读成受伤比读成冲突更合理
  assert.equal(classify('你是不是讨厌我？').kind, 'hurt')
  assert.equal(classify('你是不是不要我了？').kind, 'conflict')
})

test('返回命中片段，便于审计', () => {
  const result = classify('鲸鲸最厉害了')
  assert.ok(result.why.includes('厉害') || result.why.includes('最'))
  assert.ok(result.hits >= 1)
})
