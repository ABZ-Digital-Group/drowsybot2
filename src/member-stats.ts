import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface MemberActivityStats {
  joined: number;
  left: number;
  lastUpdatedAt: string | null;
  uniqueVoiceVisitors: number;
  averageVoiceMinutes: number;
  returnVisitors: number;
  requests: number;
  participations: number;
  messages: number;
  reactions: number;
  presenceUpdates: number;
  games: Record<string, number>;
}

export interface VoiceActivitySession {
  sessionId: string;
  guildId: string;
  guildName: string;
  userId: string;
  userName: string;
  channelId: string;
  channelName: string;
  startedAt: string;
  endedAt: string;
  durationSeconds: number;
}

export interface DailyActivitySnapshot {
  date: string;
  uniqueActiveMembers: number;
  uniqueVoiceVisitors: number;
  voiceMinutes: number;
  messages: number;
  reactions: number;
  joins: number;
  leaves: number;
  requests: number;
  participations: number;
  presenceUpdates: number;
  games: Record<string, number>;
}

interface DailyStats {
  visitors: string[];
  activeUsers: string[];
  voiceMinutes: number;
  messages: number;
  reactions: number;
  joins: number;
  leaves: number;
  requests: number;
  participations: number;
  presenceUpdates: number;
  games: Record<string, number>;
}

interface StoredStats {
  guilds: Record<string, MemberActivityStats>;
  daily?: Record<string, DailyStats>;
  sessions?: VoiceActivitySession[];
}

const emptyStats = (): MemberActivityStats => ({
  joined: 0,
  left: 0,
  lastUpdatedAt: null,
  uniqueVoiceVisitors: 0,
  averageVoiceMinutes: 0,
  returnVisitors: 0,
  requests: 0,
  participations: 0,
  messages: 0,
  reactions: 0,
  presenceUpdates: 0,
  games: {},
});
const emptyDailyStats = (): DailyStats => ({
  visitors: [],
  activeUsers: [],
  voiceMinutes: 0,
  messages: 0,
  reactions: 0,
  joins: 0,
  leaves: 0,
  requests: 0,
  participations: 0,
  presenceUpdates: 0,
  games: {},
});

