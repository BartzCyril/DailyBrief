import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
export function createDb(url: string) {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
}
export type Db = ReturnType<typeof createDb>;
