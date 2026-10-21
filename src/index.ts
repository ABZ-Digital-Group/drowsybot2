import 'dotenv/config';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  Client,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  GatewayIntentBits,
  ChannelType,
  Partials,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type ButtonInteraction,
  type Message,
} from 'discord.js';
import { QueueStore } from './queue.js';
import { MemberStatsStore } from './member-stats.js';
import { StageStore, type StageSession } from './stage.js';

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
const guildId = process.env.DISCORD_GUILD_ID;
const botApiSecret = process.env.BOT_API_SECRET;
const botApiPort = Number(process.env.BOT_API_PORT) || 8080;
const allowedLinkUserIds = new Set(
  (process.env.LINK_ALLOWED_USER_IDS ?? '')
    .split(',')
    .map((userId) => userId.trim())
    .filter(Boolean),
);

if (!token || !clientId || !guildId) {
  throw new Error('DISCORD_TOKEN, DISCORD_CLIENT_ID, and DISCORD_GUILD_ID must be set in .env');
}

const config = { token, clientId, guildId };

const commands = [
  new SlashCommandBuilder().setName('join').setDescription('Join the singing queue.'),
  new SlashCommandBuilder().setName('leave').setDescription('Leave the singing queue.'),
  new SlashCommandBuilder().setName('queue').setDescription('Show the current singing queue.'),
  new SlashCommandBuilder().setName('next').setDescription('Move the next singer to the front of the session.'),
  new SlashCommandBuilder().setName('clear').setDescription('Clear the singing queue.'),
  new SlashCommandBuilder().setName('events').setDescription('Show current and upcoming Discord events.'),
  new SlashCommandBuilder()
    .setName('stage')
    .setDescription('Manage a normal voice channel as a singing stage.')
    .addSubcommand((command) => command
      .setName('start')
      .setDescription('Start a managed singing stage.')
      .addChannelOption((option) => option
        .setName('channel')
        .setDescription('The normal voice channel to use as the stage.')
        .addChannelTypes(ChannelType.GuildVoice)
        .setRequired(true)))
    .addSubcommand((command) => command.setName('join').setDescription('Join the stage queue from your current voice channel.'))
    .addSubcommand((command) => command.setName('leave').setDescription('Leave the stage queue.'))
    .addSubcommand((command) => command.setName('queue').setDescription('Show the stage queue.'))
    .addSubcommand((command) => command.setName('next').setDescription('Call the next singer and manage their mute state.'))
    .addSubcommand((command) => command.setName('clear').setDescription('Clear the stage queue.'))
    .addSubcommand((command) => command.setName('stop').setDescription('Stop managing the current voice channel as a stage.'))
    .addSubcommand((command) => command
      .setName('host')
      .setDescription('Choose the stage host.')
      .addUserOption((option) => option.setName('user').setDescription('The new host.').setRequired(true)))
    .addSubcommand((command) => command
      .setName('cohost')
      .setDescription('Add a stage co-host.')
      .addUserOption((option) => option.setName('user').setDescription('The new co-host.').setRequired(true)))
    .addSubcommand((command) => command
      .setName('uncohost')
      .setDescription('Remove a stage co-host.')
      .addUserOption((option) => option.setName('user').setDescription('The co-host to remove.').setRequired(true))),
].map((command) => command.toJSON());

const queueStore = new QueueStore();
const stageStore = new StageStore();
const memberStatsStore = new MemberStatsStore();
const stageMuteOperations = new Map<string, Promise<void>>();
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildScheduledEvents,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.GuildMember],
});

function containsDiscordInvite(message: Message): boolean {
  return /(?:https?:\/\/)?(?:www\.)?(?:discord\.gg|discord(?:app)?\.com\/invite)\/[^\s]+/i.test(message.content);
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(payload));
}

async function readBody(request: IncomingMessage): Promise<Record<string, string>> {
  let body = '';
  for await (const chunk of request) body += chunk;
  return Object.fromEntries(new URLSearchParams(body));
}

function isAuthorized(request: IncomingMessage): boolean {
  const authorization = request.headers.authorization;
  const apiKey = request.headers['x-bot-api-key'];
  return Boolean(botApiSecret && (authorization === `Bearer ${botApiSecret}` || apiKey === botApiSecret));
}

