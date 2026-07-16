import Fastify from 'fastify'
import { createRequire } from 'node:module'
import { randomBytes } from 'node:crypto'
import { access, mkdir, writeFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import cors from '@fastify/cors'
import jwt from '@fastify/jwt'
import { z } from 'zod'
import { config } from './config.js'
import { prisma } from './db.js'
import { getOrCreateAnonymousUser, requireUser, userId } from './auth.js'
import { callModel, type InputMessage } from './model.js'
import { actionHintForResult, classifyAndPersist, resolveClassifyText, summarizeApplied, tryRuleExtract } from './classify.js'
import { recognizeFoodLabel } from './foodLabel.js'
import { parseReceipt } from './receipt.js'
import { refreshJournalForUser, startDailyJournalScheduler, yesterdayKey } from './journal.js'
import { ensureRecurringSchedules } from './recurringSchedules.js'

const require = createRequire(import.meta.url)
const prettyLoggerTarget = require.resolve('pino-pretty')
const uploadDir = path.resolve(process.cwd(), 'uploads')
const originalDir = path.join(uploadDir, 'originals')
const thumbnailDir = path.join(uploadDir, 'thumbs')
await mkdir(originalDir, { recursive: true })
await mkdir(thumbnailDir, { recursive: true })

const saveMessageImages = async (images: string[] | undefined) => {
  if (!images?.length) return undefined
  const paths: string[] = []
  for (const image of images.slice(0, 3)) {
    const match = image.match(/^data:image\/(jpeg|jpg|png|webp);base64,(.+)$/)
    if (!match) {
      if (image.startsWith('/v1/uploads/')) paths.push(image)
      continue
    }
    const extension = match[1] === 'jpeg' || match[1] === 'jpg' ? 'jpg' : match[1]
    const filename = `${Date.now()}-${randomBytes(8).toString('hex')}.${extension}`
    const originalPath = path.join(originalDir, filename)
    const thumbnailPath = path.join(thumbnailDir, filename)
    await writeFile(originalPath, match[2], 'base64')
    await sharp(originalPath).resize({ width: 480, height: 480, fit: 'inside', withoutEnlargement: true }).toFile(thumbnailPath)
    paths.push(`/v1/uploads/thumbs/${filename}`)
  }
  return paths.length ? paths : undefined
}

const pagination = (query: unknown) => {
  const value = z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(50).default(20) }).parse(query || {})
  return { ...value, skip: (value.page - 1) * value.pageSize }
}

const pageResult = <T>(items: T[], total: number, page: number, pageSize: number) => ({ items, total, page, pageSize, hasMore: page * pageSize < total })

const app = Fastify({
  bodyLimit: config.BODY_LIMIT_MB * 1024 * 1024,
  logger: {
    level: config.LOG_LEVEL,
    transport: {
      target: prettyLoggerTarget,
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
        singleLine: true,
      },
    },
  },
})
await app.register(cors, { origin: config.CORS_ORIGIN === '*' ? true : config.CORS_ORIGIN.split(',') })
await app.register(jwt, { secret: config.JWT_SECRET })

app.get('/health', async () => ({ ok: true, service: 'life-ai-backend' }))

app.get('/v1/uploads/:filename', async (request, reply) => {
  const { filename } = z.object({ filename: z.string().regex(/^[A-Za-z0-9._-]+$/) }).parse(request.params)
  const filePath = path.join(originalDir, filename)
  try {
    await access(filePath)
    const extension = path.extname(filename).toLowerCase()
    const contentType = extension === '.png' ? 'image/png' : extension === '.webp' ? 'image/webp' : 'image/jpeg'
    return reply.type(contentType).send(createReadStream(filePath))
  } catch {
    return reply.code(404).send({ error: '图片不存在' })
  }
})

app.get('/v1/uploads/:kind/:filename', async (request, reply) => {
  const { kind, filename } = z.object({ kind: z.enum(['originals', 'thumbs']), filename: z.string().regex(/^[A-Za-z0-9._-]+$/) }).parse(request.params)
  const filePath = path.join(uploadDir, kind, filename)
  try {
    await access(filePath)
    const extension = path.extname(filename).toLowerCase()
    const contentType = extension === '.png' ? 'image/png' : extension === '.webp' ? 'image/webp' : 'image/jpeg'
    return reply.type(contentType).send(createReadStream(filePath))
  } catch {
    return reply.code(404).send({ error: '图片不存在' })
  }
})

