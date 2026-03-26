import type { ProgressConfig } from '../types';

export class ProgressTracker {
  private sentCount = 0;
  private lastUpdate = 0;
  private startTime: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private currentActivity: string = 'waiting';

  constructor(
    private config: ProgressConfig,
    private onSend: (elapsedMs: number, activity: string) => Promise<void>
  ) {
    this.startTime = Date.now();
  }

  start(): void {
    this.timer = setInterval(() => {
      this.checkAndSend();
    }, 5000);
  }

  updateActivity(activity: string): void {
    this.currentActivity = activity;
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async checkAndSend(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.startTime;
    const shouldSend = this.shouldSendUpdate(elapsed);

    if (shouldSend && this.sentCount < (this.config.maxMessages ?? 5)) {
      await this.onSend(elapsed, this.currentActivity);
      this.sentCount++;
      this.lastUpdate = now;
    }
  }

  private shouldSendUpdate(elapsedMs: number): boolean {
    if (this.sentCount === 0) {
      return elapsedMs >= (this.config.initialDelayMs ?? 180000);
    }
    return (elapsedMs - this.lastUpdate) >= (this.config.intervalMs ?? 180000);
  }
}
