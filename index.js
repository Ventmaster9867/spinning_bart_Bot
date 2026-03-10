const {
  Client,
  GatewayIntentBits,
  ActivityType,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  InteractionType,
  PermissionFlagsBits
} = require('discord.js');
const fs = require('fs');
const path = require('path');

// -------------------- PERSISTENCE --------------------
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const FILES = {
  warnings:        path.join(DATA_DIR, 'warnings.json'),
  weeklyActivity:  path.join(DATA_DIR, 'weeklyActivity.json'),
  modLogs:         path.join(DATA_DIR, 'modLogs.json'),
  activeBans:      path.join(DATA_DIR, 'activeBans.json'),
  shiftStartTimes: path.join(DATA_DIR, 'shiftStartTimes.json')
};

function loadJSON(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) { console.error(`Failed to load ${file}:`, err.message); }
  return fallback;
}

function saveJSON(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) { console.error(`Failed to save ${file}:`, err.message); }
}

function appendModLog(entry) {
  const logs = loadJSON(FILES.modLogs, []);
  logs.push(entry);
  saveJSON(FILES.modLogs, logs);
}

const TOKEN = process.env.TOKEN;
const GUILD_ID = '1394380681341173810';
const ANNOUNCE_CHANNEL_ID = '1452777822618648678';
const MOD_LOG_CHANNEL_ID = '1475618663447920881';
const WHITELIST_USERS = ['1294697248759746561', '1166915839992270930'];
const MAINT_USER_ID = '1166915839992270930';
const SHIFT_ROLE_ID = '1475191266084917298';
const NOTIFY_ROLE_ID = '1395209235389743114';
const SCHEDULE_WHITELIST_ROLES = ['1410771734700888064', '1395231118537523220'];
const SSU_REQUEST_ROLE_ID = '1481025393665249391'; // Can REQUEST an SSU — needs 1 WL approval

// -------------------- PERMISSION LEVELS --------------------
const PERM_ROLES = {
  3: ['1410771734700888064', '1395231118537523220'],
  2: ['1395209235389743114'],
  1: ['1475616865471693013']
};

function getPermLevel(member) {
  if (PERM_ROLES[3].some(r => member.roles.cache.has(r))) return 3;
  if (PERM_ROLES[2].some(r => member.roles.cache.has(r))) return 2;
  if (PERM_ROLES[1].some(r => member.roles.cache.has(r))) return 1;
  return 0;
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildModeration
  ]
});

// -------------------- DATA --------------------
let schedules = [];
let botReady = false;
let maintenanceMode = false;
let activeSessionMessageId = null;
let activeSessionChannelId = ANNOUNCE_CHANNEL_ID;
let pendingMuteRequests = {};

// Tracks who is currently hosting — { hostId, hostTag, gameLink }
let currentSession = null;

// Pending SSU approval requests from SSU_REQUEST_ROLE members
// { reqId: { userId, userTag, gameLink, schedId, dmMessageIds: { wlUserId: msgId } } }
let pendingSSURequests = {};

let warnings        = loadJSON(FILES.warnings, {});
let weeklyActivity  = loadJSON(FILES.weeklyActivity, {});
let shiftStartTimes = loadJSON(FILES.shiftStartTimes, {});
let savedBans       = loadJSON(FILES.activeBans, {});

// -------------------- STATUS --------------------
async function setNormalStatus() {
  if (!client.user || maintenanceMode) return;
  await client.user.setPresence({
    status: 'idle',
    activities: [{ name: 'Created by ventmaster9867 ✨', type: ActivityType.Playing }]
  });
}
async function setDowntimeStatus() {
  if (!client.user) return;
  await client.user.setPresence({
    status: 'dnd',
    activities: [{ name: '📕 Experiencing Downtime!', type: ActivityType.Playing }]
  });
}
async function setMaintenanceStatus() {
  if (!client.user) return;
  await client.user.setPresence({
    status: 'dnd',
    activities: [{ name: '📕 Maintenance Active', type: ActivityType.Playing }]
  });
}

// -------------------- HELPERS --------------------
function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

function buildSessionButtons(gameLink) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel('Join Session').setStyle(ButtonStyle.Link).setURL(gameLink),
    new ButtonBuilder().setCustomId('start-shift').setLabel('Start Shift').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('end-shift').setLabel('End Shift').setStyle(ButtonStyle.Danger)
  );
}

const TZ_OFFSETS = { EST: -5, PST: -8, CST: -6, MST: -7, GMT: 0, CET: 1 };

function parseScheduleTime(dateStr, timeStr, tz) {
  const [month, day, year] = dateStr.split('/').map(Number);
  const [h, m] = timeStr.split(':').map(Number);
  const offsetHours = TZ_OFFSETS[tz] || 0;
  return Date.UTC(year, month - 1, day, h - offsetHours, m, 0, 0);
}

function formatTimestamp(utcMs) {
  const s = Math.floor(utcMs / 1000);
  return `<t:${s}:F> (<t:${s}:R>)`;
}

function parseDuration(str) {
  const match = str.match(/^(\d+)(m|h|d|w)$/i);
  if (!match) return null;
  const val = parseInt(match[1]);
  const unit = match[2].toLowerCase();
  const multipliers = { m: 60000, h: 3600000, d: 86400000, w: 604800000 };
  return val * multipliers[unit];
}