export class MemberStatsStore {
  private readonly stats = new Map<string, MemberActivityStats>();
  private readonly daily = new Map<string, DailyStats>();
  private readonly voiceSessions = new Map<string, {
    sessionId: string;
    guildId: string;
    guildName: string;
    userId: string;
    userName: string;
    channelId: string;
    channelName: string;
    startedAt: string;
  }>();
  private readonly sessions: VoiceActivitySession[] = [];
  private loaded = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly filePath = process.env.MEMBER_STATS_FILE ?? 'data/member-stats.json') {}

  async load(): Promise<void> {
    try {
      const stored = JSON.parse(await readFile(this.filePath, 'utf8')) as StoredStats;
      for (const [guildId, stats] of Object.entries(stored.guilds ?? {})) {
        this.stats.set(guildId, { ...emptyStats(), ...stats });
      }
      for (const [key, stats] of Object.entries(stored.daily ?? {})) {
        this.daily.set(key, {
          ...emptyDailyStats(),
          ...stats,
          visitors: [...(stats.visitors ?? [])],
          activeUsers: [...(stats.activeUsers ?? [])],
          games: { ...(stats.games ?? {}) },
        });
      }
      this.sessions.push(...(stored.sessions ?? []));
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

  getVoiceSessions(): VoiceActivitySession[] {
    return this.sessions.map((session) => ({ ...session }));
  }

  getDailyHistory(guildId: string, requestedDays = 14): DailyActivitySnapshot[] {
    const days = Math.min(90, Math.max(1, Math.floor(requestedDays) || 14));
    const now = new Date();
    const endMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
    const firstDayMs = endMs - (days * 24 * 60 * 60 * 1000);

    return Array.from({ length: days }, (_, index) => {
      const date = new Date(firstDayMs + (index * 24 * 60 * 60 * 1000)).toISOString().slice(0, 10);
      const daily = this.daily.get(`${guildId}:${date}`) ?? emptyDailyStats();
      return {
        date,
        uniqueActiveMembers: daily.activeUsers.length,
        uniqueVoiceVisitors: daily.visitors.length,
        voiceMinutes: Number(daily.voiceMinutes.toFixed(1)),
        messages: daily.messages,
        reactions: daily.reactions,
        joins: daily.joins,
        leaves: daily.leaves,
        requests: daily.requests,
        participations: daily.participations,
        presenceUpdates: daily.presenceUpdates,
        games: { ...daily.games },
      };
    });
  }

  recordJoined(guildId: string): void {
    this.record(guildId, 'joined');
  }

  recordLeft(guildId: string): void {
    this.record(guildId, 'left');
  }

  recordVoiceJoin(guildId: string, guildName: string, userId: string, channelId: string, channelName: string, userName: string, startedAt = new Date().toISOString()): void {
    if (!this.loaded) return;
    const key = `${guildId}:${userId}`;
    if (!this.voiceSessions.has(key)) {
      this.voiceSessions.set(key, {
        sessionId: randomUUID(),
        guildId,
        guildName,
        userId,
        userName,
        channelId,
        channelName,
        startedAt,
      });
    }
    const day = this.getDaily(guildId);
    if (!day.visitors.includes(userId)) day.visitors.push(userId);
    if (!day.activeUsers.includes(userId)) day.activeUsers.push(userId);
    this.refresh(guildId);
  }

  recordVoiceLeave(guildId: string, userId: string, endedAt = new Date().toISOString()): VoiceActivitySession | null {
    const activeSession = this.voiceSessions.get(`${guildId}:${userId}`);
    if (!activeSession) return null;
    this.voiceSessions.delete(`${guildId}:${userId}`);
    const durationSeconds = Math.max(0, (Date.parse(endedAt) - Date.parse(activeSession.startedAt)) / 1000);
    if (durationSeconds < 60) return null;

    const session: VoiceActivitySession = {
      ...activeSession,
      endedAt,
      durationSeconds: Math.round(durationSeconds),
    };
    this.sessions.push(session);
    this.getDaily(guildId).voiceMinutes += durationSeconds / 60;
    this.refresh(guildId);
    return session;
  }

  recordRequest(guildId: string): void {
    this.getDaily(guildId).requests += 1;
    this.refresh(guildId);
  }

  recordParticipation(guildId: string): void {
    this.getDaily(guildId).participations += 1;
    this.refresh(guildId);
  }

  recordMessage(guildId: string, userId: string): void {
    const daily = this.getDaily(guildId);
    daily.messages += 1;
    this.addActiveUser(daily, userId);
    this.refresh(guildId);
  }

  recordReaction(guildId: string, userId: string): void {
    const daily = this.getDaily(guildId);
    daily.reactions += 1;
    this.addActiveUser(daily, userId);
    this.refresh(guildId);
  }

  recordPresence(guildId: string, userId: string, activities: string[]): void {
    const daily = this.getDaily(guildId);
    daily.presenceUpdates += 1;
    this.addActiveUser(daily, userId);
    for (const activity of activities) {
      daily.games[activity] = (daily.games[activity] ?? 0) + 1;
    }
    this.refresh(guildId);
  }

  private getDaily(guildId: string): DailyStats {
    const key = `${guildId}:${new Date().toISOString().slice(0, 10)}`;
    const stats = this.daily.get(key) ?? emptyDailyStats();
    this.daily.set(key, stats);
    return stats;
  }

  private addActiveUser(daily: DailyStats, userId: string): void {
    if (userId && !daily.activeUsers.includes(userId)) daily.activeUsers.push(userId);
  }

  private refresh(guildId: string): void {
    const current = this.stats.get(guildId) ?? emptyStats();
    const daily = this.getDaily(guildId);
    current.uniqueVoiceVisitors = daily.visitors.length;
    current.averageVoiceMinutes = daily.visitors.length ? Number((daily.voiceMinutes / daily.visitors.length).toFixed(1)) : 0;
    current.returnVisitors = daily.visitors.filter((userId) => this.hasPreviousVisit(guildId, userId)).length;
    current.requests = daily.requests;
    current.participations = daily.participations;
    current.messages = daily.messages;
    current.reactions = daily.reactions;
    current.presenceUpdates = daily.presenceUpdates;
    current.games = { ...daily.games };
    current.lastUpdatedAt = new Date().toISOString();
    this.stats.set(guildId, current);
    this.scheduleSave();
  }

  private hasPreviousVisit(guildId: string, userId: string): boolean {
    const today = new Date().toISOString().slice(0, 10);
    return [...this.daily.entries()].some(([key, stats]) => key.startsWith(`${guildId}:`) && !key.endsWith(today) && stats.visitors.includes(userId));
  }

  private record(guildId: string, activity: 'joined' | 'left'): void {
    if (!this.loaded) return;
    const stats = this.stats.get(guildId) ?? emptyStats();
    stats[activity] += 1;
    const daily = this.getDaily(guildId);
    daily[activity === 'joined' ? 'joins' : 'leaves'] += 1;
    stats.lastUpdatedAt = new Date().toISOString();
    this.stats.set(guildId, stats);
    this.scheduleSave();
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.save();
    }, 1000);
  }

  private async save(): Promise<void> {
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
        await writeFile(this.filePath, JSON.stringify({
          guilds: Object.fromEntries(this.stats),
          daily: Object.fromEntries(this.daily),
          sessions: this.sessions,
        }, null, 2));
    } catch (error) {
      console.error('Could not save member activity stats:', error);
    }
  }
}