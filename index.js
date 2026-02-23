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

const TOKEN = process.env.TOKEN;
const GUILD_ID = '1394380681341173810';
const ANNOUNCE_CHANNEL_ID = '1452777822618648678';
const MOD_LOG_CHANNEL_ID = '1475618663447920881';
const WHITELIST_USERS = ['1294697248759746561', '1166915839992270930'];
const MAINT_USER_ID = '1166915839992270930';
const SHIFT_ROLE_ID = '1475191266084917298';
const NOTIFY_ROLE_ID = '1395209235389743114';
const SCHEDULE_WHITELIST_ROLES = ['1410771734700888064', '1395231118537523220'];

// -------------------- PERMISSION LEVELS --------------------
// Higher = more powerful
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
let shiftStartTimes = {};
let weeklyActivity = {};
let activeSessionMessageId = null;
let activeSessionChannelId = ANNOUNCE_CHANNEL_ID;

// warnings: { userId: [ { reason, moderatorTag, moderatorId, timestamp } ] }
let warnings = {};

// pending mute approvals: { requestId: { targetId, targetTag, moderatorId, moderatorTag, reason, warnCount } }
let pendingMuteRequests = {};

// active temp bans: { userId: timeoutId } — for cleanup tracking
let activeBans = {};

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

// Parse time strings like "10m", "2h", "3d", "1w"
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
      } catch (err) { console.error('Weekly report error:', err); }
    }
  }, 60 * 1000);
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
    new SlashCommandBuilder().setName('ssu').setDescription('Start a session (whitelisted)')
      .addStringOption(o => o.setName('game_link').setDescription('Roblox link (https://roblox.com...)').setRequired(true))
      .addStringOption(o => o.setName('schedule_id').setDescription('Linked schedule ID (optional)').setRequired(false)).toJSON(),
    new SlashCommandBuilder().setName('server-hop').setDescription('Start a server hop (whitelisted)')
      .addStringOption(o => o.setName('game_link').setDescription('Roblox link (https://roblox.com...)').setRequired(true)).toJSON(),
    new SlashCommandBuilder().setName('ssd').setDescription('Shutdown the current session (whitelisted)').toJSON(),
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

    // Undo commands
    new SlashCommandBuilder().setName('unwarn').setDescription('Remove a warning from a user [Perm 2 to undo Perm 1 warns, Perm 3 for Perm 2]')
      .addUserOption(o => o.setName('user').setDescription('User to remove warning from').setRequired(true))
      .addIntegerOption(o => o.setName('index').setDescription('Warning number to remove (see /view-warnings)').setRequired(true)).toJSON(),
    new SlashCommandBuilder().setName('unmute').setDescription('Remove a timeout/mute from a user [Perm 2 to undo Perm 1 mutes, Perm 3 for Perm 2]')
      .addUserOption(o => o.setName('user').setDescription('User to unmute').setRequired(true))
      .addStringOption(o => o.setName('reason').setDescription('Reason for unmute').setRequired(false)).toJSON(),
    new SlashCommandBuilder().setName('unban').setDescription('Unban a user early [Perm 3 only]')
      .addStringOption(o => o.setName('userid').setDescription('User ID to unban').setRequired(true))
      .addStringOption(o => o.setName('reason').setDescription('Reason for early unban').setRequired(false)).toJSON()
  ];

  try {
    const rest = new REST({ version: '10' }).setToken(TOKEN);
    await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: commands });
    console.log('Slash commands registered.');
  } catch (err) { console.error(err); await setDowntimeStatus(); }

  startScheduleChecker();
  scheduleWeeklyReport();
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
        '• `/ssu` — Start a session *(whitelisted)*\n' +
        '• `/server-hop` — Server hop *(whitelisted)*\n' +
        '• `/ssd` — Shutdown session *(whitelisted)*\n' +
        '• `/notify-active` — DM all active members *(Perm 2)*\n' +
        '• `/maintenance` — Toggle maintenance *(owner)*\n\n' +
        '🛡️ **Moderation:**\n' +
        '• `/warn` — Warn a member *(Perm 1+)*\n' +
        '• `/view-warnings` — View a user\'s warnings *(Perm 1+)*\n' +
        '• `/my-warns` — View your own warnings\n' +
        '• `/bloxy-ban` — Ban a user *(Perm 3)*\n\n' +
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
      if (!isWhitelisted) return interaction.editReply('❌ No permission.');
      if (!announceChannel) return interaction.editReply('❌ Announcement channel missing.');
      const link = interaction.options.getString('game_link');
      const schedId = interaction.options.getString('schedule_id');
      if (!link.startsWith('https://roblox.com')) return interaction.editReply('❌ Link must start with `https://roblox.com`.');
      let signupPing = '';
      if (schedId) {
        const si = schedules.findIndex(s => s.id === schedId);
        if (si !== -1) {
          const s = schedules[si];
          if (s.signups.size > 0) signupPing = [...s.signups].map(id => `<@${id}>`).join(' ');
          if (s.embedMessageId) { try { const m = await announceChannel.messages.fetch(s.embedMessageId); await m.delete(); } catch {} }
          schedules.splice(si, 1);
        }
      }
      const embed = new EmbedBuilder().setTitle('🟢 Session Start Up!').setColor(0x00FF00)
        .setDescription(`A session has been started by ${interaction.user.tag}!\nPlease join using the link below!`);
      const msg = await announceChannel.send({ content: `@everyone${signupPing ? '\n' + signupPing : ''}`, embeds: [embed], components: [buildSessionButtons(link)] });
      activeSessionMessageId = msg.id;
      activeSessionChannelId = announceChannel.id;
      return interaction.editReply('✅ Session started!');
    }

    // ===== SERVER HOP =====
    if (interaction.commandName === 'server-hop') {
      if (!isWhitelisted) return interaction.editReply('❌ No permission.');
      if (!announceChannel) return interaction.editReply('❌ Announcement channel missing.');
      const link = interaction.options.getString('game_link');
      if (!link.startsWith('https://roblox.com')) return interaction.editReply('❌ Link must start with `https://roblox.com`.');
      const embed = new EmbedBuilder().setTitle('🔄 Server Hopping!').setColor(0xFFAA00)
        .setDescription('A server hop was started! Please join the new server below.');
      const msg = await announceChannel.send({ content: `@here <@&${SHIFT_ROLE_ID}>`, embeds: [embed], components: [buildSessionButtons(link)] });
      activeSessionMessageId = msg.id;
      activeSessionChannelId = announceChannel.id;
      return interaction.editReply('✅ Server hop posted!');
    }

    // ===== SSD =====
    if (interaction.commandName === 'ssd') {
      if (!isWhitelisted) return interaction.editReply('❌ No permission.');
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
      if (announceChannel) await announceChannel.send({ embeds: [new EmbedBuilder().setTitle('🔴 Session Shutdown').setColor(0xFF0000).setDescription('The session has been shutdown.')] });
      return interaction.editReply(`✅ Session shut down. Removed shift role from ${membersWithRole.size} member(s).`);
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

    // ===== WARN =====
    if (interaction.commandName === 'warn') {
      if (permLevel < 1) return interaction.editReply('❌ You need at least Permission Level 1 to use this command.');

      const targetUser = interaction.options.getUser('user');
      const reason = interaction.options.getString('reason');
      const targetMember = await interaction.guild.members.fetch(targetUser.id).catch(() => null);

      if (!targetMember) return interaction.editReply('❌ User not found in this server.');
      const targetPerm = getPermLevel(targetMember);
      if (targetPerm >= permLevel) return interaction.editReply('❌ You cannot warn someone with an equal or higher permission level.');

      // Add warning
      if (!warnings[targetUser.id]) warnings[targetUser.id] = [];
      warnings[targetUser.id].push({
        reason,
        moderatorTag: interaction.user.tag,
        moderatorId: interaction.user.id,
        timestamp: Date.now()
      });
      const warnCount = warnings[targetUser.id].length;

      // DM the warned user
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

      // Log it
      await sendModLog(modLogEmbed('Warning Issued', interaction.user, targetUser, { reason, warnCount, color: 0xFFFF00 }));

      // Auto action at 3 warnings
      if (warnCount >= 3) {
        // Always apply 5 minute mute immediately
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
          // Perm 2+ issued the 3rd warn — ask them directly if additional mute should be applied
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
          // Perm 1 issued the 3rd warn — send to mod channel for perm 2 approval
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

          // Inform the perm-1 mod it's being processed
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

      // DM the user BEFORE banning
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

      // Ban the user
      try {
        await targetMember.ban({ reason: `${reason} | Duration: ${humanDuration(durationMs)} | By: ${interaction.user.tag}` });
      } catch (err) {
        return interaction.editReply(`❌ Failed to ban: ${err.message}`);
      }

      // Schedule unban
      setTimeout(async () => {
        try {
          await interaction.guild.members.unban(targetUser.id, 'Temporary ban expired');
          console.log(`Unbanned ${targetUser.tag} after ${humanDuration(durationMs)}`);
          const unbanLog = new EmbedBuilder()
            .setTitle('🔓 Temporary Ban Expired')
            .setColor(0x00FF00)
            .setDescription(`<@${targetUser.id}> (${targetUser.tag}) has been unbanned after their temporary ban expired.`)
            .addFields({ name: 'Original Duration', value: humanDuration(durationMs) })
            .setTimestamp();
          await sendModLog(unbanLog);
        } catch (err) { console.error('Unban failed:', err.message); }
      }, durationMs);

      // Log it
      await sendModLog(modLogEmbed('Member Banned', interaction.user, targetUser, { reason, duration: humanDuration(durationMs), color: 0xFF0000 }));

      return interaction.editReply(`✅ **${targetUser.tag}** has been banned for **${humanDuration(durationMs)}**.\nThey were DM'd before the ban.`);
    }

    // ===== UNWARN =====
    if (interaction.commandName === 'unwarn') {
      // To undo a Perm 1 warn you need Perm 2. To undo a Perm 2 warn you need Perm 3.
      if (permLevel < 2) return interaction.editReply('❌ You need at least Permission Level 2 to remove warnings.');

      const targetUser = interaction.options.getUser('user');
      const warnIndex = interaction.options.getInteger('index') - 1; // convert to 0-based
      const userWarns = warnings[targetUser.id] || [];

      if (userWarns.length === 0) return interaction.editReply(`✅ **${targetUser.tag}** has no warnings to remove.`);
      if (warnIndex < 0 || warnIndex >= userWarns.length)
        return interaction.editReply(`❌ Invalid warning number. **${targetUser.tag}** has ${userWarns.length} warning(s).`);

      const warn = userWarns[warnIndex];

      // Check if the mod who issued the warn was perm 2 — if so need perm 3 to undo
      // We stored moderatorId, fetch their current perm level
      let warnIssuerPerm = 1; // default assume perm 1 if we can't find them
      try {
        const warnIssuerMember = await interaction.guild.members.fetch(warn.moderatorId);
        warnIssuerPerm = getPermLevel(warnIssuerMember);
      } catch {}

      if (warnIssuerPerm >= permLevel)
        return interaction.editReply(`❌ You need a higher permission level than the moderator who issued this warning (Perm ${warnIssuerPerm}) to remove it.`);

      // Remove the warning
      warnings[targetUser.id].splice(warnIndex, 1);
      const remaining = warnings[targetUser.id].length;

      // DM the user
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

      // Log it
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

      // Check they are actually muted
      if (!targetMember.communicationDisabledUntil || targetMember.communicationDisabledUntil < new Date())
        return interaction.editReply('⚠️ That user is not currently muted.');

      // Perm level check — perm 2 can unmute perm 1 mutes, perm 3 can unmute anyone
      const targetPerm = getPermLevel(targetMember);
      if (targetPerm >= permLevel)
        return interaction.editReply('❌ You cannot unmute someone with an equal or higher permission level than you.');

      try {
        await targetMember.timeout(null, `Unmuted by ${interaction.user.tag}: ${reason}`);
      } catch (err) {
        return interaction.editReply(`❌ Failed to unmute: ${err.message}`);
      }

      // DM the user
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

      // Log it
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

      // Check they are actually banned
      let bannedUser;
      try {
        bannedUser = await interaction.guild.bans.fetch(userId);
      } catch {
        return interaction.editReply('❌ That user is not currently banned, or the ID is invalid.');
      }

      try {
        await interaction.guild.members.unban(userId, `Unbanned by ${interaction.user.tag}: ${reason}`);
      } catch (err) {
        return interaction.editReply(`❌ Failed to unban: ${err.message}`);
      }

      // DM the user if possible
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

      // Log it
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

    // ===== MUTE APPROVE =====
    if (interaction.customId.startsWith('muteApprove-')) {
      const reqId = interaction.customId.replace('muteApprove-', '');
      const req = pendingMuteRequests[reqId];
      if (!req) return interaction.reply({ content: '❌ Request not found or already handled.', ephemeral: true });

      // Ask how long to mute
      await interaction.reply({
        content: '⏱️ How long should the extended mute be? Reply in DMs or use the format `10m`, `2h`, `3d` — **Note: Use `/bloxy-mute` if available, or reply here with the time.**\n\nFor now, type the duration in this message and I will apply it. *(Feature: you can modify the bot to add a modal here)*\n\n**Applying 1 hour extended mute as default.** To customize, edit the bot to add a duration modal.',
        ephemeral: true
      });

      // Default extended mute: 1 hour
      const extendedMs = 60 * 60 * 1000;
      try {
        const targetMember = await guild.members.fetch(req.targetId);
        await targetMember.timeout(extendedMs, `Extended mute approved by ${interaction.user.tag}`);
      } catch (err) { console.error('Extended mute failed:', err.message); }

      // Notify the original mod
      try {
        const origMod = await client.users.fetch(req.moderatorId);
        const updateEmbed = new EmbedBuilder()
          .setTitle('✅ Extended Mute Approved')
          .setColor(0x00FF00)
          .setDescription(`Your mute request for **${req.targetTag}** was approved by ${interaction.user.tag}.\nAn extended mute of **1 hour** has been applied.`);
        await origMod.send({ embeds: [updateEmbed] });
      } catch {}

      // Log
      const logEmbed = new EmbedBuilder().setTitle('🔇 Extended Mute Applied').setColor(0xFF6600)
        .setDescription(`Extended mute of 1 hour applied to <@${req.targetId}> (${req.targetTag}).`)
        .addFields(
          { name: 'Approved By', value: `${interaction.user.tag}` },
          { name: 'Original Moderator', value: req.moderatorTag }
        ).setTimestamp();
      await sendModLog(logEmbed);

      delete pendingMuteRequests[reqId];

      // Disable buttons on the message
      try {
        await interaction.message.edit({ components: [] });
      } catch {}
    }

    // ===== MUTE DENY =====
    if (interaction.customId.startsWith('muteDeny-')) {
      const reqId = interaction.customId.replace('muteDeny-', '');
      const req = pendingMuteRequests[reqId];
      if (!req) return interaction.reply({ content: '❌ Request not found or already handled.', ephemeral: true });

      // Notify the original mod
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