async function startAdminApi(): Promise<void> {
  if (!botApiSecret) {
    console.warn('BOT_API_SECRET is not set; remote bot management API is disabled.');
    return;
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    if (url.pathname === '/health' && request.method === 'GET') {
      return sendJson(response, 200, { ok: true, online: client.isReady(), botUser: client.user?.tag ?? null });
    }
    if (!isAuthorized(request)) return sendJson(response, 401, { error: 'Unauthorized.' });

    try {
      if (url.pathname === '/admin/api/state' && request.method === 'GET') {
        const queues = queueStore.getQueueIds().map(({ guildId: queueGuildId, channelId }) => ({
          guildId: queueGuildId,
          channelId,
          entries: queueStore.get(queueGuildId, channelId),
        }));
        const trackedStages = stageStore.getAll().map((stage) => {
          const guild = client.guilds.cache.get(stage.guildId);
          const channel = guild?.channels.cache.get(stage.voiceChannelId);
          const entries = queueStore.get(stage.guildId, stage.voiceChannelId);
          return {
            guildId: stage.guildId,
            guildName: guild?.name ?? stage.guildId,
            channelId: stage.voiceChannelId,
            channelName: channel?.name ?? stage.voiceChannelId,
            acceptingJoins: stage.acceptingJoins,
            queueMembers: entries.map((entry) => ({ id: entry.userId, name: entry.displayName })),
            hostId: stage.hostId,
            coHostIds: stage.coHostIds,
            currentSpeaker: stage.currentSpeakerId,
            songsSung: 0,
            peakAttendance: entries.length,
            runtimeText: 'Active',
          };
        });
        const allowedInviteUsers = await Promise.all(
          [...allowedLinkUserIds].map(async (userId) => {
            try {
              const guild = guildId ? client.guilds.cache.get(guildId) : null;
              const member = guild ? (guild.members.cache.get(userId) ?? await guild.members.fetch(userId).catch(() => null)) : null;
              if (member) {
                return {
                  userId,
                  displayName: member.displayName || member.user.globalName || member.user.username,
                  avatarUrl: member.displayAvatarURL({ size: 64 }),
                };
              }

              const user = client.users.cache.get(userId) ?? await client.users.fetch(userId).catch(() => null);
              if (user) {
                return {
                  userId,
                  displayName: user.globalName || user.username || user.tag,
                  avatarUrl: user.displayAvatarURL({ size: 64 }),
                };
              }
            } catch {
              // Ignore fetch failures
            }

            return {
              userId,
              displayName: userId,
              avatarUrl: null,
            };
          }),
        );
        return sendJson(response, 200, {
          ok: true,
          online: client.isReady(),
          botUser: client.user?.tag ?? null,
          guildCount: client.guilds.cache.size,
          guilds: client.guilds.cache.map((guild) => ({
            id: guild.id,
            name: guild.name,
            textChannels: guild.channels.cache.filter((channel) => channel.isTextBased()).map((channel) => ({ id: channel.id, name: channel.name })),
            voiceChannels: guild.channels.cache.filter((channel) => channel.type === ChannelType.GuildVoice).map((channel) => ({ id: channel.id, name: channel.name })),
          })),
          queues,
          trackedStages,
          allowedInviteUsers,
          allowedInviteUserIds: [...allowedLinkUserIds],
          uptimeSeconds: process.uptime(),
          latencyMs: client.ws.ping,
          memberStats: client.guilds.cache.map((guild) => ({ guildId: guild.id, guildName: guild.name, memberCount: guild.memberCount, ...memberStatsStore.get(guild.id) })),
        });
      }

      if (url.pathname === '/admin/api/stats' && request.method === 'GET') {
        const requestedGuildId = url.searchParams.get('guildId');
        const guilds = client.guilds.cache
          .filter((guild) => !requestedGuildId || guild.id === requestedGuildId)
          .map((guild) => ({ guildId: guild.id, guildName: guild.name, memberCount: guild.memberCount, ...memberStatsStore.get(guild.id) }));
        return sendJson(response, 200, { ok: true, guilds });
      }

      if (url.pathname === '/admin/api/settings' && request.method === 'POST') {
        const body = await readBody(request);
        return sendJson(response, 200, { ok: true, settings: body });
      }

      if (url.pathname === '/admin/api/invites' && request.method === 'POST') {
        const body = await readBody(request);
        const userId = body.userId?.trim();
        if (!userId) return sendJson(response, 400, { error: 'userId is required.' });
        body.allowed === 'false' ? allowedLinkUserIds.delete(userId) : allowedLinkUserIds.add(userId);
        return sendJson(response, 200, { ok: true, allowedInviteUserIds: [...allowedLinkUserIds] });
      }

      if (url.pathname === '/admin/api/stage/start' && request.method === 'POST') {
        const body = await readBody(request);
        const targetGuildId = body.guildId || guildId!;
        if (!body.channelId || !body.hostId) return sendJson(response, 400, { error: 'channelId and hostId are required.' });
        const channel = await client.channels.fetch(body.channelId);
        if (!channel || channel.type !== ChannelType.GuildVoice || channel.guild.id !== targetGuildId) {
          return sendJson(response, 400, { error: 'channelId must identify a voice channel in the requested guild.' });
        }
        const stage = stageStore.start(targetGuildId, channel.id, body.announcementChannelId || channel.id, body.hostId);
        await applyStageMutePolicy(stage);
        return sendJson(response, 200, { ok: true, stage });
      }

      if (url.pathname === '/admin/api/stage/stop' && request.method === 'POST') {
        const body = await readBody(request);
        const targetGuildId = body.guildId || guildId!;
        if (!body.channelId) return sendJson(response, 400, { error: 'channelId is required.' });
        const stage = stageStore.get(targetGuildId, body.channelId);
        if (!stage) return sendJson(response, 404, { error: 'No active stage found.' });
        if (stage.currentSpeakerId && stage.currentSpeakerId !== stage.hostId) await setStageMute(targetGuildId, stage.currentSpeakerId, true);
        const cleared = queueStore.clear(targetGuildId, body.channelId);
        stageStore.stop(targetGuildId, body.channelId);
        return sendJson(response, 200, { ok: true, result: { stopped: true, cleared } });
      }

      if (url.pathname === '/admin/api/stage/join-toggle' && request.method === 'POST') {
        const body = await readBody(request);
        const targetGuildId = body.guildId || guildId!;
        if (!body.channelId) return sendJson(response, 400, { error: 'channelId is required.' });
        const acceptingJoins = body.acceptingJoins !== 'false';
        if (!stageStore.setAcceptingJoins(targetGuildId, body.channelId, acceptingJoins)) return sendJson(response, 404, { error: 'No active stage found.' });
        return sendJson(response, 200, { ok: true, result: { acceptingJoins } });
      }

      const stageRoleMatch = url.pathname.match(/^\/admin\/api\/stage\/(host|cohost|uncohost)$/);
      if (stageRoleMatch && request.method === 'POST') {
        const body = await readBody(request);
        const targetGuildId = body.guildId || guildId!;
        if (!body.channelId || !body.userId) return sendJson(response, 400, { error: 'channelId and userId are required.' });
        const stage = stageStore.get(targetGuildId, body.channelId);
        if (!stage) return sendJson(response, 404, { error: 'No active stage found.' });
        if (stageRoleMatch[1] === 'host') {
          stageStore.setHost(targetGuildId, body.channelId, body.userId);
        } else {
          stageStore.setCoHost(targetGuildId, body.channelId, body.userId, stageRoleMatch[1] === 'cohost');
        }
        return sendJson(response, 200, { ok: true, stage: stageStore.get(targetGuildId, body.channelId) });
      }

      const queueMatch = url.pathname.match(/^\/admin\/api\/(?:queue|stage)\/(next|clear|remove-user)$/);
      if (queueMatch && request.method === 'POST') {
        const body = await readBody(request);
        const targetGuildId = body.guildId || guildId!;
        const targetChannelId = body.channelId;
        if (!targetChannelId) return sendJson(response, 400, { error: 'channelId is required.' });
        if (queueMatch[1] === 'next' && url.pathname.startsWith('/admin/api/stage/')) {
          const stage = stageStore.get(targetGuildId, targetChannelId);
          if (!stage) return sendJson(response, 404, { error: 'No active stage found.' });
          if (stage.currentSpeakerId && stage.currentSpeakerId !== stage.hostId) await setStageMute(targetGuildId, stage.currentSpeakerId, true);
          const nextEntry = queueStore.next(targetGuildId, targetChannelId);
          stageStore.setCurrentSpeaker(targetGuildId, targetChannelId, nextEntry?.userId ?? null);
          if (nextEntry) {
            const unmuted = await setStageMute(targetGuildId, nextEntry.userId, false);
            memberStatsStore.recordParticipation(targetGuildId);
            return sendJson(response, 200, { ok: true, result: { ...nextEntry, currentSpeaker: nextEntry.userId, unmuted } });
          }
          return sendJson(response, 200, { ok: true, result: null });
        }
        if (queueMatch[1] === 'next') return sendJson(response, 200, { ok: true, result: queueStore.next(targetGuildId, targetChannelId) ?? null });
        if (queueMatch[1] === 'clear') {
          if (url.pathname.startsWith('/admin/api/stage/')) {
            const stage = stageStore.get(targetGuildId, targetChannelId);
            if (!stage) return sendJson(response, 404, { error: 'No active stage found.' });
            if (stage.currentSpeakerId && stage.currentSpeakerId !== stage.hostId) await setStageMute(targetGuildId, stage.currentSpeakerId, true);
            stageStore.setCurrentSpeaker(targetGuildId, targetChannelId, null);
          }
          return sendJson(response, 200, { ok: true, result: { cleared: queueStore.clear(targetGuildId, targetChannelId) } });
        }
        if (url.pathname.startsWith('/admin/api/stage/')) {
          const stage = stageStore.get(targetGuildId, targetChannelId);
          if (!stage) return sendJson(response, 404, { error: 'No active stage found.' });
          if (stage.currentSpeakerId === body.userId && stage.currentSpeakerId !== stage.hostId) {
            await setStageMute(targetGuildId, stage.currentSpeakerId, true);
            stageStore.setCurrentSpeaker(targetGuildId, targetChannelId, null);
          }
        }
        return sendJson(response, 200, { ok: true, result: { removed: queueStore.remove(targetGuildId, targetChannelId, body.userId ?? '') } });
      }

      if (url.pathname === '/admin/api/stage/radio' && request.method === 'POST') {
        await readBody(request);
        return sendJson(response, 200, { ok: true, result: { status: 'stopped' } });
      }

      if (url.pathname === '/actions/announcement' && request.method === 'POST') {
        const body = await readBody(request);
        const channel = await client.channels.fetch(body.channelId);
        if (!channel?.isTextBased() || !('send' in channel)) return sendJson(response, 400, { error: 'Invalid text channel.' });
        await channel.send(body.title ? `**${body.title}**\n${body.message}` : body.message);
        return sendJson(response, 200, { ok: true });
      }

      if (url.pathname === '/actions/sync' && request.method === 'POST') {
        const body = await readBody(request);
        const member = await client.guilds.cache.get(guildId!)?.members.fetch(body.discordId);
        return sendJson(response, 200, { ok: Boolean(member), results: { discordDisplayName: member?.displayName ?? null } });
      }

      if (url.pathname === '/admin/api/channel-messages' && request.method === 'GET') {
        const channelId = url.searchParams.get('channelId');
        if (!channelId) return sendJson(response, 400, { error: 'channelId is required.' });
        const channel = await client.channels.fetch(channelId);
        if (!channel?.isTextBased() || !('messages' in channel)) return sendJson(response, 400, { error: 'Invalid text channel.' });
        const messages = await channel.messages.fetch({ limit: Math.min(Number(url.searchParams.get('limit')) || 50, 100) });
        return sendJson(response, 200, { messages: messages.map((message) => ({ id: message.id, author: message.author.tag, content: message.content, createdAt: message.createdAt })) });
      }

      return sendJson(response, 404, { error: 'Not found.' });
    } catch (error) {
      console.error('Bot API request failed:', error);
      return sendJson(response, 500, { error: 'Bot API request failed.' });
    }
  });

  await new Promise<void>((resolve) => server.listen(botApiPort, '0.0.0.0', resolve));
  console.log(`Bot management API listening on port ${botApiPort}`);
}

