/**
 * 文本工具：内容块取字、分块、指纹。
 *
 * 插件里所有「消息 → 可索引文本」的换算都走这里，避免各处各写一遍。
 */

import { createHash } from 'node:crypto'

/** 只取消息里的文本块，拼接成一行。 */
export function blocksToText(content) {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

/** 一条消息的可索引文本；非对话来源（运行时上下文等）返回空串。 */
export function messageText(message) {
  if (!message || typeof message !== 'object') return ''
  const kind = message.source && message.source.kind
  // runtime-context / system-prompt 是 harness 自己注入的说明；
  // schedule 是心跳、鲸梦这类定时任务投递的 prompt。
  // 三类都不是「用户说的话」，进记忆库会把自己的调度指令当成对话。
  const INJECTED = new Set(['runtime-context', 'system-prompt', 'schedule', 'time-context', 'agent-instructions', 'skill-catalog'])
  if (INJECTED.has(kind)) return ''
  return blocksToText(message.content)
}

/** 每轮都会重复、且不含事实的行（时间戳、环境快照等）。 */
const NOISE_LINE = /^(Time sampled while preparing|Elapsed since the|Browser time zone for this request|Current runtime context\.|Current working directory:|Current DSH file policy:|Current DeepSeek Harness implementation checkout|Current DeepSeek Harness Web GUI URL|This snapshot supersedes|Approval prompts are disabled)/

/**
 * 把整行噪声剔掉，留下真正有内容的句子。
 * 这些行出现在每条用户消息的头部，整条丢弃会浪费掉同一条里的真话。
 */
export function sanitize(text) {
  const lines = String(text ?? '').split('\n')
  return lines.filter((line) => !NOISE_LINE.test(line.trim())).join('\n').trim()
}

/**
 * 判掉不该进记忆的噪声：系统注入的说明、定时任务批、附件占位等。
 * 这些东西量大、没信息量，还会把真正的记忆挤出检索结果。
 */
export function isNoise(text) {
  const t = String(text ?? '')
  if (!t) return true
  if (t.includes('<system-reminder>')) return true
  if (/^\[SCHEDULE REMINDER/.test(t)) return true
  if (t.includes('Repeated tool call detected')) return true
  if (t.includes('You are repeating the exact same tool call')) return true
  if (t.includes('This is a scheduled message from the user')) return true
  if (/^\[file:/.test(t) || /^\[attached/i.test(t)) return true
  if (t.includes('Updated instructions from:')) return true
  return false
}

/** 从进入下一步的消息里取最后一条真实用户输入。 */
export function lastUserText(messages) {
  if (!Array.isArray(messages)) return ''
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]
    if (!m || m.role !== 'user') continue
    const text = messageText(m)
    if (text) return text
  }
  return ''
}

/** 按句子边界把长文本切成带重叠的小块。 */
export function chunkText(text, max = 600, overlap = 60) {
  const clean = String(text ?? '').replace(/\r/g, '').trim()
  if (!clean) return []
  if (clean.length <= max) return [clean]
  const pieces = []
  const sentences = clean.split(/(?<=[。！？!?；;\n])/)
  let buf = ''
  const push = (s) => {
    if (s.trim()) pieces.push(s.trim())
  }
  for (const sentence of sentences) {
    if (!sentence) continue
    if (buf.length + sentence.length > max && buf) {
      push(buf)
      buf = overlap > 0 ? buf.slice(-overlap) : ''
    }
    if (sentence.length > max) {
      if (buf) {
        push(buf)
        buf = ''
      }
      for (let i = 0; i < sentence.length; i += max - overlap) {
        push(sentence.slice(i, i + max))
      }
      continue
    }
    buf += sentence
  }
  push(buf)
  return pieces
}

/**
 * Markdown 分块：先按标题切段，段内再按长度切，并把标题路径带进每块。
 * 这样「规矩」这种小节不会跟别的内容糊在一起，检索时也不会只命中文件开头。
 */
export function chunkMarkdown(text, max = 480, overlap = 60) {
  const lines = String(text ?? '').replace(/\r/g, '').split('\n')
  const sections = []
  let heading = ''
  let buf = []
  const flush = () => {
    const body = buf.join('\n').trim()
    if (body) sections.push({ heading, body })
    buf = []
  }
  for (const line of lines) {
    if (/^#{1,6}\s+/.test(line)) {
      flush()
      heading = line.replace(/^#{1,6}\s+/, '').trim()
      continue
    }
    buf.push(line)
  }
  flush()
  const pieces = []
  for (const section of sections) {
    const prefix = section.heading ? `【${section.heading}】` : ''
    for (const piece of chunkText(section.body, max, overlap)) {
      pieces.push(`${prefix}${piece}`)
    }
  }
  return pieces
}

/** 稳定的短指纹，用于幂等落库。 */
export function fingerprint(...parts) {
  return createHash('sha1').update(parts.join('\u0001')).digest('hex').slice(0, 24)
}

/** 截断到 n 个字符，尾巴用省略号。 */
export function truncate(text, n = 240) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`
}
