import { z } from 'zod'
import { config } from './config.js'

const labelSchema = z.object({
  name: z.string().default('未命名食品'),
  servingSizeG: z.number().nullable().default(null),
  nutritionPer100g: z.object({
    calories: z.number().nullable().default(null),
    proteinG: z.number().nullable().default(null),
    fatG: z.number().nullable().default(null),
    carbsG: z.number().nullable().default(null),
    sugarG: z.number().nullable().default(null),
    fiberG: z.number().nullable().default(null),
    sodiumMg: z.number().nullable().default(null),
  }).default({}),
  confidence: z.number().min(0).max(1).default(0),
  notes: z.string().default(''),
})

export type FoodLabel = z.infer<typeof labelSchema>

const normalizeEnergy = (label: FoodLabel): FoodLabel => {
  const calories = label.nutritionPer100g.calories
  // 常见食品每 100g 的 kcal 通常不会超过 1000；营养表中的 kJ 数值往往在 1000 以上。
  // 模型未能区分单位时，按 1 kcal = 4.184 kJ 做一次兜底换算。
  if (calories != null && calories > 1000) {
    return {
      ...label,
      nutritionPer100g: {
        ...label.nutritionPer100g,
        calories: Number((calories / 4.184).toFixed(1)),
      },
    }
  }
  return label
}

export async function recognizeFoodLabel(images: string[]): Promise<FoodLabel> {
  if (!config.OPENROUTER_API_KEY) throw new Error('请先配置 OPENROUTER_API_KEY')
  const imageParts = images.filter((value) => value.startsWith('data:image/')).slice(0, 3).map((url) => ({ type: 'image_url', image_url: { url } }))
  if (!imageParts.length) throw new Error('没有有效的图片')
  const payload = JSON.stringify({
    model: config.OPENROUTER_MODEL,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: `请只识别图片中的食品营养成分表，不要猜测饭菜营养。返回 JSON，不要 Markdown：
{"name":"食品名称","servingSizeG":null,"nutritionPer100g":{"calories":null,"proteinG":null,"fatG":null,"carbsG":null,"sugarG":null,"fiberG":null,"sodiumMg":null},"confidence":0.0,"notes":""}
如果图片不是营养成分表，confidence 填 0，营养字段全部填 null。
如果标签按每份标注，请根据每份重量换算到每100g；无法确认的字段填 null。热量单位统一 kcal，钠统一 mg。明确是营养成分表且读到关键数值时 confidence ≥ 0.85。`, },
        ...imageParts,
      ],
    }],
    temperature: 0,
  })
  const response = await fetch(config.OPENROUTER_API_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)), 'HTTP-Referer': config.OPENROUTER_SITE_URL, 'X-Title': `${config.OPENROUTER_APP_NAME} Nutrition Label` },
    body: payload,
    signal: AbortSignal.timeout(180_000),
  })
  const result = await response.json() as any
  if (!response.ok) throw new Error(result?.error?.message || `图片识别失败（${response.status}）`)
  const text = String(result?.choices?.[0]?.message?.content || '').trim().replace(/^```json\s*/i, '').replace(/```$/, '').trim()
  return normalizeEnergy(labelSchema.parse(JSON.parse(text)))
}
