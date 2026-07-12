import { z } from 'zod'
import { config } from './config.js'
import { prisma } from './db.js'

const categories = ['note', 'weight', 'food', 'schedule', 'shopping', 'ledger', 'none'] as const
type Category = (typeof categories)[number]

const resultSchema = z.object({
  category: z.enum(categories),
  confidence: z.number().min(0).max(1),
  data: z.record(z.unknown()).default({}),
})

type ClassifyResult = z.infer<typeof resultSchema>

/** 模块关键词：同一句话多个命中时，越靠前权重越高，只归入最先出现的那个模块。 */
const keywordDefs: { word: string; category: Exclude<Category, 'none'> }[] = [
  { word: '体重', category: 'weight' },
  { word: '饮食', category: 'food' },
  { word: '记事', category: 'note' },
  { word: '日程', category: 'schedule' },
  { word: '购买', category: 'shopping' },
  { word: '收入', category: 'ledger' },
  { word: '支出', category: 'ledger' },
]

export function primaryKeywordCategory(text: string): Exclude<Category, 'none'> | null {
  let best: { category: Exclude<Category, 'none'>; index: number } | null = null
  for (const item of keywordDefs) {
    const index = text.indexOf(item.word)
    if (index < 0) continue
    if (!best || index < best.index) best = { category: item.category, index }
  }
  return best?.category ?? null
}

const extractAmount = (text: string) => {
  const match =
    text.match(/(\d+(?:\.\d+)?)\s*(?:元|块钱?|块)/) ||
    text.match(/[￥¥]\s*(\d+(?:\.\d+)?)/) ||
    text.match(/(?:收入|支出)\s*[：:]?\s*(\d+(?:\.\d+)?)/)
  return match ? Number(match[1]) : null
}

