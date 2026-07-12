import { z } from 'zod'
import { config } from './config.js'

const receiptSchema = z.object({
  date: z.string().optional(),
  totalAmount: z.number().nonnegative().nullable().optional(),
  items: z.array(z.object({
    description: z.string().min(1).max(200),
    amount: z.number().positive(),
    category: z.string().max(40).optional(),
    quantity: z.number().int().positive().default(1),
  })).min(1).max(50),
})

export async function parseReceipt(images: string[], source: 'jd' | 'taobao' | 'other' = 'other') {
  if (!config.OPENROUTER_API_KEY.trim()) throw new Error('后端未配置 OPENROUTER_API_KEY')
  const imageParts = images.filter((value) => value.startsWith('data:image/')).slice(0, 3).map((url) => ({ type: 'image_url', image_url: { url } }))
  if (!imageParts.length) throw new Error('没有有效的购物明细图片')
  const payload = JSON.stringify({
    model: config.OPENROUTER_MODEL,
    messages: [{ role: 'user', content: [
      { type: 'text', text: `请识别图片中的购物小票或购物明细，只返回 JSON，不要 Markdown。来源是${source === 'jd' ? '京东' : source === 'taobao' ? '淘宝' : '其他'}。提取每一项商品、购买数量和金额；数量要识别商品名后的“x2”“×2”“2件”等，没有标注数量时填1。${source === 'jd' || source === 'taobao' ? 'amount 请填写单价，系统会再乘以 quantity。' : 'amount 请填写小票中该行的最终金额，不要自行乘数量。'} JSON 格式：{"date":"YYYY-MM-DD（看不清可省略）","totalAmount":0,"items":[{"description":"商品名称","quantity":2,"amount":3.98,"category":"分类"}]}。不要把合计金额重复作为商品项；看不清金额的项目不要猜测。` },
      ...imageParts,
    ] }],
    temperature: 0,
  })
  const response = await fetch(config.OPENROUTER_API_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)), 'HTTP-Referer': config.OPENROUTER_SITE_URL, 'X-Title': `${config.OPENROUTER_APP_NAME} Receipt Parser` },
    body: payload,
    signal: AbortSignal.timeout(180_000),
  })
  const result = await response.json() as any
  if (!response.ok) throw new Error(result?.error?.message || `购物明细识别失败（${response.status}）`)
  const content = String(result?.choices?.[0]?.message?.content || '').trim()
  if (!content) throw new Error(`模型没有返回购物明细内容（finish_reason=${result?.choices?.[0]?.finish_reason || 'unknown'}）`)
  const cleaned = content.replace(/^```json\s*/i, '').replace(/```$/, '').trim()
  const parsed = receiptSchema.parse(JSON.parse(cleaned))
  return {
    ...parsed,
    items: parsed.items.map((item) => ({ ...item, amount: source === 'jd' || source === 'taobao' ? Number((item.amount * item.quantity).toFixed(2)) : Number(item.amount.toFixed(2)) })),
  }
}
