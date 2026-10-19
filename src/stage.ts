export interface StageSession {
  guildId: string;
  voiceChannelId: string;
  announcementChannelId: string;
  hostId: string;
  coHostIds: string[];
  currentSpeakerId: string | null;
}

export class StageStore {
  private readonly stages = new Map<string, StageSession>();

  private key(guildId: string, voiceChannelId: string): string {
    return `${guildId}:${voiceChannelId}`;
  }

  start(guildId: string, voiceChannelId: string, announcementChannelId: string, hostId: string): StageSession {
    const session = this.get(guildId, voiceChannelId) ?? {
      guildId,
      voiceChannelId,
      announcementChannelId,
      hostId,
      coHostIds: [],
      currentSpeakerId: null,
    };
    session.announcementChannelId = announcementChannelId;
    session.hostId = hostId;
    this.stages.set(this.key(guildId, voiceChannelId), session);
    return { ...session };
  }

  get(guildId: string, voiceChannelId: string): StageSession | undefined {
    const session = this.stages.get(this.key(guildId, voiceChannelId));
    return session ? { ...session } : undefined;
  }

  setCurrentSpeaker(guildId: string, voiceChannelId: string, userId: string | null): void {
    const session = this.stages.get(this.key(guildId, voiceChannelId));
    if (session) session.currentSpeakerId = userId;
  }

  setHost(guildId: string, voiceChannelId: string, userId: string): void {
    const session = this.stages.get(this.key(guildId, voiceChannelId));
    if (session) session.hostId = userId;
  }

  setCoHost(guildId: string, voiceChannelId: string, userId: string, enabled: boolean): void {
    const session = this.stages.get(this.key(guildId, voiceChannelId));
    if (!session || userId === session.hostId) return;
    session.coHostIds = enabled
      ? [...new Set([...session.coHostIds, userId])]
      : session.coHostIds.filter((coHostId) => coHostId !== userId);
  }

  stop(guildId: string, voiceChannelId: string): StageSession | undefined {
    const key = this.key(guildId, voiceChannelId);
    const session = this.stages.get(key);
    this.stages.delete(key);
    return session ? { ...session } : undefined;
  }
}