async function registerCommands(): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(config.token);
  await rest.put(Routes.applicationGuildCommands(config.clientId, config.guildId), { body: commands });
}

function formatQueue(interaction: ChatInputCommandInteraction): string {
  const queue = queueStore.get(interaction.guildId!, interaction.channelId);
  if (queue.length === 0) {
    return 'The singing queue is empty.';
  }

  return queue.map((entry, index) => `${index + 1}. <@${entry.userId}>`).join('\n');
}

function queuePanel(guildId: string, channelId: string): { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] } {
  const queue = queueStore.get(guildId, channelId);
  const description = queue.length === 0
    ? 'No singers are waiting. Be the first to join!'
    : queue.map((entry, index) => `**${index + 1}.** <@${entry.userId}>`).join('\n');
  const embed = new EmbedBuilder()
    .setColor(0x7c5cff)
    .setTitle('Singing Queue')
    .setDescription(description)
    .addFields({ name: 'Singers waiting', value: `${queue.length}`, inline: true })
    .setFooter({ text: 'Use the buttons below to manage your place.' })
    .setTimestamp();
  const controls = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('queue:join').setLabel('Join queue').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('queue:leave').setLabel('Leave queue').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('queue:done').setLabel('Done').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('queue:refresh').setLabel('Refresh').setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [controls] };
}

