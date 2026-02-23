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
let shiftStartTimes = {};
let weeklyActivity = {};
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

// -------------------- SCHEDULE REMINDER LOOP --------------------
// Runs every 30 seconds to check for sessions starting within 5 minutes
function startScheduleChecker() {
  setInterval(async () => {
    const now = Date.now();
    for (const sched of schedules) {
      if (sched.notified) continue;
      const startMs = sched.startTime;
      const diff = startMs - now;
      // Ping when between 5min and 4min 30sec away
      if (diff <= 5 * 60 * 1000 && diff > 4.5 * 60 * 1000) {
        sched.notified = true;
        try {
          const channel = await client.channels.fetch(ANNOUNCE_CHANNEL_ID);
          const signupMentions = sched.signups.size > 0
            ? [...sched.signups].map(id => `<@${id}>`).join(' ')
            : '';
          await channel.send(
            `⏰ <@${sched.userId}> Your scheduled session **"${sched.desc}"** starts in 5 minutes!\n${signupMentions}`
          );
        } catch (err) {
          console.error('Schedule reminder error:', err.message);
        }
      }
    }
  }, 30 * 1000);
}

// -------------------- WEEKLY REPORT --------------------
function scheduleWeeklyReport() {
  async function sendWeeklyReports() {
    try {
      const guild = await client.guilds.fetch(GUILD_ID);
      const met = [];
      const failed = [];
      for (const [userId, seconds] of Object.entries(weeklyActivity)) {
        let tag = userId;
        try {
          const m = await guild.members.fetch(userId);
          tag = m.user.tag;
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
      weeklyActivity = {};
      console.log('Weekly activity report sent and reset.');
    } catch (err) {
      console.error('Weekly report error:', err);
    }
  }
  // Check every minute — fire on Saturday midnight EST (Sunday 05:00 UTC)
  let lastFired = null;
  setInterval(async () => {
    const now = new Date();
    const key = `${now.getUTCFullYear()}-${now.getUTCMonth()}-${now.getUTCDate()}`;
    if (now.getUTCDay() === 0 && now.getUTCHours() === 5 && now.getUTCMinutes() === 0 && lastFired !== key) {
      lastFired = key;
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

    new SlashCommandBuilder().setName('schedule').setDescription('Schedule a session (whitelisted)')
      .addStringOption(o => o.setName('date').setDescription('Date of session (MM/DD/YYYY)').setRequired(true))
      .addStringOption(o => o.setName('time').setDescription('Time HH:MM (24hr)').setRequired(true))
      .addStringOption(o => o.setName('timezone').setDescription('Your timezone').setRequired(true)
        .addChoices(
          { name: 'EST (UTC-5)', value: 'EST' },
          { name: 'PST (UTC-8)', value: 'PST' },
          { name: 'CST (UTC-6)', value: 'CST' },
          { name: 'MST (UTC-7)', value: 'MST' },
          { name: 'GMT (UTC+0)', value: 'GMT' },
          { name: 'CET (UTC+1)', value: 'CET' }
        ))
      .addStringOption(o => o.setName('description').setDescription('Session description').setRequired(false)).toJSON(),

    new SlashCommandBuilder().setName('schedule-view').setDescription('View upcoming sessions and sign up').toJSON(),

    new SlashCommandBuilder().setName('del-schedule').setDescription('Delete a scheduled session')
      .addStringOption(o => o.setName('session-id').setDescription('Session ID to delete').setRequired(true)).toJSON(),

    new SlashCommandBuilder().setName('maintenance').setDescription('Toggle maintenance mode').toJSON(),

    new SlashCommandBuilder().setName('ssu').setDescription('Start a session (whitelisted)')
      .addStringOption(o => o.setName('game_link').setDescription('Roblox game link (must start with https://roblox.com)').setRequired(true))
      .addStringOption(o => o.setName('schedule_id').setDescription('Optional: link to a scheduled session ID').setRequired(false)).toJSON(),

    new SlashCommandBuilder().setName('server-hop').setDescription('Start a server hop (whitelisted)')
      .addStringOption(o => o.setName('game_link').setDescription('Roblox game link (must start with https://roblox.com)').setRequired(true)).toJSON(),

    new SlashCommandBuilder().setName('ssd').setDescription('Shutdown the current session (whitelisted)').toJSON(),

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

  startScheduleChecker();
  scheduleWeeklyReport();
});

// -------------------- TIMEZONE OFFSETS --------------------
const TZ_OFFSETS = { EST: -5, PST: -8, CST: -6, MST: -7, GMT: 0, CET: 1 };

function parseScheduleTime(dateStr, timeStr, tz) {
  // dateStr: MM/DD/YYYY, timeStr: HH:MM, tz: EST etc
  const [month, day, year] = dateStr.split('/').map(Number);
  const [h, m] = timeStr.split(':').map(Number);
  const offsetHours = TZ_OFFSETS[tz] || 0;
  // Convert to UTC
  const utcMs = Date.UTC(year, month - 1, day, h - offsetHours, m, 0, 0);
  return utcMs;
}

function formatTimestamp(utcMs) {
  // Returns a Discord dynamic timestamp that shows in the user's local time
  return `<t:${Math.floor(utcMs / 1000)}:F> (<t:${Math.floor(utcMs / 1000)}:R>)`;
}

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
        '• `/schedule` — Schedule a session *(whitelisted)*\n' +
        '• `/schedule-view` — View & sign up for upcoming sessions\n' +
        '• `/del-schedule` — Delete a scheduled session *(whitelisted)*\n' +
        '• `/ssu` — Start a session *(whitelisted)*\n' +
        '• `/server-hop` — Server hop *(whitelisted)*\n' +
        '• `/ssd` — Shutdown session *(whitelisted)*\n' +
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
      if (!hasScheduleRole && !isWhitelisted) return interaction.editReply('❌ No permission.');

      const dateStr = interaction.options.getString('date');
      const timeStr = interaction.options.getString('time');
      const tz = interaction.options.getString('timezone');
      const desc = interaction.options.getString('description') || 'Session';

      // Validate date format
      if (!/^\d{2}\/\d{2}\/\d{4}$/.test(dateStr))
        return interaction.editReply('❌ Date must be in MM/DD/YYYY format.');
      if (!/^\d{2}:\d{2}$/.test(timeStr))
        return interaction.editReply('❌ Time must be in HH:MM (24hr) format.');

      const startMs = parseScheduleTime(dateStr, timeStr, tz);
      if (startMs <= Date.now()) return interaction.editReply('❌ That time is in the past.');

      const id = Date.now().toString();
      const sched = {
        id,
        userId: interaction.user.id,
        userTag: interaction.user.tag,
        desc,
        startTime: startMs,
        signups: new Set(),
        notified: false,
        embedMessageId: null
      };
      schedules.push(sched);

      const embed = new EmbedBuilder()
        .setTitle('📅 Scheduled Session')
        .setColor(0x00AAFF)
        .setDescription(
          `**Host:** ${interaction.user.tag}\n` +
          `**Description:** ${desc}\n` +
          `**Starts:** ${formatTimestamp(startMs)}\n\n` +
          `_Time shown in your local timezone automatically._`
        )
        .setFooter({ text: `Signups: 0 | ID: ${id}` });

      const signupBtn = new ButtonBuilder()
        .setCustomId(`signup-sched-${id}`)
        .setLabel('Sign Up')
        .setStyle(ButtonStyle.Success);
      const row = new ActionRowBuilder().addComponents(signupBtn);

      const msg = await channel.send({ embeds: [embed], components: [row] });
      sched.embedMessageId = msg.id;

      return interaction.editReply(`✅ Session scheduled! ID: \`${id}\`\nShows in everyone's local time automatically.`);
    }

    // ---------- SCHEDULE VIEW ----------
    if (interaction.commandName === 'schedule-view') {
      if (schedules.length === 0) return interaction.editReply('📅 No upcoming sessions.');
      const lines = schedules.map(s =>
        `• **${s.desc}** — ${formatTimestamp(s.startTime)} — Host: ${s.userTag} — Signups: ${s.signups.size} — ID: \`${s.id}\``
      ).join('\n');
      return interaction.editReply(
        `📅 **Upcoming Sessions:**\n${lines}\n\nClick **Sign Up** on the session post in <#${ANNOUNCE_CHANNEL_ID}> to join!`
      );
    }

    // ---------- DEL SCHEDULE ----------
    if (interaction.commandName === 'del-schedule') {
      if (!hasScheduleRole && !isWhitelisted) return interaction.editReply('❌ No permission.');
      const sessionId = interaction.options.getString('session-id');
      const index = schedules.findIndex(s => s.id === sessionId);
      if (index === -1) return interaction.editReply('❌ Session not found.');
      const sched = schedules[index];
      if (sched.embedMessageId) {
        try {
          const msg = await channel.messages.fetch(sched.embedMessageId);
          if (msg) await msg.delete();
        } catch (err) { console.warn('Failed to delete schedule embed:', err.message); }
      }
      schedules.splice(index, 1);
      return interaction.editReply(`✅ Deleted session "${sched.desc}".`);
    }

    // ---------- SSU ----------
    if (interaction.commandName === 'ssu') {
      if (!isWhitelisted) return interaction.editReply('❌ No permission.');
      const link = interaction.options.getString('game_link');
      const schedId = interaction.options.getString('schedule_id');
      if (!link.startsWith('https://roblox.com')) return interaction.editReply('❌ Link must start with `https://roblox.com`.');

      // If linked to a schedule, ping signups and remove from list
      let signupPing = '';
      if (schedId) {
        const schedIndex = schedules.findIndex(s => s.id === schedId);
        if (schedIndex !== -1) {
          const sched = schedules[schedIndex];
          if (sched.signups.size > 0) {
            signupPing = [...sched.signups].map(id => `<@${id}>`).join(' ');
          }
          // Delete the schedule embed
          if (sched.embedMessageId) {
            try {
              const schedMsg = await channel.messages.fetch(sched.embedMessageId);
              if (schedMsg) await schedMsg.delete();
            } catch {}
          }
          schedules.splice(schedIndex, 1);
        }
      }

      const embed = new EmbedBuilder()
        .setTitle('🟢 Session Start Up!')
        .setColor(0x00FF00)
        .setDescription(
          `A session has been started by ${interaction.user.tag}!\n` +
          `Please join using the link below!`
        );

      const row = buildSessionButtons(link);
      const msg = await channel.send({
        content: `@everyone${signupPing ? '\n' + signupPing : ''}`,
        embeds: [embed],
        components: [row]
      });
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
        .setDescription('A server hop was started! Please join the new server below.');

      const row = buildSessionButtons(link);
      const msg = await channel.send({
        content: `@here <@&${SHIFT_ROLE_ID}>`,
        embeds: [embed],
        components: [row]
      });
      activeSessionMessageId = msg.id;
      activeSessionChannelId = channel.id;

      return interaction.editReply('✅ Server hop posted!');
    }

    // ---------- SSD ----------
    if (interaction.commandName === 'ssd') {
      if (!isWhitelisted) return interaction.editReply('❌ No permission.');
      const guild = interaction.guild;
      await guild.members.fetch();
      const membersWithRole = guild.members.cache.filter(m => m.roles.cache.has(SHIFT_ROLE_ID));

      for (const [uid, m] of membersWithRole) {
        try { await m.roles.remove(SHIFT_ROLE_ID); } catch {}
        try {
          await m.send('The session has ended, thank you for your participation. Your shift was automatically ended. If this was a mistake please open a ticket.');
        } catch {}
        if (shiftStartTimes[uid]) {
          const elapsed = Math.floor((Date.now() - shiftStartTimes[uid]) / 1000);
          weeklyActivity[uid] = (weeklyActivity[uid] || 0) + elapsed;
          delete shiftStartTimes[uid];
        }
      }

      // Disable buttons on last session message
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
        } catch {}
        activeSessionMessageId = null;
      }

      const embed = new EmbedBuilder()
        .setTitle('🔴 Session Shutdown')
        .setColor(0xFF0000)
        .setDescription('The session has been shutdown.');

      await channel.send({ embeds: [embed] });
      return interaction.editReply(`✅ Session shut down. Removed shift role from ${membersWithRole.size} member(s).`);
    }

    // ---------- NOTIFY ACTIVE ----------
    if (interaction.commandName === 'notify-active') {
      if (!hasNotifyRole) return interaction.editReply('❌ No permission.');
      const text = interaction.options.getString('message');
      const guild = interaction.guild;
      await guild.members.fetch();
      const activeMembers = guild.members.cache.filter(m => m.roles.cache.has(SHIFT_ROLE_ID));
      let successCount = 0;
      for (const [uid, m] of activeMembers) {
        try {
          await m.send(`Notification to all active units from: ${interaction.user.tag}, ${text}`);
          successCount++;
        } catch {}
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

    // Schedule session signup
    if (interaction.customId.startsWith('signup-sched-')) {
      const sid = interaction.customId.replace('signup-sched-', '');
      const sched = schedules.find(s => s.id === sid);
      if (!sched) return interaction.reply({ content: '❌ Session not found or already started.', ephemeral: true });
      if (sched.signups.has(interaction.user.id))
        return interaction.reply({ content: '⚠️ You are already signed up.', ephemeral: true });
      sched.signups.add(interaction.user.id);
      await interaction.reply({ content: `✅ You signed up for **"${sched.desc}"**! You'll be pinged when it starts.`, ephemeral: true });
      // Update embed signup count
      try {
        const message = await interaction.channel.messages.fetch(interaction.message.id);
        const embed = EmbedBuilder.from(message.embeds[0]);
        embed.setFooter({ text: `Signups: ${sched.signups.size} | ID: ${sched.id}` });
        await message.edit({ embeds: [embed] });
      } catch {}
      return;
    }

    // Start shift button
    if (interaction.customId === 'start-shift') {
      if (member.roles.cache.has(SHIFT_ROLE_ID))
        return interaction.reply({ content: '⚠️ You already have an active shift.', ephemeral: true });
      await member.roles.add(SHIFT_ROLE_ID).catch(() => {});
      shiftStartTimes[interaction.user.id] = Date.now();
      return interaction.reply({ content: '✅ Your shift has started! Good luck!', ephemeral: true });
    }

    // End shift button
    if (interaction.customId === 'end-shift') {
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
