import { config } from './config.js'

export type InputMessage = {
  role: 'user' | 'assistant'
  content: string
  images?: string[]
}

const imageDataUrl = (value: unknown): value is string =>
  typeof value === 'string' && value.startsWith('data:image/')

const SYSTEM_PROMPT = `你是小日子 AI，一个友好、实用的生活助手。请用简洁的中文回答。

用户可用关键词把内容写入生活模块。若本轮属于这类操作，请简短确认已记录，不要当成闲聊或科普。
关键词：体重、饮食、记事、日程、购买、收入、支出；带图且含「食物」→ 食物库。
重要：同一句话多个关键词时，**越靠前权重越高**，只按最先出现的关键词对应模块处理。
例如「支出购买鸡蛋」按「支出」记账，不是待购买；「购买 牛奶」才是待购买。
记账需要金额；可先说「支出 鸡蛋」再补「20元」。`

function modelContent(message: InputMessage) {
  const images = Array.isArray(message.images) ? message.images.filter(imageDataUrl).slice(0, 3) : []
  if (!images.length) return message.content || ''
  return [
    { type: 'text', text: message.content || '请查看图片并给出有用的回复。' },
    ...images.map((url) => ({ type: 'image_url', image_url: { url } })),
  ]
}

export async function callModel(messages: InputMessage[], actionHint?: string | null) {
  if (!config.OPENROUTER_API_KEY.trim()) {
    throw new Error('后端未配置 OPENROUTER_API_KEY，请在 lifeAI-backend/.env 中填写后重启服务')
  }
  const systemMessages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...(actionHint ? [{ role: 'system', content: actionHint }] : []),
  ]
  const payload = JSON.stringify({
    model: config.OPENROUTER_MODEL,
    messages: [
      ...systemMessages,
      ...messages.slice(-12).map((message) => ({ role: message.role, content: modelContent(message) })),
    ],
    temperature: 0.7,
  })
  const response = await fetch(config.OPENROUTER_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(payload)),
      'HTTP-Referer': config.OPENROUTER_SITE_URL,
      'X-Title': config.OPENROUTER_APP_NAME,
    },
    body: payload,
    signal: AbortSignal.timeout(180_000),
  })
  const result = await response.json() as any
  if (!response.ok) throw new Error(result?.error?.message || `模型请求失败（${response.status}）`)
  const content = result?.choices?.[0]?.message?.content
  if (typeof content !== 'string' || !content) throw new Error('模型没有返回有效内容')
  return content
}
