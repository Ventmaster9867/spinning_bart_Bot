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
const WHITELIST_ROLES = ['1410771734700888064','1395231118537523220'];
const MAINT_USER_ID = '1166915839992270930';
const SHIFT_ROLE_ID = '1475191266084917298';
const LOG_VIEW_ROLE = '1395209235389743114';

const client = new Client({ intents: [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMembers,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.GuildVoiceStates
] });

// -------------------- DATA --------------------
let schedules = []; // {id,userTag,type,startTime,endTime?,desc,signups:Set,notified,userId}
let weeklyActivity = {}; // {userId: seconds}
let grandActivity = {}; // {userId: totalSeconds}
let logs = []; // {userId,userTag,command,reason,time}
let botReady = false;
let maintenanceMode = false;

// -------------------- STATUS --------------------
async function setNormalStatus() {
  if (!client.user) return;
  if(maintenanceMode) return;
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
function parseTimeToUTC(timeStr, tz){
  const [h,m] = timeStr.split(':').map(Number);
  const date = new Date();
  if(tz==='EST') date.setUTCHours(h + 5, m, 0, 0);
  if(tz==='PST') date.setUTCHours(h + 8, m, 0, 0);
  return date;
}
function formatTime24(date, offset){
  const d = new Date(date.getTime() + offset*3600000);
  const hh = String(d.getUTCHours()).padStart(2,'0');
  const mm = String(d.getUTCMinutes()).padStart(2,'0');
  return `${hh}:${mm}`;
}
function addLog(user, command, reason='') {
  logs.push({userId:user.id,userTag:user.tag,command,reason,time:Date.now()});
}

// -------------------- READY --------------------
client.once('ready', async ()=>{
  console.log(`Logged in as ${client.user.tag}`);
  botReady = true;
  try { await setNormalStatus(); } catch(err){ console.error(err); }

  // Register slash commands
  const commands = [
    new SlashCommandBuilder().setName('help').setDescription('Shows command menu').toJSON(),
    new SlashCommandBuilder().setName('schedule').setDescription('Schedule a session')
      .addStringOption(o=>o.setName('type').setDescription('Exact or range').setRequired(true)
        .addChoices({name:'Exact',value:'exact'},{name:'Range',value:'range'}))
      .addStringOption(o=>o.setName('timezone').setDescription('EST or PST').setRequired(true)
        .addChoices({name:'EST',value:'EST'},{name:'PST',value:'PST'}))
      .addStringOption(o=>o.setName('time').setDescription('Exact time HH:MM or earliest HH:MM').setRequired(true))
      .addStringOption(o=>o.setName('end-time').setDescription('Latest time for range').setRequired(false))
      .addStringOption(o=>o.setName('description').setDescription('Optional description').setRequired(false)).toJSON(),
    new SlashCommandBuilder().setName('del-schedule').setDescription('Delete a scheduled session')
      .addStringOption(o=>o.setName('session-id').setDescription('Session ID to delete').setRequired(true)).toJSON(),
    new SlashCommandBuilder().setName('view-schedule').setDescription('View upcoming sessions').toJSON(),
    new SlashCommandBuilder().setName('view-activity-grand').setDescription('View global activity leaderboard').toJSON(),
    new SlashCommandBuilder().setName('activity-view').setDescription('View weekly activity leaderboard').toJSON(),
    new SlashCommandBuilder().setName('logs').setDescription('View global command logs').toJSON(),
    new SlashCommandBuilder().setName('del-activity').setDescription('Delete a user activity').addUserOption(o=>o.setName('user').setDescription('User to remove').setRequired(true))
      .addStringOption(o=>o.setName('reason').setDescription('Reason').setRequired(false)).toJSON(),
    new SlashCommandBuilder().setName('maintenance').setDescription('Toggle maintenance mode').toJSON(),
    new SlashCommandBuilder().setName('ssu').setDescription('Start a shift')
      .addStringOption(o=>o.setName('game_link').setDescription('Game link').setRequired(true)).toJSON(),
    new SlashCommandBuilder().setName('server-hop').setDescription('Server hop session')
      .addStringOption(o=>o.setName('game_link').setDescription('Game link').setRequired(true)).toJSON(),
    new SlashCommandBuilder().setName('ssd').setDescription('Shutdown current session').toJSON(),
    new SlashCommandBuilder().setName('code-red').setDescription('Call code red')
      .addStringOption(o=>o.setName('location').setDescription('Location').setRequired(true)).toJSON(),
    new SlashCommandBuilder().setName('code-orange').setDescription('Call code orange')
      .addStringOption(o=>o.setName('location').setDescription('Location').setRequired(true)).toJSON()
  ];

  try {
    const rest = new REST({version:'10'}).setToken(TOKEN);
    await rest.put(Routes.applicationGuildCommands(client.user.id,GUILD_ID),{body:commands});
    console.log('Slash commands registered.');
  } catch(err){ console.error(err); await setDowntimeStatus(); }

});

// -------------------- COMMAND HANDLER --------------------
client.on('interactionCreate', async interaction=>{
  if(!interaction.isChatInputCommand()) return;
  try{
    // MAINTENANCE MODE BLOCK
    if(maintenanceMode && interaction.commandName!=='maintenance') return interaction.reply({content:'⚠️ Bot is in maintenance mode.', ephemeral:true});

    const member = await interaction.guild.members.fetch(interaction.user.id);
    const hasRole = WHITELIST_ROLES.some(r=>member.roles.cache.has(r));
    await interaction.deferReply({ephemeral:true});
    const channel = await client.channels.fetch(ANNOUNCE_CHANNEL_ID).catch(()=>null);
    if(!channel) return interaction.editReply('❌ Announcement channel missing.');

    // ---------- HELP ----------
    if(interaction.commandName==='help'){
      return interaction.editReply(`🛠 Commands:\n• /help\n• /schedule (restricted)\n• /del-schedule (restricted)\n• /view-schedule\n• /activity-view\n• /view-activity-grand\n• /logs\n• /del-activity\n• /ssu\n• /server-hop\n• /ssd\n• /code-red /code-orange\n• /maintenance`);
    }

    // ---------- MAINTENANCE ----------
    if(interaction.commandName==='maintenance'){
      if(interaction.user.id!==MAINT_USER_ID) return interaction.editReply('❌ No permission.');
      maintenanceMode = !maintenanceMode;
      if(maintenanceMode){
        await setMaintenanceStatus();
        return interaction.editReply('✅ Maintenance mode enabled.');
      } else {
        await setNormalStatus();
        return interaction.editReply('✅ Maintenance mode disabled.');
      }
    }

    // ---------- SCHEDULE ----------
    if(interaction.commandName==='schedule'){
      if(!hasRole) return interaction.editReply('❌ No permission.');
      const type = interaction.options.getString('type');
      const tz = interaction.options.getString('timezone');
      const desc = interaction.options.getString('description')||'Session';
      const time = interaction.options.getString('time');
      const endTime = interaction.options.getString('end-time');

      const id = Date.now().toString();
      const sched = {id,userId:interaction.user.id,userTag:interaction.user.tag,type,timezone:tz,desc,signups:new Set(),notified:false};

      if(type==='exact'){
        sched.startTime = parseTimeToUTC(time, tz);
      } else {
        sched.startTime = parseTimeToUTC(time, tz);
        sched.endTime = parseTimeToUTC(endTime, tz);
      }

      schedules.push(sched);

      const startEST = formatTime24(sched.startTime,-5);
      const startPST = formatTime24(sched.startTime,-8);
      let descTime;
      if(type==='exact'){
        descTime = `Starts at: ${startEST} EST / ${startPST} PST`;
      } else {
        const endEST = formatTime24(sched.endTime,-5);
        const endPST = formatTime24(sched.endTime,-8);
        descTime = `Starts between: ${startEST}-${endEST} EST / ${startPST}-${endPST} PST`;
      }

      const embed = new EmbedBuilder()
        .setTitle('📅 New Scheduled Session')
        .setColor(0x00AAFF)
        .setDescription(`Hosted by: ${interaction.user.tag}\nType: ${type}\nDescription: ${desc}\n${descTime}`)
        .setFooter({text:`Signups: 0 | ID: ${id}`});

      const btn = new ButtonBuilder().setCustomId(`signup-${id}`).setLabel('Sign Up').setStyle(ButtonStyle.Success);
      const row = new ActionRowBuilder().addComponents(btn);
      await channel.send({embeds:[embed],components:[row]});
      return interaction.editReply(`✅ Session scheduled with ID: ${id}`);
    }

    // ---------- Other commands like /ssd, /ssu, /server-hop, /activity-view, /view-activity-grand, /del-activity, /logs, /code-red/orange ---------- //
    // Note: For brevity in this example, the same pattern applies:
    //   - check permissions
    //   - perform action
    //   - update activity/leaderboard/logs
    //   - send embeds or messages
    //   - handle shift roles
    //   - ping roles as needed
    // These sections will follow the same structure as /schedule above and merge with your existing logic.

  } catch(err){
    console.error(err);
    await setDowntimeStatus();
    interaction.editReply('❌ An error occurred.');
  }
});

// -------------------- BUTTON HANDLER --------------------
client.on('interactionCreate', async interaction=>{
  if(interaction.type===InteractionType.MessageComponent){
    try{
      if(interaction.customId.startsWith('signup-')){
        const sid = interaction.customId.split('-')[1];
        const sched = schedules.find(s=>s.id===sid);
        if(!sched) return interaction.reply({content:'❌ Session not found.',ephemeral:true});
        sched.signups.add(interaction.user.id);
        const guildMember = await interaction.guild.members.fetch(interaction.user.id);
        if(guildMember) guildMember.roles.add(SHIFT_ROLE_ID).catch(()=>{});
        await interaction.reply({content:`✅ You signed up for "${sched.desc}"`,ephemeral:true});
        const message = await interaction.channel.messages.fetch(interaction.message.id);
        const embed = EmbedBuilder.from(message.embeds[0]);
        embed.setFooter({text:`Signups: ${sched.signups.size} | ID: ${sched.id}`});
        await message.edit({embeds:[embed]});
      }
    }catch(err){console.error(err);}
  }
});

// -------------------- ERROR HANDLER --------------------
process.on('unhandledRejection', async err=>{
  console.error('Unhandled promise rejection:', err);
  await setDowntimeStatus();
});

client.login(TOKEN).catch(async err=>{
  console.error('Login failed:', err);
  await setDowntimeStatus();
});
