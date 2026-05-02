const { PrismaClient } = require('@prisma/client');
import { logger } from '../utils/logger';

type PrismaClientType = InstanceType<typeof PrismaClient>;

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClientType };

export const prisma: PrismaClientType =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['query', 'warn', 'error'] : ['warn', 'error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

export async function connectDb(): Promise<void> {
  await prisma.$connect();
  logger.info('Database connected');
}

export async function disconnectDb(): Promise<void> {
  await prisma.$disconnect();
  logger.info('Database disconnected');
}