function stageQueuePanel(
  guildId: string,
  channelId: string,
): { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] } {
  const stage = stageStore.get(guildId, channelId);
  const queue = queueStore.get(guildId, channelId);
  const description = queue.length === 0
    ? 'No singers are waiting. Be the first to join!'
    : queue.map((entry, index) => `**${index + 1}.** <@${entry.userId}>`).join('\n');
  const embed = new EmbedBuilder()
    .setColor(0x7c5cff)
    .setTitle('Stage Queue')
    .setDescription(description)
    .addFields(
      { name: 'Singers waiting', value: `${queue.length}`, inline: true },
      { name: 'Current speaker', value: stage?.currentSpeakerId ? `<@${stage.currentSpeakerId}>` : 'Nobody', inline: true },
    )
    .setFooter({ text: 'Use the buttons below to manage your place.' })
    .setTimestamp();
  const controls = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`stage:join:${channelId}`).setLabel('Join queue').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`stage:leave:${channelId}`).setLabel('Leave queue').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`stage:done:${channelId}`).setLabel('Done').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`stage:refresh:${channelId}`).setLabel('Refresh').setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [controls] };
}

async function currentVoiceChannel(interaction: ChatInputCommandInteraction) {
  const member = await interaction.guild!.members.fetch(interaction.user.id);
  return member.voice.channel?.type === ChannelType.GuildVoice ? member.voice.channel : null;
}

