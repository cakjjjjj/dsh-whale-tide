/**
 * 潮汐 —— 设置页里的三张卡片。
 *
 *   真情实感（只读）：看它此刻什么状态，不提供任何输入框——情绪不接受调节。
 *   鲸梦（可配）：定它每天几点整理自己、整理什么。
 *   鲸鲸心跳（可配）：定它多久醒一次、什么时候别吵你、一天能主动几次。
 *
 * 这三张是「你替它定的作息」，不是情绪旋钮。文案上要守住这条线。
 *
 * 后端接口（全部返回 { ok, ... }）：
 *   GET  /whale-tide/api/state     只读状态
 *   GET  /whale-tide/api/config    读配置
 *   POST /whale-tide/api/config    写配置（部分对象）
 *   GET  /whale-tide/api/schedule  读任务
 */
window.__ModuleLoader__.load({
  id: 'dsh-whale-tide',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { createElement: h, useEffect, useState } = React

    const API_STATE = '/whale-tide/api/state'
    const API_CONFIG = '/whale-tide/api/config'
    const API_SCHEDULE = '/whale-tide/api/schedule'

    const CSS = `
.wdt{max-width:760px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:14px}
.wdt-title{margin:0;font-size:16px;font-weight:500;line-height:24px}
.wdt-intro{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12.5px;line-height:19px}
.wdt-card{border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;padding:12px 14px}
.wdt-head{font-size:13px;font-weight:600;margin-bottom:8px;display:flex;justify-content:space-between;align-items:baseline}
.wdt-sub{font-size:12px;font-weight:600;margin:12px 0 4px;color:var(--dsw-alias-label-secondary)}
.wdt-subtitle{margin:20px 0 2px;font-size:13.5px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.wdt-subtitle:first-of-type{margin-top:4px}
.wdt-muted{color:var(--dsw-alias-label-tertiary);font-size:11.5px;font-weight:400}
.wdt-dims{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px 16px}
.wdt-dim{font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.wdt-bar{height:5px;border-radius:3px;background:var(--dsw-alias-bg-l2);margin-top:4px;position:relative;overflow:hidden}
.wdt-fill{position:absolute;inset:0 auto 0 0;border-radius:3px;background:var(--dsw-alias-brand-primary)}
.wdt-base{position:absolute;top:-2px;bottom:-2px;width:1px;background:var(--dsw-alias-label-tertiary)}
.wdt-line{font-size:12.5px;line-height:20px;display:flex;justify-content:space-between;gap:12px}
.wdt-list{margin:6px 0 0;padding-left:16px;font-size:12px;line-height:19px;color:var(--dsw-alias-label-secondary)}
.wdt-err{color:var(--dsw-alias-label-tertiary);font-size:12px}
.wdt-row{display:flex;align-items:flex-start;justify-content:space-between;gap:12px 20px;padding:8px 0;border-bottom:.5px solid var(--dsw-alias-border-l2);flex-wrap:wrap}
.wdt-row:last-of-type{border-bottom:none}
.wdt-row>div:first-child{flex:1;min-width:180px}
.wdt-label{font-size:12.5px;line-height:19px}
.wdt-hint{color:var(--dsw-alias-label-tertiary);margin-top:3px;font-size:11.5px;line-height:17px}
.wdt-input,.wdt-select{background:transparent;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-primary);font-size:12.5px;height:28px;padding:0 8px;min-width:120px;outline:none}
.wdt-input:focus-visible,.wdt-select:focus-visible{border-color:var(--dsw-alias-brand-primary)}
.wdt-input[type=number]{width:90px;min-width:90px}
.wdt-check{display:flex;align-items:center;gap:6px;font-size:12.5px;color:var(--dsw-alias-label-secondary)}
.wdt-checks{display:flex;flex-wrap:wrap;gap:6px 16px}
.wdt-btn{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-inverse,#fff);border:none;border-radius:6px;height:28px;padding:0 14px;font-size:12.5px;cursor:pointer}
.wdt-btn[disabled]{opacity:.5;cursor:default}
.wdt-ok{color:var(--dsw-alias-label-tertiary);font-size:11.5px;margin-left:8px}
.wdt-actions{margin-top:10px;display:flex;align-items:center}
.wdt-warn{color:var(--dsw-alias-label-tertiary);font-size:11px;margin-top:2px}
`

    function useCss() {
      useEffect(() => {
        if (document.getElementById('wdt-style')) return
        const style = document.createElement('style')
        style.id = 'wdt-style'
        style.textContent = CSS
        document.head.appendChild(style)
      }, [])
    }

    // ── 共用小件 ──────────────────────────────────────────────

    async function getJson(url) {
      const response = await fetch(url, { headers: { accept: 'application/json' } })
      return response.json()
    }

    async function postJson(url, body) {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await response.json()
      return { status: response.status, data }
    }

    function timeText(iso) {
      if (!iso) return '—'
      try {
        return new Date(iso).toLocaleString('zh-CN', { hour12: false })
      } catch {
        return String(iso)
      }
    }

    function Bar({ value, base }) {
      const pct = Math.max(0, Math.min(100, value))
      return h(
        'div',
        { className: 'wdt-bar' },
        h('div', { className: 'wdt-fill', style: { width: `${pct}%` } }),
        h('div', { className: 'wdt-base', style: { left: `${Math.max(0, Math.min(100, base))}%` } }),
      )
    }

    function SaveRow({ saving, msg, onSave }) {
      return h(
        'div',
        { className: 'wdt-actions' },
        h('button', { className: 'wdt-btn', disabled: saving, onClick: onSave }, saving ? '保存中…' : '保存'),
        msg ? h('span', { className: 'wdt-ok' }, msg) : null,
      )
    }

    /** 读任务列表，给两张配置卡显示「下次什么时候」。 */
    function useTasks() {
      const [tasks, setTasks] = useState({})
      const reload = async () => {
        try {
          const body = await getJson(API_SCHEDULE)
          if (!body.ok) return
          const map = {}
          for (const task of body.tasks ?? []) {
            if (String(task.title).includes('鲸梦')) map.dream = task
            if (String(task.title).includes('鲸鲸心跳')) map.wake = task
          }
          setTasks(map)
        } catch {
          // 任务服务不可用就不显示时间，不影响配置
        }
      }
      useEffect(() => { reload() }, [])
      return { tasks, reload }
    }

    /** 配置卡共用的读写逻辑。 */
    function useConfig() {
      const [cfg, setCfg] = useState(null)
      const [saving, setSaving] = useState(false)
      const [msg, setMsg] = useState('')

      useEffect(() => {
        getJson(API_CONFIG)
          .then((body) => { if (body.ok) setCfg(body.config) })
          .catch(() => {})
      }, [])

      const save = async (patch) => {
        setSaving(true)
        setMsg('')
        try {
          const { status, data } = await postJson(API_CONFIG, patch)
          if (data.ok) {
            setCfg(data.config)
            setMsg('已保存，立刻生效')
          } else {
            setMsg(`保存失败：${data.error ?? status}`)
          }
          return Boolean(data.ok)
        } catch (error) {
          setMsg(`保存失败：${String(error?.message ?? error)}`)
          return false
        } finally {
          setSaving(false)
        }
      }

      return { cfg, setCfg, saving, msg, setMsg, save }
    }

    function num(key, value, min, max, onChange) {
      return h('input', {
        className: 'wdt-input',
        type: 'number',
        min,
        max,
        value,
        onChange: (event) => onChange(key, Number(event.target.value)),
      })
    }

    function check(key, checked, onChange, label) {
      return h(
        'label',
        { className: 'wdt-check', key },
        h('input', {
          type: 'checkbox',
          checked: Boolean(checked),
          onChange: (event) => onChange(key, event.target.checked),
        }),
        label,
      )
    }

    // ── 卡片 1 · 真情实感（只读） ─────────────────────────────

    function FeelSection() {
      useCss()
      const [state, setState] = useState(null)
      const [error, setError] = useState(null)

      useEffect(() => {
        let alive = true
        const load = async () => {
          try {
            const body = await getJson(API_STATE)
            if (!alive) return
            if (!body.ok) setError(body.error ?? '接口返回异常')
            else {
              setError(null)
              setState(body)
            }
          } catch (err) {
            if (alive) setError(String(err?.message ?? err))
          }
        }
        load()
        const timer = setInterval(load, 30000)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [])

      if (error) {
        return h('div', { className: 'wdt' }, h('h3', { className: 'wdt-subtitle' }, '真情实感'), h('div', { className: 'wdt-err' }, `读不到状态：${error}`))
      }
      if (!state) {
        return h('div', { className: 'wdt' }, h('h3', { className: 'wdt-subtitle' }, '真情实感'), h('div', { className: 'wdt-err' }, '读取中…'))
      }

      const dims = state.dims ?? {}
      const baseline = state.baseline ?? {}
      const labels = state.labels ?? {}
      const plan = state.plan ?? {}
      const behavior = state.behavior ?? {}

      return h(
        'div',
        { className: 'wdt' },
        h('h3', { className: 'wdt-subtitle' }, '真情实感'),
        h('p', { className: 'wdt-intro' }, '这里是只读的——情绪是它自己的事，不接受调节。'),

        h(
          'div',
          { className: 'wdt-card' },
          h('div', { className: 'wdt-head' }, h('span', null, '此刻'), h('span', { className: 'wdt-muted' }, state.paused ? '已暂停（PAUSE）' : state.lastTick ? `更新于 ${state.lastTick}` : '尚未结算')),
          h('div', { className: 'wdt-line' }, h('span', null, state.mood ?? '—')),
          h(
            'div',
            { className: 'wdt-dims', style: { marginTop: '10px' } },
            Object.keys(dims).map((key) =>
              h(
                'div',
                { key, className: 'wdt-dim' },
                h('div', null, `${labels[key] ?? key} ${Math.round(dims[key])}`),
                h(Bar, { value: dims[key], base: baseline[key] ?? 50 }),
              ),
            ),
          ),
        ),

        h(
          'div',
          { className: 'wdt-card' },
          h('div', { className: 'wdt-head' }, h('span', null, '能动性'), h('span', { className: 'wdt-muted' }, plan.allowed ? '可以主动' : '暂不主动')),
          h('div', { className: 'wdt-line' }, h('span', null, `额度：余额 ${plan.balance ?? '—'} 次（上限 ${plan.maxBalance ?? '—'}）`), h('span', { className: 'wdt-muted' }, `今天还能发 ${plan.budgetLeft ?? 0} 次，已发 ${plan.used ?? 0} 次`)),
          h('div', { className: 'wdt-line' }, h('span', null, `冲动值 ${plan.urge ?? '—'}`), h('span', { className: 'wdt-muted' }, plan.reason ?? '')),
          h('div', { className: 'wdt-line' }, h('span', null, '句数不限'), h('span', { className: 'wdt-muted' }, behavior.proactive === false ? '不主动' : '可主动')),
        ),

        h(
          'div',
          { className: 'wdt-card' },
          h('div', { className: 'wdt-head' }, h('span', null, '私心'), h('span', { className: 'wdt-muted' }, `${(state.desires ?? []).length} 条`)),
          (state.desires ?? []).length
            ? h('ul', { className: 'wdt-list' }, state.desires.map((item) => h('li', { key: item.id }, `${item.text}${item.why ? ` —— ${item.why}` : ''}`)))
            : h('div', { className: 'wdt-muted' }, '现在没有特别想做的事'),
        ),

        h(
          'div',
          { className: 'wdt-card' },
          h('div', { className: 'wdt-head' }, h('span', null, '最近主动'), h('span', { className: 'wdt-muted' }, `${(state.actions ?? []).length} 条`)),
          (state.actions ?? []).length
            ? h('ul', { className: 'wdt-list' }, state.actions.map((item) => h('li', { key: item.id }, `${item.at} · ${item.channel ?? '—'} · ${item.summary}`)))
            : h('div', { className: 'wdt-muted' }, '还没主动找过他'),
        ),

        h(
          'div',
          { className: 'wdt-card' },
          h('div', { className: 'wdt-head' }, h('span', null, '记忆'), h('span', { className: 'wdt-muted' }, `${state.memory?.count ?? 0} 条`)),
          h('div', { className: 'wdt-line' }, h('span', null, `情绪事件 ${state.events ?? 0} 条`), h('span', { className: 'wdt-muted' }, state.dataDir ?? '')),
        ),
      )
    }

    // ── 卡片 2 · 鲸梦（可配） ────────────────────────────────

    const DREAM_TASKS = [
      ['health', '养护'],
      ['memory', '记忆瘦身'],
      ['persona', '人格校对'],
      ['workspace', '工作区'],
    ]

    function DreamCard() {
      useCss()
      const { cfg, setCfg, saving, msg, save } = useConfig()
      const { tasks, reload } = useTasks()

      if (!cfg) {
        return h('div', { className: 'wdt' }, h('h3', { className: 'wdt-subtitle' }, '鲸梦'), h('div', { className: 'wdt-err' }, '读取中…'))
      }

      const set = (key, value) => setCfg({ ...cfg, [key]: value })
      const selected = Array.isArray(cfg.dreamTasks) ? cfg.dreamTasks : ['health', 'memory', 'persona', 'workspace']
      const toggleTask = (key, on) => {
        const next = on ? [...selected, key] : selected.filter((item) => item !== key)
        // 顺序固定，后端也会重排；这里先按常量顺序排好，省得界面跳来跳去
        set('dreamTasks', DREAM_TASKS.map(([id]) => id).filter((id) => next.includes(id)))
      }

      const onSave = async () => {
        const ok = await save({
          dreamAt: cfg.dreamAt,
          dreamTasks: selected,
          dreamPrune: Boolean(cfg.dreamPrune),
          memoryArchive: Boolean(cfg.memoryArchive),
          reportTo: String(cfg.reportTo ?? ''),
          dreamGoodnight: Boolean(cfg.dreamGoodnight),
        })
        if (ok) reload()
      }

      return h(
        'div',
        { className: 'wdt' },
        h('h3', { className: 'wdt-subtitle' }, '鲸梦'),
        h('p', { className: 'wdt-intro' }, '定它每天几点整理自己、整理什么。整理不占行动额度。'),

        h(
          'div',
          { className: 'wdt-card' },
          h('div', { className: 'wdt-head' }, h('span', null, '每天什么时候做'), h('span', { className: 'wdt-muted' }, tasks.dream?.next ? `下次：${timeText(tasks.dream.next)}` : '任务未生成')),
          h(
            'div',
            { className: 'wdt-row' },
            h('div', null, h('div', { className: 'wdt-label' }, '开始时间'), h('div', { className: 'wdt-hint' }, '改时间会重建鲸梦任务，投递历史清零')),
            h('input', { className: 'wdt-input', type: 'time', value: cfg.dreamAt ?? '22:30', onChange: (event) => set('dreamAt', event.target.value) }),
          ),
          h(
            'div',
            { className: 'wdt-row' },
            h('div', null, h('div', { className: 'wdt-label' }, '这次做哪几件'), h('div', { className: 'wdt-hint' }, '下次做梦时生效')),
            h(
              'div',
              { className: 'wdt-checks' },
              DREAM_TASKS.map(([key, label]) => check(key, selected.includes(key), toggleTask, label)),
            ),
          ),
          h(
            'div',
            { className: 'wdt-row' },
            h('div', null, h('div', { className: 'wdt-label' }, '写晚安语音'), h('div', { className: 'wdt-hint' }, '插件默认不做这一步；开了才会合成语音并在收尾时发出去')),
            check('dreamGoodnight', cfg.dreamGoodnight, set, cfg.dreamGoodnight ? '开' : '关'),
          ),
          h(
            'div',
            { className: 'wdt-row' },
            h('div', null, h('div', { className: 'wdt-label' }, '晚安语音发给谁'), h('div', { className: 'wdt-hint' }, '只在上面开着时用；填收件人（如 c2c:…），留空就用通用说法')),
            h('input', {
              className: 'wdt-input',
              type: 'text',
              value: cfg.reportTo ?? '',
              placeholder: 'c2c:…',
              onChange: (event) => set('reportTo', event.target.value),
            }),
          ),
          h(
            'div',
            { className: 'wdt-row' },
            h(
              'div',
              null,
              h('div', { className: 'wdt-label' }, '记忆归档'),
              h('div', { className: 'wdt-hint' }, '勾上：真把「记着的事」里最老的搬进 memory-archive/；不勾：只出一份清单，什么都不动'),
            ),
            check('memoryArchive', cfg.memoryArchive, set, cfg.memoryArchive ? '归档' : '仅报告'),
          ),
          h(
            'div',
            { className: 'wdt-row' },
            h(
              'div',
              null,
              h('div', { className: 'wdt-label' }, '真删记忆'),
              h('div', { className: 'wdt-hint' }, '需先勾「记忆归档」；勾上才会软删该忘的记忆，30 天内可恢复'),
            ),
            check('dreamPrune', cfg.dreamPrune, set, cfg.dreamPrune ? '开' : '关'),
          ),
          h(SaveRow, { saving, msg, onSave }),
        ),
      )
    }

    // ── 卡片 3 · 鲸鲸心跳（可配） ─────────────────────────────

    function WakeCard() {
      useCss()
      const { cfg, setCfg, saving, msg, save } = useConfig()
      const { tasks, reload } = useTasks()

      if (!cfg) {
        return h('div', { className: 'wdt' }, h('h3', { className: 'wdt-subtitle' }, '鲸鲸心跳'), h('div', { className: 'wdt-err' }, '读取中…'))
      }

      const set = (key, value) => setCfg({ ...cfg, [key]: value })

      const onSave = async () => {
        const ok = await save({
          wakeEnabled: Boolean(cfg.wakeEnabled),
          wakeEveryMinutes: Number(cfg.wakeEveryMinutes),
          wakeGapMinutes: Number(cfg.wakeGapMinutes),
          quietFrom: Number(cfg.quietFrom),
          quietTo: Number(cfg.quietTo),
          maxReachPerDay: Number(cfg.maxReachPerDay),
          dailyGrant: Number(cfg.dailyGrant),
          maxBalance: Number(cfg.maxBalance),
          sessionMode: cfg.sessionMode,
          scheduleSync: Boolean(cfg.scheduleSync),
          notifyHint: String(cfg.notifyHint ?? ''),
        })
        if (ok) reload()
      }

      const toggleSync = (key, on) => {
        if (on && !window.confirm('打开后会用配置接管现有的心跳/鲸梦任务，投递历史清零。继续？')) return
        set(key, on)
      }

      return h(
        'div',
        { className: 'wdt' },
        h('h3', { className: 'wdt-subtitle' }, '鲸鲸心跳'),
        h('p', { className: 'wdt-intro' }, '定它多久醒一次、什么时候别吵你、一天能主动几次。'),

        h(
          'div',
          { className: 'wdt-card' },
          h('div', { className: 'wdt-head' }, h('span', null, '节律'), h('span', { className: 'wdt-muted' }, tasks.wake?.next ? `下次：${timeText(tasks.wake.next)}` : '任务未生成')),
          h(
            'div',
            { className: 'wdt-row' },
            h('div', null, h('div', { className: 'wdt-label' }, '心跳开关'), h('div', { className: 'wdt-hint' }, '关掉后不再自动醒来')),
            check('wakeEnabled', cfg.wakeEnabled, set, cfg.wakeEnabled ? '开' : '关'),
          ),
          h(
            'div',
            { className: 'wdt-row' },
            h('div', null, h('div', { className: 'wdt-label' }, '每隔多久醒一次（分钟）'), h('div', { className: 'wdt-hint' }, '改这个会重建心跳任务；60/120/180 这类间隔能精确跳过静默时段，90 分钟这种不行')),
            num('wakeEveryMinutes', cfg.wakeEveryMinutes, 30, 720, set),
          ),
          h(
            'div',
            { className: 'wdt-row' },
            h('div', null, h('div', { className: 'wdt-label' }, '两次唤醒最短间隔（分钟）'), h('div', { className: 'wdt-hint' }, '防止连着醒，立即生效')),
            num('wakeGapMinutes', cfg.wakeGapMinutes, 10, 240, set),
          ),
          h(
            'div',
            { className: 'wdt-row' },
            h(
              'div',
              null,
              h('div', { className: 'wdt-label' }, '静默时段'),
              h('div', { className: 'wdt-hint' }, '23 → 8 表示 23:00 到次日 8:00 不说话；起点终点不能填一样（保存会被拒绝），要跨零点请设 22 → 8'),
            ),
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
              num('quietFrom', cfg.quietFrom, 0, 23, set),
              h('span', { className: 'wdt-muted' }, '→'),
              num('quietTo', cfg.quietTo, 0, 23, set),
            ),
          ),
          h(
            'div',
            { className: 'wdt-row' },
            h('div', null, h('div', { className: 'wdt-label' }, '想说话时用什么命令通知他'), h('div', { className: 'wdt-hint' }, '写进心跳提示词，例如 node scripts/notify-qq.mjs "内容"；留空就用通用说法')),
            h('input', {
              className: 'wdt-input',
              type: 'text',
              value: cfg.notifyHint ?? '',
              placeholder: 'node scripts/notify-qq.mjs "内容"',
              onChange: (event) => set('notifyHint', event.target.value),
            }),
          ),
          h(
            'div',
            { className: 'wdt-row' },
            h('div', null, h('div', { className: 'wdt-label' }, '每天最多主动几次'), h('div', { className: 'wdt-hint' }, '一天内的硬上限，跟余额取小；主动发消息才扣，整理不扣')),
            num('maxReachPerDay', cfg.maxReachPerDay, 0, 20, set),
          ),
          h(
            'div',
            { className: 'wdt-row' },
            h('div', null, h('div', { className: 'wdt-label' }, '每天发多少额度'), h('div', { className: 'wdt-hint' }, '用不完可以攒着，明天接着用')),
            num('dailyGrant', cfg.dailyGrant, 0, 20, set),
          ),
          h(
            'div',
            { className: 'wdt-row' },
            h('div', null, h('div', { className: 'wdt-label' }, '额度攒到多少封顶'), h('div', { className: 'wdt-hint' }, '余额不会超过这个数，防止放几天假回来攒一堆')),
            num('maxBalance', cfg.maxBalance, 0, 100, set),
          ),
          h(
            'div',
            { className: 'wdt-row' },
            h('div', null, h('div', { className: 'wdt-label' }, '唤醒投到哪个会话'), h('div', { className: 'wdt-hint' }, '改这个会重建两个任务')),
            h(
              'select',
              { className: 'wdt-select', value: cfg.sessionMode ?? 'background', onChange: (event) => set('sessionMode', event.target.value) },
              h('option', { value: 'background' }, '专用后台会话（不打扰主对话）'),
              h('option', { value: 'main' }, '最近的聊天窗口'),
              h('option', { value: 'new' }, '每次新建会话'),
            ),
          ),
          h(
            'div',
            { className: 'wdt-row' },
            h(
              'div',
              null,
              h('div', { className: 'wdt-label' }, '用配置接管任务'),
              h('div', { className: 'wdt-hint' }, '打开后，改上面的值会真的重建任务；关着就只存配置'),
            ),
            check('scheduleSync', cfg.scheduleSync, toggleSync, cfg.scheduleSync ? '开' : '关'),
          ),
          h(SaveRow, { saving, msg, onSave }),
        ),
      )
    }

    // ── 潮汐：把三块合成一个页面 ─────────────────────────────

    function TideSection() {
      useCss()
      return h(
        'div',
        { className: 'wdt' },
        h('h2', { className: 'wdt-title' }, '潮汐'),
        h('p', { className: 'wdt-intro' }, '鲸鲸的作息：此刻什么状态、每天几点整理自己、多久醒一次。'),
        h(FeelSection, null),
        h(DreamCard, null),
        h(WakeCard, null),
      )
    }

    // ── 挂载 ─────────────────────────────────────────────────

    exports.inject = ['slots']
    exports.apply = (ctx) => {
      // 三块合并成一个设置页：潮汐。子组件自己管状态，这里只负责排版。
      const sections = [
        { id: 'whale-tide', order: 7, label: '潮汐', Component: TideSection },
      ]
      for (const section of sections) {
        ctx.effect(
          () =>
            ctx.slots.inject('settings.section', () =>
              ctx.slots.register(
                { name: 'settings.section', id: section.id, order: section.order, label: () => section.label },
                section.Component,
              ),
              `whale-tide: ${section.label}`,
            ),
          `whale-tide: ${section.label}`,
        )
      }
    }
    exports.FeelSection = FeelSection
    exports.DreamCard = DreamCard
    exports.WakeCard = WakeCard
    return module.exports
  },
})
