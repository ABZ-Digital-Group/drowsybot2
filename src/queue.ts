export interface QueueEntry {
  userId: string;
  displayName: string;
}

export class QueueStore {
  private readonly queues = new Map<string, QueueEntry[]>();

  private key(guildId: string, channelId: string): string {
    return `${guildId}:${channelId}`;
  }

  get(guildId: string, channelId: string): QueueEntry[] {
    return [...(this.queues.get(this.key(guildId, channelId)) ?? [])];
  }

  getQueueIds(): Array<{ guildId: string; channelId: string }> {
    return [...this.queues.keys()].map((queueId) => {
      const separator = queueId.indexOf(':');
      return { guildId: queueId.slice(0, separator), channelId: queueId.slice(separator + 1) };
    });
  }

  add(guildId: string, channelId: string, entry: QueueEntry): { added: boolean; position: number } {
    const queueKey = this.key(guildId, channelId);
    const queue = this.queues.get(queueKey) ?? [];
    if (queue.some((queuedEntry) => queuedEntry.userId === entry.userId)) {
      return { added: false, position: queue.findIndex((queuedEntry) => queuedEntry.userId === entry.userId) + 1 };
    }

    queue.push(entry);
    this.queues.set(queueKey, queue);
    return { added: true, position: queue.length };
  }

  remove(guildId: string, channelId: string, userId: string): boolean {
    const queueKey = this.key(guildId, channelId);
    const queue = this.queues.get(queueKey) ?? [];
    const index = queue.findIndex((entry) => entry.userId === userId);
    if (index === -1) {
      return false;
    }

    queue.splice(index, 1);
    this.queues.set(queueKey, queue);
    return true;
  }

  next(guildId: string, channelId: string): QueueEntry | undefined {
    const queueKey = this.key(guildId, channelId);
    const queue = this.queues.get(queueKey) ?? [];
    const nextEntry = queue.shift();
    this.queues.set(queueKey, queue);
    return nextEntry;
  }

  clear(guildId: string, channelId: string): number {
    const queueKey = this.key(guildId, channelId);
    const size = (this.queues.get(queueKey) ?? []).length;
    this.queues.set(queueKey, []);
    return size;
  }
}