async function setStageMute(guildId: string, userId: string, mute: boolean): Promise<boolean> {
  const operationKey = `${guildId}:${userId}`;
  const previousOperation = stageMuteOperations.get(operationKey) ?? Promise.resolve();
  const operation = previousOperation.then(() => performStageMute(guildId, userId, mute));
  const completion = operation.then(() => undefined, () => undefined);
  stageMuteOperations.set(operationKey, completion);

  try {
    return await operation;
  } finally {
    if (stageMuteOperations.get(operationKey) === completion) {
      stageMuteOperations.delete(operationKey);
    }
  }
}

async function performStageMute(guildId: string, userId: string, mute: boolean): Promise<boolean> {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return false;
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member?.voice.channel || member.user.bot) return false;
  const botMember = guild.members.me;
  if (!botMember?.permissions.has(PermissionFlagsBits.MuteMembers)) {
    console.warn(`Could not ${mute ? 'mute' : 'unmute'} stage member ${userId}: the bot is missing the Mute Members permission.`);
    return false;
  }
  if (!member.manageable) {
    console.warn(`Could not ${mute ? 'mute' : 'unmute'} stage member ${userId}: the bot's highest role must be above the member's highest role.`);
    return false;
  }
  try {
    await member.voice.setMute(mute, mute ? 'Another singer was called.' : 'Singer called to the stage.');
    return true;
  } catch (error) {
    console.warn(`Could not ${mute ? 'mute' : 'unmute'} stage member ${userId}:`, error);
    return false;
  }
}

async function applyStageMutePolicy(stage: StageSession): Promise<void> {
  const guild = client.guilds.cache.get(stage.guildId);
  const channel = guild?.channels.cache.get(stage.voiceChannelId);
  if (!guild || !channel || channel.type !== ChannelType.GuildVoice) return;

  await Promise.all([...channel.members.values()]
    .filter((member) => !member.user.bot)
    .map((member) => setStageMute(
      stage.guildId,
      member.id,
      member.id !== stage.hostId && !stage.coHostIds.includes(member.id),
    )));
}

function hasDefenderAuthority(interaction: ChatInputCommandInteraction): boolean {
  if (interaction.guild?.ownerId === interaction.user.id) return true;
  const member = interaction.guild?.members.cache.get(interaction.user.id);
  const defenderRole = interaction.guild?.roles.cache.find((role) => {
    const roleName = role.name.trim().toLowerCase();
    return roleName === 'drowsy defender' || roleName === 'defender';
  });
  return Boolean(member && defenderRole && member.roles.highest.position >= defenderRole.position);
}

function canManageStage(interaction: ChatInputCommandInteraction, stage: { hostId: string; coHostIds: string[] }): boolean {
  return hasDefenderAuthority(interaction) || interaction.user.id === stage.hostId || stage.coHostIds.includes(interaction.user.id);
}