app.post('/v1/auth/anonymous', async (request, reply) => {
  const body = z.object({ externalId: z.string().max(200).optional() }).parse(request.body || {})
  const user = await getOrCreateAnonymousUser(body.externalId)
  return reply.send({ userId: user.id, token: app.jwt.sign({ userId: user.id }) })
})

app.post('/v1/auth/share-code/join', async (request, reply) => {
  const body = z.object({ shareCode: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{8}$/) }).parse(request.body || {})
  const user = await prisma.user.findUnique({ where: { shareCode: body.shareCode } })
  if (!user) return reply.code(404).send({ error: '共享码不存在或已失效' })
  return reply.send({ userId: user.id, token: app.jwt.sign({ userId: user.id }) })
})

app.register(async (api) => {
  api.addHook('preHandler', requireUser)

  api.get('/v1/conversations', async (request) => {
    return prisma.conversation.findMany({ where: { userId: userId(request) }, orderBy: { updatedAt: 'desc' }, take: 50 })
  })

  api.post('/v1/conversations', async (request) => {
    const body = z.object({ title: z.string().max(100).optional() }).parse(request.body || {})
    return prisma.conversation.create({ data: { userId: userId(request), title: body.title || '新对话' } })
  })

  api.post('/v1/auth/share-code', async (request) => {
    const uid = userId(request)
    const existing = await prisma.user.findUnique({ where: { id: uid }, select: { shareCode: true } })
    if (existing?.shareCode) return { shareCode: existing.shareCode }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const shareCode = randomBytes(5).toString('hex').slice(0, 8).toUpperCase()
      try {
        await prisma.user.update({ where: { id: uid }, data: { shareCode } })
        return { shareCode }
      } catch (error) {
        if (attempt === 4) throw error
      }
    }
    throw new Error('共享码生成失败')
  })

  api.get('/v1/conversations/:id/messages', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params)
    const conversation = await prisma.conversation.findFirst({ where: { id, userId: userId(request) } })
    if (!conversation) return reply.code(404).send({ error: '会话不存在' })
    return prisma.message.findMany({ where: { conversationId: id }, orderBy: { createdAt: 'asc' } })
  })

  api.delete('/v1/conversations/:id', async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params)
    const conversation = await prisma.conversation.findFirst({ where: { id, userId: userId(request) }, select: { id: true } })
    if (!conversation) return { ok: true }
    await prisma.$transaction(async (tx) => {
      await tx.message.deleteMany({ where: { conversationId: id } })
      await tx.conversation.delete({ where: { id } })
    })
    return { ok: true }
  })

  api.post('/v1/chat', async (request, reply) => {
    const body = z.object({
      conversationId: z.string().optional(),
      messages: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(20000), images: z.array(z.string()).max(3).optional() })).min(1),
    }).parse(request.body)
    const uid = userId(request)
    let conversation = body.conversationId
      ? await prisma.conversation.findFirst({ where: { id: body.conversationId, userId: uid } })
      : null
    if (!conversation) conversation = await prisma.conversation.create({ data: { userId: uid, title: body.messages.find((item) => item.role === 'user')?.content.slice(0, 80) || '新对话' } })
    const input = body.messages.slice(-12) as InputMessage[]
    const last = input[input.length - 1]
    const storedImages = await saveMessageImages(last.images)
    await prisma.message.create({ data: { conversationId: conversation.id, role: last.role, content: last.content, images: storedImages } })
    try {
      if (/更新|修改|补充|重写/.test(last.content) && /昨天.*日记|日记.*昨天|日记/.test(last.content)) {
        const content = '好的，我会在后台更新昨天的日记，请稍后到日记模块查看。'
        await prisma.message.create({ data: { conversationId: conversation.id, role: 'assistant', content, model: 'journal-background' } })
        await prisma.conversation.update({ where: { id: conversation.id }, data: { updatedAt: new Date() } })
        void refreshJournalForUser(uid, yesterdayKey())
        return { conversationId: conversation.id, content, applied: null, ledgerBatch: null }
      }
      const classifyText = await resolveClassifyText(conversation.id, last.content)
      const preview = tryRuleExtract(classifyText)
      const content = await callModel(input, actionHintForResult(preview, last.content))
      const assistantMessage = await prisma.message.create({ data: { conversationId: conversation.id, role: 'assistant', content, model: config.OPENROUTER_MODEL } })
      await prisma.conversation.update({ where: { id: conversation.id }, data: { updatedAt: new Date() } })
      let applied: string | null = null
      const ledgerBatch = preview?.category === 'ledger' && Array.isArray(preview.data.items) ? preview.data.items : null
      if (preview && !ledgerBatch) {
        const extraction = await classifyAndPersist(uid, assistantMessage.id, last.content, conversation.id)
        applied = extraction?.status === 'applied' ? summarizeApplied(extraction) : null
      } else {
        void classifyAndPersist(uid, assistantMessage.id, last.content, conversation.id)
      }
      return { conversationId: conversation.id, content, applied, ledgerBatch }
    } catch (error) {
      request.log.error(error)
      return reply.code(502).send({ error: error instanceof Error ? error.message : '模型请求失败' })
    }
  })

  api.get('/v1/notes', async (request) => {
    const page = pagination(request.query)
    const where = { userId: userId(request) }
    const [items, total] = await Promise.all([prisma.note.findMany({ where, orderBy: { updatedAt: 'desc' }, skip: page.skip, take: page.pageSize }), prisma.note.count({ where })])
    return pageResult(items, total, page.page, page.pageSize)
  })
  api.post('/v1/notes', async (request) => {
    const body = z.object({ title: z.string().min(1).max(100), content: z.string().max(100000).default(''), type: z.enum(['text', 'list']).default('text'), items: z.array(z.object({ text: z.string().min(1).max(500), done: z.boolean().default(false) })).max(200).optional() }).parse(request.body)
    return prisma.note.create({ data: { ...body, userId: userId(request) } })
  })
  api.patch('/v1/notes/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params)
    const body = z.object({ title: z.string().min(1).max(100).optional(), content: z.string().max(100000).optional(), type: z.enum(['text', 'list']).optional(), items: z.array(z.object({ text: z.string().min(1).max(500), done: z.boolean().default(false) })).max(200).optional() }).parse(request.body)
    const note = await prisma.note.findFirst({ where: { id, userId: userId(request) } })
    if (!note) return reply.code(404).send({ error: '笔记不存在' })
    return prisma.note.update({ where: { id }, data: body })
  })
  api.delete('/v1/notes/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params)
    await prisma.note.deleteMany({ where: { id, userId: userId(request) } })
    return { ok: true }
  })

  api.get('/v1/journals', async (request) => {
    const page = pagination(request.query)
    const where = { userId: userId(request) }
    const [items, total] = await Promise.all([prisma.journal.findMany({ where, orderBy: { date: 'desc' }, skip: page.skip, take: page.pageSize }), prisma.journal.count({ where })])
    return pageResult(items, total, page.page, page.pageSize)
  })
  api.patch('/v1/journals/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params)
    const body = z.object({ title: z.string().min(1).max(120).optional(), content: z.string().min(1).max(100000) }).parse(request.body)
    const journal = await prisma.journal.findFirst({ where: { id, userId: userId(request) } })
    if (!journal) return reply.code(404).send({ error: '日记不存在' })
    return prisma.journal.update({ where: { id }, data: body })
  })

  api.get('/v1/weight-records', async (request) => {
    const page = pagination(request.query)
    const where = { userId: userId(request) }
    const [items, total] = await Promise.all([prisma.weightRecord.findMany({ where, orderBy: { date: 'desc' }, skip: page.skip, take: page.pageSize }), prisma.weightRecord.count({ where })])
    return pageResult(items, total, page.page, page.pageSize)
  })
  api.post('/v1/weight-records', async (request) => {
    const body = z.object({ date: z.coerce.date(), weightKg: z.number().positive(), note: z.string().max(500).optional() }).parse(request.body)
    return prisma.weightRecord.create({ data: { userId: userId(request), date: body.date, weightKg: body.weightKg, note: body.note } })
  })
  api.delete('/v1/weight-records/:id', async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params)
    await prisma.weightRecord.deleteMany({ where: { id, userId: userId(request) } })
    return { ok: true }
  })

  api.get('/v1/food-records', async (request) => {
    const page = pagination(request.query)
    const where = { userId: userId(request) }
    const [items, total] = await Promise.all([prisma.foodRecord.findMany({ where, orderBy: { date: 'desc' }, skip: page.skip, take: page.pageSize }), prisma.foodRecord.count({ where })])
    return pageResult(items, total, page.page, page.pageSize)
  })
  api.post('/v1/food-records', async (request) => {
    const body = z.object({ date: z.coerce.date(), meal: z.string().min(1).max(40).optional(), description: z.string().min(1).max(1000), calories: z.number().nonnegative().optional(), proteinG: z.number().nonnegative().optional(), foodItemId: z.string().optional(), amountG: z.number().positive().optional() }).parse(request.body)
    let calories = body.calories
    let proteinG = body.proteinG
    if (body.foodItemId && body.amountG) {
      const food = await prisma.foodItem.findFirst({ where: { id: body.foodItemId, userId: userId(request) } })
      if (food) {
        const baseG = food.servingSizeG && food.servingSizeG > 0 ? food.servingSizeG : 100
        const ratio = body.amountG / baseG
        calories = food.caloriesPer100g == null ? calories : food.caloriesPer100g * ratio
        proteinG = food.proteinGPer100g == null ? proteinG : food.proteinGPer100g * ratio
      }
    }
    return prisma.foodRecord.create({ data: { date: body.date, meal: body.meal || '全天', description: body.description, calories, proteinG, foodItemId: body.foodItemId, amountG: body.amountG, userId: userId(request) } })
  })
  api.patch('/v1/food-records/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params)
    const body = z.object({
      date: z.coerce.date().optional(),
      amountG: z.number().positive().nullable().optional(),
      description: z.string().min(1).max(1000).optional(),
      calories: z.number().nonnegative().nullable().optional(),
      proteinG: z.number().nonnegative().nullable().optional(),
    }).parse(request.body)
    const record = await prisma.foodRecord.findFirst({ where: { id, userId: userId(request) } })
    if (!record) return reply.code(404).send({ error: '饮食记录不存在' })

    const nextAmount = body.amountG !== undefined ? body.amountG : record.amountG
    let calories = body.calories !== undefined ? body.calories : record.calories
    let proteinG = body.proteinG !== undefined ? body.proteinG : record.proteinG
    if (record.foodItemId && body.amountG !== undefined && nextAmount != null && nextAmount > 0) {
      const food = await prisma.foodItem.findFirst({ where: { id: record.foodItemId, userId: userId(request) } })
      if (food) {
        const baseG = food.servingSizeG && food.servingSizeG > 0 ? food.servingSizeG : 100
        const ratio = nextAmount / baseG
        calories = food.caloriesPer100g == null ? calories : food.caloriesPer100g * ratio
        proteinG = food.proteinGPer100g == null ? proteinG : food.proteinGPer100g * ratio
      }
    }

    return prisma.foodRecord.update({
      where: { id },
      data: {
        date: body.date,
        amountG: body.amountG === undefined ? undefined : body.amountG,
        description: body.description,
        calories,
        proteinG,
      },
    })
  })
  api.delete('/v1/food-records/:id', async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params)
    await prisma.foodRecord.deleteMany({ where: { id, userId: userId(request) } })
    return { ok: true }
  })

  api.get('/v1/ledger/months', async (request) => {
    const rows = await prisma.ledgerRecord.findMany({
      where: { userId: userId(request) },
      select: { date: true, type: true, amount: true },
      orderBy: { date: 'desc' },
    })
    const grouped = new Map()
    for (const row of rows) {
      const date = new Date(row.date)
      const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
      const current = grouped.get(month) || { month, income: 0, expense: 0, count: 0 }
      const amount = Number(row.amount) || 0
      if (row.type === 'income') current.income += amount
      else current.expense += amount
      current.count += 1
      grouped.set(month, current)
    }
    return [...grouped.values()].sort((a, b) => (a.month < b.month ? 1 : -1))
  })
  api.get('/v1/ledger', async (request) => {
    const query = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/).optional() }).merge(z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(50).default(20) })).parse(request.query || {})
    const uid = userId(request)
    const page = { ...query, skip: (query.page - 1) * query.pageSize }
    let where: { userId: string; date?: { gte: Date; lt: Date } } = { userId: uid }
    if (query.month) {
      const [year, month] = query.month.split('-').map(Number)
      const start = new Date(year, month - 1, 1)
      const end = new Date(year, month, 1)
      where = { userId: uid, date: { gte: start, lt: end } }
    }
    const [items, total] = await Promise.all([prisma.ledgerRecord.findMany({ where, orderBy: [{ date: 'desc' }, { createdAt: 'desc' }], skip: page.skip, take: page.pageSize }), prisma.ledgerRecord.count({ where })])
    return pageResult(items, total, page.page, page.pageSize)
  })
  api.post('/v1/ledger', async (request) => {
    const body = z.object({ type: z.enum(['income', 'expense']), amount: z.number().positive(), category: z.string().min(1).max(40), description: z.string().max(500).optional(), date: z.coerce.date() }).parse(request.body)
    return prisma.ledgerRecord.create({ data: { ...body, userId: userId(request) } })
  })
  api.post('/v1/ledger/batch', async (request) => {
    const body = z.object({ items: z.array(z.object({ type: z.enum(['income', 'expense']), amount: z.number().positive(), category: z.string().min(1).max(40), description: z.string().max(500).optional(), date: z.coerce.date() })).min(1).max(50) }).parse(request.body)
    return prisma.$transaction(body.items.map((item) => prisma.ledgerRecord.create({ data: { ...item, userId: userId(request) } })))
  })
  api.delete('/v1/ledger/:id', async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params)
    await prisma.ledgerRecord.deleteMany({ where: { id, userId: userId(request) } })
    return { ok: true }
  })

  api.get('/v1/schedules', async (request) => {
    const page = pagination(request.query)
    const completedParam = z.object({ completed: z.enum(['true', 'false']).optional() }).parse(request.query || {}).completed
    const where: Record<string, unknown> = { userId: userId(request) }
    if (completedParam === 'true') where.completed = true
    else if (completedParam === 'false') where.completed = false
    const orderBy = completedParam === 'true' ? { updatedAt: 'desc' as const } : { startAt: 'asc' as const }
    const [items, total] = await Promise.all([prisma.schedule.findMany({ where, orderBy, skip: page.skip, take: page.pageSize }), prisma.schedule.count({ where })])
    return pageResult(items, total, page.page, page.pageSize)
  })
  api.post('/v1/schedules', async (request, reply) => {
    const body = z.object({ title: z.string().min(1).max(120), startAt: z.coerce.date(), endAt: z.coerce.date().optional(), notes: z.string().max(2000).optional(), repeat: z.enum(['none', 'daily', 'weekly', 'monthly', 'custom']).default('none'), reminderMinutes: z.number().int().min(0).nullable().optional(), customRepeatDays: z.number().int().min(1).nullable().optional() }).parse(request.body)
    if (body.endAt && body.endAt < body.startAt) return reply.code(400).send({ error: '结束时间不能早于开始时间' })
    if (body.repeat === 'custom' && !body.customRepeatDays) return reply.code(400).send({ error: '自定义重复需要指定重复天数' })
    return prisma.schedule.create({ data: { ...body, userId: userId(request) } })
  })
  api.patch('/v1/schedules/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params)
    const body = z.object({ title: z.string().min(1).max(120).optional(), startAt: z.coerce.date().optional(), endAt: z.coerce.date().nullable().optional(), notes: z.string().max(2000).optional(), completed: z.boolean().optional(), repeat: z.enum(['none', 'daily', 'weekly', 'monthly', 'custom']).optional(), reminderMinutes: z.number().int().min(0).nullable().optional(), customRepeatDays: z.number().int().min(1).nullable().optional() }).parse(request.body)
    const schedule = await prisma.schedule.findFirst({ where: { id, userId: userId(request) } })
    if (!schedule) return reply.code(404).send({ error: '日程不存在' })
    return prisma.schedule.update({ where: { id }, data: body })
  })
  api.delete('/v1/schedules/:id', async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params)
    await prisma.schedule.deleteMany({ where: { id, userId: userId(request) } })
    return { ok: true }
  })

  api.post('/v1/food-label/recognize', async (request) => {
    const body = z.object({ images: z.array(z.string()).min(1).max(3) }).parse(request.body)
    return recognizeFoodLabel(body.images)
  })
  api.post('/v1/food-label/recognize-and-save', async (request) => {
    const body = z.object({ images: z.array(z.string()).min(1).max(3), name: z.string().max(100).optional() }).parse(request.body)
    const uid = userId(request)
    const work = (async () => {
      const label = await recognizeFoodLabel(body.images)
      const name = (body.name?.trim() || label.name || '未命名食品').replace(/\s+/g, ' ').slice(0, 100)
      const nutrition = label.nutritionPer100g
      const valid = Number(label.confidence) >= 0.7 && [nutrition.calories, nutrition.proteinG, nutrition.fatG, nutrition.carbsG].some((value) => value != null && Number.isFinite(Number(value)))
      if (!valid) return { label: { ...label, name }, saved: null }
      const existing = await prisma.foodItem.findFirst({ where: { userId: uid, name } })
      if (existing) return { label: { ...label, name }, saved: { ...existing, alreadyExists: true } }
      const created = await prisma.foodItem.create({ data: { userId: uid, name, servingSizeG: label.servingSizeG, caloriesPer100g: nutrition.calories, proteinGPer100g: nutrition.proteinG, fatGPer100g: nutrition.fatG, carbsGPer100g: nutrition.carbsG, sugarGPer100g: nutrition.sugarG, fiberGPer100g: nutrition.fiberG, sodiumMgPer100g: nutrition.sodiumMg } })
      return { label: { ...label, name }, saved: { ...created, alreadyExists: false } }
    })()
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 10_000))
    const result = await Promise.race([work, timeout])
    if (result !== null) return result
    void work.catch((error) => request.log.error({ err: error }, 'food label background save failed'))
    return { processing: true, content: '图片识别时间较长，已在后台继续处理。请稍后到食物库查看结果。' }
  })
  api.post('/v1/receipt/parse', async (request) => {
    const body = z.object({ images: z.array(z.string()).min(1).max(3), source: z.enum(['jd', 'taobao', 'other']).default('other') }).parse(request.body)
    return parseReceipt(body.images, body.source)
  })
  api.get('/v1/food-items', async (request) => {
    const query = z.object({ search: z.string().trim().max(200).optional() }).parse(request.query || {})
    const page = pagination(request.query)
    const where: { userId: string; name?: { contains: string } } = { userId: userId(request) }
    if (query.search) where.name = { contains: query.search }
    const select = {
      id: true,
      name: true,
      servingSizeG: true,
      caloriesPer100g: true,
      proteinGPer100g: true,
      fatGPer100g: true,
      carbsGPer100g: true,
      sugarGPer100g: true,
      fiberGPer100g: true,
      sodiumMgPer100g: true,
      createdAt: true,
      updatedAt: true,
    } as const
    const [items, total] = await Promise.all([prisma.foodItem.findMany({ where, orderBy: { updatedAt: 'desc' }, skip: page.skip, take: page.pageSize, select }), prisma.foodItem.count({ where })])
    return pageResult(items, total, page.page, page.pageSize)
  })
  api.post('/v1/food-items', async (request) => {
    const body = z.object({ name: z.string().min(1).max(200), servingSizeG: z.number().positive().nullable().optional(), nutritionPer100g: z.object({ calories: z.number().nullable().optional(), proteinG: z.number().nullable().optional(), fatG: z.number().nullable().optional(), carbsG: z.number().nullable().optional(), sugarG: z.number().nullable().optional(), fiberG: z.number().nullable().optional(), sodiumMg: z.number().nullable().optional() }), sourceImage: z.string().optional() }).parse(request.body)
    const uid = userId(request)
    const name = body.name.trim().replace(/\s+/g, ' ')
    const existing = await prisma.foodItem.findFirst({ where: { userId: uid, name } })
    if (existing) return { ...existing, alreadyExists: true }
    const created = await prisma.foodItem.create({ data: { userId: uid, name, servingSizeG: body.servingSizeG, caloriesPer100g: body.nutritionPer100g.calories, proteinGPer100g: body.nutritionPer100g.proteinG, fatGPer100g: body.nutritionPer100g.fatG, carbsGPer100g: body.nutritionPer100g.carbsG, sugarGPer100g: body.nutritionPer100g.sugarG, fiberGPer100g: body.nutritionPer100g.fiberG, sodiumMgPer100g: body.nutritionPer100g.sodiumMg } })
    return { ...created, alreadyExists: false }
  })
  api.patch('/v1/food-items/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params)
    const body = z.object({ name: z.string().min(1).max(200).optional(), servingSizeG: z.number().positive().nullable().optional(), caloriesPer100g: z.number().nonnegative().nullable().optional(), proteinGPer100g: z.number().nonnegative().nullable().optional(), fatGPer100g: z.number().nonnegative().nullable().optional(), carbsGPer100g: z.number().nonnegative().nullable().optional(), sugarGPer100g: z.number().nonnegative().nullable().optional(), fiberGPer100g: z.number().nonnegative().nullable().optional(), sodiumMgPer100g: z.number().nonnegative().nullable().optional() }).parse(request.body)
    const item = await prisma.foodItem.findFirst({ where: { id, userId: userId(request) } })
    if (!item) return reply.code(404).send({ error: '食物不存在' })
    return prisma.foodItem.update({ where: { id }, data: body })
  })
  api.delete('/v1/food-items/:id', async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params)
    await prisma.foodItem.deleteMany({ where: { id, userId: userId(request) } })
    return { ok: true }
  })

  api.get('/v1/shopping-items', async (request) => {
    const query = z.object({ listType: z.enum(['short', 'long']).optional() }).parse(request.query || {})
    const listType = query.listType
    return prisma.shoppingItem.findMany({
      where: { userId: userId(request), ...(listType ? { listType } : {}) },
      orderBy: listType === 'long'
        ? [{ sortOrder: 'asc' }, { createdAt: 'asc' }]
        : [{ purchased: 'asc' }, { updatedAt: 'desc' }],
    })
  })
  api.post('/v1/shopping-items', async (request) => {
    const body = z.object({ name: z.string().min(1).max(100), listType: z.enum(['short', 'long']).default('short') }).parse(request.body)
    const uid = userId(request)
    const max = await prisma.shoppingItem.aggregate({ where: { userId: uid, listType: body.listType }, _max: { sortOrder: true } })
    const sortOrder = (max._max.sortOrder ?? -1) + 1
    return prisma.shoppingItem.create({ data: { userId: uid, name: body.name.trim(), listType: body.listType, purchased: false, sortOrder } })
  })
  api.put('/v1/shopping-items/reorder', async (request, reply) => {
    const body = z.object({ listType: z.enum(['long']), orderedIds: z.array(z.string().min(1)).min(1) }).parse(request.body)
    const uid = userId(request)
    const existing = await prisma.shoppingItem.findMany({ where: { userId: uid, listType: body.listType }, select: { id: true } })
    const idSet = new Set(existing.map((item) => item.id))
    if (body.orderedIds.length !== existing.length || body.orderedIds.some((id) => !idSet.has(id))) {
      return reply.code(400).send({ error: '排序列表与当前长期清单不一致' })
    }
    await prisma.$transaction(body.orderedIds.map((id, index) => prisma.shoppingItem.update({ where: { id }, data: { sortOrder: index } })))
    return { ok: true }
  })
  api.patch('/v1/shopping-items/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params)
    const body = z.object({ name: z.string().min(1).max(100).optional(), listType: z.enum(['short', 'long']).optional(), purchased: z.boolean().optional() }).parse(request.body)
    const item = await prisma.shoppingItem.findFirst({ where: { id, userId: userId(request) } })
    if (!item) return reply.code(404).send({ error: '待购项不存在' })
    const nextListType = body.listType ?? item.listType
    const data: { name?: string; listType?: 'short' | 'long'; purchased?: boolean; sortOrder?: number } = {}
    if (body.name !== undefined) data.name = body.name.trim()
    if (body.listType !== undefined) data.listType = body.listType
    if (nextListType === 'long') data.purchased = false
    else if (body.purchased !== undefined) data.purchased = body.purchased
    if (body.listType && body.listType !== item.listType) {
      const max = await prisma.shoppingItem.aggregate({ where: { userId: userId(request), listType: body.listType }, _max: { sortOrder: true } })
      data.sortOrder = (max._max.sortOrder ?? -1) + 1
    }
    return prisma.shoppingItem.update({ where: { id }, data })
  })
  api.delete('/v1/shopping-items/purchased', async (request) => {
    const result = await prisma.shoppingItem.deleteMany({ where: { userId: userId(request), listType: 'short', purchased: true } })
    return { ok: true, deleted: result.count }
  })
  api.delete('/v1/shopping-items/:id', async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params)
    await prisma.shoppingItem.deleteMany({ where: { id, userId: userId(request) } })
    return { ok: true }
  })
})

app.addHook('onClose', async () => prisma.$disconnect())
await app.listen({ port: config.PORT, host: '0.0.0.0' })
app.log.info({ port: config.PORT, model: config.OPENROUTER_MODEL, database: 'mysql' }, '拾光AI backend started')
startDailyJournalScheduler()
setInterval(() => {
  void ensureRecurringSchedules().catch((error) => app.log.error({ err: error }, 'recurring schedule sync failed'))
}, 60_000)
