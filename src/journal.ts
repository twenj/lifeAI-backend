import { config } from './config.js'
import { prisma } from './db.js'
import { callModel } from './model.js'

const ZONE = 'Asia/Shanghai'
const dateKey = (date: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date)
const rangeFor = (key: string) => ({ start: new Date(`${key}T00:00:00+08:00`), end: new Date(`${key}T00:00:00+08:00`).getTime() + 86400000 })
const clip = (value: unknown, max = 800) => String(value ?? '').replace(/\s+/g, ' ').slice(0, max)
const yesterdayKey = () => dateKey(new Date(Date.now() - 86400000))

async function buildSourceSummary(userId: string, key: string) {
  const range = rangeFor(key)
  const [messages, notes, weights, foods, ledger, schedules, foodItems] = await Promise.all([
    prisma.message.findMany({ where: { conversation: { userId }, createdAt: { gte: range.start, lt: new Date(range.end) } }, orderBy: { createdAt: 'asc' }, select: { role: true, content: true } }),
    prisma.note.findMany({ where: { userId, updatedAt: { gte: range.start, lt: new Date(range.end) } }, select: { title: true, content: true } }),
    prisma.weightRecord.findMany({ where: { userId, updatedAt: { gte: range.start, lt: new Date(range.end) } }, select: { date: true, weightKg: true, note: true } }),
    prisma.foodRecord.findMany({ where: { userId, updatedAt: { gte: range.start, lt: new Date(range.end) } }, select: { date: true, description: true, calories: true, proteinG: true } }),
    prisma.ledgerRecord.findMany({ where: { userId, updatedAt: { gte: range.start, lt: new Date(range.end) } }, select: { type: true, amount: true, category: true, description: true } }),
    prisma.schedule.findMany({ where: { userId, updatedAt: { gte: range.start, lt: new Date(range.end) } }, select: { title: true, startAt: true, completed: true, notes: true } }),
    prisma.foodItem.findMany({ where: { userId, updatedAt: { gte: range.start, lt: new Date(range.end) } }, select: { name: true, caloriesPer100g: true, proteinGPer100g: true } }),
  ])
  return [
    `聊天：${messages.map((item) => `${item.role === 'user' ? '我' : 'AI'}：${clip(item.content, 500)}`).join('；') || '无'}`,
    `记事本：${notes.map((item) => `${clip(item.title, 80)}：${clip(item.content)}`).join('；') || '无'}`,
    `体重：${weights.map((item) => `${item.weightKg}kg${item.note ? `（${clip(item.note, 120)}）` : ''}`).join('；') || '无'}`,
    `饮食：${foods.map((item) => `${clip(item.description, 120)} ${item.calories ?? 0}kcal/${item.proteinG ?? 0}g蛋白质`).join('；') || '无'}`,
    `账单：${ledger.map((item) => `${item.type === 'income' ? '收入' : '支出'}${item.amount}元 ${item.category}${item.description ? `（${clip(item.description, 100)}）` : ''}`).join('；') || '无'}`,
    `日程：${schedules.map((item) => `${clip(item.title, 100)}（${item.completed ? '已完成' : '未完成'}）`).join('；') || '无'}`,
    `食物库：${foodItems.map((item) => `${clip(item.name, 100)} ${item.caloriesPer100g ?? '--'}kcal/100g`).join('；') || '无'}`,
  ].join('\n')
}

export async function generateJournalsForDate(key: string) {
  if (!config.OPENROUTER_API_KEY) return
  const users = await prisma.user.findMany({ select: { id: true } })
  for (const user of users) {
    const date = new Date(`${key}T00:00:00+08:00`)
    const existing = await prisma.journal.findUnique({ where: { userId_date: { userId: user.id, date } } })
    if (existing) continue
    try {
      const summary = await buildSourceSummary(user.id, key)
      const content = await callModel([{ role: 'user', content: `请根据以下${key}的生活记录，写一篇简洁、温暖、真实的中文日记。不要编造没有出现的事实；没有记录的模块可以略过。只返回日记正文，不要标题、Markdown 或解释。\n\n${summary}` }])
      await prisma.journal.create({ data: { userId: user.id, date, title: `${key} 日记`, content: content.trim() } })
    } catch (error) {
      console.error(`journal generation failed for ${user.id}`, error)
    }
  }
}

export function startDailyJournalScheduler() {
  let lastRun = ''
  const tick = async () => {
    const now = new Date()
    const local = new Intl.DateTimeFormat('en-GB', { timeZone: ZONE, hour: '2-digit', minute: '2-digit', hour12: false }).format(now)
    const today = dateKey(now)
    if (local === '00:00' && lastRun !== today) {
      lastRun = today
      await generateJournalsForDate(yesterdayKey())
    }
  }
  void tick()
  setInterval(() => { void tick() }, 30_000)
}