function humanDuration(ms) {
  const w = Math.floor(ms / 604800000);
  const d = Math.floor((ms % 604800000) / 86400000);
  const h = Math.floor((ms % 86400000) / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const parts = [];
  if (w) parts.push(`${w}w`);
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  return parts.join(' ') || '0m';
}

// -------------------- MOD LOGGING --------------------
async function sendModLog(embed) {
  const fields = (embed.data && embed.data.fields) ? embed.data.fields : [];
  appendModLog({
    timestamp: Date.now(),
    title: (embed.data && embed.data.title) ? embed.data.title : 'Mod Action',
    fields: fields.map(f => ({ name: f.name, value: f.value }))
  });
  try {
    const ch = await client.channels.fetch(MOD_LOG_CHANNEL_ID);
    await ch.send({ embeds: [embed] });
  } catch (err) {
    console.error('Failed to send mod log:', err.message);
  }
}

function modLogEmbed(action, moderator, target, extra = {}) {
  const embed = new EmbedBuilder()
    .setColor(extra.color || 0xFF6600)
    .setTitle(`🛡️ ${action}`)
    .addFields(
      { name: 'Moderator', value: `${moderator.tag} (<@${moderator.id}>)`, inline: true },
      { name: 'Target', value: `${target.tag} (<@${target.id}>)`, inline: true }
    )
    .setTimestamp();
  if (extra.reason) embed.addFields({ name: 'Reason', value: extra.reason });
  if (extra.duration) embed.addFields({ name: 'Duration', value: extra.duration, inline: true });
  if (extra.warnCount !== undefined) embed.addFields({ name: 'Total Warnings', value: String(extra.warnCount), inline: true });
  return embed;
}

// -------------------- BAN PERSISTENCE --------------------
function scheduleBanExpiry(userId, userTag, guildId, ms) {
  const MAX_TIMEOUT = 2073600000;
  const delay = Math.min(ms, MAX_TIMEOUT);
  setTimeout(async () => {
    try {
      const guild = await client.guilds.fetch(guildId);
      await guild.members.unban(userId, 'Temporary ban expired');
      console.log(`Unbanned ${userTag} after temporary ban expired.`);
      delete savedBans[userId];
      saveJSON(FILES.activeBans, savedBans);
      const unbanLog = new EmbedBuilder()
        .setTitle('🔓 Temporary Ban Expired')
        .setColor(0x00FF00)
        .setDescription(`<@${userId}> (${userTag}) has been unbanned after their temporary ban expired.`)
        .setTimestamp();
      await sendModLog(unbanLog);
    } catch (err) { console.error('Unban failed:', err.message); }
  }, delay);
}

function restorePendingBans() {
  const now = Date.now();
  for (const [userId, banData] of Object.entries(savedBans)) {
    const remaining = banData.expiresAt - now;
    if (remaining <= 0) {
      scheduleBanExpiry(userId, banData.tag, banData.guildId, 0);
    } else {
      console.log(`Restoring ban for ${banData.tag}, expires in ${Math.round(remaining / 60000)}m`);
      scheduleBanExpiry(userId, banData.tag, banData.guildId, remaining);
    }
  }
}

// -------------------- SCHEDULE CHECKER --------------------
function startScheduleChecker() {
  setInterval(async () => {
    const now = Date.now();
    for (const sched of schedules) {
      if (sched.notified) continue;
      const diff = sched.startTime - now;
      if (diff <= 5 * 60 * 1000 && diff > 4.5 * 60 * 1000) {
        sched.notified = true;
        try {
          const channel = await client.channels.fetch(ANNOUNCE_CHANNEL_ID);
          const signupMentions = sched.signups.size > 0
            ? [...sched.signups].map(id => `<@${id}>`).join(' ') : '';
          await channel.send(
            `⏰ <@${sched.userId}> Your session **"${sched.desc}"** starts in 5 minutes!\n${signupMentions}`
          );
        } catch (err) { console.error('Schedule reminder error:', err.message); }
      }
    }
  }, 30 * 1000);
}

// -------------------- WEEKLY REPORT --------------------
function scheduleWeeklyReport() {
  let lastFired = null;
  setInterval(async () => {
    const now = new Date();
    const key = `${now.getUTCFullYear()}-${now.getUTCMonth()}-${now.getUTCDate()}`;
    if (now.getUTCDay() === 0 && now.getUTCHours() === 5 && now.getUTCMinutes() === 0 && lastFired !== key) {
      lastFired = key;
      try {
        const guild = await client.guilds.fetch(GUILD_ID);
        const met = [], failed = [];
        for (const [userId, seconds] of Object.entries(weeklyActivity)) {
          let tag = userId;
          try { const m = await guild.members.fetch(userId); tag = m.user.tag; } catch {}
          const entry = `• <@${userId}> (${tag}) — ${formatDuration(seconds)}`;
          if (seconds >= 7200) met.push(entry); else failed.push(entry);
        }
        const metEmbed = new EmbedBuilder().setTitle('✅ Met Activity Requirements').setColor(0x00FF00)
          .setDescription(met.length ? met.join('\n') : 'No users.').setFooter({ text: 'Weekly Activity Report' });
        const failEmbed = new EmbedBuilder().setTitle('❌ Failed to Meet Requirements').setColor(0xFF0000)
          .setDescription(failed.length ? failed.join('\n') : 'No users.').setFooter({ text: 'Weekly Activity Report' });
        for (const uid of WHITELIST_USERS) {
          try { const u = await client.users.fetch(uid); await u.send({ embeds: [metEmbed, failEmbed] }); } catch {}
        }
        weeklyActivity = {};
        saveJSON(FILES.weeklyActivity, weeklyActivity);
      } catch (err) { console.error('Weekly report error:', err); }
    }
  }, 60 * 1000);
}

// -------------------- SSU EXECUTION HELPER --------------------
async function executeSSU(userId, userTag, gameLink, schedId) {
  const announceChannel = await client.channels.fetch(ANNOUNCE_CHANNEL_ID).catch(() => null);
  if (!announceChannel) { console.error('executeSSU: Announcement channel missing.'); return; }

  let signupPing = '';
  if (schedId) {
    const si = schedules.findIndex(s => s.id === schedId);
    if (si !== -1) {
      const s = schedules[si];
      if (s.signups.size > 0) signupPing = [...s.signups].map(id => `<@${id}>`).join(' ');
      if (s.embedMessageId) {
        try { const m = await announceChannel.messages.fetch(s.embedMessageId); await m.delete(); } catch {}
      }
      schedules.splice(si, 1);
    }
  }

  const embed = new EmbedBuilder().setTitle('🟢 Session Start Up!').setColor(0x00FF00)
    .setDescription(`A session has been started by ${userTag}!\nPlease join using the link below!`);
  const msg = await announceChannel.send({
    content: `@everyone${signupPing ? '\n' + signupPing : ''}`,
    embeds: [embed],
    components: [buildSessionButtons(gameLink)]
  });

  activeSessionMessageId = msg.id;
  activeSessionChannelId = announceChannel.id;
  currentSession = { hostId: userId, hostTag: userTag, gameLink };
}

// -------------------- READY --------------------
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  botReady = true;
  try { await setNormalStatus(); } catch (err) { console.error(err); }

  const commands = [
    new SlashCommandBuilder().setName('help').setDescription('Shows command menu').toJSON(),

    // Schedule
    new SlashCommandBuilder().setName('schedule').setDescription('Schedule a session (whitelisted)')
      .addStringOption(o => o.setName('date').setDescription('Date (MM/DD/YYYY)').setRequired(true))
      .addStringOption(o => o.setName('time').setDescription('Time HH:MM (24hr)').setRequired(true))
      .addStringOption(o => o.setName('timezone').setDescription('Your timezone').setRequired(true)
        .addChoices(
          { name: 'EST (UTC-5)', value: 'EST' }, { name: 'PST (UTC-8)', value: 'PST' },
          { name: 'CST (UTC-6)', value: 'CST' }, { name: 'MST (UTC-7)', value: 'MST' },
          { name: 'GMT (UTC+0)', value: 'GMT' }, { name: 'CET (UTC+1)', value: 'CET' }
        ))
      .addStringOption(o => o.setName('description').setDescription('Session description').setRequired(false)).toJSON(),
    new SlashCommandBuilder().setName('schedule-view').setDescription('View upcoming sessions and sign up').toJSON(),
    new SlashCommandBuilder().setName('del-schedule').setDescription('Delete a scheduled session')
      .addStringOption(o => o.setName('session-id').setDescription('Session ID').setRequired(true)).toJSON(),

    // Session
    new SlashCommandBuilder().setName('maintenance').setDescription('Toggle maintenance mode').toJSON(),
    new SlashCommandBuilder().setName('ssu').setDescription('Start a session (whitelisted instantly; approved role needs 1 WL approval)')
      .addStringOption(o => o.setName('game_link').setDescription('Roblox link (https://roblox.com...)').setRequired(true))
      .addStringOption(o => o.setName('schedule_id').setDescription('Linked schedule ID (optional)').setRequired(false)).toJSON(),
    new SlashCommandBuilder().setName('server-hop').setDescription('Start a server hop (whitelisted or current host only)')
      .addStringOption(o => o.setName('game_link').setDescription('Roblox link (https://roblox.com...)').setRequired(true)).toJSON(),
    new SlashCommandBuilder().setName('ssd').setDescription('Shutdown the current session (current host or whitelisted only)').toJSON(),
    new SlashCommandBuilder().setName('host-transfer').setDescription('Transfer session host to another user (current host or whitelisted)')
      .addUserOption(o => o.setName('user').setDescription('User to transfer host to').setRequired(true)).toJSON(),
    new SlashCommandBuilder().setName('notify-active').setDescription('DM all in-game of critical events')
      .addStringOption(o => o.setName('message').setDescription('Message to send').setRequired(true)).toJSON(),

    // Moderation
    new SlashCommandBuilder().setName('warn').setDescription('Warn a member [Perm 1+]')
      .addUserOption(o => o.setName('user').setDescription('User to warn').setRequired(true))
      .addStringOption(o => o.setName('reason').setDescription('Reason for warning').setRequired(true)).toJSON(),
    new SlashCommandBuilder().setName('view-warnings').setDescription('View warnings for a user [Perm 1+]')
      .addUserOption(o => o.setName('user').setDescription('User to check').setRequired(true)).toJSON(),
    new SlashCommandBuilder().setName('my-warns').setDescription('View your own warnings').toJSON(),
    new SlashCommandBuilder().setName('bloxy-ban').setDescription('Ban a user [Perm 3]')
      .addUserOption(o => o.setName('user').setDescription('User to ban').setRequired(true))
      .addStringOption(o => o.setName('duration').setDescription('Duration e.g. 10m, 2h, 3d, 1w').setRequired(true))
      .addStringOption(o => o.setName('reason').setDescription('Reason for ban').setRequired(true)).toJSON(),
    new SlashCommandBuilder().setName('topic').setDescription('Request a topic change in the current channel [Perm 1+]').toJSON(),

    // Undo commands
    new SlashCommandBuilder().setName('unwarn').setDescription('Remove a warning from a user [Perm 2 to undo Perm 1 warns, Perm 3 for Perm 2]')
      .addUserOption(o => o.setName('user').setDescription('User to remove warning from').setRequired(true))
      .addIntegerOption(o => o.setName('index').setDescription('Warning number to remove (see /view-warnings)').setRequired(true)).toJSON(),
    new SlashCommandBuilder().setName('unmute').setDescription('Remove a timeout/mute from a user [Perm 2 to undo Perm 1 mutes, Perm 3 for Perm 2]')
      .addUserOption(o => o.setName('user').setDescription('User to unmute').setRequired(true))
      .addStringOption(o => o.setName('reason').setDescription('Reason for unmute').setRequired(false)).toJSON(),
    new SlashCommandBuilder().setName('unban').setDescription('Unban a user early [Perm 3 only]')
      .addStringOption(o => o.setName('userid').setDescription('User ID to unban').setRequired(true))
      .addStringOption(o => o.setName('reason').setDescription('Reason for early unban').setRequired(false)).toJSON(),

    new SlashCommandBuilder().setName('status').setDescription('Change the bot status [Owner only]')
      .addStringOption(o => o.setName('text').setDescription('Status text').setRequired(true))
      .addStringOption(o => o.setName('emoji').setDescription('Emoji to prefix the status').setRequired(false))
      .addStringOption(o => o.setName('state').setDescription('Bot state').setRequired(false)
        .addChoices(
          { name: 'Online', value: 'online' },
          { name: 'Idle', value: 'idle' },
          { name: 'Do Not Disturb', value: 'dnd' }
        )).toJSON(),

    // Owner DM
    new SlashCommandBuilder().setName('dm').setDescription('DM a user as the bot [Owner only]')
      .addUserOption(o => o.setName('user').setDescription('User to DM').setRequired(true))
      .addStringOption(o => o.setName('message').setDescription('Message to send').setRequired(true)).toJSON(),
  ];

  try {
    const rest = new REST({ version: '10' }).setToken(TOKEN);
    await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: commands });
    console.log('Slash commands registered.');
  } catch (err) { console.error(err); await setDowntimeStatus(); }

  startScheduleChecker();
  scheduleWeeklyReport();
  restorePendingBans();
});

