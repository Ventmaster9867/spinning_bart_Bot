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
const cron = require('node-cron');

const TOKEN = process.env.TOKEN;
const GUILD_ID = '1394380681341173810';
const ANNOUNCE_CHANNEL_ID = '1452777822618648678';
const WHITELIST_ROLES = ['1410771734700888064','1395231118537523220'];
const SHIFT_ROLE_ID = '1475191266084917298';
const LOG_ROLE_ID = '1395209235389743114';

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });

// -------------------- DATA --------------------
let botReady = false;
let sessionStartTime = null;
let sessionInterval = null;

const schedules = []; // {id,userTag,type,startTime,endTime?,timezone,desc,signups:Set,notified,userId}
const activeShifts = new Map(); // userId -> {startTime,roleActive}
const activity = new Map(); // userId -> seconds
const grandActivity = new Map(); // userId -> seconds across all weeks
const logs = []; // {timestamp,text}

// -------------------- STATUS --------------------
async function setNormalStatus() {
  if (!client.user) return;
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
async function updateSessionStatus() {
  if (!client.user || !sessionStartTime) return;
  const elapsed = Date.now() - sessionStartTime;
  const hrs = Math.floor(elapsed / 3600000);
  const mins = Math.floor((elapsed % 3600000) / 60000);
  const sec = Math.floor((elapsed % 60000) / 1000);
  await client.user.setPresence({
    status: 'online',
    activities: [{ name: `Server Online since: ${String(hrs).padStart(2,'0')}:${String(mins).padStart(2,'0')}:${String(sec).padStart(2,'0')}`, type: ActivityType.Playing }]
  });
}

// -------------------- READY --------------------
client.once('ready', async ()=>{
  console.log(`Logged in as ${client.user.tag}`);
  botReady = true;
  try { await setNormalStatus(); } catch(err){ console.error(err); }

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
    new SlashCommandBuilder().setName('view-schedule').setDescription('View upcoming sessions').toJSON()
  ];

  try {
    const rest = new REST({version:'10'}).setToken(TOKEN);
    await rest.put(Routes.applicationGuildCommands(client.user.id,GUILD_ID),{body:commands});
    console.log('Slash commands registered.');
  } catch(err){ console.error(err); await setDowntimeStatus(); }
  setInterval(checkSchedules,30*1000);
});

// -------------------- SCHEDULE HANDLER --------------------
async function checkSchedules(){
  const now = new Date();
  const channel = await client.channels.fetch(ANNOUNCE_CHANNEL_ID).catch(()=>null);
  if(!channel) return;
  for(const s of schedules){
    if(!s.notified && now >= new Date(s.startTime.getTime()-5*60000) && now<s.startTime){
      s.notified = true;
      channel.send(`<@${s.userId}> ⚡ Your scheduled session "${s.desc}" starts in 5 minutes!`);
    }
  }
}

// -------------------- COMMAND HANDLER --------------------
client.on('interactionCreate',async interaction=>{
  if(!interaction.isChatInputCommand()) return;
  try{
    const member = await interaction.guild.members.fetch(interaction.user.id);
    const hasRole = WHITELIST_ROLES.some(r=>member.roles.cache.has(r));
    await interaction.deferReply({ephemeral:true});
    const channel = await client.channels.fetch(ANNOUNCE_CHANNEL_ID).catch(()=>null);
    if(!channel) return interaction.editReply('❌ Announcement channel missing.');

    // ---------- HELP ----------
    if(interaction.commandName==='help'){
      return interaction.editReply(`🛠 Commands:\n• /help\n• /schedule (restricted)\n• /del-schedule (restricted)\n• /view-schedule`);
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
        const [h,m] = time.split(':').map(Number);
        sched.startTime = new Date();
        sched.startTime.setHours(h-(tz==='EST'?5:8),m,0,0);
      } else {
        const [h1,m1]=time.split(':').map(Number);
        const [h2,m2]=endTime.split(':').map(Number);
        sched.startTime=new Date(); sched.startTime.setHours(h1-(tz==='EST'?5:8),m1,0,0);
        sched.endTime=new Date(); sched.endTime.setHours(h2-(tz==='EST'?5:8),m2,0,0);
      }

      schedules.push(sched);

      let descTime = type==='exact' ? `Starts at: ${sched.startTime.toUTCString()}` :
        `Starts between: ${sched.startTime.toUTCString()} - ${sched.endTime.toUTCString()}`;
      const embed = new EmbedBuilder()
        .setTitle('📅 New Scheduled Session')
        .setColor(0x00AAFF)
        .setDescription(`Hosted by: ${interaction.user.tag}\nType: ${type}\nTimezone: ${tz}\nDescription: ${desc}\n${descTime}`)
        .setFooter({text:`Signups: 0`});
      const btn = new ButtonBuilder().setCustomId(`signup-${id}`).setLabel('Sign Up').setStyle(ButtonStyle.Success);
      const row = new ActionRowBuilder().addComponents(btn);
      await channel.send({embeds:[embed],components:[row]});
      return interaction.editReply(`✅ Session scheduled with ID: ${id}`);
    }

    // ---------- DEL SCHEDULE ----------
    if(interaction.commandName==='del-schedule'){
      if(!hasRole) return interaction.editReply('❌ No permission.');
      const sessionId = interaction.options.getString('session-id');
      const index = schedules.findIndex(s => s.id === sessionId);
      if(index === -1) return interaction.editReply('❌ Session not found.');
      const sched = schedules[index];
      try {
        const messages = await channel.messages.fetch({limit:100});
        const msg = messages.find(m => m.embeds.length && m.embeds[0].title==='📅 New Scheduled Session' && m.embeds[0].description.includes(sched.desc));
        if(msg) await msg.delete();
      } catch(err){ console.warn('Failed to delete embed message:', err); }
      schedules.splice(index,1);
      logs.push({timestamp:Date.now(),text:`${interaction.user.tag} deleted scheduled session "${sched.desc}"`});
      return interaction.editReply(`✅ Deleted scheduled session "${sched.desc}".`);
    }

    // ---------- VIEW SCHEDULE ----------
    if(interaction.commandName==='view-schedule'){
      if(schedules.length===0) return interaction.editReply('No upcoming sessions.');
      const text = schedules.map(s=>{
        let range = s.type==='exact' ? `Starts at: ${s.startTime.toUTCString()}` :
          `Starts between: ${s.startTime.toUTCString()} - ${s.endTime.toUTCString()}`;
        return `• ID:${s.id} - ${range} - ${s.userTag} - ${s.desc} (Signups: ${s.signups.size})`;
      }).join('\n');
      return interaction.editReply(`📅 Upcoming sessions:\n${text}`);
    }

  }catch(err){ console.error(err); await setDowntimeStatus(); interaction.editReply('❌ An error occurred.'); }
});

// -------------------- GLOBAL ERROR HANDLER --------------------
process.on('unhandledRejection', async err=>{
  console.error('Unhandled promise rejection:', err);
  await setDowntimeStatus();
});

client.login(TOKEN).catch(async err=>{
  console.error('Login failed:', err);
  await setDowntimeStatus();
});
