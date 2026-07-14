import { prisma } from './db.js'

type Repeat = 'daily' | 'weekly' | 'monthly'

const groupKey = (item: { userId: string; title: string; notes: string | null; repeat: string; reminderMinutes: number | null }) =>
  JSON.stringify([item.userId, item.title, item.notes || '', item.repeat, item.reminderMinutes])

const nextDate = (date: Date, repeat: Repeat) => {
  const next = new Date(date)
  if (repeat === 'daily') next.setUTCDate(next.getUTCDate() + 1)
  else if (repeat === 'weekly') next.setUTCDate(next.getUTCDate() + 7)
  else next.setUTCMonth(next.getUTCMonth() + 1)
  return next
}

export async function ensureRecurringSchedules() {
  const recurring = await prisma.schedule.findMany({ where: { repeat: { not: 'none' } }, orderBy: { startAt: 'asc' } })
  const latestByGroup = new Map<string, (typeof recurring)[number]>()
  for (const item of recurring) {
    const key = groupKey(item)
    const current = latestByGroup.get(key)
    if (!current || item.startAt > current.startAt) latestByGroup.set(key, item)
  }

  let created = 0
  for (const latest of latestByGroup.values()) {
    const nextStart = nextDate(latest.startAt, latest.repeat as Repeat)
    const exists = await prisma.schedule.findFirst({
      where: {
        userId: latest.userId,
        title: latest.title,
        notes: latest.notes,
        repeat: latest.repeat,
        reminderMinutes: latest.reminderMinutes,
        startAt: nextStart,
      },
      select: { id: true },
    })
    if (exists) continue
    const duration = latest.endAt ? latest.endAt.getTime() - latest.startAt.getTime() : null
    await prisma.schedule.create({
      data: {
        userId: latest.userId,
        title: latest.title,
        startAt: nextStart,
        endAt: duration == null ? null : new Date(nextStart.getTime() + duration),
        notes: latest.notes,
        completed: false,
        repeat: latest.repeat,
        reminderMinutes: latest.reminderMinutes,
      },
    })
    created += 1
  }
  return created
}