async function handleStageCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply();
  const subcommand = interaction.options.getSubcommand();

  if (subcommand === 'start') {
    if (!hasDefenderAuthority(interaction)) {
      await interaction.editReply('Only members with the Defender role or a higher role can assign stage hosts.');
      return;
    }

    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)) {
      await interaction.editReply('You need the Manage Channels permission to start a singing stage.');
      return;
    }

    const channel = interaction.options.getChannel('channel', true);
    if (channel.type !== ChannelType.GuildVoice) {
      await interaction.editReply('Choose a normal voice channel.');
      return;
    }
    const stage = stageStore.start(interaction.guildId!, channel.id, interaction.channelId, interaction.user.id);
    await applyStageMutePolicy(stage);
    await interaction.editReply(`Singing stage started in <#${channel.id}>. You are the host and can speak at any time. Use /stage join while connected to it.`);
    return;
  }

  const channel = await currentVoiceChannel(interaction);
  if (!channel) {
    await interaction.editReply('Join the managed voice channel before using this stage command.');
    return;
  }

  const stage = stageStore.get(interaction.guildId!, channel.id);
  if (!stage) {
    await interaction.editReply(`There is no active singing stage in <#${channel.id}>.`);
    return;
  }

  if (subcommand === 'host' || subcommand === 'cohost' || subcommand === 'uncohost') {
    if (!hasDefenderAuthority(interaction)) {
      await interaction.editReply('Only members with the Defender role or a higher role can assign stage hosts.');
      return;
    }
    const user = interaction.options.getUser('user', true);
    if (subcommand === 'host') {
      stageStore.setHost(interaction.guildId!, channel.id, user.id);
      await interaction.editReply(`<@${user.id}> is now the stage host.`);
      return;
    }
    stageStore.setCoHost(interaction.guildId!, channel.id, user.id, subcommand === 'cohost');
    await interaction.editReply(subcommand === 'cohost'
      ? `<@${user.id}> is now a stage co-host.`
      : `<@${user.id}> is no longer a stage co-host.`);
    return;
  }

  if ((subcommand === 'next' || subcommand === 'clear' || subcommand === 'stop') && !canManageStage(interaction, stage)) {
    await interaction.editReply('Only the host, co-hosts, or Defender+ staff can manage this stage.');
    return;
  }

  if (subcommand === 'join') {
    if (!stage.acceptingJoins) {
      await interaction.editReply('This stage is not currently accepting new singers.');
      return;
    }
    if (interaction.user.id === stage.hostId || stage.coHostIds.includes(interaction.user.id)) {
      await interaction.editReply('You are the stage host, so you can speak without joining the singer queue.');
      return;
    }
    const result = queueStore.add(interaction.guildId!, channel.id, {
      userId: interaction.user.id,
      displayName: interaction.user.displayName,
    });
    if (result.added) {
      await setStageMute(interaction.guildId!, interaction.user.id, true);
      memberStatsStore.recordRequest(interaction.guildId!);
    }
    await interaction.editReply(result.added
      ? `You joined the stage queue at position ${result.position}.`
      : `You are already in the stage queue at position ${result.position}.`);
    return;
  }

  if (subcommand === 'leave') {
    const removed = queueStore.remove(interaction.guildId!, channel.id, interaction.user.id);
    await interaction.editReply(removed ? 'You left the stage queue.' : 'You are not currently in the stage queue.');
    return;
  }

  if (subcommand === 'queue') {
    await interaction.editReply(stageQueuePanel(interaction.guildId!, channel.id));
    return;
  }

  if (subcommand === 'next') {
    if (stage.currentSpeakerId && stage.currentSpeakerId !== stage.hostId) await setStageMute(interaction.guildId!, stage.currentSpeakerId, true);
    const nextEntry = queueStore.next(interaction.guildId!, channel.id);
    if (!nextEntry) {
      stageStore.setCurrentSpeaker(interaction.guildId!, channel.id, null);
      await interaction.editReply('The stage queue is empty.');
      return;
    }

    stageStore.setCurrentSpeaker(interaction.guildId!, channel.id, nextEntry.userId);
    const unmuted = await setStageMute(interaction.guildId!, nextEntry.userId, false);
    memberStatsStore.recordParticipation(interaction.guildId!);
    await interaction.editReply(`Up next: <@${nextEntry.userId}>${unmuted ? '' : ' (I could not change their mute state.)'}`);
    return;
  }

  if (subcommand === 'clear') {
    await interaction.editReply(`Cleared ${queueStore.clear(interaction.guildId!, channel.id)} singer(s) from the stage queue.`);
    return;
  }

  if (stage.currentSpeakerId && stage.currentSpeakerId !== stage.hostId) await setStageMute(interaction.guildId!, stage.currentSpeakerId, true);
  queueStore.clear(interaction.guildId!, channel.id);
  stageStore.stop(interaction.guildId!, channel.id);
  await interaction.editReply(`Singing stage stopped in <#${channel.id}>.`);
}