const ledgerDescription = (text: string) => {
  const cleaned = text
    .replace(/收入|支出/g, ' ')
    .replace(/[￥¥]?\s*\d+(?:\.\d+)?\s*(?:元|块钱?|块)?/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned ? cleaned.slice(0, 500) : undefined
}

const ledgerTypeForText = (text: string): 'income' | 'expense' => {
  const incomeAt = text.indexOf('收入')
  const expenseAt = text.indexOf('支出')
  if (incomeAt >= 0 && (expenseAt < 0 || incomeAt < expenseAt)) return 'income'
  return 'expense'
}

const extractLedgerItems = (text: string) => {
  const items: { type: 'income' | 'expense'; amount: number; category: string; description?: string }[] = []
  const pattern = /([^，,、\n;；]+?)\s*[￥¥]?\s*(\d+(?:\.\d+)?)\s*(?:元|块钱?|块)/g
  for (const match of text.matchAll(pattern)) {
    const raw = match[1].trim()
    const amount = Number(match[2])
    if (!raw || !Number.isFinite(amount) || amount <= 0) continue
    const type = ledgerTypeForText(raw)
    const description = ledgerDescription(raw)
    items.push({ type, amount, category: type === 'income' ? '收入' : '支出', description })
  }
  return items.length > 1 ? items : null
}

export const isAmountOnlyText = (text: string) =>
  /^\s*[￥¥]?\s*\d+(?:\.\d+)?\s*(?:元|块钱?|块)?\s*$/.test(text.trim())

/** 补金额短句时，拼上同会话最近一条含「收入/支出」的用户话。 */
export async function resolveClassifyText(conversationId: string, text: string) {
  if (!isAmountOnlyText(text)) return text.trim()
  const prior = await prisma.message.findMany({
    where: { conversationId, role: 'user' },
    orderBy: { createdAt: 'desc' },
    take: 8,
  })
  const context = prior.find((item) => {
    const content = item.content.trim()
    if (!content || content === text.trim()) return false
    return content.includes('支出') || content.includes('收入')
  })
  if (!context) return text.trim()
  return `${context.content} ${text}`.replace(/\s+/g, ' ').trim()
}

function extractForCategory(category: Exclude<Category, 'none'>, text: string): ClassifyResult | null {
  if (category === 'weight') {
    const match = text.match(/(\d+(?:\.\d+)?)\s*(?:kg|KG|公斤|千克)/) || text.match(/体重\s*[：:是为]?\s*(\d+(?:\.\d+)?)/)
    if (!match) return null
    return { category: 'weight', confidence: 1, data: { weightKg: Number(match[1]) } }
  }
  if (category === 'food') {
    const cleaned = text.replace(/饮食/g, ' ').replace(/\s+/g, ' ').trim()
    if (!cleaned) return null
    const calories = text.match(/(\d+(?:\.\d+)?)\s*(?:kcal|大卡|卡)/i)
    const protein = text.match(/蛋白(?:质)?\s*(\d+(?:\.\d+)?)/)
    return {
      category: 'food',
      confidence: 1,
      data: {
        description: cleaned.slice(0, 1000),
        calories: calories ? Number(calories[1]) : undefined,
        proteinG: protein ? Number(protein[1]) : undefined,
      },
    }
  }
  if (category === 'note') {
    const content = text.replace(/记事/g, ' ').replace(/\s+/g, ' ').trim()
    if (!content) return null
    return { category: 'note', confidence: 1, data: { title: 'AI 自动记录', content } }
  }
  if (category === 'ledger') {
    const items = extractLedgerItems(text)
    if (items) return { category: 'ledger', confidence: 1, data: { items } }
    const amount = extractAmount(text)
    if (amount == null || amount <= 0) return null
    const incomeAt = text.indexOf('收入')
    const expenseAt = text.indexOf('支出')
    let type: 'income' | 'expense' = 'expense'
    if (incomeAt >= 0 && (expenseAt < 0 || incomeAt < expenseAt)) type = 'income'
    else if (expenseAt >= 0) type = 'expense'
    else if (incomeAt >= 0) type = 'income'
    return {
      category: 'ledger',
      confidence: 1,
      data: {
        type,
        amount,
        category: type === 'income' ? '收入' : '支出',
        description: ledgerDescription(text),
      },
    }
  }
  if (category === 'shopping') {
    const raw = text.replace(/待?购买/g, ' ').replace(/\s+/g, ' ').trim()
    const items = raw.split(/[、，,和及\s]+/).map((item) => item.trim()).filter((item) => item.length > 0 && item.length <= 100)
    if (!items.length) return null
    return { category: 'shopping', confidence: 1, data: { items, listType: 'short' } }
  }
  // schedule 需要时间，规则层暂不强解析，交给 LLM
  return null
}

/** 对明确短句先走规则解析；多关键词时只处理最靠前的那个模块。 */
export function tryRuleExtract(text: string): ClassifyResult | null {
  const primary = primaryKeywordCategory(text)
  if (!primary) return null
  return extractForCategory(primary, text)
}

const parseJson = (text: string) => {
  const cleaned = text.trim().replace(/^```json\s*/i, '').replace(/```$/, '').trim()
  return resultSchema.parse(JSON.parse(cleaned))
}

async function classify(text: string) {
  const payload = JSON.stringify({
    model: config.OPENROUTER_MODEL,
    messages: [
      {
        role: 'system',
        content: `你是生活助手的数据分类器。只返回 JSON，不要 Markdown。分类只能是 note、weight、food、schedule、shopping、ledger、none。
硬性规则：
1. 文案必须含对应关键词才可归入该类，否则必须 none。
2. 同一句话出现多个关键词时，**越靠前权重越高**，只能归入最先出现的那个关键词对应分类（例如「支出购买鸡蛋」→ ledger，不是 shopping；「购买 支出清单」→ shopping）。
关键词：体重→weight；饮食→food；记事→note；日程→schedule；购买→shopping；收入/支出→ledger。
ledger 的 amount 必须 > 0，没有金额时不要用高置信 ledger。
食物库入库不在这里处理（前端单独要求含「食物」+图片）。日记不在这里处理。
JSON 格式：{"category":"none","confidence":0.0,"data":{}}。
weight data：weightKg、date、note；food data：date、description、calories、proteinG；note data：title、content；schedule data：必须含 title、startAt（ISO 8601），可含 endAt、notes、repeat（none/daily/weekly/monthly）、reminderMinutes；shopping data：name 或 items 数组、listType（short/long，默认 short）；ledger data：必须含 type（income/expense）、amount（>0），可含 category、description、date。`,
      },
      { role: 'user', content: text },
    ],
    temperature: 0,
  })
  const response = await fetch(config.OPENROUTER_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(payload)),
      'HTTP-Referer': config.OPENROUTER_SITE_URL,
      'X-Title': `${config.OPENROUTER_APP_NAME} Classifier`,
    },
    body: payload,
    signal: AbortSignal.timeout(90_000),
  })
  const result = await response.json() as any
  if (!response.ok) throw new Error(result?.error?.message || `分类请求失败（${response.status}）`)
  return parseJson(result?.choices?.[0]?.message?.content || '')
}

const dateOf = (value: unknown) => {
  const date = typeof value === 'string' && value ? new Date(`${value}T00:00:00`) : new Date()
  return Number.isNaN(date.getTime()) ? new Date() : date
}

