#!/usr/bin/env node
/**
 * 用官方联网接口读网页 / 搜东西。
 *
 *   node tools/web.mjs read <url> [问题]
 *   node tools/web.mjs search "查询词"
 *   node tools/web.mjs read https://example.com --json
 *
 * 和 web_fetch 的差别：正文在服务端就抽好了，上下文里只进来干净的正文 + 引用。
 * 需要 deepseek-flash；密钥从 $DSH_HOME/.credentials.yaml 的 refs.DEEPSEEK_API_KEY 读。
 */

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const CRED_FILE = join(DSH_HOME, '.credentials.yaml')
const ENDPOINT = 'https://api.deepseek.com/chat/completions'
const MODEL = 'deepseek-flash'

function apiKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY
  if (!existsSync(CRED_FILE)) throw new Error(`找不到凭据文件：${CRED_FILE}`)
  const text = readFileSync(CRED_FILE, 'utf8')
  const match = /DEEPSEEK_API_KEY:\s*["']?(sk-[A-Za-z0-9]+)["']?/.exec(text)
  if (!match) throw new Error('凭据文件里没有 DEEPSEEK_API_KEY')
  return match[1]
}

async function call(messages, tools) {
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey()}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      tools,
      stream: false,
    }),
  })
  const body = await response.json()
  if (!response.ok) {
    throw new Error(`${response.status} ${JSON.stringify(body).slice(0, 300)}`)
  }
  if (body.error) throw new Error(`${body.error.type ?? 'error'}: ${body.error.message ?? ''}`)
  return body
}

function summarize(body) {
  const choice = body.choices?.[0] ?? {}
  const message = choice.message ?? {}
  const calls = (message.server_tool_calls ?? []).flatMap((step) => step.calls ?? [])
  const citations = (message.annotations ?? []).map((item) => item.url_citation).filter(Boolean)
  const usage = body.usage ?? {}
  return {
    answer: message.content ?? '',
    calls: calls.map((call) => ({
      kind: call.kind,
      status: call.status,
      url: call.page?.url ?? call.action?.url ?? null,
      title: call.page?.title ?? null,
      queries: call.action?.queries ?? null,
      sources: (call.sources ?? []).map((s) => ({ title: s.title, url: s.url })),
      error: call.error?.code ?? null,
    })),
    citations: [...new Map(citations.map((c) => [c.url, { title: c.title, url: c.url }])).values()],
    usage: {
      input: usage.prompt_tokens ?? usage.input_tokens ?? null,
      output: usage.completion_tokens ?? usage.output_tokens ?? null,
      tool_search: usage.server_tool_use?.tool_search ?? null,
      tool_fetch: usage.server_tool_use?.tool_fetch ?? null,
    },
  }
}

function print(result, asJson) {
  if (asJson) {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  console.log(result.answer.trim())
  if (result.calls.length) {
    console.log('\n--- 调用 ---')
    for (const call of result.calls) {
      const where = call.url ?? (call.queries ? call.queries.join(' | ') : '')
      console.log(`${call.kind} ${call.status}${call.error ? ` (${call.error})` : ''} ${where}`)
      for (const source of call.sources ?? []) console.log(`  - ${source.title} ${source.url}`)
    }
  }
  if (result.citations.length) {
    console.log('\n--- 引用 ---')
    for (const citation of result.citations) console.log(`- ${citation.title} ${citation.url}`)
  }
  const usage = result.usage
  console.log(`\n[用量] in ${usage.input} / out ${usage.output} / 搜索 ${usage.tool_search ?? 0} / 抓取 ${usage.tool_fetch ?? 0}`)
}

const args = process.argv.slice(2)
const asJson = args.includes('--json')
const clean = args.filter((arg) => arg !== '--json')
const mode = clean[0]

if (!mode || (mode !== 'read' && mode !== 'search')) {
  console.error('用法：node tools/web.mjs read <url> [问题] [--json]')
  console.error('      node tools/web.mjs search "查询词" [--json]')
  process.exit(2)
}

try {
  if (mode === 'search') {
    const query = clean.slice(1).join(' ')
    if (!query) throw new Error('查询词不能为空')
    const body = await call([{ role: 'user', content: query }], [{ type: 'deepseek_web_search' }])
    print(summarize(body), asJson)
  } else {
    const url = clean[1]
    if (!url) throw new Error('URL 不能为空')
    const question = clean.slice(2).join(' ') || '用中文概括这一页的要点，控制在 300 字内，并标出来源标题'
    const body = await call(
      [{ role: 'user', content: `${question}\n\n${url}` }],
      [{ type: 'deepseek_read_url' }],
    )
    print(summarize(body), asJson)
  }
} catch (error) {
  console.error(`[web] ${error?.message ?? error}`)
  process.exit(1)
}