async function handleQueueButton(interaction: ButtonInteraction): Promise<void> {
  if (!interaction.guildId) return;
  await interaction.deferUpdate();
  if (interaction.customId.startsWith('stage:')) {
    const [, action, stageChannelId] = interaction.customId.split(':');
    if (!stageChannelId) return;
    const stage = stageStore.get(interaction.guildId, stageChannelId);
    if (!stage) {
      await interaction.editReply({ content: 'This stage is no longer active.', components: [] });
      return;
    }
    if (action === 'refresh') {
      await interaction.editReply(stageQueuePanel(interaction.guildId, stageChannelId));
      return;
    }
    if (action === 'join') {
      if (!stage.acceptingJoins) {
        await interaction.editReply({ content: 'This stage is not currently accepting new singers.' });
        return;
      }
      const member = await interaction.guild?.members.fetch(interaction.user.id);
      if (member?.voice.channelId !== stageChannelId) {
        await interaction.editReply({ content: 'Join the stage voice channel before joining its queue.' });
        return;
      }
      if (interaction.user.id === stage.hostId || stage.coHostIds.includes(interaction.user.id)) {
        await interaction.editReply({ content: 'You are a stage host and can speak without joining the queue.' });
        return;
      }
      const result = queueStore.add(interaction.guildId, stageChannelId, {
        userId: interaction.user.id,
        displayName: interaction.user.displayName,
      });
      if (result.added) {
        memberStatsStore.recordRequest(interaction.guildId);
        await setStageMute(interaction.guildId, interaction.user.id, true);
      }
      await interaction.editReply(stageQueuePanel(interaction.guildId, stageChannelId));
      await interaction.followUp({ content: result.added ? `You joined the stage queue at position ${result.position}.` : `You are already in the stage queue at position ${result.position}.`, ephemeral: true });
      return;
    }
    const removed = queueStore.remove(interaction.guildId, stageChannelId, interaction.user.id);
    if (removed && action === 'done') memberStatsStore.recordParticipation(interaction.guildId);
    await interaction.editReply(stageQueuePanel(interaction.guildId, stageChannelId));
    await interaction.followUp({ content: removed
      ? action === 'done' ? 'Nice work. Your turn is marked as complete.' : 'You left the stage queue.'
      : 'You are not currently in the stage queue.', ephemeral: true });
    return;
  }
  if (interaction.customId === 'queue:refresh') {
    await interaction.editReply(queuePanel(interaction.guildId, interaction.channelId));
    return;
  }
  if (interaction.customId === 'queue:join') {
    const result = queueStore.add(interaction.guildId, interaction.channelId, { userId: interaction.user.id, displayName: interaction.user.displayName });
    if (result.added) memberStatsStore.recordRequest(interaction.guildId);
    await interaction.editReply(queuePanel(interaction.guildId, interaction.channelId));
    await interaction.followUp({ content: result.added ? `You joined the queue at position ${result.position}.` : `You are already in the queue at position ${result.position}.`, ephemeral: true });
    return;
  }
  const removed = queueStore.remove(interaction.guildId, interaction.channelId, interaction.user.id);
  if (removed && interaction.customId === 'queue:done') memberStatsStore.recordParticipation(interaction.guildId);
  await interaction.editReply(queuePanel(interaction.guildId, interaction.channelId));
  await interaction.followUp({ content: removed
    ? interaction.customId === 'queue:done' ? 'Nice work. Your turn is marked as complete.' : 'You left the singing queue.'
    : 'You are not currently in the singing queue.', ephemeral: true });
}