function canPersist(result: ClassifyResult) {
  if (result.category === 'none' || result.confidence < 0.9) return false
  if (result.category === 'ledger') {
    if (Array.isArray(result.data.items)) return false
    const amount = Number(result.data.amount)
    return Number.isFinite(amount) && amount > 0
  }
  if (result.category === 'weight') {
    const weightKg = Number(result.data.weightKg)
    return Number.isFinite(weightKg) && weightKg > 0
  }
  if (result.category === 'food') return typeof result.data.description === 'string' && !!result.data.description.trim()
  if (result.category === 'note') return typeof result.data.content === 'string' && !!result.data.content.trim()
  if (result.category === 'schedule') return typeof result.data.title === 'string' && !!result.data.title.trim() && typeof result.data.startAt === 'string'
  if (result.category === 'shopping') {
    if (Array.isArray(result.data.items) && result.data.items.some((item) => typeof item === 'string' && item.trim())) return true
    return typeof result.data.name === 'string' && !!result.data.name.trim()
  }
  return false
}

async function persistApplied(userId: string, result: ClassifyResult, text: string) {
  if (result.category === 'weight') {
    const weightKg = Number(result.data.weightKg)
    if (!Number.isFinite(weightKg) || weightKg <= 0) return
    await prisma.weightRecord.create({
      data: {
        userId,
        date: typeof result.data.date === 'string' && result.data.date ? dateOf(result.data.date) : new Date(),
        weightKg,
        note: typeof result.data.note === 'string' ? result.data.note : undefined,
      },
    })
  }
  if (result.category === 'food') {
    if (typeof result.data.description !== 'string' || !result.data.description.trim()) return
    await prisma.foodRecord.create({
      data: {
        userId,
        date: dateOf(result.data.date),
        meal: '全天',
        description: result.data.description,
        calories: Number.isFinite(Number(result.data.calories)) ? Number(result.data.calories) : undefined,
        proteinG: Number.isFinite(Number(result.data.proteinG)) ? Number(result.data.proteinG) : undefined,
      },
    })
  }
  if (result.category === 'schedule') {
    if (typeof result.data.title !== 'string' || !result.data.title.trim() || typeof result.data.startAt !== 'string') return
    const startAt = new Date(result.data.startAt)
    if (Number.isNaN(startAt.getTime())) return
    const endAt = typeof result.data.endAt === 'string' ? new Date(result.data.endAt) : undefined
    const repeat = ['none', 'daily', 'weekly', 'monthly'].includes(String(result.data.repeat)) ? String(result.data.repeat) as 'none' | 'daily' | 'weekly' | 'monthly' : 'none'
    const reminderValue = result.data.reminderMinutes == null ? NaN : Number(result.data.reminderMinutes)
    const reminderMinutes = Number.isInteger(reminderValue) && reminderValue >= 0 ? reminderValue : undefined
    await prisma.schedule.create({
      data: {
        userId,
        title: result.data.title.trim(),
        startAt,
        endAt: endAt && !Number.isNaN(endAt.getTime()) ? endAt : undefined,
        notes: typeof result.data.notes === 'string' ? result.data.notes : undefined,
        repeat,
        reminderMinutes,
      },
    })
  }
  if (result.category === 'note') {
    if (typeof result.data.content !== 'string' || !result.data.content.trim()) return
    await prisma.note.create({
      data: {
        userId,
        title: typeof result.data.title === 'string' && result.data.title ? result.data.title : 'AI 自动记录',
        content: result.data.content,
      },
    })
  }
  if (result.category === 'shopping') {
    const listType = result.data.listType === 'long' ? 'long' : 'short'
    const names: string[] = []
    if (Array.isArray(result.data.items)) {
      for (const item of result.data.items) {
        if (typeof item === 'string' && item.trim()) names.push(item.trim().slice(0, 100))
      }
    } else if (typeof result.data.name === 'string' && result.data.name.trim()) {
      names.push(result.data.name.trim().slice(0, 100))
    }
    for (const name of names) {
      const max = await prisma.shoppingItem.aggregate({ where: { userId, listType }, _max: { sortOrder: true } })
      const sortOrder = (max._max.sortOrder ?? -1) + 1
      await prisma.shoppingItem.create({ data: { userId, name, listType, purchased: false, sortOrder } })
    }
  }
  if (result.category === 'ledger') {
    if (Array.isArray(result.data.items) && result.data.items.length) return `系统解析出 ${result.data.items.length} 条记账，请确认后批量入账。`
    const amount = Number(result.data.amount)
    if (!Number.isFinite(amount) || amount <= 0) return
    let resolvedType: 'income' | 'expense' | null = null
    if (result.data.type === 'income' || result.data.type === 'expense') {
      resolvedType = result.data.type
    } else if (text.includes('收入') && !text.includes('支出')) {
      resolvedType = 'income'
    } else if (text.includes('支出')) {
      resolvedType = 'expense'
    } else if (text.includes('收入')) {
      resolvedType = 'income'
    }
    if (!resolvedType) return
    await prisma.ledgerRecord.create({
      data: {
        userId,
        type: resolvedType,
        amount,
        category: typeof result.data.category === 'string' && result.data.category.trim() ? result.data.category.trim().slice(0, 40) : (resolvedType === 'income' ? '收入' : '支出'),
        description: typeof result.data.description === 'string' && result.data.description.trim()
          ? result.data.description.trim().slice(0, 500)
          : ledgerDescription(text),
        date: dateOf(result.data.date),
      },
    })
  }
}