// -------------------- COMMAND HANDLER --------------------
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  try {
    if (maintenanceMode && interaction.commandName !== 'maintenance')
      return interaction.reply({ content: '⚠️ Bot is in maintenance mode.', ephemeral: true });

    const member = await interaction.guild.members.fetch(interaction.user.id);
    const permLevel = getPermLevel(member);
    const isWhitelisted = WHITELIST_USERS.includes(interaction.user.id);
    const hasScheduleRole = SCHEDULE_WHITELIST_ROLES.some(r => member.roles.cache.has(r));
    const hasNotifyRole = member.roles.cache.has(NOTIFY_ROLE_ID);
    const hasSSURequestRole = member.roles.cache.has(SSU_REQUEST_ROLE_ID);
    const isCurrentHost = currentSession && currentSession.hostId === interaction.user.id;

    await interaction.deferReply({ ephemeral: true });
    const announceChannel = await client.channels.fetch(ANNOUNCE_CHANNEL_ID).catch(() => null);

    // ===== HELP =====
    if (interaction.commandName === 'help') {
      return interaction.editReply(
        '🛠 **Commands:**\n' +
        '• `/help` — Shows this menu\n' +
        '• `/schedule` — Schedule a session *(whitelisted)*\n' +
        '• `/schedule-view` — View & sign up for sessions\n' +
        '• `/del-schedule` — Delete a session *(whitelisted)*\n' +
        '• `/ssu` — Start a session *(whitelisted instantly; approved role needs 1 WL approval)*\n' +
        '• `/server-hop` — Server hop *(whitelisted or current host only)*\n' +
        '• `/ssd` — Shutdown session *(current host or whitelisted only)*\n' +
        '• `/host-transfer` — Transfer session host *(current host or whitelisted)*\n' +
        '• `/notify-active` — DM all active members *(Perm 2)*\n' +
        '• `/maintenance` — Toggle maintenance *(owner)*\n' +
        '• `/dm` — DM a user as the bot *(owner)*\n\n' +
        '🛡️ **Moderation:**\n' +
        '• `/warn` — Warn a member *(Perm 1+)*\n' +
        '• `/view-warnings` — View a user\'s warnings *(Perm 1+)*\n' +
        '• `/my-warns` — View your own warnings\n' +
        '• `/bloxy-ban` — Ban a user *(Perm 3)*\n' +
        '• `/topic` — Request a topic change *(Perm 1+)*\n\n' +
        '↩️ **Undo Commands:**\n' +
        '• `/unwarn` — Remove a warning *(Perm 2 undoes Perm 1, Perm 3 undoes Perm 2)*\n' +
        '• `/unmute` — Remove a mute *(Perm 2 undoes Perm 1, Perm 3 undoes Perm 2)*\n' +
        '• `/unban` — Unban a user early *(Perm 3 only)*'
      );
    }

    // ===== MAINTENANCE =====
    if (interaction.commandName === 'maintenance') {
      if (interaction.user.id !== MAINT_USER_ID) return interaction.editReply('❌ No permission.');
      maintenanceMode = !maintenanceMode;
      if (maintenanceMode) { await setMaintenanceStatus(); return interaction.editReply('✅ Maintenance mode enabled.'); }
      else { await setNormalStatus(); return interaction.editReply('✅ Maintenance mode disabled.'); }
    }

    // ===== SCHEDULE =====
    if (interaction.commandName === 'schedule') {
      if (!hasScheduleRole && !isWhitelisted) return interaction.editReply('❌ No permission.');
      const dateStr = interaction.options.getString('date');
      const timeStr = interaction.options.getString('time');
      const tz = interaction.options.getString('timezone');
      const desc = interaction.options.getString('description') || 'Session';
      if (!/^\d{2}\/\d{2}\/\d{4}$/.test(dateStr)) return interaction.editReply('❌ Date must be MM/DD/YYYY.');
      if (!/^\d{2}:\d{2}$/.test(timeStr)) return interaction.editReply('❌ Time must be HH:MM (24hr).');
      const startMs = parseScheduleTime(dateStr, timeStr, tz);
      if (startMs <= Date.now()) return interaction.editReply('❌ That time is in the past.');
      const id = Date.now().toString();
      const sched = { id, userId: interaction.user.id, userTag: interaction.user.tag, desc, startTime: startMs, signups: new Set(), notified: false, embedMessageId: null };
      schedules.push(sched);
      const embed = new EmbedBuilder().setTitle('📅 Scheduled Session').setColor(0x00AAFF)
        .setDescription(`**Host:** ${interaction.user.tag}\n**Description:** ${desc}\n**Starts:** ${formatTimestamp(startMs)}\n\n_Time shown in your local timezone automatically._`)
        .setFooter({ text: `Signups: 0 | ID: ${id}` });
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`signup-sched-${id}`).setLabel('Sign Up').setStyle(ButtonStyle.Success)
      );
      if (!announceChannel) return interaction.editReply('❌ Announcement channel missing.');
      const msg = await announceChannel.send({ embeds: [embed], components: [row] });
      sched.embedMessageId = msg.id;
      return interaction.editReply(`✅ Session scheduled! ID: \`${id}\``);
    }

    // ===== SCHEDULE VIEW =====
    if (interaction.commandName === 'schedule-view') {
      if (schedules.length === 0) return interaction.editReply('📅 No upcoming sessions.');
      const lines = schedules.map(s =>
        `• **${s.desc}** — ${formatTimestamp(s.startTime)} — Host: ${s.userTag} — Signups: ${s.signups.size} — ID: \`${s.id}\``
      ).join('\n');
      return interaction.editReply(`📅 **Upcoming Sessions:**\n${lines}\n\nClick **Sign Up** on the session post in <#${ANNOUNCE_CHANNEL_ID}> to join!`);
    }

    // ===== DEL SCHEDULE =====
    if (interaction.commandName === 'del-schedule') {
      if (!hasScheduleRole && !isWhitelisted) return interaction.editReply('❌ No permission.');
      const sessionId = interaction.options.getString('session-id');
      const index = schedules.findIndex(s => s.id === sessionId);
      if (index === -1) return interaction.editReply('❌ Session not found.');
      const sched = schedules[index];
      if (sched.embedMessageId && announceChannel) {
        try { const msg = await announceChannel.messages.fetch(sched.embedMessageId); await msg.delete(); } catch {}
      }
      schedules.splice(index, 1);
      return interaction.editReply(`✅ Deleted session "${sched.desc}".`);
    }

    // ===== SSU =====
    if (interaction.commandName === 'ssu') {
      const link = interaction.options.getString('game_link');
      const schedId = interaction.options.getString('schedule_id');

      if (!link.startsWith('https://roblox.com')) return interaction.editReply('❌ Link must start with `https://roblox.com`.');
      if (!announceChannel) return interaction.editReply('❌ Announcement channel missing.');

      // Whitelisted users start immediately
      if (isWhitelisted) {
        await executeSSU(interaction.user.id, interaction.user.tag, link, schedId);
        return interaction.editReply('✅ Session started!');
      }

      // SSU request role — send approval DM to all WL users, first to respond wins
      if (hasSSURequestRole) {
        const existing = Object.values(pendingSSURequests).find(r => r.userId === interaction.user.id);
        if (existing) return interaction.editReply('⚠️ You already have a pending SSU request. Please wait for it to be reviewed.');

        const reqId = `ssuReq-${Date.now()}`;
        pendingSSURequests[reqId] = {
          userId: interaction.user.id,
          userTag: interaction.user.tag,
          gameLink: link,
          schedId: schedId || null,
          dmMessageIds: {}
        };

        const dmEmbed = new EmbedBuilder()
          .setTitle('🔔 SSU Approval Request')
          .setColor(0x00AAFF)
          .setDescription(`**${interaction.user.tag}** is requesting to start a session and needs approval.\n\n⚡ **First whitelisted user to approve will start the session.**`)
          .addFields(
            { name: 'Requested By', value: `${interaction.user.tag} (<@${interaction.user.id}>)` },
            { name: 'Game Link', value: link },
            { name: 'Schedule ID', value: schedId || 'None' },
            { name: 'Request ID', value: reqId }
          )
          .setTimestamp();

        const approveBtn = new ButtonBuilder().setCustomId(`ssuApprove-${reqId}`).setLabel('✅ Approve').setStyle(ButtonStyle.Success);
        const denyBtn = new ButtonBuilder().setCustomId(`ssuDeny-${reqId}`).setLabel('❌ Deny').setStyle(ButtonStyle.Danger);
        const row = new ActionRowBuilder().addComponents(approveBtn, denyBtn);

        let sentCount = 0;
        for (const wlId of WHITELIST_USERS) {
          try {
            const wlUser = await client.users.fetch(wlId);
            const dmMsg = await wlUser.send({ embeds: [dmEmbed], components: [row] });
            pendingSSURequests[reqId].dmMessageIds[wlId] = dmMsg.id;
            sentCount++;
          } catch (err) {
            console.error(`Failed to DM WL user ${wlId}:`, err.message);
          }
        }

        if (sentCount === 0) {
          delete pendingSSURequests[reqId];
          return interaction.editReply('❌ Could not reach any whitelisted users. Please ask them to enable DMs.');
        }

        return interaction.editReply(`⏳ SSU request sent to **${sentCount}** whitelisted user(s). Only **one** approval is needed. You will be notified of the outcome.`);
      }

      return interaction.editReply('❌ You do not have permission to start a session.');
    }

    // ===== SERVER HOP =====
    if (interaction.commandName === 'server-hop') {
      if (!isWhitelisted && !isCurrentHost)
        return interaction.editReply('❌ Only whitelisted users or the current session host can start a server hop.');
      if (!announceChannel) return interaction.editReply('❌ Announcement channel missing.');

      const link = interaction.options.getString('game_link');
      if (!link.startsWith('https://roblox.com')) return interaction.editReply('❌ Link must start with `https://roblox.com`.');

      const embed = new EmbedBuilder().setTitle('🔄 Server Hopping!').setColor(0xFFAA00)
        .setDescription('A server hop was started! Please join the new server below.');
      const msg = await announceChannel.send({ content: `@here <@&${SHIFT_ROLE_ID}>`, embeds: [embed], components: [buildSessionButtons(link)] });
      activeSessionMessageId = msg.id;
      activeSessionChannelId = announceChannel.id;
      if (currentSession) currentSession.gameLink = link;
      return interaction.editReply('✅ Server hop posted!');
    }

    // ===== SSD =====
    if (interaction.commandName === 'ssd') {
      if (!isWhitelisted && !isCurrentHost)
        return interaction.editReply('❌ Only the current session host or whitelisted users can shut down the session.');

      await interaction.guild.members.fetch();
      const membersWithRole = interaction.guild.members.cache.filter(m => m.roles.cache.has(SHIFT_ROLE_ID));
      for (const [uid, m] of membersWithRole) {
        try { await m.roles.remove(SHIFT_ROLE_ID); } catch {}
        try { await m.send('The session has ended, thank you for your participation. Your shift was automatically ended. If this was a mistake please open a ticket.'); } catch {}
        if (shiftStartTimes[uid]) {
          const elapsed = Math.floor((Date.now() - shiftStartTimes[uid]) / 1000);
          weeklyActivity[uid] = (weeklyActivity[uid] || 0) + elapsed;
          delete shiftStartTimes[uid];
        }
      }
      saveJSON(FILES.weeklyActivity, weeklyActivity);
      saveJSON(FILES.shiftStartTimes, shiftStartTimes);

      if (activeSessionMessageId) {
        try {
          const sc = await client.channels.fetch(activeSessionChannelId);
          const sm = await sc.messages.fetch(activeSessionMessageId);
          await sm.edit({ components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setLabel('Join Session').setStyle(ButtonStyle.Link).setURL('https://roblox.com').setDisabled(true),
            new ButtonBuilder().setCustomId('start-shift-disabled').setLabel('Start Shift').setStyle(ButtonStyle.Success).setDisabled(true),
            new ButtonBuilder().setCustomId('end-shift-disabled').setLabel('End Shift').setStyle(ButtonStyle.Danger).setDisabled(true)
          )] });
        } catch {}
        activeSessionMessageId = null;
      }

      currentSession = null;

      if (announceChannel) await announceChannel.send({ embeds: [new EmbedBuilder().setTitle('🔴 Session Shutdown').setColor(0xFF0000).setDescription('The session has been shutdown.')] });
      return interaction.editReply(`✅ Session shut down. Removed shift role from ${membersWithRole.size} member(s).`);
    }

    // ===== HOST TRANSFER =====
    if (interaction.commandName === 'host-transfer') {
      if (!isWhitelisted && !isCurrentHost)
        return interaction.editReply('❌ Only the current session host or whitelisted users can transfer the host.');
      if (!currentSession)
        return interaction.editReply('❌ There is no active session to transfer.');

      const newHostUser = interaction.options.getUser('user');
      const newHostMember = await interaction.guild.members.fetch(newHostUser.id).catch(() => null);
      if (!newHostMember) return interaction.editReply('❌ User not found in this server.');
      if (newHostUser.id === currentSession.hostId) return interaction.editReply('⚠️ That user is already the host.');

      const oldHostTag = currentSession.hostTag;
      const oldHostId = currentSession.hostId;
      currentSession.hostId = newHostUser.id;
      currentSession.hostTag = newHostUser.tag;

      // DM the new host
      try {
        const newHostEmbed = new EmbedBuilder()
          .setTitle('🎙️ You Are Now the Session Host')
          .setColor(0x00AAFF)
          .setDescription(`Session host has been transferred to you by **${interaction.user.tag}**.\nYou now have control of \`/server-hop\`, \`/ssd\`, and \`/host-transfer\`.`)
          .setTimestamp();
        await newHostUser.send({ embeds: [newHostEmbed] });
      } catch {}

      // DM the old host if they didn't initiate the transfer themselves
      if (oldHostId !== interaction.user.id) {
        try {
          const oldHostUser = await client.users.fetch(oldHostId);
          const oldHostEmbed = new EmbedBuilder()
            .setTitle('🔁 Host Transferred Away')
            .setColor(0xFFAA00)
            .setDescription(`Your host status has been transferred to **${newHostUser.tag}** by **${interaction.user.tag}**.`)
            .setTimestamp();
          await oldHostUser.send({ embeds: [oldHostEmbed] });
        } catch {}
      }

      // Announce in the session channel
      if (announceChannel) {
        const announceEmbed = new EmbedBuilder()
          .setTitle('🔁 Host Transfer')
          .setColor(0x00AAFF)
          .setDescription(`Session host has been transferred from **${oldHostTag}** to **${newHostUser.tag}**.`)
          .addFields({ name: 'Transferred by', value: interaction.user.tag, inline: true })
          .setTimestamp();
        await announceChannel.send({ embeds: [announceEmbed] });
      }

      return interaction.editReply(`✅ Host transferred from **${oldHostTag}** to **${newHostUser.tag}**.`);
    }

    // ===== NOTIFY ACTIVE =====
    if (interaction.commandName === 'notify-active') {
      if (!hasNotifyRole) return interaction.editReply('❌ No permission.');
      const text = interaction.options.getString('message');
      await interaction.guild.members.fetch();
      const active = interaction.guild.members.cache.filter(m => m.roles.cache.has(SHIFT_ROLE_ID));
      let count = 0;
      for (const [, m] of active) {
        try { await m.send(`Notification to all active units from: ${interaction.user.tag}, ${text}`); count++; } catch {}
      }
      return interaction.editReply(`✅ Notified ${count} active member(s).`);
    }

    // =========================================================
    // ==================== MODERATION ========================
    // =========================================================

    // ===== TOPIC =====
    if (interaction.commandName === 'topic') {
      if (permLevel < 1) return interaction.editReply('❌ You need at least Permission Level 1 to use this command.');
      const embed = new EmbedBuilder()
        .setTitle('🔄 Topic Change')
        .setColor(0xFF6600)
        .setDescription('Please change the current topic of conversation.\nKeep all discussion relevant, respectful, and within the server rules.')
        .addFields({ name: 'Requested by', value: `<@${interaction.user.id}>`, inline: true })
        .setTimestamp();
      await interaction.channel.send({ embeds: [embed] });
      return interaction.editReply('✅ Topic change embed sent.');
    }

    // ===== DM =====
    if (interaction.commandName === 'dm') {
      if (interaction.user.id !== MAINT_USER_ID) return interaction.editReply('❌ This command is owner only.');
      const targetUser = interaction.options.getUser('user');
      const message = interaction.options.getString('message');
      try {
        await targetUser.send(message);
        return interaction.editReply(`✅ Message sent to **${targetUser.tag}**.`);
      } catch (err) {
        return interaction.editReply(`❌ Failed to DM **${targetUser.tag}**. They may have DMs disabled.\n\`${err.message}\``);
      }
    }

    // ===== WARN =====
    if (interaction.commandName === 'warn') {
      if (permLevel < 1) return interaction.editReply('❌ You need at least Permission Level 1 to use this command.');

      const targetUser = interaction.options.getUser('user');
      const reason = interaction.options.getString('reason');
      const targetMember = await interaction.guild.members.fetch(targetUser.id).catch(() => null);

      if (!targetMember) return interaction.editReply('❌ User not found in this server.');
      const targetPerm = getPermLevel(targetMember);
      if (targetPerm >= permLevel) return interaction.editReply('❌ You cannot warn someone with an equal or higher permission level.');

      if (!warnings[targetUser.id]) warnings[targetUser.id] = [];
      warnings[targetUser.id].push({
        reason,
        moderatorTag: interaction.user.tag,
        moderatorId: interaction.user.id,
        timestamp: Date.now()
      });
      saveJSON(FILES.warnings, warnings);
      const warnCount = warnings[targetUser.id].length;

      try {
        const warnEmbed = new EmbedBuilder()
          .setTitle('⚠️ You Have Been Warned')
          .setColor(0xFFFF00)
          .setDescription(`You have received a warning in **${interaction.guild.name}**.`)
          .addFields(
            { name: 'Reason', value: reason },
            { name: 'Moderator', value: interaction.user.tag },
            { name: 'Total Warnings', value: String(warnCount) }
          )
          .setTimestamp();
        await targetUser.send({ embeds: [warnEmbed] });
      } catch {}

      await sendModLog(modLogEmbed('Warning Issued', interaction.user, targetUser, { reason, warnCount, color: 0xFFFF00 }));

      if (warnCount >= 3) {
        try {
          await targetMember.timeout(5 * 60 * 1000, `Auto-mute: 3 warnings reached`);
        } catch (err) { console.error('Auto-mute failed:', err.message); }

        const autoMuteLog = new EmbedBuilder()
          .setTitle('🔇 Auto-Mute Applied (3 Warnings)')
          .setColor(0xFF6600)
          .setDescription(`<@${targetUser.id}> has been automatically muted for 5 minutes due to reaching 3 warnings.`)
          .addFields({ name: 'Moderator who issued 3rd warn', value: interaction.user.tag })
          .setTimestamp();
        await sendModLog(autoMuteLog);

        if (permLevel >= 2) {
          const reqId = `muteReq-${Date.now()}`;
          pendingMuteRequests[reqId] = {
            targetId: targetUser.id,
            targetTag: targetUser.tag,
            moderatorId: interaction.user.id,
            moderatorTag: interaction.user.tag,
            reason,
            warnCount
          };

          const dmEmbed = new EmbedBuilder()
            .setTitle('🔔 Action Required: 3rd Warning Issued')
            .setColor(0xFF6600)
            .setDescription(`You issued the 3rd warning to **${targetUser.tag}**.\nA 5-minute auto-mute has been applied.\n\nDo you want to apply an **additional extended mute**?`)
            .addFields(
              { name: 'Target', value: `${targetUser.tag} (<@${targetUser.id}>)` },
              { name: 'Reason', value: reason },
              { name: 'Request ID', value: reqId }
            );

          const yesBtn = new ButtonBuilder().setCustomId(`muteApprove-${reqId}`).setLabel('Yes, Mute More').setStyle(ButtonStyle.Danger);
          const noBtn = new ButtonBuilder().setCustomId(`muteDeny-${reqId}`).setLabel('No, 5min is Enough').setStyle(ButtonStyle.Secondary);
          const row = new ActionRowBuilder().addComponents(yesBtn, noBtn);
          try { await interaction.user.send({ embeds: [dmEmbed], components: [row] }); } catch {}

        } else {
          const reqId = `muteReq-${Date.now()}`;
          pendingMuteRequests[reqId] = {
            targetId: targetUser.id,
            targetTag: targetUser.tag,
            moderatorId: interaction.user.id,
            moderatorTag: interaction.user.tag,
            reason,
            warnCount
          };

          const modChannel = await client.channels.fetch(MOD_LOG_CHANNEL_ID).catch(() => null);
          if (modChannel) {
            const requestEmbed = new EmbedBuilder()
              .setTitle('⚠️ Mute Approval Request')
              .setColor(0xFF6600)
              .setDescription(`<@&${PERM_ROLES[2][0]}> — A member has reached 3 warnings. A 5-minute auto-mute has been applied. Approve an extended mute?`)
              .addFields(
                { name: 'Target', value: `${targetUser.tag} (<@${targetUser.id}>)` },
                { name: 'Moderator (Perm 1)', value: `${interaction.user.tag} (<@${interaction.user.id}>)` },
                { name: 'Reason for 3rd Warn', value: reason },
                { name: 'Request ID', value: reqId }
              )
              .setTimestamp();

            const approveBtn = new ButtonBuilder().setCustomId(`muteApprove-${reqId}`).setLabel('Approve Extended Mute').setStyle(ButtonStyle.Danger);
            const denyBtn = new ButtonBuilder().setCustomId(`muteDeny-${reqId}`).setLabel('Deny — 5min is enough').setStyle(ButtonStyle.Secondary);
            const row = new ActionRowBuilder().addComponents(approveBtn, denyBtn);
            await modChannel.send({ content: `<@&${PERM_ROLES[2][0]}>`, embeds: [requestEmbed], components: [row] });
          }

          try {
            const processingEmbed = new EmbedBuilder()
              .setTitle('⏳ Mute Request Submitted')
              .setColor(0x00AAFF)
              .setDescription(`Your 3rd warning for **${targetUser.tag}** has triggered a mute approval request.\nA 5-minute auto-mute has been applied. A Perm 2+ moderator is reviewing an extended mute.\nYou will be notified of the outcome.`)
              .addFields({ name: 'Request ID', value: reqId });
            await interaction.user.send({ embeds: [processingEmbed] });
          } catch {}
        }

        return interaction.editReply(`⚠️ Warning issued. **${targetUser.tag}** now has **${warnCount}** warnings. A 5-minute auto-mute has been applied and an extended mute review has been initiated.`);
      }

      return interaction.editReply(`✅ Warned **${targetUser.tag}**. They now have **${warnCount}** warning(s).`);
    }

    // ===== VIEW WARNINGS =====
    if (interaction.commandName === 'view-warnings') {
      if (permLevel < 1) return interaction.editReply('❌ You need at least Permission Level 1.');
      const targetUser = interaction.options.getUser('user');
      const userWarns = warnings[targetUser.id] || [];
      if (userWarns.length === 0) return interaction.editReply(`✅ **${targetUser.tag}** has no warnings.`);

      const embed = new EmbedBuilder()
        .setTitle(`⚠️ Warnings for ${targetUser.tag}`)
        .setColor(0xFFFF00)
        .setDescription(userWarns.map((w, i) =>
          `**${i + 1}.** ${w.reason}\n*By ${w.moderatorTag} — <t:${Math.floor(w.timestamp / 1000)}:R>*`
        ).join('\n\n'))
        .setFooter({ text: `Total: ${userWarns.length}` })
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }

    // ===== MY WARNS =====
    if (interaction.commandName === 'my-warns') {
      const userWarns = warnings[interaction.user.id] || [];
      if (userWarns.length === 0) return interaction.editReply('✅ You have no warnings.');

      const embed = new EmbedBuilder()
        .setTitle('⚠️ Your Warnings')
        .setColor(0xFFFF00)
        .setDescription(userWarns.map((w, i) =>
          `**${i + 1}.** ${w.reason}\n*By ${w.moderatorTag} — <t:${Math.floor(w.timestamp / 1000)}:R>*`
        ).join('\n\n'))
        .setFooter({ text: `Total: ${userWarns.length}` })
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }

    // ===== BLOXY BAN =====
    if (interaction.commandName === 'bloxy-ban') {
      if (permLevel < 3) return interaction.editReply('❌ You need Permission Level 3 to use this command.');

      const targetUser = interaction.options.getUser('user');
      const durationStr = interaction.options.getString('duration');
      const reason = interaction.options.getString('reason');
      const targetMember = await interaction.guild.members.fetch(targetUser.id).catch(() => null);

      if (!targetMember) return interaction.editReply('❌ User not found in this server.');
      const targetPerm = getPermLevel(targetMember);
      if (targetPerm >= permLevel) return interaction.editReply('❌ You cannot ban someone with an equal or higher permission level.');

      const durationMs = parseDuration(durationStr);
      if (!durationMs) return interaction.editReply('❌ Invalid duration. Use format: `10m`, `2h`, `3d`, `1w`.');

      const unbanTime = new Date(Date.now() + durationMs);

      try {
        const banDmEmbed = new EmbedBuilder()
          .setTitle('🔨 You Have Been Banned')
          .setColor(0xFF0000)
          .setDescription(`You have been banned from **${interaction.guild.name}**.`)
          .addFields(
            { name: 'Reason', value: reason },
            { name: 'Duration', value: humanDuration(durationMs) },
            { name: 'Expires', value: `<t:${Math.floor(unbanTime.getTime() / 1000)}:F>` },
            { name: 'Banned By', value: interaction.user.tag }
          )
          .setTimestamp();
        await targetUser.send({ embeds: [banDmEmbed] });
      } catch {}

      try {
        await targetMember.ban({ reason: `${reason} | Duration: ${humanDuration(durationMs)} | By: ${interaction.user.tag}` });
      } catch (err) {
        return interaction.editReply(`❌ Failed to ban: ${err.message}`);
      }

      savedBans[targetUser.id] = {
        expiresAt: Date.now() + durationMs,
        tag: targetUser.tag,
        guildId: interaction.guild.id,
        reason,
        duration: humanDuration(durationMs)
      };
      saveJSON(FILES.activeBans, savedBans);
      scheduleBanExpiry(targetUser.id, targetUser.tag, interaction.guild.id, durationMs);
      await sendModLog(modLogEmbed('Member Banned', interaction.user, targetUser, { reason, duration: humanDuration(durationMs), color: 0xFF0000 }));

      return interaction.editReply(`✅ **${targetUser.tag}** has been banned for **${humanDuration(durationMs)}**.\nThey were DM'd before the ban.`);
    }

    // ===== STATUS =====
    if (interaction.commandName === 'status') {
      if (interaction.user.id !== MAINT_USER_ID) return interaction.editReply('❌ This command is owner only.');
      const text = interaction.options.getString('text');
      const emoji = interaction.options.getString('emoji') || '';
      const state = interaction.options.getString('state') || 'idle';
      const fullText = emoji ? `${emoji} ${text}` : text;
      try {
        await client.user.setPresence({
          status: state,
          activities: [{ name: fullText, type: ActivityType.Playing }]
        });
        return interaction.editReply(`✅ Status updated to **${fullText}** (${state})`);
      } catch (err) {
        return interaction.editReply(`❌ Failed to set status: ${err.message}`);
      }
    }

    // ===== UNWARN =====
    if (interaction.commandName === 'unwarn') {
      if (permLevel < 2) return interaction.editReply('❌ You need at least Permission Level 2 to remove warnings.');

      const targetUser = interaction.options.getUser('user');
      const warnIndex = interaction.options.getInteger('index') - 1;
      const userWarns = warnings[targetUser.id] || [];

      if (userWarns.length === 0) return interaction.editReply(`✅ **${targetUser.tag}** has no warnings to remove.`);
      if (warnIndex < 0 || warnIndex >= userWarns.length)
        return interaction.editReply(`❌ Invalid warning number. **${targetUser.tag}** has ${userWarns.length} warning(s).`);

      const warn = userWarns[warnIndex];
      let warnIssuerPerm = 1;
      try {
        const warnIssuerMember = await interaction.guild.members.fetch(warn.moderatorId);
        warnIssuerPerm = getPermLevel(warnIssuerMember);
      } catch {}

      if (permLevel < 3 && warnIssuerPerm >= permLevel)
        return interaction.editReply(`❌ You need a higher permission level than the moderator who issued this warning (Perm ${warnIssuerPerm}) to remove it.`);

      warnings[targetUser.id].splice(warnIndex, 1);
      saveJSON(FILES.warnings, warnings);
      const remaining = warnings[targetUser.id].length;

      try {
        const dmEmbed = new EmbedBuilder()
          .setTitle('✅ Warning Removed')
          .setColor(0x00FF00)
          .setDescription(`A warning has been removed from your record in **${interaction.guild.name}**.`)
          .addFields(
            { name: 'Warning Removed', value: warn.reason },
            { name: 'Removed By', value: interaction.user.tag },
            { name: 'Remaining Warnings', value: String(remaining) }
          )
          .setTimestamp();
        await targetUser.send({ embeds: [dmEmbed] });
      } catch {}

      const logEmbed = new EmbedBuilder()
        .setTitle('🗑️ Warning Removed')
        .setColor(0x00FF00)
        .addFields(
          { name: 'Moderator', value: `${interaction.user.tag} (<@${interaction.user.id}>)`, inline: true },
          { name: 'Target', value: `${targetUser.tag} (<@${targetUser.id}>)`, inline: true },
          { name: 'Warning Removed', value: warn.reason },
          { name: 'Originally Issued By', value: warn.moderatorTag, inline: true },
          { name: 'Remaining Warnings', value: String(remaining), inline: true }
        )
        .setTimestamp();
      await sendModLog(logEmbed);

      return interaction.editReply(`✅ Removed warning #${warnIndex + 1} from **${targetUser.tag}**. They now have **${remaining}** warning(s).`);
    }

    // ===== UNMUTE =====
    if (interaction.commandName === 'unmute') {
      if (permLevel < 2) return interaction.editReply('❌ You need at least Permission Level 2 to unmute members.');

      const targetUser = interaction.options.getUser('user');
      const reason = interaction.options.getString('reason') || 'No reason provided';
      const targetMember = await interaction.guild.members.fetch(targetUser.id).catch(() => null);

      if (!targetMember) return interaction.editReply('❌ User not found in this server.');
      if (!targetMember.communicationDisabledUntil || targetMember.communicationDisabledUntil < new Date())
        return interaction.editReply('⚠️ That user is not currently muted.');

      const targetPerm = getPermLevel(targetMember);
      if (targetPerm >= permLevel)
        return interaction.editReply('❌ You cannot unmute someone with an equal or higher permission level than you.');

      try {
        await targetMember.timeout(null, `Unmuted by ${interaction.user.tag}: ${reason}`);
      } catch (err) {
        return interaction.editReply(`❌ Failed to unmute: ${err.message}`);
      }

      try {
        const dmEmbed = new EmbedBuilder()
          .setTitle('🔊 You Have Been Unmuted')
          .setColor(0x00FF00)
          .setDescription(`Your mute in **${interaction.guild.name}** has been lifted.`)
          .addFields(
            { name: 'Reason', value: reason },
            { name: 'Unmuted By', value: interaction.user.tag }
          )
          .setTimestamp();
        await targetUser.send({ embeds: [dmEmbed] });
      } catch {}

      const logEmbed = new EmbedBuilder()
        .setTitle('🔊 Member Unmuted')
        .setColor(0x00FF00)
        .addFields(
          { name: 'Moderator', value: `${interaction.user.tag} (<@${interaction.user.id}>)`, inline: true },
          { name: 'Target', value: `${targetUser.tag} (<@${targetUser.id}>)`, inline: true },
          { name: 'Reason', value: reason }
        )
        .setTimestamp();
      await sendModLog(logEmbed);

      return interaction.editReply(`✅ **${targetUser.tag}** has been unmuted.`);
    }

    // ===== UNBAN =====
    if (interaction.commandName === 'unban') {
      if (permLevel < 3) return interaction.editReply('❌ You need Permission Level 3 to unban members.');

      const userId = interaction.options.getString('userid');
      const reason = interaction.options.getString('reason') || 'No reason provided';

      let bannedUser;
      try {
        bannedUser = await interaction.guild.bans.fetch(userId);
      } catch {
        return interaction.editReply('❌ That user is not currently banned, or the ID is invalid.');
      }

      try {
        await interaction.guild.members.unban(userId, `Unbanned by ${interaction.user.tag}: ${reason}`);
        if (savedBans[userId]) { delete savedBans[userId]; saveJSON(FILES.activeBans, savedBans); }
      } catch (err) {
        return interaction.editReply(`❌ Failed to unban: ${err.message}`);
      }

      try {
        const unbannedUser = await client.users.fetch(userId);
        const dmEmbed = new EmbedBuilder()
          .setTitle('✅ You Have Been Unbanned')
          .setColor(0x00FF00)
          .setDescription(`Your ban from **${interaction.guild.name}** has been lifted early.`)
          .addFields(
            { name: 'Reason', value: reason },
            { name: 'Unbanned By', value: interaction.user.tag }
          )
          .setTimestamp();
        await unbannedUser.send({ embeds: [dmEmbed] });
      } catch {}

      const logEmbed = new EmbedBuilder()
        .setTitle('🔓 Member Unbanned Early')
        .setColor(0x00FF00)
        .addFields(
          { name: 'Moderator', value: `${interaction.user.tag} (<@${interaction.user.id}>)`, inline: true },
          { name: 'Target', value: `${bannedUser.user.tag} (${userId})`, inline: true },
          { name: 'Reason', value: reason }
        )
        .setTimestamp();
      await sendModLog(logEmbed);

      return interaction.editReply(`✅ **${bannedUser.user.tag}** has been unbanned early.`);
    }

  } catch (err) {
    console.error(err);
    await setDowntimeStatus();
    try { interaction.editReply('❌ An error occurred.'); } catch {}
  }
});