async function formatEvents(interaction: ChatInputCommandInteraction): Promise<string> {
  const events = await interaction.guild!.scheduledEvents.fetch();
  const currentEvents = [...events.values()]
    .filter((event) => event.scheduledStartTimestamp !== null && event.status !== 3 && event.status !== 4 && (event.status === 2 || event.scheduledStartTimestamp >= Date.now() || (event.scheduledEndTimestamp ?? 0) > Date.now()))
    .sort((first, second) => (first.scheduledStartTimestamp ?? 0) - (second.scheduledStartTimestamp ?? 0));

  if (currentEvents.length === 0) {
    return 'There are no current or upcoming Discord events.';
  }

  return currentEvents.map((event) => {
    const start = `<t:${Math.floor((event.scheduledStartTimestamp ?? 0) / 1000)}:F>`;
    const end = event.scheduledEndTimestamp ? `<t:${Math.floor(event.scheduledEndTimestamp / 1000)}:t>` : 'unknown';
    const location = event.entityMetadata?.location ? `\nLocation: ${event.entityMetadata.location}` : '';
    return `**${event.name}**\n${start} to ${end}${location}\n${event.url}`;
  }).join('\n\n');
}

client.once('ready', (readyClient) => {
  console.log(`DrowsyBot is online as ${readyClient.user.tag}`);
});

client.on('guildMemberAdd', (member) => memberStatsStore.recordJoined(member.guild.id));
client.on('guildMemberRemove', (member) => memberStatsStore.recordLeft(member.guild.id));
client.on('voiceStateUpdate', async (oldState, newState) => {
  if (!oldState.channelId && newState.channelId && !newState.member?.user.bot) memberStatsStore.recordVoiceJoin(newState.guild.id, newState.id);
  if (oldState.channelId && !newState.channelId && !oldState.member?.user.bot) memberStatsStore.recordVoiceLeave(oldState.guild.id, oldState.id);

  if (!newState.channelId || newState.member?.user.bot) return;
  const stage = stageStore.get(newState.guild.id, newState.channelId);
  if (!stage) return;

  const canSpeak = newState.id === stage.hostId
    || stage.coHostIds.includes(newState.id)
    || newState.id === stage.currentSpeakerId;
  await setStageMute(newState.guild.id, newState.id, !canSpeak);
});

client.on('messageCreate', async (message) => {
  if (
    !message.guildId ||
    message.author.bot ||
    allowedLinkUserIds.has(message.author.id) ||
    !containsDiscordInvite(message)
  ) {
    return;
  }

  try {
    await message.delete();
    await message.channel.send(`${message.author}, Discord invite links are not allowed here.`);
  } catch (error) {
    console.error('Failed to moderate Discord invite:', error);
  }
});

client.on('interactionCreate', async (interaction) => {
  if (interaction.isButton()) {
    try {
      await handleQueueButton(interaction);
    } catch (error) {
      console.error('Failed to handle queue button:', error);
      if (!interaction.replied && !interaction.deferred) await interaction.reply({ content: 'The queue could not be updated.', ephemeral: true });
    }
    return;
  }

  if (!interaction.isChatInputCommand() || !interaction.guildId) {
    return;
  }

  try {
    switch (interaction.commandName) {
      case 'join': {
        const result = queueStore.add(interaction.guildId, interaction.channelId, {
          userId: interaction.user.id,
          displayName: interaction.user.displayName,
        });
        if (result.added) memberStatsStore.recordRequest(interaction.guildId);
        await interaction.reply(
          result.added
            ? `You joined the queue at position ${result.position}.`
            : `You are already in the queue at position ${result.position}.`,
        );
        break;
      }
      case 'leave':
        await interaction.reply(
          queueStore.remove(interaction.guildId, interaction.channelId, interaction.user.id)
            ? 'You left the singing queue.'
            : 'You are not currently in the singing queue.',
        );
        break;
      case 'queue':
        await interaction.reply(queuePanel(interaction.guildId, interaction.channelId));
        break;
      case 'next': {
        const nextEntry = queueStore.next(interaction.guildId, interaction.channelId);
        if (nextEntry) memberStatsStore.recordParticipation(interaction.guildId);
        await interaction.reply(nextEntry ? `Up next: <@${nextEntry.userId}>` : 'The singing queue is empty.');
        break;
      }
      case 'clear':
        await interaction.reply(`Cleared ${queueStore.clear(interaction.guildId, interaction.channelId)} singer(s) from the queue.`);
        break;
      case 'events':
        await interaction.reply(`**Current Discord events**\n${await formatEvents(interaction)}`);
        break;
      case 'stage':
        await handleStageCommand(interaction);
        break;
      default:
        break;
    }
  } catch (error) {
    console.error('Failed to handle interaction:', error);
    const message = 'Something went wrong while handling that command.';
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(message);
    } else {
      await interaction.reply(message);
    }
  }
});

await memberStatsStore.load();
await startAdminApi();
await registerCommands();
await client.login(config.token);
