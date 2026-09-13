import 'dotenv/config';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Message,
} from 'discord.js';
import { QueueStore } from './queue.js';
import { MemberStatsStore } from './member-stats.js';

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
].map((command) => command.toJSON());

const queueStore = new QueueStore();
const memberStatsStore = new MemberStatsStore();
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
        const trackedStages = queues.map((queue) => {
          const guild = client.guilds.cache.get(queue.guildId);
          const channel = guild?.channels.cache.get(queue.channelId);
          return {
            guildId: queue.guildId,
            guildName: guild?.name ?? queue.guildId,
            channelId: queue.channelId,
            channelName: channel?.name ?? queue.channelId,
            acceptingJoins: true,
            queueMembers: queue.entries.map((entry) => ({ id: entry.userId, name: entry.displayName })),
            currentSpeaker: null,
            songsSung: 0,
            peakAttendance: queue.entries.length,
            runtimeText: 'Active',
          };
        });
        return sendJson(response, 200, {
          ok: true,
          online: client.isReady(),
          botUser: client.user?.tag ?? null,
          guildCount: client.guilds.cache.size,
          guilds: client.guilds.cache.map((guild) => ({
            id: guild.id,
            name: guild.name,
            textChannels: guild.channels.cache.filter((channel) => channel.isTextBased()).map((channel) => ({ id: channel.id, name: channel.name })),
          })),
          queues,
          trackedStages,
          allowedInviteUserIds: [...allowedLinkUserIds].map((userId) => ({ userId, displayName: userId })),
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

      const queueMatch = url.pathname.match(/^\/admin\/api\/(?:queue|stage)\/(next|clear|remove-user)$/);
      if (queueMatch && request.method === 'POST') {
        const body = await readBody(request);
        const targetGuildId = body.guildId || guildId!;
        const targetChannelId = body.channelId;
        if (!targetChannelId) return sendJson(response, 400, { error: 'channelId is required.' });
        if (queueMatch[1] === 'next') return sendJson(response, 200, { ok: true, result: queueStore.next(targetGuildId, targetChannelId) ?? null });
        if (queueMatch[1] === 'clear') return sendJson(response, 200, { ok: true, result: { cleared: queueStore.clear(targetGuildId, targetChannelId) } });
        return sendJson(response, 200, { ok: true, result: { removed: queueStore.remove(targetGuildId, targetChannelId, body.userId ?? '') } });
      }

      if (url.pathname === '/admin/api/stage/join-toggle' && request.method === 'POST') {
        const body = await readBody(request);
        return sendJson(response, 200, { ok: true, result: { acceptingJoins: body.acceptingJoins !== 'false' } });
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
client.on('voiceStateUpdate', (oldState, newState) => {
  if (!oldState.channelId && newState.channelId && !newState.member?.user.bot) memberStatsStore.recordVoiceJoin(newState.guild.id, newState.id);
  if (oldState.channelId && !newState.channelId && !oldState.member?.user.bot) memberStatsStore.recordVoiceLeave(oldState.guild.id, oldState.id);
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
        await interaction.reply(`**Singing queue**\n${formatQueue(interaction)}`);
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
