import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface MemberActivityStats {
  joined: number;
  left: number;
  lastUpdatedAt: string | null;
  uniqueVoiceVisitors: number;
  averageVoiceMinutes: number;
  returnVisitors: number;
  requests: number;
  participations: number;
}

interface DailyStats {
  visitors: string[];
  voiceMinutes: number;
  requests: number;
  participations: number;
}

interface StoredStats {
  guilds: Record<string, MemberActivityStats>;
  daily?: Record<string, DailyStats>;
}

const emptyStats = (): MemberActivityStats => ({ joined: 0, left: 0, lastUpdatedAt: null, uniqueVoiceVisitors: 0, averageVoiceMinutes: 0, returnVisitors: 0, requests: 0, participations: 0 });

export class MemberStatsStore {
  private readonly stats = new Map<string, MemberActivityStats>();
  private readonly daily = new Map<string, DailyStats>();
  private readonly voiceSessions = new Map<string, number>();
  private loaded = false;

  constructor(private readonly filePath = process.env.MEMBER_STATS_FILE ?? 'data/member-stats.json') {}

  async load(): Promise<void> {
    try {
      const stored = JSON.parse(await readFile(this.filePath, 'utf8')) as StoredStats;
      for (const [guildId, stats] of Object.entries(stored.guilds ?? {})) {
        this.stats.set(guildId, { ...emptyStats(), ...stats });
      }
      for (const [key, stats] of Object.entries(stored.daily ?? {})) {
        this.daily.set(key, stats);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('Could not load member activity stats:', error);
      }
    }
    this.loaded = true;
  }

  get(guildId: string): MemberActivityStats {
    const stats = this.stats.get(guildId) ?? emptyStats();
    return { ...stats };
  }

  recordJoined(guildId: string): void {
    this.record(guildId, 'joined');
  }

  recordLeft(guildId: string): void {
    this.record(guildId, 'left');
  }

  recordVoiceJoin(guildId: string, userId: string): void {
    if (!this.loaded) return;
    const key = `${guildId}:${userId}`;
    if (!this.voiceSessions.has(key)) this.voiceSessions.set(key, Date.now());
    const day = this.getDaily(guildId);
    if (!day.visitors.includes(userId)) day.visitors.push(userId);
    this.refresh(guildId);
  }

  recordVoiceLeave(guildId: string, userId: string): void {
    const startedAt = this.voiceSessions.get(`${guildId}:${userId}`);
    if (startedAt === undefined) return;
    this.voiceSessions.delete(`${guildId}:${userId}`);
    this.getDaily(guildId).voiceMinutes += Math.max(0, (Date.now() - startedAt) / 60000);
    this.refresh(guildId);
  }

  recordRequest(guildId: string): void {
    this.getDaily(guildId).requests += 1;
    this.refresh(guildId);
  }

  recordParticipation(guildId: string): void {
    this.getDaily(guildId).participations += 1;
    this.refresh(guildId);
  }

  private getDaily(guildId: string): DailyStats {
    const key = `${guildId}:${new Date().toISOString().slice(0, 10)}`;
    const stats = this.daily.get(key) ?? { visitors: [], voiceMinutes: 0, requests: 0, participations: 0 };
    this.daily.set(key, stats);
    return stats;
  }

  private refresh(guildId: string): void {
    const current = this.stats.get(guildId) ?? emptyStats();
    const daily = this.getDaily(guildId);
    current.uniqueVoiceVisitors = daily.visitors.length;
    current.averageVoiceMinutes = daily.visitors.length ? Number((daily.voiceMinutes / daily.visitors.length).toFixed(1)) : 0;
    current.returnVisitors = daily.visitors.filter((userId) => this.hasPreviousVisit(guildId, userId)).length;
    current.requests = daily.requests;
    current.participations = daily.participations;
    current.lastUpdatedAt = new Date().toISOString();
    this.stats.set(guildId, current);
    void this.save();
  }

  private hasPreviousVisit(guildId: string, userId: string): boolean {
    const today = new Date().toISOString().slice(0, 10);
    return [...this.daily.entries()].some(([key, stats]) => key.startsWith(`${guildId}:`) && !key.endsWith(today) && stats.visitors.includes(userId));
  }

  private record(guildId: string, activity: 'joined' | 'left'): void {
    if (!this.loaded) return;
    const stats = this.stats.get(guildId) ?? emptyStats();
    stats[activity] += 1;
    stats.lastUpdatedAt = new Date().toISOString();
    this.stats.set(guildId, stats);
    void this.save();
  }

  private async save(): Promise<void> {
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(this.filePath, JSON.stringify({ guilds: Object.fromEntries(this.stats), daily: Object.fromEntries(this.daily) }, null, 2));
    } catch (error) {
      console.error('Could not save member activity stats:', error);
    }
  }
}