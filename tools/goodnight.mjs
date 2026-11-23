#!/usr/bin/env node
/**
 * 用鲸鲸自己的音色合成一句话。
 *
 *   node plugins/dsh-whale-tide/tools/goodnight.mjs "今天辛苦了"
 *   node plugins/dsh-whale-tide/tools/goodnight.mjs --text "今天辛苦了" --dry
 *   node plugins/dsh-whale-tide/tools/goodnight.mjs "试一下" --engine edge   # 强制走在线备份
 *
 * 优先 piper（本地离线，4C4G 峰值约 190MB）；模型缺失或失败时退回 edge-tts。
 * 只负责合成，不负责发送——发送由会话里的 qqbot_send_file 完成，留痕更好查。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { day } from '../lib/time.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const WORKSPACE = join(HERE, '..', '..', '..')
const PROFILE_FILE = join(WORKSPACE, 'voice', 'profile.json')
const PY_DIR = join(WORKSPACE, '.cache', 'py')
const EDGE = join(PY_DIR, 'bin', 'edge-tts')
const FFMPEG = join(WORKSPACE, 'bin', 'ffmpeg')

const args = process.argv.slice(2)
const dry = args.includes('--dry')
const engineFlag = (() => {
  const index = args.indexOf('--engine')
  return index >= 0 ? args[index + 1] : null
})()
const textIndex = args.indexOf('--text')
const text = textIndex >= 0
  ? args[textIndex + 1]
  : args.filter((arg, index) => !arg.startsWith('--') && args[index - 1] !== '--engine').join(' ')

if (!text) {
  console.error('用法：node tools/goodnight.mjs "今天辛苦了"')
  process.exit(2)
}
if (!existsSync(PROFILE_FILE)) {
  console.error(`找不到音色配置：${PROFILE_FILE}`)
  process.exit(2)
}

const profile = JSON.parse(readFileSync(PROFILE_FILE, 'utf8'))
const stamp = day()
const mp3 = join(WORKSPACE, 'voice', `goodnight-${stamp}.mp3`)
const pyEnv = { ...process.env, PYTHONPATH: PY_DIR }

function piperPath() {
  const model = join(WORKSPACE, profile.model?.path ?? '')
  const config = join(WORKSPACE, profile.model?.config ?? '')
  return existsSync(model) && existsSync(config) ? { model, config } : null
}

/** 本地合成：piper 出 wav，ffmpeg 抬音高再转 mp3。 */
function withPiper(model, config) {
  const wav = join(WORKSPACE, 'voice', `.goodnight-${stamp}.wav`)
  const shifted = join(WORKSPACE, 'voice', `.goodnight-${stamp}-high.wav`)
  const rate = Number(profile.model?.sampleRate ?? 22050)
  const factor = Number(profile.pitch?.factor ?? 1)
  execFileSync(
    'python3',
    ['-m', 'piper', '-m', model, '-c', config, '-f', wav, '--length-scale', String(profile.model?.lengthScale ?? 0.95)],
    { env: pyEnv, input: `${text}\n`, stdio: ['pipe', 'ignore', 'inherit'] },
  )
  execFileSync(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', wav,
    '-filter:a', `asetrate=${rate}*${factor},aresample=44100,atempo=1/${factor}`,
    shifted,
  ], { stdio: ['ignore', 'ignore', 'inherit'] })
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', shifted, '-codec:a', 'libmp3lame', '-q:a', '5', mp3], { stdio: ['ignore', 'ignore', 'inherit'] })
  return 'piper'
}

/** 在线备份：edge-tts，音色轻一点。 */
function withEdge() {
  if (!existsSync(EDGE)) throw new Error(`找不到 edge-tts：${EDGE}`)
  const fallback = profile.fallback ?? {}
  execFileSync(EDGE, [
    '--voice', fallback.voice ?? 'zh-CN-XiaoyiNeural',
    '--rate', fallback.rate ?? '+8%',
    '--pitch', fallback.pitch ?? '+18Hz',
    '--text', text,
    '--write-media', mp3,
  ], { env: pyEnv, stdio: ['ignore', 'ignore', 'inherit'] })
  return 'edge-tts'
}

const chosen = engineFlag ?? profile.engine ?? 'piper'
if (dry) {
  const model = piperPath()
  console.log(`[dry] engine=${chosen} model=${model?.model ?? '(缺失，会退回 edge-tts)'} out=${mp3}`)
  process.exit(0)
}

let used = null
if (chosen === 'piper') {
  const model = piperPath()
  if (model) {
    try {
      used = withPiper(model.model, model.config)
    } catch (error) {
      console.error(`[goodnight] piper 失败，改用 edge-tts：${error?.message ?? error}`)
    }
  }
}
if (!used) used = withEdge()

console.log(mp3)
console.error(`[goodnight] engine=${used}`)
