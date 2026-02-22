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

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });

// -------------------- DATA --------------------
let schedules = []; // {id,userTag,type,startTime,endTime?,desc,signups:Set,notified,userId}
let botReady = false;

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
});

// -------------------- HELPER --------------------
function formatTime24(date, offset){
  const d = new Date(date.getTime() + offset*3600000);
  const hh = String(d.getUTCHours()).padStart(2,'0');
  const mm = String(d.getUTCMinutes()).padStart(2,'0');
  return `${hh}:${mm}`;
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
        sched.startTime.setUTCHours(h-(tz==='EST'?5:8),m,0,0);
      } else {
        const [h1,m1]=time.split(':').map(Number);
        const [h2,m2]=endTime.split(':').map(Number);
        sched.startTime=new Date(); sched.startTime.setUTCHours(h1-(tz==='EST'?5:8),m1,0,0);
        sched.endTime=new Date(); sched.endTime.setUTCHours(h2-(tz==='EST'?5:8),m2,0,0);
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

    // ---------- DEL SCHEDULE ----------
    if(interaction.commandName==='del-schedule'){
      if(!hasRole) return interaction.editReply('❌ No permission.');
      const sessionId = interaction.options.getString('session-id');
      const index = schedules.findIndex(s => s.id === sessionId);
      if(index === -1) return interaction.editReply('❌ Session not found.');
      const sched = schedules[index];
      try {
        const messages = await channel.messages.fetch({limit:100});
        const msg = messages.find(m => m.embeds.length && m.embeds[0].title==='📅 New Scheduled Session' && m.embeds[0].footer?.text?.includes(sessionId));
        if(msg) await msg.delete();
      } catch(err){ console.warn('Failed to delete embed message:', err); }
      schedules.splice(index,1);
      return interaction.editReply(`✅ Deleted scheduled session "${sched.desc}".`);
    }

    // ---------- VIEW SCHEDULE ----------
    if(interaction.commandName==='view-schedule'){
      if(schedules.length===0) return interaction.editReply('No upcoming sessions.');
      const text = schedules.map(s=>{
        const startEST = formatTime24(s.startTime,-5);
        const startPST = formatTime24(s.startTime,-8);
        if(s.type==='exact'){
          return `• ID:${s.id} - Starts at: ${startEST} EST / ${startPST} PST - ${s.userTag} - ${s.desc} (Signups: ${s.signups.size})`;
        } else {
          const endEST = formatTime24(s.endTime,-5);
          const endPST = formatTime24(s.endTime,-8);
          return `• ID:${s.id} - Starts between: ${startEST}-${endEST} EST / ${startPST}-${endPST} PST - ${s.userTag} - ${s.desc} (Signups: ${s.signups.size})`;
        }
      }).join('\n');
      return interaction.editReply(`📅 Upcoming sessions:\n${text}`);
    }

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
      const member = await interaction.guild.members.fetch(interaction.user.id);
      if(interaction.customId.startsWith('signup-')){
        const sid = interaction.customId.split('-')[1];
        const sched = schedules.find(s=>s.id===sid);
        if(!sched) return interaction.reply({content:'❌ Session not found.',ephemeral:true});
        sched.signups.add(interaction.user.id);
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
