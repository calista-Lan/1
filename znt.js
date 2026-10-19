/* ==========================================================
 * znt.js —— 时空终端 v1.0 交互逻辑
 * 模块划分：
 *   1) 背景星空渲染
 *   2) 智能体配置（AGENTS）
 *   3) 视图切换
 *   4) 智能体卡片渲染与切换
 *   5) 消息渲染 / 发送 / 模拟回复
 *   6) 真实 API 接入预留位（见 fetchReply 内 TODO）
 * ========================================================== */

'use strict';

/* ==========================================================
 * 1) 背景：轻量星空 + 偶发流星
 * ========================================================== */
const Starfield = (() => {
  const canvas = document.getElementById('starfield');
  const ctx = canvas.getContext('2d');
  let stars = [];
  let shooting = null;
  let dpr = window.devicePixelRatio || 1;

  function resize() {
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    build();
  }

  function build() {
    const count = Math.min(160, Math.floor((window.innerWidth * window.innerHeight) / 9000));
    stars = Array.from({ length: count }, () => ({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      r: (Math.random() * 1.4 + 0.3) * dpr,
      a: Math.random() * 0.6 + 0.25,
      v: (Math.random() * 0.15 + 0.02) * (Math.random() > 0.5 ? 1 : -1) // 闪烁速度
    }));
  }

  function drawShootingStar() {
    if (!shooting) {
      // 随机生成一颗流星
      if (Math.random() > 0.996) {
        shooting = {
          x: Math.random() * canvas.width * 0.7,
          y: Math.random() * canvas.height * 0.4,
          len: 120 * dpr,
          life: 1
        };
      }
      return;
    }
    const g = ctx.createLinearGradient(shooting.x, shooting.y,
      shooting.x + shooting.len, shooting.y + shooting.len * 0.55);
    g.addColorStop(0, `rgba(34,211,238,${0.55 * shooting.life})`);
    g.addColorStop(1, 'rgba(168,85,247,0)');
    ctx.strokeStyle = g;
    ctx.lineWidth = 1.6 * dpr;
    ctx.beginPath();
    ctx.moveTo(shooting.x, shooting.y);
    ctx.lineTo(shooting.x + shooting.len, shooting.y + shooting.len * 0.55);
    ctx.stroke();

    shooting.x += 6 * dpr;
    shooting.y += 3.3 * dpr;
    shooting.life -= 0.018;
    if (shooting.life <= 0) shooting = null;
  }

  function loop() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    for (const s of stars) {
      s.a += 0.012 * s.v;
      if (s.a > 1 || s.a < 0.15) s.v *= -1;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(190,215,255,${Math.abs(s.a)})`;
      ctx.fill();
    }

    drawShootingStar();
    requestAnimationFrame(loop);
  }

  window.addEventListener('resize', resize);
  resize();
  loop();

  // 尊重「减少动态效果」的系统偏好
  return { stop: () => { stars = []; shooting = null; } };
})();


/* ==========================================================
 * 2) 扣子（Coze）智能体接入配置
 *    —— 只需填 3 个值：令牌 + 两个智能体的 bot_id，页面即真实对话
 *    —— 任意一项为空时自动回退到本地模拟，不影响页面运行
 *
 *    令牌获取：扣子控制台 → 扣子 API → 授权 → 个人访问令牌
 *             需勾选 chat 权限（生成后只显示一次，注意保存）
 *    bot_id 获取：打开智能体编辑页，地址栏 .../bot/73428668xxxx 里的那串数字
 *
 *    ⚠️ 安全提醒：令牌写在前端代码里，任何打开此页面的人按 F12 都能看到。
 *       自己做demo/课程作业没问题；对外发布务必改成后端代理转发。
 * ========================================================== */
const COZE_CONFIG = {
  enabled: true,          // 改成 false 可强制使用本地模拟
  token: 'pat_TFZ7YmYKrtFrRzBxbvhg4ULMkKc7hWjmQOjO1muK6pdjeO4KrKs0GljyibavZYld',   // 形如 'pat_xxxxxxxxxxxxxxxx'
  apiBase: 'https://api.coze.cn',

  // 智能体 ID 映射：键名对应下面 AGENTS 里的 id
  bots: {
    wastelander: '7698292915872727049',      // 废土生存专家
    sheriff: '7698296361578053695'           // 时空警长
  },

  // 会话用户标识：同一浏览器保持一致，扣子据此隔离记忆
  userId: (() => {
    try {
      let uid = localStorage.getItem('mvs_uid');
      if (!uid) {
        uid = 'mvs-' + Math.random().toString(36).slice(2, 10);
        localStorage.setItem('mvs_uid', uid);
      }
      return uid;
    } catch {
      return 'mvs-anonymous';   // 隐私模式下 localStorage 可能不可用
    }
  })(),

  /* ------------------------------------------------------------
   * 回复降噪开关（纯前端文本处理，不改变智能体的实际回答逻辑）
   * true  → 自动剥除"（指节敲了敲铁皮）""【啐了一口】"这类舞台提示
   * false → 原样显示智能体输出的全部文字
   * 注意：这只治"表演性旁白"。如果嫌它话痨、算账啰嗦、语气浮夸，
   *      根因在扣子智能体的提示词里，前端改不了，见 README 说明。
   * ------------------------------------------------------------ */
  stripStageDirections: true
};

/**
 * 扣子 API 客户端
 * 使用 /v3/chat 的流式（SSE）模式：回复边生成边显示，体验接近真实终端
 * 文档：https://www.coze.cn/open/docs/developer_guides/chat_v3
 */
const Coze = {
  // agentId -> conversation_id，用于同一智能体的多轮上下文
  conversationIds: {},

  /**
   * 解析某个智能体的接入参数
   * 优先级：智能体自带的 botId / token（用户自定义的） > COZE_CONFIG 里的内置映射
   */
  resolve(agentId) {
    const agent = (typeof AGENTS !== 'undefined' ? AGENTS : []).find(a => a.id === agentId);
    const cfg = (agent && agent.config) || {};
    return {
      botId: (agent && agent.botId) || cfg.botId || COZE_CONFIG.bots[agentId] || '',
      token: (agent && agent.token) || cfg.token || COZE_CONFIG.token || '',
      // 允许自建网关/代理覆盖官方地址
      apiBase: cfg.apiBase || COZE_CONFIG.apiBase
    };
  },

  /** 该智能体是否已经配置好可以走真实接口 */
  isReady(agentId) {
    const { botId, token } = this.resolve(agentId);
    return COZE_CONFIG.enabled && /^pat_/.test(token) && !!botId;
  },

  /** 切换智能体 / 重置会话时，丢弃服务端会话，保证开场白是全新的 */
  resetConversation(agentId) {
    delete this.conversationIds[agentId];
  },

  /** 与其他适配器保持同名接口 */
  reset(agentId) {
    this.resetConversation(agentId);
  },

  /**
   * 发起一次对话
   * @param {string} agentId
   * @param {string} userText
   * @param {{onDelta?: (full:string)=>void, signal?: AbortSignal}} opts
   * @returns {Promise<string>} 完整回复文本
   */
  async chat(agentId, userText, { onDelta, signal } = {}) {
    const { botId, token, apiBase } = this.resolve(agentId);
    if (!botId) throw new Error('该智能体没有配置 bot_id');
    const convId = this.conversationIds[agentId];
    const url = apiBase + '/v3/chat' + (convId ? `?conversation_id=${encodeURIComponent(convId)}` : '');

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        bot_id: botId,
        user_id: COZE_CONFIG.userId,
        stream: true,                 // 流式返回
        auto_save_history: true,      // 由扣子侧保存上下文
        additional_messages: [
          { role: 'user', content: userText, content_type: 'text' }
        ]
      }),
      signal
    });

    // 失败时尽量把扣子返回的 msg 透出来，方便排查令牌/发布状态问题
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const err = await res.json();
        if (err && (err.msg || err.error_message)) detail += ` · ${err.msg || err.error_message}`;
      } catch { /* 响应体不是 JSON 就忽略 */ }
      throw new Error(detail);
    }

    // ⚠️ 扣子的错误经常是「HTTP 200 + JSON 错误体」（如令牌无效返回 code 4101），
    //    所以不能用状态码判断，必须看 content-type 是否为事件流
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('text/event-stream')) {
      let msg = '接口未返回事件流';
      try {
        const body = await res.json();
        if (body?.msg) msg = `[${body.code ?? '-'}] ${body.msg}`;
        else if (body?.error_message) msg = body.error_message;
      } catch { /* 非 JSON 就保留默认提示 */ }
      throw new Error(msg);
    }

    if (!res.body) throw new Error('当前浏览器不支持流式读取');

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let answer = '';
    let reasoning = '';
    let failure = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE 以空行分隔事件；一次 read 可能带来多个事件，需循环切分
      let cut;
      while ((cut = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        const { event, data } = this.parseEvent(raw);

        // 记录会话 ID，后续多轮对话带上它
        if (event === 'conversation.chat.created' && data?.conversation_id) {
          this.conversationIds[agentId] = data.conversation_id;
        }

        if (event === 'conversation.message.delta' && data?.type === 'answer') {
          // 普通智能体：content 是正文增量（打字机效果）
          if (data.content) {
            answer += data.content;
            onDelta && onDelta(this.toneDown(answer), '');
          }
          // 开启「深度思考」的智能体：正文迟迟不给，先把推理过程吐在 reasoning_content 里
          else if (data.reasoning_content) {
            reasoning += data.reasoning_content;
            onDelta && onDelta('', reasoning);
          }
        }

        // 深度思考型智能体往往只在 completed 里给完整正文
        if (event === 'conversation.message.completed' && data?.type === 'answer' && data?.content) {
          if (data.content.length > answer.length) {
            answer = data.content;
            onDelta && onDelta(this.toneDown(answer), '');
          }
        }

        // 错误事件：流里报错不会让 HTTP 状态码变成 4xx
        if (event === 'conversation.chat.failed' || event === 'error') {
          failure = data?.last_error?.msg || data?.msg || '对话执行失败';
        }
      }
    }

    if (failure) throw new Error(failure);
    if (!answer.trim()) throw new Error('智能体没有返回任何内容');
    return this.toneDown(answer);
  },

  /**
   * 收敛回复里的“戏”：剥除独占行首 / 整行的舞台提示
   * 例：（指节敲了敲铁皮）、【啐了一口】、（沉默两秒）
   * 只处理行首，避免误删正文中间的短括号（如“（3 钉）”这类报价）
   */
  toneDown(text) {
    if (!COZE_CONFIG.stripStageDirections || !text) return text;
    const isStage = inner => !/\d/.test(inner);        // 含数字的括号多半是数据，保留

    return text
      .split('\n')
      .filter(line => {
        const m = line.trim().match(/^[（(【\[]([\s\S]{1,80})[）)】\]]$/);
        return !(m && isStage(m[1]));                   // 整行只有一段舞台提示 → 丢弃该行
      })
      .map(line => line.replace(
        /^[ \t]*[（(【\[]([\s\S]{1,80}?)[）)】\]][ \t]*/,
        (whole, inner) => (isStage(inner) ? '' : whole)
      ))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  },

  /** 只验通路：发一条极短消息，收到事件流首个事件就断开（不写入会话历史） */
  async testConnection(botId, token, apiBase = COZE_CONFIG.apiBase) {
    const res = await fetch(apiBase + '/v3/chat', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bot_id: botId,
        user_id: COZE_CONFIG.userId,
        stream: true,
        auto_save_history: false,
        additional_messages: [{ role: 'user', content: 'ping', content_type: 'text' }]
      })
    });

    const ct = res.headers.get('content-type') || '';
    if (ct.includes('text/event-stream')) {
      try {
        const reader = res.body.getReader();
        await reader.read();      // 等到第一个事件即视为链路通畅
        reader.cancel();
      } catch { /* 主动断开导致的异常忽略 */ }
      return true;
    }
    throw await httpError(res);
  },

  /** 解析单个 SSE 事件块 */
  parseEvent(raw) {
    let event = 'message';
    const dataLines = [];
    for (const line of raw.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    const dataStr = dataLines.join('\n');
    if (!dataStr || dataStr === '[DONE]') return { event, data: null };
    try {
      return { event, data: JSON.parse(dataStr) };
    } catch {
      return { event, data: null };
    }
  }
};


/* ==========================================================
 * 2.5) 通用工具：SSE 读取 / 错误解析
 * ========================================================== */
const findAgent = id => AGENTS.find(a => a.id === id) || null;
const trimSlash = u => String(u || '').replace(/\/+$/, '');

/** 把 text/event-stream 逐块切成事件块交给 onChunk */
async function readSSE(res, onChunk) {
  if (!res.body) throw new Error('当前浏览器不支持流式读取');
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut;
    while ((cut = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      onChunk(raw);
    }
  }
}

/** 统一错误解析：不少平台报错也返回 HTTP 200 + JSON */
async function httpError(res) {
  let detail = `HTTP ${res.status}`;
  try {
    const b = await res.json();
    const msg = b?.msg || b?.message || b?.error?.message || b?.error;
    if (msg) detail = `[${b.code ?? res.status}] ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`;
  } catch { /* 非 JSON 保留默认 */ }
  return new Error(detail);
}

/** 从事件块里取出 data: 后面的 JSON */
function sseData(raw) {
  const line = raw.split('\n').find(l => l.startsWith('data:'));
  if (!line) return null;
  const s = line.slice(5).trim();
  if (!s || s === '[DONE]') return null;
  try { return JSON.parse(s); } catch { return null; }
}


/* ==========================================================
 * 2.6) 平台适配器：一个平台一个对象，新增平台只要再写一个
 *      约定：isReady(agentId) / chat(agentId, text, {onDelta}) / reset(agentId)
 * ========================================================== */

/* ---------- Dify ---------- */
const Dify = {
  convIds: {},

  isReady(agentId) {
    const a = findAgent(agentId); const c = (a && a.config) || {};
    return COZE_CONFIG.enabled && !!c.baseUrl && !!c.appKey;
  },

  reset(agentId) { delete this.convIds[agentId]; },

  headers(c) {
    return { 'Authorization': `Bearer ${c.appKey}`, 'Content-Type': 'application/json' };
  },

  async chat(agentId, text, { onDelta } = {}) {
    const c = (findAgent(agentId) || {}).config || {};
    const res = await fetch(trimSlash(c.baseUrl) + '/chat-messages', {
      method: 'POST',
      headers: this.headers(c),
      body: JSON.stringify({
        inputs: {},
        query: text,
        response_mode: 'streaming',
        conversation_id: this.convIds[agentId] || '',
        user: COZE_CONFIG.userId,
        auto_generate_name: false
      })
    });

    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('text/event-stream')) throw await httpError(res);

    let answer = '';
    let failure = null;
    await readSSE(res, raw => {
      const d = sseData(raw);
      if (!d) return;
      if (d.conversation_id) this.convIds[agentId] = d.conversation_id;
      if ((d.event === 'message' || d.event === 'agent_message') && d.answer) {
        answer += d.answer;
        onDelta && onDelta(Coze.toneDown(answer), '');
      }
      if (d.event === 'error') failure = d.message || 'Dify 返回错误';
    });

    if (failure) throw new Error(failure);
    if (!answer.trim()) throw new Error('智能体没有返回任何内容');
    return Coze.toneDown(answer);
  },

  /** 用阻塞模式发一句极短的话，只验通路（不写入会话） */
  async testConfig(c) {
    const res = await fetch(trimSlash(c.baseUrl) + '/chat-messages', {
      method: 'POST',
      headers: this.headers(c),
      body: JSON.stringify({
        inputs: {}, query: 'ping', response_mode: 'blocking',
        conversation_id: '', user: COZE_CONFIG.userId, auto_generate_name: false
      })
    });
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.answer !== undefined) return true;
      throw new Error(body.message || body.code || `HTTP ${res.status}`);
    }
    if (!res.ok) throw await httpError(res);
    return true;
  }
};

/* ---------- OpenAI 兼容（DeepSeek / 通义 / Kimi / Ollama / vLLM / LM Studio…） ---------- */
const OpenAICompat = {
  threads: {},          // agentId -> [{role, content}]
  MAX_TURNS: 24,        // 保留最近若干条消息，避免上下文无限增长

  isReady(agentId) {
    const a = findAgent(agentId); const c = (a && a.config) || {};
    return COZE_CONFIG.enabled && !!c.baseUrl && !!c.apiKey && !!c.model;
  },

  reset(agentId) { delete this.threads[agentId]; },

  async chat(agentId, text, { onDelta } = {}) {
    const c = (findAgent(agentId) || {}).config || {};
    const msgs = this.threads[agentId] || (this.threads[agentId] = []);

    const payload = [];
    if (c.systemPrompt) payload.push({ role: 'system', content: c.systemPrompt });
    payload.push(...msgs, { role: 'user', content: text });

    const body = { model: c.model, messages: payload, stream: true };
    // 温度是可选参数：留空就用服务端默认值
    if (c.temperature !== undefined && c.temperature !== '') {
      const t = Number(c.temperature);
      if (Number.isFinite(t)) body.temperature = Math.min(2, Math.max(0, t));
    }

    const res = await fetch(trimSlash(c.baseUrl) + '/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${c.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('text/event-stream')) throw await httpError(res);

    let answer = '';
    let failure = null;
    await readSSE(res, raw => {
      const d = sseData(raw);
      if (!d) return;
      if (d.error) { failure = d.error.message || JSON.stringify(d.error); return; }
      const choice = d.choices && d.choices[0];
      const piece = choice?.delta?.content;
      if (piece) {
        answer += piece;
        onDelta && onDelta(Coze.toneDown(answer), '');
      }
    });

    if (failure) throw new Error(failure);
    if (!answer.trim()) throw new Error('模型没有返回任何内容');

    // 服务端无状态，历史由前端维护
    msgs.push({ role: 'user', content: text }, { role: 'assistant', content: answer });
    if (msgs.length > this.MAX_TURNS) msgs.splice(0, msgs.length - this.MAX_TURNS);

    return Coze.toneDown(answer);
  },

  async testConfig(c) {
    const res = await fetch(trimSlash(c.baseUrl) + '/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${c.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: c.model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        stream: false
      })
    });
    if (res.ok) return true;
    throw await httpError(res);
  }
};


/* ==========================================================
 * 2.7) 统一门面：按 agent.provider 分发，UI 层只认 LLM
 * ========================================================== */
const LLM = {
  adapters: { coze: Coze, dify: Dify, openai: OpenAICompat },

  /** 平台的显示名，用于状态文案 */
  LABELS: { coze: '扣子', dify: 'Dify', openai: 'OpenAI 兼容' },

  providerOf(agentId) {
    const a = findAgent(agentId);
    return (a && a.provider) || 'coze';       // 内置两个默认走扣子
  },

  adapterFor(agentId) {
    return this.adapters[this.providerOf(agentId)] || Coze;
  },

  /* Dify / OpenAI 适配器需要单独实现 test，扣子沿用 Coze.testConnection */
  label(agentId) { return this.LABELS[this.providerOf(agentId)] || '外部 API'; },

  isReady(agentId) { return this.adapterFor(agentId).isReady(agentId); },

  chat(agentId, text, opts) { return this.adapterFor(agentId).chat(agentId, text, opts); },

  reset(agentId) {
    Object.values(this.adapters).forEach(p => p.reset && p.reset(agentId));
  }
};

/* ==========================================================
 * 3) 智能体配置
 *    —— 内置两个向导；用户接入的会自动追加到同一数组
 * ========================================================== */
const AGENTS = [
  {
    id: 'wastelander',
    name: '废土生存专家',
    tag: 'WASTELAND SURVIVAL',
    desc: '擅长极端环境求生',
    icon: 'fa-skull-crossbones',
    color: '#a3e635',
    // 专属开场白
    greeting: '滴——生命体征正常。幸存者，在这片废土上，你最大的依仗就是我。今天想了解如何在辐射区找水，还是对付变异的变异鼠？',
    // 快捷提问
    chips: ['辐射区怎么找干净的水？', '遇到变异鼠怎么办？', '夜里该在哪里过夜？', '哪些东西绝对不能吃？'],
    // 关键词 -> 定向回复（命中优先于随机池）
    keywordReplies: [
      { keys: ['水', '喝', '渴', '净水'], reply: '找水的第一条规矩：流动的水比静止的干净，地下的比地面的干净。用衣服包住沙子过滤三次，再煮沸三分钟。实在没有火，就把水装在浅盘里晒六个小时——紫外线是免费的消毒剂。' },
      { keys: ['鼠', '老鼠', '变异鼠', '怪物'], reply: '变异鼠重四十公斤，但髋关节是弱点，它会直线冲刺，不会急转弯。背靠墙，让它先冲，横向闪开，一棍子砸在它的后腿根。别用枪——声音会招来比它更大的东西。' },
      { keys: ['吃', '食物', '饿', '罐头'], reply: '三条铁律：不认识的菌类一律不吃；粉色肉类一律不吃；过期五年以上的罐头闻着没味也一律不吃（肉毒杆菌是没有味道的）。宁可饿两天，也别赌一口。' },
      { keys: ['辐射', '防化', '盖革'], reply: '辐射看不见闻不着，但它怕三样东西：距离、屏蔽和时间。退到十米外，躲在混凝土后，等二十四个小时，地表剂量会衰减大半。脱外套时往内卷，别抖。' }
    ],
    // 随机回复池（硬核与搞笑混搭）
    replies: [
      '我在这片废土上活了二十七年。你知道我是怎么做到的吗？我从不跟比自己更绝望的东西讲道理。',
      '你的靴子在渗水。赶紧脱下来检查一下——脚一旦泡烂，你连走到下一个避难所的机会都没有。',
      '忘掉净水片吧，那玩意儿早过期了。把水煮沸，然后对着它骂两句。这不杀菌，但能让你心态好一点。',
      '实测数据：在辐射尘暴里，蒙住口鼻能让你多活四十七分钟。够你找到一个还算完整的冰箱——可以当避难舱。',
      ' Variant-7 型变异鼠会装死。要确认它死了，先用长杆戳三下，间隔十分钟。它会以为你走了。',
      '别相信任何带 Logo 的食品。上次我按包装上的保质期吃了一块能量棒，结果在沙子里躺了三天，做了很多奇怪的梦。',
      '如果夜里听到有人喊你的名字——不要回答。废土上会模仿人声的东西，一共有十九种，它们全都很饿。',
      '记住方位：太阳落下那边通常有水源，但它也可能是个巨大的坑。这两件事在废土上都不算新鲜。',
      '给你个硬数据：人在没有水的条件下平均活三天，但恐慌能把这个数字压到六小时。所以首先——冷静，然后找水。',
      '我背包里永远有三样东西：一小段铁丝、一块打火石、还有一张家人照片。前两样救命，第三样让你知道为什么值得活。'
    ]
  },
  {
    id: 'sheriff',
    name: '时空警长',
    tag: 'TIME PATROL UNIT',
    desc: '擅长时间悖论解答',
    icon: 'fa-shield-halved',
    color: '#22d3ee',
    greeting: '警告！检测到时间线扰动！我是时空警长。别试图用祖父悖论骗我，告诉我，你是从哪条时间线掉进来的？',
    chips: ['我遇到了祖父悖论', '如何回到自己的时间线？', '我见到了另一个我', '时间线编号说明'],
    keywordReplies: [
      { keys: ['祖父', '悖论', '爷爷'], reply: '祖父悖论在实务上并不成立。你回到过去杀掉祖父的那一刻，你的出生概率归零，而「归零」意味着执行「杀」这个动作的主体也不存在——逻辑自动回滚。所以你最多造成一次擦伤，或者成就一段你祖母不太想提起的往事。' },
      { keys: ['回去', '回到', '回家', '返回'], reply: '要回原时间线，我需要你的出发时间戳和因果锚点。先把你口袋里的东西掏出来——任何来自你原本时代的物件都可以充当锚点，包括那张过期的公交卡。' },
      { keys: ['怎么办', '怎么搞', '求助'], reply: '标准处置流程三步走：第一，不要与任何版本的自己发生肢体接触；第二，不要改变任何你记得的历史事件；第三，不要告诉过去的任何人今天的日期。做到这三点，你的时间线保住八成。' }
    ],
    replies: [
      '根据《跨时间线管制条例》第七条：禁止向过去的自己透露彩票号码、股票点位和球赛比分。违者处以时间线内终身回溯。',
      '你刚才那句话，在三条不同的时间线里同时构成了因果闭环。恭喜，你现在既是自己的父亲，也是自己的祖母。这事儿我见过十一次，没有一次是干净的。',
      '别紧张。比起上一批掉进来的那家伙——他为了证明自己能穿越，回去把自己的闹钟提前了五分钟——你目前的违规程度还只是「口头违纪」。',
      '提醒一下：你现在所处的时间线编号为 M-1024，属于稳定区。这意味着你的任何改动都会被自动修正，但修正过程会把你身体里的每个原子重排一遍。会有点晕。',
      '我处理过一个案子：某位幸存者为了救一只猫改变了整个城市的供电走向。现在那条时间线上所有人都在点蜡烛，而那只猫，成了网红。',
      '如果你看到天空同时出现两个月亮，请不要拍照，请立刻躺下。那说明至少有两条时间线正在你头顶合并，站着的话会比较吃亏。',
      '我这生涯里抓过最离谱的家伙，他复制了十七个自己开派对。我们花了三个世纪才把十七个人重新合并回去——中间有一次合并反了。',
      '想耍我？省省吧。我比对过你谈话时的时态一致性——你在第三人称和第一人称之间切换过四次，典型的跨线后遗症。先喝点水，我们慢慢来。',
      '时间不是河流，是一条被熨过无数次的领带。你现在站在其中一个折痕里，而我负责把你烫平——或者烫回原形。',
      '统计显示：在未经许可的时间跳跃中，有 73% 的人第一句话是问「现在是几几年」。你是少数先关心价格的，有意思。'
    ]
  }
];

/* 兜底回复：两侧通用 */
const FALLBACK_REPLIES = [
  '信号受到量子干扰，这句没听清。麻烦再讲一遍——用更短的句子，最好别带隐喻。',
  '数据库里没有这条记录。按照协议，我应当保持沉默；但按照直觉，我建议你先找个能遮住头顶的地方。',
  '这个问题跨越了十七个专业领域，我只能回答其中最要命的那部分：先活下来，然后再问我一次。'
];


/* ==========================================================
 * 4) 用户自定义智能体：本地存储
 *    —— 用户填 bot_id 后，会以和内置智能体完全相同的结构并入 AGENTS
 *    —— 存储位置是浏览器 localStorage，换电脑/清缓存后需重新添加
 * ========================================================== */
const CustomAgents = {
  KEY: 'mvs_custom_agents',

  /** 读取全部自定义智能体（数据损坏时安全降级为空数组） */
  list() {
    try {
      const raw = localStorage.getItem(this.KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr)
        ? arr.filter(a => a && a.id && (a.botId || a.config))   // 兼容早期只存 botId 的记录
        : [];
    } catch {
      return [];
    }
  },

  save(list) {
    try {
      localStorage.setItem(this.KEY, JSON.stringify(list));
      return true;
    } catch {
      return false;   // 隐私模式/配额满
    }
  },

  upsert(rec) {
    const list = this.list();
    const i = list.findIndex(a => a.id === rec.id);
    if (i >= 0) list[i] = rec; else list.push(rec);
    return this.save(list);
  },

  remove(id) {
    return this.save(this.list().filter(a => a.id !== id));
  },

  find(id) {
    return this.list().find(a => a.id === id) || null;
  },

  /** 把存储记录转成 AGENTS 需要的完整智能体结构 */
  toAgent(rec) {
    const provider = rec.provider || 'coze';
    // 兼容早期版本：botId/token 直接平铺在记录上
    const config = rec.config || { botId: rec.botId, token: rec.token };

    return {
      id: rec.id,
      name: rec.name,
      provider,
      config,
      tag: `CUSTOM · ${provider === 'coze' ? 'COZE' : provider === 'dify' ? 'DIFY' : 'OPENAI-API'}`,
      desc: rec.desc || '用户接入的外部智能体',
      icon: rec.icon || 'fa-satellite-dish',
      color: rec.color || '#22d3ee',
      botId: config.botId || '',
      token: config.token || '',
      custom: true,
      greeting: rec.greeting || `信道握手完成。我是「${rec.name}」，已接入这条时间线。直接说你的问题，别绕圈子。`,
      // 自定义智能体没有预设问题库，用一组通用引导
      chips: ['你能做什么？', '给我一个能立刻执行的建议', '这个领域最常见的错误是什么？', '用三句话总结'],
      keywordReplies: [],
      replies: ['信号收到了，但我这边的资料还没有覆盖这个话题。换个问法，或者问得更具体一点。']
    };
  }
};


/* ==========================================================
 * 3) 主应用
 * ========================================================== */
const App = {
  currentView: 'home',
  currentAgent: AGENTS[0],       // 默认选中【废土生存专家】
  history: {},                   // agentId -> 消息数组（切换智能体时保留各自的会话）
  typingEl: null,
  usedPool: {},                  // agentId -> 已用过的随机回复索引，避免连续重复

  /* ---------------- 视图切换 ---------------- */
  switchView(view, opts) {
    this.currentView = view;

    // 移动端进入终端页时锁定视口高度（见 znt.css 的 body.view-lock）
    document.body.classList.toggle('view-lock', view === 'terminal');

    // 同步 URL hash（形如 index.html#terminal），方便直接分享/刷新定位
    if (!opts || !opts.silent) {
      if (location.hash !== '#' + view) history.replaceState(null, '', '#' + view);
    }

    // 显示/隐藏各个视图
    ['home', 'terminal', 'guide', 'builder'].forEach(v => {
      const el = document.getElementById('view-' + v);
      if (!el) return;
      el.classList.toggle('hidden', v !== view);
      if (v !== view) return;
      // 重置入场动画：先移除类名、强制重排，再重新添加
      el.classList.remove('view-enter');
      void el.offsetWidth;
      el.classList.add('view-enter');
    });

    // 更新 Tab 高亮
    document.querySelectorAll('.tab-item').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.view === view);
    });

    // 进入终端时聚焦输入框，并把聊天区滚动到底部
    if (view === 'terminal') {
      this.renderQuickChips();
      this.scrollToBottom();
      // 仅桌面端自动聚焦：移动端自动弹软键盘会挡住半个屏幕
      if (window.matchMedia('(min-width: 1024px)').matches) {
        setTimeout(() => document.getElementById('chatInput')?.focus({ preventScroll: true }), 350);
      }
    }

    // 进入接入页时刷新"已接入"列表与右侧预览
    if (view === 'builder') {
      Builder.render();
      Builder.renderPreview();
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  },

  /* ---------------- 渲染智能体卡片（侧边栏） ---------------- */
  renderAgentCards() {
    const box = document.getElementById('agentList');

    // 侧栏顶部的在线数量随自定义智能体动态变化
    const countEl = document.getElementById('onlineCount');
    if (countEl) countEl.textContent = `${AGENTS.length} 名在线`;
    // 同一份数据渲染两种密度：窄屏是紧凑小卡，桌面是完整信息卡
    box.innerHTML = AGENTS.map(a => `
      <article class="agent-card rounded-xl p-3 lg:p-3.5 ${a.id === this.currentAgent.id ? 'active' : ''}"
               style="--card-color:${a.color}"
               data-agent="${a.id}"
               onclick="App.selectAgent('${a.id}')">
        <div class="flex items-center gap-2.5 lg:items-start lg:gap-3">
          <span class="w-8 h-8 lg:w-10 lg:h-10 shrink-0 rounded-lg grid place-items-center text-sm lg:text-lg"
                style="background:${a.color}1f; color:${a.color}; box-shadow:0 0 0 1px ${a.color}55 inset;">
            <i class="fa-solid ${a.icon}"></i>
          </span>
          <div class="min-w-0 flex-1">
            <h3 class="font-semibold text-white text-[12.5px] lg:text-sm truncate">${a.name}</h3>
            <p class="hidden lg:block text-[10px] tracking-wider mt-0.5" style="color:${a.color}">${a.tag}</p>
            <p class="hidden lg:block text-[11px] text-[#8ea0c9] mt-1 leading-snug">${a.desc}</p>
            <p class="lg:hidden mt-0.5 flex items-center gap-1 text-[10px] text-[#4ade80]">
              <span class="status-dot" style="width:6px;height:6px"></span>在线
            </p>
          </div>
        </div>
        <div class="hidden lg:flex mt-2.5 items-center justify-between text-[10px]">
          <span class="flex items-center gap-1 text-[#4ade80]"><span class="status-dot"></span>在线</span>
          <span class="text-[#5f6f99]" data-count-msg="${a.id}">${(this.history[a.id] || []).length} 条对话</span>
        </div>
      </article>
    `).join('');
  },

  /* ---------------- 选择智能体：清空对话 + 发送专属开场白 ---------------- */
  selectAgent(id) {
    const agent = AGENTS.find(a => a.id === id);
    if (!agent) return;

    this.currentAgent = agent;

    // 卡片选中态
    document.querySelectorAll('.agent-card').forEach(c => {
      c.classList.toggle('active', c.dataset.agent === id);
    });

    // 更新聊天头部信息（标注当前内核：外部 API / 本地模拟）
    const ava = document.getElementById('chatAvatar');
    ava.innerHTML = `<i class="fa-solid ${agent.icon}"></i>`;
    ava.style.setProperty('--agent-color', agent.color);
    ava.style.background = agent.color + '1f';
    ava.style.color = agent.color;
    document.getElementById('chatName').textContent = agent.name;
    const mode = LLM.isReady(agent.id) ? LLM.label(agent.id) : '本地模拟';
    const descEl = document.getElementById('chatDesc');
    descEl.textContent = `在线 · ${mode} · ${agent.desc}`;
    descEl.title = descEl.textContent;

    this.renderQuickChips();

    // 换人即视为新会话：丢弃服务端上下文，保证开场白是全新的
    LLM.reset(id);

    // 清空聊天区并重新播放该智能体的开场白
    document.getElementById('chatBody').innerHTML = '';
    this.history[id] = [];
    this.updateMsgCounters();
    // 稍作停顿再播放开场白，让"连接建立"的感觉更真实
    setTimeout(() => this.pushMessage('ai', agent.greeting), 220);
  },

  /* ---------------- 从接入页跳到对话 ---------------- */
  gotoAgent(id) {
    this.selectAgent(id);
    this.switchView('terminal');
  },

  /* ---------------- 快捷提问标签 ---------------- */
  renderQuickChips() {
    const box = document.getElementById('quickChips');
    box.innerHTML = this.currentAgent.chips.map(q =>
      `<button type="button" class="chip text-[11px] sm:text-xs px-3 py-1.5 rounded-full" onclick="App.useChip(this)">${this.escapeHtml(q)}</button>`
    ).join('');
  },

  useChip(btn) {
    const input = document.getElementById('chatInput');
    input.value = btn.textContent.trim();
    input.focus({ preventScroll: true });
    this.autoGrow(input);
  },

  /* ---------------- 发送主流程 ---------------- */
  sendMessage() {
    const input = document.getElementById('chatInput');
    const text = input.value.trim();
    if (!text) return;

    // 清空输入并复位高度
    input.value = '';
    this.autoGrow(input);

    this.pushMessage('user', text);
    this.respondTo(text);
  },

  handleEnter(e) {
    // Enter 发送，Shift + Enter 换行
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      this.sendMessage();
    }
  },

  autoGrow(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 128) + 'px';
  },

  /* ---------------- 生成 AI 回复 ---------------- */
  async respondTo(userText) {
    const agentId = this.currentAgent.id;

    // ① 未配置令牌 / bot_id：走本地模拟内核
    if (!LLM.isReady(agentId)) {
      this.showTyping();
      await new Promise(r => setTimeout(r, 1000));
      this.hideTyping();
      this.pushMessage('ai', this.mockReply(agentId, userText));
      return;
    }

    // ② 已接入外部平台：流式渲染（边生成边显示）
    const bubble = this.createStreamBubble();
    try {
      const content = await LLM.chat(agentId, userText, {
        onDelta: (full, reasoning) => bubble.update(full, reasoning)
      });
      bubble.commit(content);
    } catch (err) {
      console.error('[时空终端] 智能体接口调用失败：', err);
      bubble.fail(err.message || '网络异常');
    }
  },

  /**
   * 创建一条"正在生成"的 AI 气泡，返回三个控制方法
   * 流式场景下不断 update，结束后 commit 写入历史
   */
  createStreamBubble() {
    const agent = this.currentAgent;
    const self = this;

    const wrap = document.createElement('div');
    wrap.className = 'msg-bubble flex gap-3';
    wrap.innerHTML = `
      <span class="w-9 h-9 shrink-0 rounded-xl grid place-items-center"
            style="background:${agent.color}1f; color:${agent.color}; box-shadow:0 0 0 1px ${agent.color}55 inset;">
        <i class="fa-solid ${agent.icon}"></i>
      </span>
      <div class="max-w-[78%]">
        <div class="bubble-ai rounded-2xl px-4 py-2.5 text-sm leading-relaxed" data-content>
          <div class="typing"><span></span><span></span><span></span></div>
        </div>
        <div class="mt-1 text-[10px] text-[#5f6f99] pl-1 hidden" data-meta></div>
      </div>`;

    document.getElementById('chatBody').appendChild(wrap);
    this.scrollToBottom();

    const contentEl = wrap.querySelector('[data-content]');
    const metaEl = wrap.querySelector('[data-meta]');
    let lastText = '';
    let lastReasoning = '';
    const startedAt = Date.now();

    const api = {
      // text：正式正文；reasoning：深度思考型智能体的推理过程
      update(text, reasoning) {
        if (reasoning !== undefined) lastReasoning = reasoning;

        if (text) {
          lastText = text;
          contentEl.innerHTML = self.formatText(text) + '<span class="caret"></span>';
        } else if (lastReasoning) {
          // 正文还没到时，把推理过程末尾滚动出来，并显示已等待时长
          const secs = Math.floor((Date.now() - startedAt) / 1000);
          const tail = lastReasoning.length > 80 ? '…' + lastReasoning.slice(-80) : lastReasoning;
          contentEl.innerHTML =
            `<span class="text-[11px] italic text-[#8ea0c9]" title="该智能体开启了深度思考，通常需要 30-60 秒">` +
            `深度思考中 · ${secs}s · ${self.escapeHtml(tail)}</span><span class="caret"></span>`;
        }
        self.scrollToBottom();
      },
      commit(finalText) {
        clearInterval(ticker);
        const text = finalText || lastText;
        contentEl.innerHTML = self.formatText(text);
        metaEl.classList.remove('hidden');
        metaEl.textContent = `${agent.name} · ${self.now()}`;
        (self.history[agent.id] ||= []).push({ role: 'ai', text, time: self.now() });
        self.updateMsgCounters();
        self.scrollToBottom();
      },
      fail(msg) {
        clearInterval(ticker);
        contentEl.innerHTML = `<span class="text-[#f87171]"><i class="fa-solid fa-triangle-exclamation mr-1.5"></i>${self.escapeHtml(msg)}</span>
          <div class="mt-2 text-[11px] leading-relaxed text-[#8ea0c9]">
            排查顺序：① 令牌是否有效且开通了 <span class="text-[#22d3ee]">chat</span> 权限；
            ② bot_id 是否正确；③ 该智能体是否已发布到 <span class="text-[#22d3ee]">Agent as API</span> 渠道。
            也可以把 <span class="text-[#22d3ee]">znt.js</span> 顶部的 <span class="text-[#22d3ee]">enabled</span> 改成 false 回到本地模拟。
          </div>`;
        metaEl.classList.remove('hidden');
        metaEl.textContent = `连接失败 · ${self.now()}`;
        self.scrollToBottom();
      }
    };

    // 模型思考时流可能是静默的，用定时器刷新秒数，让用户知道没有卡死
    const ticker = setInterval(() => {
      if (!lastText && lastReasoning) api.update('', lastReasoning);
    }, 800);

    return api;
  },

  /** 轻量格式化：先转义再处理 **粗体** / `代码` / 换行，避免 XSS */
  formatText(str) {
    let html = this.escapeHtml(str);
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong class="text-white">$1</strong>');
    html = html.replace(/`([^`]+)`/g, '<code class="px-1 py-0.5 rounded bg-black/50 text-[#22d3ee] text-[0.9em]">$1</code>');
    html = html.replace(/\n/g, '<br>');
    return html;
  },

  /** 本地模拟回复：关键词命中优先，否则从随机池中抽取 */
  mockReply(agentId, text) {
    const agent = AGENTS.find(a => a.id === agentId) || this.currentAgent;
    const clean = text.toLowerCase();

    // 1) 关键词定向回复
    const hit = (agent.keywordReplies || []).find(k => k.keys.some(key => clean.includes(key)));
    if (hit) return hit.reply;

    // 2) 随机池：打乱后循环取用，保证连续多条不重复
    if (!this.usedPool[agentId]) this.usedPool[agentId] = [];
    const pool = this.usedPool[agentId];
    if (pool.length === 0) {
      // 一轮抽完则重新洗牌
      pool.push(...agent.replies.map((_, i) => i).sort(() => Math.random() - 0.5));
    }
    const idx = pool.shift();

    // 3) 极短输入做一次兜底，避免答非所问显得突兀
    if (clean.length <= 2 && Math.random() < 0.5) {
      return this.randomOf(FALLBACK_REPLIES);
    }
    return agent.replies[idx] || this.randomOf(FALLBACK_REPLIES);
  },

  randomOf(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  },

  /* ---------------- 消息渲染 ---------------- */
  pushMessage(role, text) {
    const id = this.currentAgent.id;
    if (!this.history[id]) this.history[id] = [];
    this.history[id].push({ role, text, time: this.now() });

    const body = document.getElementById('chatBody');
    body.appendChild(this.buildBubble(role, text));
    this.scrollToBottom();
    this.updateMsgCounters();
  },

  buildBubble(role, text) {
    const agent = this.currentAgent;
    const wrap = document.createElement('div');
    wrap.className = 'msg-bubble flex gap-3 ' + (role === 'user' ? 'flex-row-reverse' : '');

    const time = this.now();

    if (role === 'user') {
      wrap.innerHTML = `
        <span class="w-9 h-9 shrink-0 rounded-xl grid place-items-center bg-[#a855f7]/15 text-[#c084fc] border border-[#a855f7]/40">
          <i class="fa-solid fa-user-astronaut"></i>
        </span>
        <div class="max-w-[78%]">
          <div class="bubble-user rounded-2xl px-4 py-2.5 text-sm leading-relaxed">${this.escapeHtml(text)}</div>
          <div class="mt-1 text-[10px] text-[#5f6f99] text-right pr-1">幸存者 · ${time}</div>
        </div>`;
    } else {
      wrap.innerHTML = `
        <span class="w-9 h-9 shrink-0 rounded-xl grid place-items-center"
              style="background:${agent.color}1f; color:${agent.color}; box-shadow:0 0 0 1px ${agent.color}55 inset;">
          <i class="fa-solid ${agent.icon}"></i>
        </span>
        <div class="max-w-[78%]">
          <div class="bubble-ai rounded-2xl px-4 py-2.5 text-sm leading-relaxed">${this.formatText(text)}</div>
          <div class="mt-1 text-[10px] text-[#5f6f99] pl-1">${agent.name} · ${time}</div>
        </div>`;
    }

    // 文本已由 formatText 做过转义 + 轻量 Markdown 处理（粗体/行内代码/换行）
    return wrap;
  },

  /* ---------------- 正在输入指示器 ---------------- */
  showTyping() {
    const agent = this.currentAgent;
    const body = document.getElementById('chatBody');
    const el = document.createElement('div');
    el.id = 'typingIndicator';
    el.className = 'flex gap-3';
    el.innerHTML = `
      <span class="w-9 h-9 shrink-0 rounded-xl grid place-items-center"
            style="background:${agent.color}1f; color:${agent.color}; box-shadow:0 0 0 1px ${agent.color}55 inset;">
        <i class="fa-solid ${agent.icon}"></i>
      </span>
      <div class="bubble-ai rounded-2xl px-4 py-3">
        <div class="typing"><span></span><span></span><span></span></div>
      </div>`;
    body.appendChild(el);
    this.scrollToBottom();
  },

  hideTyping() {
    document.getElementById('typingIndicator')?.remove();
  },

  /* ---------------- 重置当前会话 ---------------- */
  resetConversation() {
    const agent = this.currentAgent;
    this.history[agent.id] = [];
    LLM.reset(agent.id);   // 丢弃服务端会话上下文
    document.getElementById('chatBody').innerHTML = '';
    setTimeout(() => this.pushMessage('ai', agent.greeting), 180);
  },

  /* ---------------- 工具函数 ---------------- */
  scrollToBottom() {
    const body = document.getElementById('chatBody');
    if (body) body.scrollTop = body.scrollHeight;
  },

  updateMsgCounters() {
    AGENTS.forEach(a => {
      const el = document.querySelector(`[data-count-msg="${a.id}"]`);
      if (el) el.textContent = `${(this.history[a.id] || []).length} 条对话`;
    });
  },

  now() {
    return new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  },

  escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  },

  /* ---------------- 侧栏内核状态 ---------------- */
  updateKernelMode() {
    const el = document.getElementById('kernelMode');
    if (!el) return;
    const ready = AGENTS.filter(a => LLM.isReady(a.id)).length;
    if (ready === AGENTS.length) {
      el.textContent = '实时 API';
      el.className = 'text-[#4ade80]';
    } else if (ready > 0) {
      el.textContent = `混合 ${ready}/${AGENTS.length}`;
      el.className = 'text-[#fbbf24]';
    } else {
      el.textContent = '本地模拟';
      el.className = 'text-[#fbbf24]';
    }
    el.title = ready === 0
      ? '未配置任何外部智能体，当前使用本地模拟回复'
      : `${ready} 个智能体已接入外部 API`;

    // 输入框下方的说明跟随内核切换
    const hint = document.getElementById('kernelHint');
    if (hint) {
      hint.textContent = ready > 0 ? '已接入外部智能体，回复由 AI 实时生成' : '模拟内核，回复随机生成，仅供娱乐';
    }
  },

  /* ---------------- 自定义智能体：载入 / 新增 / 移除 ---------------- */
  /** 把本地保存的自定义智能体并入 AGENTS（重复执行不会产生副本） */
  loadCustomAgents() {
    CustomAgents.list().forEach(rec => {
      if (!AGENTS.some(a => a.id === rec.id)) AGENTS.push(CustomAgents.toAgent(rec));
    });
  },

  /** 新增或更新一个自定义智能体，并立刻反映到侧栏与计数 */
  addCustomAgent(rec) {
    if (!CustomAgents.upsert(rec)) return false;
    const agent = CustomAgents.toAgent(rec);
    const i = AGENTS.findIndex(a => a.id === agent.id);
    if (i >= 0) AGENTS[i] = agent; else AGENTS.push(agent);
    this.renderAgentCards();
    this.updateKernelMode();
    return true;
  },

  /** 移除自定义智能体；若正停在该智能体上，先切回内置的第一个 */
  removeAgent(id) {
    if (!CustomAgents.find(id)) return false;   // 只允许删自定义的，内置不可删
    CustomAgents.remove(id);

    const i = AGENTS.findIndex(a => a.id === id);
    if (i >= 0) AGENTS.splice(i, 1);
    delete this.history[id];
    LLM.reset(id);

    if (this.currentAgent.id === id) this.selectAgent(AGENTS[0].id);
    this.renderAgentCards();
    this.updateKernelMode();
    return true;
  },

  /* ---------------- 初始化 ---------------- */
  init() {
    // 先把用户自定义的智能体并入列表，后续所有渲染/计数/切换都自动包含它们
    this.loadCustomAgents();

    this.renderAgentCards();
    this.updateKernelMode();
    this.selectAgent(this.currentAgent.id);   // 触发默认智能体的开场白

    // 默认落在首页；若 URL 带了 hash（如 #terminal），则直达对应视图
    const initial = (location.hash || '').replace('#', '');
    this.switchView(['home', 'terminal', 'guide', 'builder'].includes(initial) ? initial : 'home');

    // 浏览器前进/后退时同步视图
    window.addEventListener('hashchange', () => {
      const v = (location.hash || '').replace('#', '');
      if (['home', 'terminal', 'guide', 'builder'].includes(v) && v !== this.currentView) {
        this.switchView(v, { silent: true });
      }
    });

    // 首屏数字滚动动画
    document.querySelectorAll('[data-count]').forEach(el => {
      const target = parseInt(el.dataset.count, 10);
      const duration = 1200;
      const start = performance.now();
      const tick = now => {
        const p = Math.min((now - start) / duration, 1);
        el.textContent = Math.floor(target * (1 - Math.pow(1 - p, 3))).toLocaleString();
        if (p < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    // 页脚装饰计数
    document.getElementById('footerTimeline').textContent = Math.floor(Math.random() * 900 + 100).toLocaleString();

    // 若 Tailwind CDN 未能加载（如离线），给出提示而不是白屏
    setTimeout(() => {
      if (typeof window.tailwind === 'undefined') {
        console.warn('[时空终端] Tailwind CDN 未加载，已退化为自定义基础样式，请把 index.html 置于联网环境或改用本地构建版 Tailwind。');
      }
    }, 1500);
  }
};

/* ==========================================================
 * 5) 接入智能体（用户自助配置）
 *    —— 平台可插拔：扣子 / Dify / OpenAI 兼容接口
 *    —— 想再加一个平台，只需在 LLM.adapters 里注册新的适配器
 * ========================================================== */
const Builder = {
  provider: 'coze',
  icon: 'fa-satellite-dish',
  color: '#22d3ee',
  previewId: null,      // 右侧正在预览哪个智能体
  previewMsgs: {},      // agentId -> [{role, text}]
  previewBusy: false,   // 预览区是否正在生成

  esc(s) { return App.escapeHtml(s); },
  val(id) { return (document.getElementById(id)?.value || '').trim(); },

  /** 切换平台：只显示该平台对应的字段组 */
  onProviderChange() {
    const sel = document.getElementById('fldProvider');
    if (sel) this.provider = sel.value;
    document.querySelectorAll('[data-pgroup]').forEach(el => {
      el.classList.toggle('hidden', el.dataset.pgroup !== this.provider);
    });
    this.msg('');
    this.renderPreview();
  },

  /** 名称/定位变化时，右侧草稿标题跟着走 */
  onMetaChange() {
    if (!this.selectedAgent()) this.renderPreview();
  },

  /** 地址统一成 https://，允许用户直接粘贴 ws:// 或 websocket:// */
  normalizeUrl(raw, fallback) {
    let s = (raw || '').trim();
    if (!s) return fallback;
    s = s.replace(/^wss?:\/\//i, 'https://').replace(/^websocket:\/\//i, 'https://');
    // 不认识的协议原样返回，让校验去报错
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) && !/^https?:\/\//i.test(s)) return s;
    if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
    return s.replace(/\/+$/, '');
  },

  /** 显示/隐藏密钥 */
  toggleKey(id, btn) {
    const el = document.getElementById(id);
    if (!el) return;
    const show = el.type === 'password';
    el.type = show ? 'text' : 'password';
    btn.textContent = show ? '隐藏' : '显示';
  },

  /** 表单里的通用字段 */
  read() {
    return { name: this.val('fldName'), desc: this.val('fldDesc'), greeting: this.val('fldGreeting') };
  },

  /** 按平台读取连接配置 */
  readConfig() {
    if (this.provider === 'coze') {
      return {
        botId: this.val('cozeBotId'),
        token: this.val('cozeToken'),
        apiBase: this.normalizeUrl(this.val('cozeApiBase'), COZE_CONFIG.apiBase)
      };
    }
    if (this.provider === 'dify') {
      return {
        baseUrl: this.normalizeUrl(this.val('difyBaseUrl'), 'https://api.dify.ai/v1'),
        appKey: this.val('difyAppKey')
      };
    }
    return {
      baseUrl: this.normalizeUrl(this.val('oaiBaseUrl'), 'https://api.openai.com/v1'),
      apiKey: this.val('oaiApiKey'),
      model: this.val('oaiModel') || 'gpt-4o-mini',
      temperature: this.val('oaiTemp'),
      systemPrompt: this.val('oaiSystem')
    };
  },

  msg(text, kind = 'info') {
    const el = document.getElementById('builderMsg');
    if (!el) return;
    el.style.color = { info: '#8ea0c9', ok: '#4ade80', err: '#f87171', busy: '#22d3ee' }[kind];
    el.innerHTML = text;
  },

  pickIcon(btn) {
    this.icon = btn.dataset.icon;
    document.querySelectorAll('#iconPicker button').forEach(b => b.classList.toggle('picked', b === btn));
  },

  pickColor(btn) {
    this.color = btn.dataset.color;
    document.querySelectorAll('#colorPicker button').forEach(b => b.classList.toggle('picked', b === btn));
  },

  /** 生成稳定的 id：同样的平台 + 同样的凭据重复添加时视为"更新" */
  shortHash(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return Math.abs(h).toString(36);
  },

  makeId(cfg) {
    const key = this.provider === 'coze'
      ? cfg.botId
      : (cfg.baseUrl || '') + '|' + (cfg.appKey || cfg.apiKey || '');
    return `custom-${this.provider}-${this.shortHash(key)}`;
  },

  /** 校验，返回错误文案或 null */
  validate(f, cfg) {
    if (!f.name) return '请先给它起个名字。';
    if (f.name.length > 20) return '名字太长，控制在 20 字以内。';

    if (this.provider === 'coze') {
      if (!/^\d{12,20}$/.test(cfg.botId)) return 'bot_id 应该是一串数字（扣子智能体编辑页地址栏 /bot/ 后面那串）。';
      if (cfg.token && !/^pat_/.test(cfg.token)) return '扣子令牌应以 pat_ 开头。';
      if (!cfg.token && !/^pat_/.test(COZE_CONFIG.token || '')) return '没有可用的扣子令牌：填一个，或先配置 znt.js 顶部的默认令牌。';
      if (!/^https?:\/\//.test(cfg.apiBase)) return '接口地址要以 http:// 或 https:// 开头。';
    } else if (this.provider === 'dify') {
      if (!/^https?:\/\//.test(cfg.baseUrl)) return '接口地址要以 http:// 或 https:// 开头。';
      if (!cfg.appKey) return 'Dify 需要 App Key（形如 app-xxxxxxxx）。';
    } else {
      if (!/^https?:\/\//.test(cfg.baseUrl)) return '接口地址要以 http:// 或 https:// 开头。';
      if (!cfg.apiKey) return '需要填 API Key（本地模型可随便填一个）。';
      if (!cfg.model) return '需要填模型名称，例如 gpt-4o-mini / deepseek-chat / qwen-plus。';
      if (cfg.temperature !== '' && !(Number(cfg.temperature) >= 0 && Number(cfg.temperature) <= 2)) {
        return '温度需要是 0 ~ 2 之间的数字，通常 0.7 左右。';
      }
    }
    return null;
  },

  /** 按平台验一次通路 */
  async probe(cfg) {
    if (this.provider === 'coze') return Coze.testConnection(cfg.botId, cfg.token || COZE_CONFIG.token, cfg.apiBase);
    if (this.provider === 'dify') return Dify.testConfig(cfg);
    return OpenAICompat.testConfig(cfg);
  },

  async test() {
    const f = this.read();
    const cfg = this.readConfig();
    const bad = this.validate(f, cfg);
    if (bad) return this.msg('<i class="fa-solid fa-circle-exclamation mr-1"></i>' + bad, 'err');

    this.msg('正在握手，请稍候……', 'busy');
    try {
      await this.probe(cfg);
      this.msg('<i class="fa-solid fa-circle-check mr-1"></i>握手成功，这组配置可以正常调用。', 'ok');
    } catch (e) {
      this.msg(`<i class="fa-solid fa-triangle-exclamation mr-1"></i>握手失败：${this.esc(e.message)}
        <span class="block mt-1 text-[11px] text-[#5f6f99]">若是浏览器报跨域（CORS），说明该平台不允许网页直连，需要一层后端代理。</span>`, 'err');
    }
  },

  async submit() {
    const f = this.read();
    const cfg = this.readConfig();
    const bad = this.validate(f, cfg);
    if (bad) return this.msg('<i class="fa-solid fa-circle-exclamation mr-1"></i>' + bad, 'err');

    const btn = document.getElementById('btnSaveAgent');
    if (btn) btn.disabled = true;
    this.msg('正在验证连接……', 'busy');

    try {
      await this.probe(cfg);
    } catch (e) {
      if (btn) btn.disabled = false;
      return this.msg(`<i class="fa-solid fa-triangle-exclamation mr-1"></i>连接失败：${this.esc(e.message)}
        <span class="block mt-1 text-[11px] text-[#5f6f99]">若是浏览器报跨域（CORS），说明该平台不允许网页直连，需要一层后端代理。</span>`, 'err');
    }

    const rec = {
      id: this.makeId(cfg),
      provider: this.provider,
      name: f.name,
      desc: f.desc,
      greeting: f.greeting,
      icon: this.icon,
      color: this.color,
      config: cfg
    };

    const existed = !!CustomAgents.find(rec.id);
    if (btn) btn.disabled = false;
    if (!App.addCustomAgent(rec)) {
      return this.msg('浏览器存储不可用，无法保存（无痕模式下常见）。换普通窗口再试。', 'err');
    }

    // 保存成功后：右侧预览切到这个智能体，并补一句开场白，用户可以直接试聊
    this.previewId = rec.id;
    this.render();
    this.renderPreview();
    this.greetPreview();

    this.msg(
      existed
        ? `<i class="fa-solid fa-circle-check mr-1"></i>「${this.esc(rec.name)}」的配置已更新，右侧可以直接试聊。`
        : `<i class="fa-solid fa-circle-check mr-1"></i>「${this.esc(rec.name)}」已接入，右侧可以直接试聊。`,
      'ok'
    );
  },

  /** 清空表单（平台选择保持不动） */
  reset() {
    ['fldName', 'fldDesc', 'fldGreeting', 'cozeBotId', 'cozeToken',
     'difyAppKey', 'oaiApiKey', 'oaiModel', 'oaiSystem'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    this.icon = 'fa-satellite-dish';
    this.color = '#22d3ee';
    document.querySelectorAll('#iconPicker button').forEach((b, i) => b.classList.toggle('picked', i === 0));
    document.querySelectorAll('#colorPicker button').forEach((b, i) => b.classList.toggle('picked', i === 0));
  },

  /* ============ 右侧：对话预览 ============ */

  /** 当前预览哪个智能体：优先刚保存的，其次已有的第一个 */
  selectedAgent() {
    if (this.previewId) {
      const a = findAgent(this.previewId);
      if (a) return a;
      this.previewId = null;
    }
    const list = CustomAgents.list();
    const first = list.length ? findAgent(list[0].id) : null;
    if (first) this.previewId = first.id;   // 记住选中项，列表高亮才对得上
    return first;
  },

  /** 切换预览对象（点左侧"已接入"列表） */
  selectPreview(id) {
    this.previewId = id;
    this.render();
    this.renderPreview();
    this.greetPreview();
  },

  scrollPreview() {
    const el = document.getElementById('previewBody');
    if (el) el.scrollTop = el.scrollHeight;
  },

  autoGrow(el) { App.autoGrow(el); },

  onPreviewKey(e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      this.sendPreview();
    }
  },

  /** 渲染预览区：空态 / 开场引导 / 历史消息 */
  renderPreview() {
    const body = document.getElementById('previewBody');
    if (!body) return;
    const agent = this.selectedAgent();
    const draft = this.val('fldName');

    // ① 还没有任何可对话的智能体：显示草稿引导
    if (!agent) {
      body.innerHTML = `
        <div class="h-full min-h-[300px] flex flex-col items-center justify-center text-center px-4">
          <span class="w-12 h-12 rounded-2xl grid place-items-center text-lg mb-3"
                style="background:#a855f71f;color:#a855f7;box-shadow:0 0 0 1px #a855f755 inset;">
            <i class="fa-solid fa-user-astronaut"></i>
          </span>
          <h4 class="text-[15px] font-medium text-white">${this.esc(draft || '你的新智能体')}</h4>
          <p class="mt-1 text-[12px] text-[#8ea0c9]">· 与智能体对话 ·</p>
          <p class="mt-3 text-[12px] leading-relaxed text-[#5f6f99] max-w-[360px]">
            先在左侧填写 ${this.provider === 'openai' ? 'API 密钥与模型名' : 'AppKey 与 API 密钥'} 并保存，再挑一个开场，或直接输入你的问题。
          </p>
        </div>`;
      this.updatePreviewHint(null);
      return;
    }

    // ② 有消息就重放，没有就显示开场引导
    const msgs = this.previewMsgs[agent.id] || [];
    if (!msgs.length) {
      const chips = (agent.chips || []).slice(0, 4);
      body.innerHTML = `
        <div class="h-full min-h-[300px] flex flex-col items-center justify-center text-center px-4">
          <span class="w-12 h-12 rounded-2xl grid place-items-center text-lg mb-3"
                style="background:${agent.color}1f;color:${agent.color};box-shadow:0 0 0 1px ${agent.color}55 inset;">
            <i class="fa-solid ${agent.icon}"></i>
          </span>
          <h4 class="text-[15px] font-medium text-white">${this.esc(agent.name)}</h4>
          <p class="mt-1 text-[12px] text-[#8ea0c9]">· 与智能体对话 ·</p>
          <p class="mt-3 text-[12px] leading-relaxed text-[#5f6f99]">
            挑一个开场，或直接输入你的问题。
          </p>
          ${chips.length ? `<div class="mt-4 flex flex-wrap gap-2 justify-center max-w-[420px]">
            ${chips.map(c => `<button type="button" class="chip text-[11.5px]" onclick="Builder.useChip(this)">${this.esc(c)}</button>`).join('')}
          </div>` : ''}
        </div>`;
      this.updatePreviewHint(agent);
      return;
    }

    body.innerHTML = '';
    msgs.forEach(m => this.appendPreviewRow(m.role, m.text, agent));
    this.scrollPreview();
    this.updatePreviewHint(agent);
  },

  /** 底部提示文案：说清"当前连的是谁" */
  updatePreviewHint(agent) {
    const el = document.getElementById('previewHint');
    if (!el) return;
    if (!agent) {
      el.innerHTML = '<i class="fa-solid fa-circle-info mr-1"></i>先在左侧填写配置并保存，即可开始对话。';
      return;
    }
    const label = LLM.label(agent.id);
    el.innerHTML = `<i class="fa-solid fa-circle-info mr-1"></i>当前连接 ${this.esc(label)} · ${this.esc(agent.name)}；改完左侧配置记得重新保存。`;
  },

  /** 首次进入时补一句开场白（纯本地，不消耗调用次数） */
  greetPreview() {
    const agent = this.selectedAgent();
    if (!agent) return;
    if ((this.previewMsgs[agent.id] || []).length) return;
    const text = agent.greeting || `信道已建立。我是「${agent.name}」，直接说你的问题。`;
    this.previewMsgs[agent.id] = [{ role: 'ai', text }];
    this.renderPreview();
  },

  useChip(btn) {
    const el = document.getElementById('previewInput');
    if (!el) return;
    el.value = btn.textContent.trim();
    el.focus();
    this.autoGrow(el);
  },

  /** 追加一条消息（写内存 + 追加 DOM） */
  pushPreview(role, text, agent = this.selectedAgent()) {
    const body = document.getElementById('previewBody');
    if (!body || !agent) return;
    if (!body.querySelector('.msg-bubble')) body.innerHTML = '';   // 清掉空态
    this.previewMsgs[agent.id] ||= [];
    this.previewMsgs[agent.id].push({ role, text });
    this.appendPreviewRow(role, text, agent);
    this.scrollPreview();
  },

  /** 生成一条静态消息行 */
  appendPreviewRow(role, text, agent) {
    const body = document.getElementById('previewBody');
    if (!body) return;
    const row = document.createElement('div');
    const avatar = role === 'ai'
      ? `<span class="w-7 h-7 shrink-0 rounded-lg grid place-items-center text-[11px]"
                style="background:${agent.color}1f;color:${agent.color};box-shadow:0 0 0 1px ${agent.color}55 inset;">
           <i class="fa-solid ${agent.icon}"></i></span>`
      : `<span class="w-7 h-7 shrink-0 rounded-lg grid place-items-center text-[11px] bg-[#a855f7]/15 text-[#c084fc]">
           <i class="fa-solid fa-user"></i></span>`;

    row.className = `flex gap-2.5 msg-bubble ${role === 'user' ? 'justify-end' : ''}`;
    row.innerHTML = role === 'ai'
      ? `${avatar}<div class="max-w-[82%]"><div class="bubble-ai rounded-xl px-3.5 py-2 text-[12.5px] leading-relaxed">${App.formatText(text)}</div></div>`
      : `<div class="max-w-[82%]"><div class="bubble-user rounded-xl px-3.5 py-2 text-[12.5px] leading-relaxed">${App.formatText(text)}</div></div>${avatar}`;
    body.appendChild(row);
  },

  /** 流式气泡：update → commit / fail */
  createPreviewBubble(agent) {
    const self = this;
    const body = document.getElementById('previewBody');
    if (!body) return { update() {}, commit() {}, fail() {} };
    if (!body.querySelector('.msg-bubble')) body.innerHTML = '';

    const row = document.createElement('div');
    row.className = 'flex gap-2.5 msg-bubble';
    row.innerHTML = `
      <span class="w-7 h-7 shrink-0 rounded-lg grid place-items-center text-[11px]"
            style="background:${agent.color}1f;color:${agent.color};box-shadow:0 0 0 1px ${agent.color}55 inset;">
        <i class="fa-solid ${agent.icon}"></i>
      </span>
      <div class="max-w-[82%]">
        <div class="bubble-ai rounded-xl px-3.5 py-2 text-[12.5px] leading-relaxed" data-content>
          <span class="typing"><span></span><span></span><span></span></span>
        </div>
      </div>`;
    body.appendChild(row);
    this.scrollPreview();

    const contentEl = row.querySelector('[data-content]');
    const started = Date.now();
    let lastText = '';
    let lastReasoning = '';

    const api = {
      update(text, reasoning) {
        if (reasoning !== undefined) lastReasoning = reasoning;
        if (text) {
          lastText = text;
          contentEl.innerHTML = App.formatText(text) + '<span class="caret"></span>';
        } else if (lastReasoning) {
          const secs = Math.floor((Date.now() - started) / 1000);
          const tail = lastReasoning.length > 60 ? '…' + lastReasoning.slice(-60) : lastReasoning;
          contentEl.innerHTML =
            `<span class="text-[11px] italic text-[#8ea0c9]" title="该智能体开启了深度思考，通常需要 30-60 秒">` +
            `思考中 · ${secs}s · ${self.esc(tail)}</span><span class="caret"></span>`;
        }
        self.scrollPreview();
      },
      commit(finalText) {
        clearInterval(ticker);
        const text = finalText || lastText;
        contentEl.innerHTML = App.formatText(text);
        (self.previewMsgs[agent.id] ||= []).push({ role: 'ai', text });
        self.scrollPreview();
      },
      fail(msg) {
        clearInterval(ticker);
        contentEl.innerHTML = `<span class="text-[#f87171]"><i class="fa-solid fa-triangle-exclamation mr-1"></i>${self.esc(msg)}</span>`;
        self.scrollPreview();
      }
    };

    // 思考阶段流是静默的，用定时器刷新秒数，避免看起来卡死
    const ticker = setInterval(() => {
      if (!lastText && lastReasoning) api.update('', lastReasoning);
    }, 800);

    return api;
  },

  /** 在预览区发一条消息，走完整的分发链路 */
  async sendPreview() {
    const input = document.getElementById('previewInput');
    if (!input) return;
    const text = (input.value || '').trim();
    if (!text) return;

    if (this.previewBusy) {
      this.msg('上一条还在生成，稍等一下再发。', 'busy');
      return;
    }

    const agent = this.selectedAgent();
    if (!agent) return this.msg('先保存配置，或点左侧「已接入」里的智能体。', 'err');
    if (!LLM.isReady(agent.id)) return this.msg('这个智能体的配置还不完整，检查一下密钥、地址或 bot_id。', 'err');

    input.value = '';
    this.autoGrow(input);
    this.pushPreview('user', text, agent);

    this.previewBusy = true;
    const bubble = this.createPreviewBubble(agent);
    try {
      const content = await LLM.chat(agent.id, text, {
        onDelta: (full, reasoning) => bubble.update(full, reasoning)
      });
      bubble.commit(content);
    } catch (e) {
      bubble.fail(e.message || '调用失败');
    } finally {
      this.previewBusy = false;
    }
  },

  /** 清空当前预览的对话（同时丢弃服务端会话） */
  clearPreview() {
    const agent = this.selectedAgent();
    if (!agent) return;
    delete this.previewMsgs[agent.id];
    LLM.reset(agent.id);
    this.renderPreview();
    this.greetPreview();
  },

  /** 清除本机保存的全部接入记录 */
  clearAll(btn) {
    if (btn && btn.dataset.confirm !== '1') {
      btn.dataset.confirm = '1';
      const old = btn.innerHTML;
      btn.innerHTML = '<i class="fa-solid fa-triangle-exclamation mr-1"></i>确认清除？';
      btn.classList.add('!text-[#f87171]');
      setTimeout(() => {
        if (!btn.isConnected || btn.dataset.confirm !== '1') return;
        btn.dataset.confirm = '';
        btn.innerHTML = old;
        btn.classList.remove('!text-[#f87171]');
      }, 3000);
      return;
    }
    try { localStorage.removeItem(CustomAgents.KEY); } catch { /* 存储不可用时忽略 */ }
    for (let i = AGENTS.length - 1; i >= 0; i--) if (AGENTS[i].custom) AGENTS.splice(i, 1);
    this.previewId = null;
    this.previewMsgs = {};
    App.renderAgentCards();
    App.updateKernelMode();
    this.render();
    this.renderPreview();
    this.msg('已清除本机保存的接入配置。', 'ok');
  },

  /** 渲染"已接入"列表 */
  render() {
    const box = document.getElementById('customList');
    if (!box) return;
    const list = CustomAgents.list();
    const activeId = this.selectedAgent()?.id;
    const countEl = document.getElementById('customCount');
    if (countEl) countEl.textContent = list.length;

    if (!list.length) {
      box.innerHTML = `
        <p class="py-2 text-[11px] text-[#5f6f99]">
          <i class="fa-solid fa-satellite-dish mr-1 opacity-50"></i>还没有接入，填好上面的配置并保存就会出现在这里
        </p>`;
      return;
    }

    box.innerHTML = list.map(a => {
      const tag = LLM.LABELS[a.provider || 'coze'] || '外部 API';
      const active = a.id === activeId;
      return `
      <div class="preview-item ${active ? 'active' : ''}" style="--card-color:${a.color || '#22d3ee'}"
           onclick="Builder.selectPreview('${a.id}')" title="点击在右侧预览">
        <span class="w-7 h-7 shrink-0 rounded-lg grid place-items-center text-[11px]"
              style="background:${a.color || '#22d3ee'}1f;color:${a.color || '#22d3ee'};box-shadow:0 0 0 1px ${a.color || '#22d3ee'}55 inset;">
          <i class="fa-solid ${a.icon || 'fa-satellite-dish'}"></i>
        </span>
        <div class="min-w-0 flex-1">
          <p class="text-[12px] text-white truncate leading-tight">${this.esc(a.name)}</p>
          <p class="text-[9.5px] text-[#5f6f99] truncate mt-0.5">${this.esc(tag)}</p>
        </div>
        <button type="button" data-confirm=""
                onclick="event.stopPropagation();Builder.askRemove(this,'${a.id}')"
                class="shrink-0 w-6 h-6 rounded-md text-[10px] text-[#5f6f99] hover:text-[#f87171] hover:bg-[#f87171]/10 transition">
          <i class="fa-solid fa-xmark"></i>
        </button>
      </div>`;
    }).join('');
  },

  /** 两步确认删除（避免浏览器原生 confirm 在部分环境被拦截） */
  askRemove(btn, id) {
    if (btn.dataset.confirm === '1') {
      const wasPreviewing = this.previewId === id;
      App.removeAgent(id);
      if (wasPreviewing) this.previewId = null;
      this.render();
      this.renderPreview();
      this.msg('已移除该智能体。', 'ok');
      return;
    }
    btn.dataset.confirm = '1';
    btn.innerHTML = '<i class="fa-solid fa-check"></i>';
    btn.classList.add('!text-[#f87171]');
    setTimeout(() => {
      if (!btn.isConnected || btn.dataset.confirm !== '1') return;
      btn.dataset.confirm = '';
      btn.innerHTML = '<i class="fa-solid fa-xmark"></i>';
      btn.classList.remove('!text-[#f87171]');
    }, 3000);
  }
};

document.addEventListener('DOMContentLoaded', () => App.init());
