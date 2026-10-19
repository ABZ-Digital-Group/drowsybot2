# DrowsyBot

DrowsyBot is a Discord bot for managing a singing queue.

## Commands

- `/join` - join the queue
- `/leave` - leave the queue
- `/queue` - show the current queue
- `/next` - call the next singer and remove them from the queue
- `/clear` - clear the queue
- `/events` - show current and upcoming Discord scheduled events
- `/stage start channel:<voice channel>` - start managing a normal voice channel as a singing stage
- `/stage join` - join the stage queue while connected to the managed voice channel
- `/stage leave` - leave the stage queue
- `/stage queue` - show the stage queue
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
6. Set `BOT_API_SECRET` to a long random value. Configure the website's `BOT_API_URL` to the bot server's HTTPS API URL and use the same secret as `BOT_API_SECRET` on the website.
7. Give the bot `Manage Messages`, `Send Messages`, `Manage Channels`, and `Mute Members` permissions, then install dependencies and build the bot:

	```sh
	npm install
	npm run build
	npm start
	```

For development, use `npm run dev`.

Queues currently live in memory and reset when the bot restarts. Each Discord channel has its own independent queue, so multiple singing sessions can run at the same time in different channels.

Stage queues are attached to normal Discord voice channels and also live in memory. The member who starts the stage is its host: they remain unmuted, can speak at any time, and are not added to the singer queue. The bot server-mutes other singers while they wait and attempts to unmute the singer selected by `/stage next`. Discord must allow the bot to moderate each member for mute changes, which requires the `Mute Members` permission and a sufficiently high bot role.

The `Defender` role is the minimum role allowed to assign a host or co-host. Higher roles are accepted using Discord's role hierarchy.

Discord invite links such as `discord.gg/...`, `discord.com/invite/...`, and `discordapp.com/invite/...` are deleted automatically unless the sender's user ID is listed in `LINK_ALLOWED_USER_IDS`.

The management API listens on `BOT_API_PORT` and must be protected by a firewall or reverse proxy so only `https://manage.drowsyvocals.com/` can reach it. Do not expose `BOT_API_SECRET` to browser code.

Member activity is persisted in `data/member-stats.json` (or the path set by `MEMBER_STATS_FILE`). The management website can request `GET /admin/api/stats` with the bot API secret and optionally a `guildId`; the response includes member count, joins, leaves, unique voice visitors, average voice time, return visitors, queue requests, and participations. Daily metrics begin when the bot starts receiving events and do not include activity that happened before installation.