/** 给聊天模型的入库提示，避免把「购买 馒头」当成闲聊科普。 */
export function actionHintForResult(result: ClassifyResult | null, rawText = ''): string | null {
  if ((!result || result.category === 'none') && (rawText.includes('支出') || rawText.includes('收入')) && !(Number(extractAmount(rawText)) > 0)) {
    return '用户在记账但还没有有效金额。请确认品类并询问金额；不要说已经完整记入账本。'
  }
  if (!result || result.category === 'none') return null
  if (result.category === 'shopping') {
    const names = Array.isArray(result.data.items)
      ? result.data.items.filter((item): item is string => typeof item === 'string' && !!item.trim())
      : typeof result.data.name === 'string' ? [result.data.name] : []
    if (!names.length) return '系统会把这条记入「待购买」。请简短确认已加入清单，不要科普商品知识。'
    return `系统会把「${names.join('、')}」写入「待购买」清单。请用一两句话确认已记下，不要介绍怎么买或怎么选。`
  }
  if (result.category === 'weight') return '系统会写入体重记录。请简短确认已记录体重，不要展开无关建议。'
  if (result.category === 'food') return '系统会写入饮食记录。请简短确认已记录饮食，不要展开无关建议。'
  if (result.category === 'note') return '系统会写入记事本。请简短确认已记下，不要展开无关闲聊。'
  if (result.category === 'schedule') return '系统会写入日程。请简短确认已安排，不要展开无关闲聊。'
  if (result.category === 'ledger') {
    const amount = Number(result.data.amount)
    return `系统会写入记账：${result.data.type === 'income' ? '收入' : '支出'} ${amount} 元。请简短确认已记账，不要展开无关建议。`
  }
  return null
}

export function summarizeApplied(result: ClassifyResult): string | null {
  if (result.category === 'shopping') {
    const names = Array.isArray(result.data.items)
      ? result.data.items.filter((item): item is string => typeof item === 'string' && !!item.trim())
      : typeof result.data.name === 'string' ? [result.data.name] : []
    return names.length ? `已加入待购买：${names.join('、')}` : '已加入待购买'
  }
  if (result.category === 'weight') return `已记录体重${result.data.weightKg != null ? ` ${result.data.weightKg} kg` : ''}`
  if (result.category === 'food') return '已写入饮食记录'
  if (result.category === 'note') return '已写入记事本'
  if (result.category === 'schedule') return '已写入日程'
  if (result.category === 'ledger') {
    const amount = Number(result.data.amount)
    const label = result.data.type === 'income' ? '收入' : '支出'
    return Number.isFinite(amount) ? `已记账：${label} ${amount} 元` : '已写入记账'
  }
  return null
}

export async function classifyAndPersist(userId: string, messageId: string, text: string, conversationId?: string) {
  if (!text.trim()) return null
  try {
    const classifyText = conversationId ? await resolveClassifyText(conversationId, text) : text.trim()
    let result = tryRuleExtract(classifyText)
    if (!result) {
      if (!config.OPENROUTER_API_KEY) return null
      result = await classify(classifyText)
    }

    const primary = primaryKeywordCategory(classifyText)
    if (result.category !== 'none' && result.category !== primary) {
      result = {
        category: 'none',
        confidence: result.confidence,
        data: { ...result.data, blockedByKeywordPosition: true, primaryCategory: primary, originalCategory: result.category },
      }
    }

    const status = result.category === 'none' ? 'ignored' : canPersist(result) ? 'applied' : 'pending'
    await prisma.aiExtraction.create({
      data: {
        userId,
        messageId,
        category: result.category,
        confidence: result.confidence,
        data: { ...result.data, classifyText } as any,
        status,
      },
    })
    if (status !== 'applied') return { ...result, status }
    await persistApplied(userId, result, classifyText)
    return { ...result, status }
  } catch (error) {
    console.error('message classification failed', error)
    try {
      await prisma.aiExtraction.create({
        data: {
          userId,
          messageId,
          category: 'none',
          confidence: 0,
          data: { error: error instanceof Error ? error.message : 'unknown' },
          status: 'failed',
        },
      })
    } catch {
      // 分类失败不影响聊天主流程。
    }
    return null
  }
}
