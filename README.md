# DrowsyBot

DrowsyBot is a Discord bot for managing a singing queue.

## Commands

- `/join` - join the queue
- `/leave` - leave the queue
- `/queue` - show the current queue
- `/next` - call the next singer and remove them from the queue
- `/clear` - clear the queue
- `/events` - show current and upcoming Discord scheduled events
- `/stage start channel:<voice channel>` - start managing a normal voice channel as a singing stage; requires the `Drowsy Defender` role or higher
- `/stage join` - join the stage queue while connected to the managed voice channel
- `/stage leave` - leave the stage queue
- `/stage queue` - show the stage queue with interactive join, leave, done, and refresh controls
- `/stage next` - call the next singer and rotate server mute state
- `/stage clear` - clear the stage queue
- `/stage stop` - stop managing the voice channel as a singing stage
- `/stage host user:<member>` - choose the host; requires the `Defender` role or higher
- `/stage cohost user:<member>` - add a co-host; requires the `Defender` role or higher
- `/stage uncohost user:<member>` - remove a co-host; requires the `Defender` role or higher

## Setup

1. Create an application and bot in the [Discord Developer Portal](https://discord.com/developers/applications).
2. Enable the `applications.commands` and `bot` scopes when inviting the bot to your server.
3. Copy `.env.example` to `.env` and fill in the bot token, application client ID, and server ID.
4. Add approved user IDs to `LINK_ALLOWED_USER_IDS`, separated by commas. Leave it empty to block Discord invite links from everyone except bots.
5. Enable the `Message Content Intent` and `Server Members Intent` under **Bot > Privileged Gateway Intents** in the Discord Developer Portal. The Server Members Intent is required to receive join and leave events.
6. Optional: if you want the management API to include non-voice users' live online status, also enable `Presence Intent` in the portal and set `ENABLE_PRESENCE_INTENT=true` in `.env`. Leave it unset or `false` if Presence Intent is not enabled.
7. Set `BOT_API_SECRET` to a long random value. Configure the website's `BOT_API_URL` to the bot server's HTTPS API URL and use the same secret as `BOT_API_SECRET` on the website.
8. Give the bot `Manage Messages`, `Send Messages`, `Manage Channels`, and `Mute Members` permissions, then install dependencies and build the bot:

	```sh
	npm install
	npm run build
	npm start
	```

For development, use `npm run dev`.

Queues currently live in memory and reset when the bot restarts. Each Discord channel has its own independent queue, so multiple singing sessions can run at the same time in different channels.

Stage queues are attached to normal Discord voice channels and also live in memory. When a stage starts, the bot server-mutes everyone already in the channel except the host and co-hosts. Members who join or move into an active stage are also server-muted unless they are the host, a co-host, or the current speaker. The member who starts the stage is its host: they can control their own mute state, can speak at any time, and are not added to the singer queue. Co-hosts also control their own mute state and are not added to the singer queue. Starting a stage and assigning a host or co-host requires the `Drowsy Defender` role or higher. The bot server-mutes other singers while they wait and attempts to unmute the singer selected by `/stage next`. Discord must allow the bot to moderate each queued member for mute changes, which requires the `Mute Members` permission and the bot's highest role to be above each member it moderates. Members with an equal or higher role cannot be server-muted by the bot.

The `Drowsy Defender` role is the minimum role allowed to assign a host or co-host. Higher roles are accepted using Discord's role hierarchy, and the server owner is also allowed.

The authenticated management API exposes active stage sessions through `GET /admin/api/state` and supports the stage controls used by the management website:

- `POST /admin/api/stage/start` with `guildId`, `channelId`, `hostId`, and optional `announcementChannelId`
- `POST /admin/api/stage/stop` with `guildId` and `channelId`
- `POST /admin/api/stage/join-toggle` with `guildId`, `channelId`, and `acceptingJoins`
- `POST /admin/api/stage/host`, `/cohost`, or `/uncohost` with `guildId`, `channelId`, and `userId`
- `POST /admin/api/stage/next`, `/clear`, or `/remove-user` with `guildId`, `channelId`, and (for removal) `userId`

Stage actions use the same in-memory session, queue, and Discord mute handling as the slash commands. A stage must be active before its website controls can be used, and disabling joins is enforced for subsequent `/stage join` commands.

Discord invite links such as `discord.gg/...`, `discord.com/invite/...`, and `discordapp.com/invite/...` are deleted automatically unless the sender's user ID is listed in `LINK_ALLOWED_USER_IDS`.

The management API listens on `BOT_API_PORT` and must be protected by a firewall or reverse proxy so only `https://manage.drowsyvocals.com/` can reach it. Do not expose `BOT_API_SECRET` to browser code.

Member activity is persisted in `data/member-stats.json` (or the path set by `MEMBER_STATS_FILE`). The management website can request `GET /admin/api/stats` with the bot API secret and optionally a `guildId`; the response includes member count, joins, leaves, unique voice visitors, average voice time, return visitors, queue requests, and participations. Daily metrics begin when the bot starts receiving events and do not include activity that happened before installation.

Completed voice sessions are also stored in the member-stats file and can be delivered to the management website by setting `ACTIVITY_API_URL`. The bot posts batches to `/api/internal/voice-sessions` using `ACTIVITY_API_SECRET` (or `BOT_API_SECRET` when the former is empty). Voice sessions exclude the guild AFK channel, split when a member changes channels, and ignore sessions shorter than one minute.