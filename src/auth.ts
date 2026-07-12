import type { FastifyReply, FastifyRequest } from 'fastify'
import { prisma } from './db.js'

export async function requireUser(request: FastifyRequest, reply: FastifyReply) {
  try {
    await request.jwtVerify()
  } catch {
    return reply.code(401).send({ error: '未登录或登录已过期' })
  }
}

export function userId(request: FastifyRequest) {
  const user = request.user as { userId?: string }
  if (!user.userId) throw new Error('无效用户')
  return user.userId
}

export async function getOrCreateAnonymousUser(externalId?: string) {
  if (externalId) {
    const existing = await prisma.user.findUnique({ where: { externalId } })
    if (existing) return existing
  }
  return prisma.user.create({ data: { externalId } })
}
