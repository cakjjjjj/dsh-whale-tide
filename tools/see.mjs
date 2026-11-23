#!/usr/bin/env node
/**
 * 让模型看一眼图片（本地文件或 URL），回答一个问题。
 *
 *   node tools/see.mjs avatar/whale-avatar.jpg "这张图里是什么"
 *   node tools/see.mjs https://example.com/a.png "截图里的报错是什么"
 *
 * 走官方多模态接口：deepseek-flash 支持 JPEG/PNG/GIF/WebP，格式按内容判断。
 */

import { readFileSync, existsSync } from 'node:fs'
import { join, extname } from 'node:path'
import { homedir } from 'node:os'

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const CRED_FILE = join(DSH_HOME, '.credentials.yaml')
const ENDPOINT = 'https://api.deepseek.com/chat/completions'
const MODEL = 'deepseek-flash'
const MAX_BYTES = 20 * 1024 * 1024

function apiKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY
  const text = readFileSync(CRED_FILE, 'utf8')
  const match = /DEEPSEEK_API_KEY:\s*["']?(sk-[A-Za-z0-9]+)["']?/.exec(text)
  if (!match) throw new Error('凭据文件里没有 DEEPSEEK_API_KEY')
  return match[1]
}

function mimeOf(path) {
  const ext = extname(path).toLowerCase()
  if (ext === '.png') return 'image/png'
  if (ext === '.gif') return 'image/gif'
  if (ext === '.webp') return 'image/webp'
  return 'image/jpeg'
}

function imageUrl(target) {
  if (/^https?:\/\//.test(target)) return target
  if (!existsSync(target)) throw new Error(`找不到文件：${target}`)
  const bytes = readFileSync(target)
  if (bytes.length > MAX_BYTES) throw new Error(`图片太大：${(bytes.length / 1048576).toFixed(1)}MB（上限 20MB）`)
  return `data:${mimeOf(target)};base64,${bytes.toString('base64')}`
}

const args = process.argv.slice(2)
const target = args[0]
const question = args.slice(1).join(' ') || '用中文描述这张图的内容，细节讲清楚'

if (!target) {
  console.error('用法：node tools/see.mjs <图片路径或URL> [问题]')
  process.exit(2)
}

try {
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey()}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: question },
            { type: 'image_url', image_url: { url: imageUrl(target) } },
          ],
        },
      ],
      stream: false,
    }),
  })
  const body = await response.json()
  if (!response.ok || body.error) {
    throw new Error(`${response.status} ${JSON.stringify(body).slice(0, 300)}`)
  }
  const message = body.choices?.[0]?.message ?? {}
  console.log(String(message.content ?? '').trim())
  const usage = body.usage ?? {}
  console.error(`[see] in ${usage.prompt_tokens ?? '?'} / out ${usage.completion_tokens ?? '?'}`)
} catch (error) {
  console.error(`[see] ${error?.message ?? error}`)
  process.exit(1)
}
