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
  InteractionType
} = require('discord.js');

const TOKEN = process.env.TOKEN;
const GUILD_ID = '1394380681341173810';
const ANNOUNCE_CHANNEL_ID = '1452777822618648678';
const WHITELIST_USERS = ['1294697248759746561', '1166915839992270930'];
const MAINT_USER_ID = '1166915839992270930';
const SHIFT_ROLE_ID = '1475191266084917298';
const NOTIFY_ROLE_ID = '1395209235389743114';
const SCHEDULE_WHITELIST_ROLES = ['1410771734700888064', '1395231118537523220'];

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates
  ]
});

// -------------------- DATA --------------------
let schedules = [];
let botReady = false;
let maintenanceMode = false;
// Track when each user got the shift role: { userId: timestamp }
let shiftStartTimes = {};
// Weekly accumulated seconds: { userId: seconds }
let weeklyActivity = {};
// Active session message id for SSD to reference
let activeSessionMessageId = null;
let activeSessionChannelId = ANNOUNCE_CHANNEL_ID;

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
function parseTimeToUTC(timeStr, tz) {
  const [h, m] = timeStr.split(':').map(Number);
  const date = new Date();
  if (tz === 'EST') date.setUTCHours(h + 5, m, 0, 0);
  if (tz === 'PST') date.setUTCHours(h + 8, m, 0, 0);
  return date;
}
function formatTime24(date, offset) {
  const d = new Date(date.getTime() + offset * 3600000);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}
function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}
function buildSessionButtons(gameLink) {
  const joinBtn = new ButtonBuilder()
    .setLabel('Join Session')
    .setStyle(ButtonStyle.Link)
    .setURL(gameLink);
  const startShiftBtn = new ButtonBuilder()
    .setCustomId('start-shift')
    .setLabel('Start Shift')
    .setStyle(ButtonStyle.Success);
  const endShiftBtn = new ButtonBuilder()
    .setCustomId('end-shift')
    .setLabel('End Shift')
    .setStyle(ButtonStyle.Danger);
  return new ActionRowBuilder().addComponents(joinBtn, startShiftBtn, endShiftBtn);
}

// -------------------- WEEKLY REPORT (Every Saturday midnight EST) --------------------
// Saturday midnight EST = Sunday 05:00 UTC
function scheduleWeeklyReport() {
  async function sendWeeklyReports() {
    try {
      const guild = await client.guilds.fetch(GUILD_ID);
      const met = [];
      const failed = [];

      for (const [userId, seconds] of Object.entries(weeklyActivity)) {
        let tag = userId;
        try {
          const member = await guild.members.fetch(userId);
          tag = member.user.tag;
        } catch {}
        const entry = `• <@${userId}> (${tag}) — ${formatDuration(seconds)}`;
        if (seconds >= 7200) met.push(entry);
        else failed.push(entry);
      }

      const metEmbed = new EmbedBuilder()
        .setTitle('✅ Met Activity Requirements')
        .setColor(0x00FF00)
        .setDescription(met.length ? met.join('\n') : 'No users.')
        .setFooter({ text: 'Weekly Activity Report' });

      const failEmbed = new EmbedBuilder()
        .setTitle('❌ Failed to Meet Requirements')
        .setColor(0xFF0000)
        .setDescription(failed.length ? failed.join('\n') : 'No users.')
        .setFooter({ text: 'Weekly Activity Report' });

      for (const uid of WHITELIST_USERS) {
        try {
          const user = await client.users.fetch(uid);
          await user.send({ embeds: [metEmbed, failEmbed] });
        } catch (err) {
          console.error(`Failed to DM weekly report to ${uid}:`, err.message);
        }
      }

      // Reset weekly activity
      weeklyActivity = {};
      console.log('Weekly activity report sent and reset.');
    } catch (err) {
      console.error('Weekly report error:', err);
    }
  }

  // Check every minute if it's Saturday midnight EST (Sunday 05:00 UTC)
  setInterval(async () => {
    const now = new Date();
    if (now.getUTCDay() === 0 && now.getUTCHours() === 5 && now.getUTCMinutes() === 0) {
      await sendWeeklyReports();
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
    new SlashCommandBuilder().setName('schedule').setDescription('Schedule a session')
      .addStringOption(o => o.setName('type').setDescription('Exact or range').setRequired(true)
        .addChoices({ name: 'Exact', value: 'exact' }, { name: 'Range', value: 'range' }))
      .addStringOption(o => o.setName('timezone').setDescription('EST or PST').setRequired(true)
        .addChoices({ name: 'EST', value: 'EST' }, { name: 'PST', value: 'PST' }))
      .addStringOption(o => o.setName('time').setDescription('Exact time HH:MM or earliest HH:MM').setRequired(true))
      .addStringOption(o => o.setName('end-time').setDescription('Latest time for range').setRequired(false))
      .addStringOption(o => o.setName('description').setDescription('Optional description').setRequired(false)).toJSON(),
    new SlashCommandBuilder().setName('del-schedule').setDescription('Delete a scheduled session')
      .addStringOption(o => o.setName('session-id').setDescription('Session ID to delete').setRequired(true)).toJSON(),
    new SlashCommandBuilder().setName('view-schedule').setDescription('View upcoming sessions').toJSON(),
    new SlashCommandBuilder().setName('maintenance').setDescription('Toggle maintenance mode').toJSON(),
    new SlashCommandBuilder().setName('ssu').setDescription('Start a session')
      .addStringOption(o => o.setName('game_link').setDescription('Roblox game link (must start with https://roblox.com)').setRequired(true)).toJSON(),
    new SlashCommandBuilder().setName('server-hop').setDescription('Start a server hop')
      .addStringOption(o => o.setName('game_link').setDescription('Roblox game link (must start with https://roblox.com)').setRequired(true)).toJSON(),
    new SlashCommandBuilder().setName('ssd').setDescription('Shutdown the current session').toJSON(),
    new SlashCommandBuilder().setName('notify-active').setDescription('DM all in-game of critical events')
      .addStringOption(o => o.setName('message').setDescription('Message to send').setRequired(true)).toJSON()
  ];

  try {
    const rest = new REST({ version: '10' }).setToken(TOKEN);
    await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: commands });
    console.log('Slash commands registered.');
  } catch (err) {
    console.error(err);
    await setDowntimeStatus();
  }

  scheduleWeeklyReport();
});

