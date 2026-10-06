import { AppError } from "./errors";
export class ConcurrencyLimiter {
  private active = 0;
  private queue: (() => void)[] = [];
  constructor(
    private limit: number,
    private maxQueue = 30,
  ) {}
  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      if (this.queue.length >= this.maxQueue)
        throw new AppError(429, "Service occupé. Réessayez plus tard.", "BUSY");
      await new Promise<void>((resolve) => this.queue.push(resolve));
    } else this.active++;
    try {
      return await task();
    } finally {
      const next = this.queue.shift();
      if (next) next();
      else this.active--;
    }
  }
}
