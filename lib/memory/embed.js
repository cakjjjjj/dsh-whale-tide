/**
 * 本地 embedding：transformers.js + bge-small-zh-v1.5（q8）。
 *
 * 全程本机 CPU 推理，5ms 一句、常驻约 180MB RSS，4G 内存机器扛得住。
 * 模型只在第一次真正用到时下载，下载失败不影响插件其余部分。
 */

import { env, pipeline } from '@huggingface/transformers'

/** bge 系列做检索时，查询侧建议加这句指令前缀。 */
const QUERY_PREFIX = '为这个句子生成表示以用于检索相关文章：'
/** 单条文本的字符上限，超出的部分对 512-token 的模型没有意义。 */
const MAX_INPUT_CHARS = 600

/**
 * @param {{ model: string, dtype?: string, mirror?: string, cacheDir?: string }} options
 */
export function createEmbedder({ model, dtype = 'q8', mirror, cacheDir, batchSize = 1 }) {
  if (mirror) env.remoteHost = mirror
  if (cacheDir) env.cacheDir = cacheDir
  env.allowLocalModels = false
  env.allowRemoteModels = true

  let loading = null
  function load() {
    if (!loading) {
      loading = pipeline('feature-extraction', model, { dtype }).catch((error) => {
        loading = null
        throw error
      })
    }
    return loading
  }

  /**
   * @param {string[]} texts
   * @returns {Promise<number[][]>}
   */
  async function embed(texts) {
    const extractor = await load()
    const input = texts.map((t) => String(t ?? '').slice(0, MAX_INPUT_CHARS) || ' ')
    const out = []
    const size = Math.max(1, Math.trunc(batchSize) || 1)
    for (let i = 0; i < input.length; i += size) {
      const output = await extractor(input.slice(i, i + size), { pooling: 'cls', normalize: true })
      out.push(...output.tolist())
    }
    return out
  }

  /** 查询侧：加检索指令后取单条向量。 */
  async function embedQuery(text) {
    const [vector] = await embed([QUERY_PREFIX + String(text ?? '')])
    return vector
  }

  return { embed, embedQuery, load }
}