// -------------------- COMMAND HANDLER --------------------
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  try {
    if (maintenanceMode && interaction.commandName !== 'maintenance')
      return interaction.reply({ content: '⚠️ Bot is in maintenance mode.', ephemeral: true });

    const member = await interaction.guild.members.fetch(interaction.user.id);
    const isWhitelisted = WHITELIST_USERS.includes(interaction.user.id);
    const hasScheduleRole = SCHEDULE_WHITELIST_ROLES.some(r => member.roles.cache.has(r));
    const hasNotifyRole = member.roles.cache.has(NOTIFY_ROLE_ID);

    await interaction.deferReply({ ephemeral: true });
    const channel = await client.channels.fetch(ANNOUNCE_CHANNEL_ID).catch(() => null);
    if (!channel) return interaction.editReply('❌ Announcement channel missing.');

    // ---------- HELP ----------
    if (interaction.commandName === 'help') {
      return interaction.editReply(
        '🛠 **Commands:**\n' +
        '• `/help` — Shows this menu\n' +
        '• `/schedule` — Schedule a session *(restricted)*\n' +
        '• `/del-schedule` — Delete a session *(restricted)*\n' +
        '• `/view-schedule` — View upcoming sessions\n' +
        '• `/ssu` — Start a session *(whitelisted only)*\n' +
        '• `/server-hop` — Server hop *(whitelisted only)*\n' +
        '• `/ssd` — Shutdown session *(whitelisted only)*\n' +
        '• `/notify-active` — DM all active members *(role restricted)*\n' +
        '• `/maintenance` — Toggle maintenance mode *(owner only)*'
      );
    }

    // ---------- MAINTENANCE ----------
    if (interaction.commandName === 'maintenance') {
      if (interaction.user.id !== MAINT_USER_ID) return interaction.editReply('❌ No permission.');
      maintenanceMode = !maintenanceMode;
      if (maintenanceMode) {
        await setMaintenanceStatus();
        return interaction.editReply('✅ Maintenance mode enabled.');
      } else {
        await setNormalStatus();
        return interaction.editReply('✅ Maintenance mode disabled.');
      }
    }

    // ---------- SCHEDULE ----------
    if (interaction.commandName === 'schedule') {
      if (!hasScheduleRole) return interaction.editReply('❌ No permission.');
      const type = interaction.options.getString('type');
      const tz = interaction.options.getString('timezone');
      const desc = interaction.options.getString('description') || 'Session';
      const time = interaction.options.getString('time');
      const endTime = interaction.options.getString('end-time');

      const id = Date.now().toString();
      const sched = { id, userId: interaction.user.id, userTag: interaction.user.tag, type, timezone: tz, desc, signups: new Set(), notified: false };

      if (type === 'exact') {
        sched.startTime = parseTimeToUTC(time, tz);
      } else {
        sched.startTime = parseTimeToUTC(time, tz);
        sched.endTime = parseTimeToUTC(endTime, tz);
      }

      schedules.push(sched);

      const startEST = formatTime24(sched.startTime, -5);
      const startPST = formatTime24(sched.startTime, -8);
      let descTime;
      if (type === 'exact') {
        descTime = `Starts at: ${startEST} EST / ${startPST} PST`;
      } else {
        const endEST = formatTime24(sched.endTime, -5);
        const endPST = formatTime24(sched.endTime, -8);
        descTime = `Starts between: ${startEST}-${endEST} EST / ${startPST}-${endPST} PST`;
      }

      const embed = new EmbedBuilder()
        .setTitle('📅 New Scheduled Session')
        .setColor(0x00AAFF)
        .setDescription(`Hosted by: ${interaction.user.tag}\nType: ${type}\nDescription: ${desc}\n${descTime}`)
        .setFooter({ text: `Signups: 0 | ID: ${id}` });

      const btn = new ButtonBuilder().setCustomId(`signup-${id}`).setLabel('Sign Up').setStyle(ButtonStyle.Success);
      const row = new ActionRowBuilder().addComponents(btn);
      await channel.send({ embeds: [embed], components: [row] });
      return interaction.editReply(`✅ Session scheduled with ID: ${id}`);
    }

    // ---------- DEL SCHEDULE ----------
    if (interaction.commandName === 'del-schedule') {
      if (!hasScheduleRole) return interaction.editReply('❌ No permission.');
      const sessionId = interaction.options.getString('session-id');
      const index = schedules.findIndex(s => s.id === sessionId);
      if (index === -1) return interaction.editReply('❌ Session not found.');
      const sched = schedules[index];
      try {
        const messages = await channel.messages.fetch({ limit: 100 });
        const msg = messages.find(m => m.embeds.length && m.embeds[0].footer?.text?.includes(sessionId));
        if (msg) await msg.delete();
      } catch (err) { console.warn('Failed to delete embed:', err.message); }
      schedules.splice(index, 1);
      return interaction.editReply(`✅ Deleted scheduled session "${sched.desc}".`);
    }

    // ---------- VIEW SCHEDULE ----------
    if (interaction.commandName === 'view-schedule') {
      if (schedules.length === 0) return interaction.editReply('No upcoming sessions.');
      const text = schedules.map(s => {
        const startEST = formatTime24(s.startTime, -5);
        const startPST = formatTime24(s.startTime, -8);
        if (s.type === 'exact') {
          return `• ID:${s.id} - ${startEST} EST / ${startPST} PST - ${s.userTag} - ${s.desc} (Signups: ${s.signups.size})`;
        } else {
          const endEST = formatTime24(s.endTime, -5);
          const endPST = formatTime24(s.endTime, -8);
          return `• ID:${s.id} - ${startEST}-${endEST} EST / ${startPST}-${endPST} PST - ${s.userTag} - ${s.desc} (Signups: ${s.signups.size})`;
        }
      }).join('\n');
      return interaction.editReply(`📅 Upcoming sessions:\n${text}`);
    }

    // ---------- SSU ----------
    if (interaction.commandName === 'ssu') {
      if (!isWhitelisted) return interaction.editReply('❌ No permission.');
      const link = interaction.options.getString('game_link');
      if (!link.startsWith('https://roblox.com')) return interaction.editReply('❌ Link must start with `https://roblox.com`.');

      const embed = new EmbedBuilder()
        .setTitle('🟢 Session Start Up!')
        .setColor(0x00FF00)
        .setDescription(`A session has been started by ${interaction.user.tag}!\nPlease join using the link below!`);

      const row = buildSessionButtons(link);
      const msg = await channel.send({ embeds: [embed], components: [row] });
      activeSessionMessageId = msg.id;
      activeSessionChannelId = channel.id;

      return interaction.editReply('✅ Session started!');
    }

    // ---------- SERVER HOP ----------
    if (interaction.commandName === 'server-hop') {
      if (!isWhitelisted) return interaction.editReply('❌ No permission.');
      const link = interaction.options.getString('game_link');
      if (!link.startsWith('https://roblox.com')) return interaction.editReply('❌ Link must start with `https://roblox.com`.');

      const embed = new EmbedBuilder()
        .setTitle('🔄 Server Hopping!')
        .setColor(0xFFAA00)
        .setDescription(`A server hop was started! Please join the new server below.`);

      const row = buildSessionButtons(link);
      const msg = await channel.send({ embeds: [embed], components: [row] });
      activeSessionMessageId = msg.id;
      activeSessionChannelId = channel.id;

      return interaction.editReply('✅ Server hop posted!');
    }

    // ---------- SSD ----------
    if (interaction.commandName === 'ssd') {
      if (!isWhitelisted) return interaction.editReply('❌ No permission.');

      const guild = interaction.guild;

      // Find all members with the shift role
      const membersWithRole = guild.members.cache.filter(m => m.roles.cache.has(SHIFT_ROLE_ID));

      // Remove role and DM each member, log their time
      for (const [uid, m] of membersWithRole) {
        try {
          await m.roles.remove(SHIFT_ROLE_ID);
        } catch (err) { console.warn(`Failed to remove shift role from ${uid}:`, err.message); }

        try {
          await m.send('The session has ended, thank you for your participation. Your shift was automatically ended. If this was a mistake please open a ticket.');
        } catch (err) { console.warn(`Failed to DM ${uid}:`, err.message); }

        // Log their time if we have a start time
        if (shiftStartTimes[uid]) {
          const elapsed = Math.floor((Date.now() - shiftStartTimes[uid]) / 1000);
          weeklyActivity[uid] = (weeklyActivity[uid] || 0) + elapsed;
          delete shiftStartTimes[uid];
        }
      }

      // Disable buttons on the last session message
      if (activeSessionMessageId) {
        try {
          const sessionChannel = await client.channels.fetch(activeSessionChannelId);
          const sessionMsg = await sessionChannel.messages.fetch(activeSessionMessageId);
          const disabledRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setLabel('Join Session').setStyle(ButtonStyle.Link).setURL('https://roblox.com').setDisabled(true),
            new ButtonBuilder().setCustomId('start-shift-disabled').setLabel('Start Shift').setStyle(ButtonStyle.Success).setDisabled(true),
            new ButtonBuilder().setCustomId('end-shift-disabled').setLabel('End Shift').setStyle(ButtonStyle.Danger).setDisabled(true)
          );
          await sessionMsg.edit({ components: [disabledRow] });
        } catch (err) { console.warn('Could not disable session buttons:', err.message); }
        activeSessionMessageId = null;
      }

      const embed = new EmbedBuilder()
        .setTitle('🔴 Session Shutdown')
        .setColor(0xFF0000)
        .setDescription('The session has been shutdown.');

      await channel.send({ embeds: [embed] });
      return interaction.editReply(`✅ Session shut down. Removed shift role from ${membersWithRole.size} member(s) and sent DMs.`);
    }

    // ---------- NOTIFY ACTIVE ----------
    if (interaction.commandName === 'notify-active') {
      if (!hasNotifyRole) return interaction.editReply('❌ No permission.');
      const text = interaction.options.getString('message');
      const guild = interaction.guild;

      // DM all members with the shift role (currently in-game/on shift)
      await guild.members.fetch();
      const activeMembers = guild.members.cache.filter(m => m.roles.cache.has(SHIFT_ROLE_ID));

      let successCount = 0;
      for (const [uid, m] of activeMembers) {
        try {
          await m.send(`Notification to all active units from: ${interaction.user.tag}, ${text}`);
          successCount++;
        } catch (err) { console.warn(`Failed to DM ${uid}:`, err.message); }
      }

      return interaction.editReply(`✅ Notified ${successCount} active member(s).`);
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
    const member = await guild.members.fetch(interaction.user.id);

    // Schedule signup
    if (interaction.customId.startsWith('signup-')) {
      const sid = interaction.customId.split('-')[1];
      const sched = schedules.find(s => s.id === sid);
      if (!sched) return interaction.reply({ content: '❌ Session not found.', ephemeral: true });
      sched.signups.add(interaction.user.id);
      await member.roles.add(SHIFT_ROLE_ID).catch(() => {});
      await interaction.reply({ content: `✅ You signed up for "${sched.desc}"`, ephemeral: true });
      const message = await interaction.channel.messages.fetch(interaction.message.id);
      const embed = EmbedBuilder.from(message.embeds[0]);
      embed.setFooter({ text: `Signups: ${sched.signups.size} | ID: ${sched.id}` });
      await message.edit({ embeds: [embed] });
    }

    // Start shift button
    if (interaction.customId === 'start-shift') {
      if (member.roles.cache.has(SHIFT_ROLE_ID)) {
        return interaction.reply({ content: '⚠️ You already have the shift role.', ephemeral: true });
      }
      await member.roles.add(SHIFT_ROLE_ID).catch(() => {});
      shiftStartTimes[interaction.user.id] = Date.now();
      return interaction.reply({ content: '✅ Your shift has started! Good luck!', ephemeral: true });
    }

    // End shift button
    if (interaction.customId === 'end-shift') {
      if (!member.roles.cache.has(SHIFT_ROLE_ID)) {
        return interaction.reply({ content: '⚠️ You do not have an active shift.', ephemeral: true });
      }
      await member.roles.remove(SHIFT_ROLE_ID).catch(() => {});

      // Log time
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