// -------------------- BUTTON HANDLER --------------------
client.on('interactionCreate', async interaction => {
  if (interaction.type !== InteractionType.MessageComponent) return;
  try {
    const guild = interaction.guild;
    const member = guild ? await guild.members.fetch(interaction.user.id).catch(() => null) : null;

    // ===== SSU APPROVE =====
    if (interaction.customId.startsWith('ssuApprove-')) {
      const reqId = interaction.customId.replace('ssuApprove-', '');
      const req = pendingSSURequests[reqId];
      if (!req) return interaction.reply({ content: '❌ Request not found or already handled.', ephemeral: true });
      if (!WHITELIST_USERS.includes(interaction.user.id))
        return interaction.reply({ content: '❌ Only whitelisted users can approve SSU requests.', ephemeral: true });

      await interaction.reply({ content: '✅ SSU approved! Session is now starting.', ephemeral: true });

      // Disable buttons on ALL WL DMs so the other WL user can't double-act
      for (const [wlId, msgId] of Object.entries(req.dmMessageIds)) {
        try {
          const wlUser = await client.users.fetch(wlId);
          const dmChannel = await wlUser.createDM();
          const dmMsg = await dmChannel.messages.fetch(msgId);
          await dmMsg.edit({ components: [] });
        } catch {}
      }

      // Notify the other WL user that it was approved
      for (const wlId of WHITELIST_USERS) {
        if (wlId === interaction.user.id) continue;
        try {
          const otherWl = await client.users.fetch(wlId);
          await otherWl.send({ content: `ℹ️ The SSU request from **${req.userTag}** was approved by **${interaction.user.tag}** and the session is now live.` });
        } catch {}
      }

      // Notify the requester
      try {
        const approvedEmbed = new EmbedBuilder()
          .setTitle('✅ SSU Request Approved')
          .setColor(0x00FF00)
          .setDescription(`Your session request was approved by **${interaction.user.tag}**! The session is now live.`)
          .setTimestamp();
        const requester = await client.users.fetch(req.userId);
        await requester.send({ embeds: [approvedEmbed] });
      } catch {}

      await executeSSU(req.userId, req.userTag, req.gameLink, req.schedId);
      delete pendingSSURequests[reqId];
    }

    // ===== SSU DENY =====
    if (interaction.customId.startsWith('ssuDeny-')) {
      const reqId = interaction.customId.replace('ssuDeny-', '');
      const req = pendingSSURequests[reqId];
      if (!req) return interaction.reply({ content: '❌ Request not found or already handled.', ephemeral: true });
      if (!WHITELIST_USERS.includes(interaction.user.id))
        return interaction.reply({ content: '❌ Only whitelisted users can deny SSU requests.', ephemeral: true });

      await interaction.reply({ content: '✅ SSU request denied.', ephemeral: true });

      // Disable buttons on all WL DMs
      for (const [wlId, msgId] of Object.entries(req.dmMessageIds)) {
        try {
          const wlUser = await client.users.fetch(wlId);
          const dmChannel = await wlUser.createDM();
          const dmMsg = await dmChannel.messages.fetch(msgId);
          await dmMsg.edit({ components: [] });
        } catch {}
      }

      // Notify the requester
      try {
        const deniedEmbed = new EmbedBuilder()
          .setTitle('❌ SSU Request Denied')
          .setColor(0xFF0000)
          .setDescription(`Your session start request was denied by **${interaction.user.tag}**.`)
          .setTimestamp();
        const requester = await client.users.fetch(req.userId);
        await requester.send({ embeds: [deniedEmbed] });
      } catch {}

      // Notify the other WL user
      for (const wlId of WHITELIST_USERS) {
        if (wlId === interaction.user.id) continue;
        try {
          const otherWl = await client.users.fetch(wlId);
          await otherWl.send({ content: `ℹ️ The SSU request from **${req.userTag}** was denied by **${interaction.user.tag}**.` });
        } catch {}
      }

      delete pendingSSURequests[reqId];
    }

    // ===== MUTE APPROVE =====
    if (interaction.customId.startsWith('muteApprove-')) {
      const reqId = interaction.customId.replace('muteApprove-', '');
      const req = pendingMuteRequests[reqId];
      if (!req) return interaction.reply({ content: '❌ Request not found or already handled.', ephemeral: true });

      await interaction.reply({ content: '✅ Applying 1 hour extended mute.', ephemeral: true });

      const extendedMs = 60 * 60 * 1000;
      try {
        const targetMember = await guild.members.fetch(req.targetId);
        await targetMember.timeout(extendedMs, `Extended mute approved by ${interaction.user.tag}`);
      } catch (err) { console.error('Extended mute failed:', err.message); }

      try {
        const origMod = await client.users.fetch(req.moderatorId);
        const updateEmbed = new EmbedBuilder()
          .setTitle('✅ Extended Mute Approved')
          .setColor(0x00FF00)
          .setDescription(`Your mute request for **${req.targetTag}** was approved by ${interaction.user.tag}.\nAn extended mute of **1 hour** has been applied.`);
        await origMod.send({ embeds: [updateEmbed] });
      } catch {}

      const logEmbed = new EmbedBuilder().setTitle('🔇 Extended Mute Applied').setColor(0xFF6600)
        .setDescription(`Extended mute of 1 hour applied to <@${req.targetId}> (${req.targetTag}).`)
        .addFields(
          { name: 'Approved By', value: `${interaction.user.tag}` },
          { name: 'Original Moderator', value: req.moderatorTag }
        ).setTimestamp();
      await sendModLog(logEmbed);

      delete pendingMuteRequests[reqId];
      try { await interaction.message.edit({ components: [] }); } catch {}
    }

    // ===== MUTE DENY =====
    if (interaction.customId.startsWith('muteDeny-')) {
      const reqId = interaction.customId.replace('muteDeny-', '');
      const req = pendingMuteRequests[reqId];
      if (!req) return interaction.reply({ content: '❌ Request not found or already handled.', ephemeral: true });

      try {
        const origMod = await client.users.fetch(req.moderatorId);
        const updateEmbed = new EmbedBuilder()
          .setTitle('❌ Extended Mute Denied')
          .setColor(0xFF0000)
          .setDescription(`Your mute request for **${req.targetTag}** was reviewed by ${interaction.user.tag}.\nNo extended mute was applied. The 5-minute auto-mute remains.`);
        await origMod.send({ embeds: [updateEmbed] });
      } catch {}

      const logEmbed = new EmbedBuilder().setTitle('🔇 Extended Mute Denied').setColor(0xAAAAAA)
        .setDescription(`Extended mute request for ${req.targetTag} was denied by ${interaction.user.tag}. 5-minute auto-mute remains.`)
        .setTimestamp();
      await sendModLog(logEmbed);

      delete pendingMuteRequests[reqId];
      try { await interaction.reply({ content: '✅ Extended mute denied. Original mod notified.', ephemeral: true }); } catch {}
      try { await interaction.message.edit({ components: [] }); } catch {}
    }

    // ===== SESSION SIGNUP =====
    if (interaction.customId.startsWith('signup-sched-')) {
      const sid = interaction.customId.replace('signup-sched-', '');
      const sched = schedules.find(s => s.id === sid);
      if (!sched) return interaction.reply({ content: '❌ Session not found or already started.', ephemeral: true });
      if (sched.signups.has(interaction.user.id))
        return interaction.reply({ content: '⚠️ You are already signed up.', ephemeral: true });
      sched.signups.add(interaction.user.id);
      await interaction.reply({ content: `✅ You signed up for **"${sched.desc}"**! You'll be pinged when it starts.`, ephemeral: true });
      try {
        const message = await interaction.channel.messages.fetch(interaction.message.id);
        const embed = EmbedBuilder.from(message.embeds[0]);
        embed.setFooter({ text: `Signups: ${sched.signups.size} | ID: ${sched.id}` });
        await message.edit({ embeds: [embed] });
      } catch {}
    }

    // ===== START SHIFT =====
    if (interaction.customId === 'start-shift') {
      if (!member) return interaction.reply({ content: '❌ Could not find your member profile.', ephemeral: true });
      if (member.roles.cache.has(SHIFT_ROLE_ID))
        return interaction.reply({ content: '⚠️ You already have an active shift.', ephemeral: true });
      await member.roles.add(SHIFT_ROLE_ID).catch(() => {});
      shiftStartTimes[interaction.user.id] = Date.now();
      saveJSON(FILES.shiftStartTimes, shiftStartTimes);
      return interaction.reply({ content: '✅ Your shift has started! Good luck!', ephemeral: true });
    }

    // ===== END SHIFT =====
    if (interaction.customId === 'end-shift') {
      if (!member) return interaction.reply({ content: '❌ Could not find your member profile.', ephemeral: true });
      if (!member.roles.cache.has(SHIFT_ROLE_ID))
        return interaction.reply({ content: '⚠️ You do not have an active shift.', ephemeral: true });
      await member.roles.remove(SHIFT_ROLE_ID).catch(() => {});
      if (shiftStartTimes[interaction.user.id]) {
        const elapsed = Math.floor((Date.now() - shiftStartTimes[interaction.user.id]) / 1000);
        weeklyActivity[interaction.user.id] = (weeklyActivity[interaction.user.id] || 0) + elapsed;
        delete shiftStartTimes[interaction.user.id];
        saveJSON(FILES.weeklyActivity, weeklyActivity);
        saveJSON(FILES.shiftStartTimes, shiftStartTimes);
      }
      return interaction.reply({ content: '✅ Your shift has ended. Thanks for your time!', ephemeral: true });
    }

  } catch (err) {
    console.error(err);
    try { interaction.reply({ content: '❌ Something went wrong.', ephemeral: true }); } catch {}
  }
});

// -------------------- ERROR HANDLER --------------------
process.on('unhandledRejection', async err => {
  console.error('Unhandled promise rejection:', err);
  await setDowntimeStatus();
});

client.login(TOKEN).catch(async err => {
  console.error('Login failed:', err);
  await setDowntimeStatus();
});
