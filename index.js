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
  ChannelType
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

const schedules = []; // {id, userTag, type, startTime, endTime?, timezone, desc, signups:Set, notified}
const activeShifts = new Map(); // userId -> {startTime, roleActive}
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
    new SlashCommandBuilder().setName('ssu').setDescription('Announce an SSU')
      .addStringOption(o=>o.setName('game-link').setDescription('Link').setRequired(true)).toJSON(),
    new SlashCommandBuilder().setName('server-hop').setDescription('Server switch')
      .addStringOption(o=>o.setName('game-link').setDescription('Link').setRequired(true)).toJSON(),
    new SlashCommandBuilder().setName('ssd').setDescription('Shut down session').toJSON(),
    new SlashCommandBuilder().setName('schedule').setDescription('Schedule a session')
      .addStringOption(o=>o.setName('type').setDescription('Exact or range').setRequired(true))
      .addStringOption(o=>o.setName('timezone').setDescription('EST or PST').setRequired(true))
      .addStringOption(o=>o.setName('time').setDescription('Exact time HH:MM or earliest HH:MM').setRequired(true))
      .addStringOption(o=>o.setName('end-time').setDescription('Latest time for range').setRequired(false))
      .addStringOption(o=>o.setName('description').setDescription('Optional description').setRequired(false)).toJSON(),
    new SlashCommandBuilder().setName('view-schedule').setDescription('View upcoming sessions').toJSON(),
    new SlashCommandBuilder().setName('activity-view').setDescription('View weekly activity leaderboard').toJSON(),
    new SlashCommandBuilder().setName('view-activity-grand').setDescription('View grand activity leaderboard').toJSON(),
    new SlashCommandBuilder().setName('del-activity').setDescription('Delete activity record')
      .addUserOption(o=>o.setName('user').setDescription('Target user').setRequired(true))
      .addStringOption(o=>o.setName('reason').setDescription('Reason').setRequired(true)).toJSON(),
    new SlashCommandBuilder().setName('logs').setDescription('View global logs').toJSON(),
    new SlashCommandBuilder().setName('code-red').setDescription('Call Code Red alert')
      .addStringOption(o=>o.setName('location').setDescription('Location').setRequired(true)).toJSON(),
    new SlashCommandBuilder().setName('code-orange').setDescription('Call Code Orange alert')
      .addStringOption(o=>o.setName('location').setDescription('Location').setRequired(true)).toJSON()
  ];

  try {
    const rest = new REST({version:'10'}).setToken(TOKEN);
    await rest.put(Routes.applicationGuildCommands(client.user.id,GUILD_ID),{body:commands});
    console.log('Slash commands registered.');
  } catch(err){ console.error(err); await setDowntimeStatus(); }

  setInterval(checkSchedules,30*1000); // every 30s
});

// -------------------- SCHEDULE HANDLER --------------------
async function checkSchedules(){
  const now = new Date();
  const channel = await client.channels.fetch(ANNOUNCE_CHANNEL_ID).catch(()=>null);
  if(!channel) return;
  for(const s of schedules){
    if(!s.notified && now >= s.startTime-5*60000){
      s.notified = true;
      channel.send(`<@${s.userId}> ⚡ Your scheduled session "${s.desc}" starts in 5 minutes!`);
    }
  }
}

// -------------------- WEEKLY ACTIVITY ROLLOVER --------------------
cron.schedule('0 0 * * 6', ()=>{
  for(const [id,secs] of activity.entries()){
    grandActivity.set(id,(grandActivity.get(id)||0)+secs);
  }
  activity.clear();
  console.log('Weekly activity rolled into grandActivity.');
},{timezone:'America/New_York'});

// -------------------- BUTTON HANDLER --------------------
client.on('interactionCreate', async interaction=>{
  if(interaction.type===InteractionType.MessageComponent){
    try{
      const member = await interaction.guild.members.fetch(interaction.user.id);
      if(interaction.customId==='join-server'){
        if(!member.roles.cache.has(SHIFT_ROLE_ID)){
          await member.roles.add(SHIFT_ROLE_ID);
          activeShifts.set(member.id,{startTime:Date.now(),roleActive:true});
          logs.push({timestamp:Date.now(),text:`${member.user.tag} joined session via button.`});
        }
        await interaction.reply({content:'✅ Role assigned. Enjoy the session!',ephemeral:true});
      }
      if(interaction.customId==='end-shift'){
        if(member.roles.cache.has(SHIFT_ROLE_ID)){
          await member.roles.remove(SHIFT_ROLE_ID);
          const shift = activeShifts.get(member.id);
          if(shift){
            const duration = Math.floor((Date.now()-shift.startTime)/1000);
            activity.set(member.id,(activity.get(member.id)||0)+duration);
            activeShifts.delete(member.id);
            logs.push({timestamp:Date.now(),text:`${member.user.tag} ended shift, duration ${duration}s`});
          }
        }
        await interaction.reply({content:'✅ Shift ended.',ephemeral:true});
      }
      if(interaction.customId.startsWith('signup-')){
        const sid = interaction.customId.split('-')[1];
        const sched = schedules.find(s=>s.id===sid);
        if(!sched) return interaction.reply({content:'❌ Session not found.',ephemeral:true});
        sched.signups.add(interaction.user.id);
        await interaction.reply({content:`✅ You signed up for "${sched.desc}"`,ephemeral:true});
        // Update embed
        const message = await interaction.channel.messages.fetch(interaction.message.id);
        const embed = EmbedBuilder.from(message.embeds[0]);
        embed.setFooter({text:`Signups: ${sched.signups.size}`});
        await message.edit({embeds:[embed]});
      }
    }catch(err){console.error(err);}
  }
});

// -------------------- COMMAND HANDLER --------------------
client.on('interactionCreate',async interaction=>{
  if(!interaction.isChatInputCommand()) return;
  try{
    const member = await interaction.guild.members.fetch(interaction.user.id);
    const hasRole = WHITELIST_ROLES.some(r=>member.roles.cache.has(r));
    await interaction.deferReply({ephemeral:true});

    const channel = await client.channels.fetch(ANNOUNCE_CHANNEL_ID).catch(()=>null);
    if(!channel) return interaction.editReply('❌ Announcement channel missing.');

    // -------------------- HELP --------------------
    if(interaction.commandName==='help'){
      return interaction.editReply(`🛠 Commands:\n• /help\n• /ssu\n• /server-hop\n• /ssd\n• /schedule (restricted)\n• /view-schedule\n• /activity-view\n• /view-activity-grand\n• /del-activity (restricted)\n• /logs (role required)\n• /code-red\n• /code-orange`);
    }

    // -------------------- SCHEDULE --------------------
    if(interaction.commandName==='schedule'){
      if(!hasRole) return interaction.editReply('❌ No permission.');
      const type = interaction.options.getString('type');
      const tz = interaction.options.getString('timezone');
      const desc = interaction.options.getString('description')||'Session';
      const time = interaction.options.getString('time');
      const endTime = interaction.options.getString('end-time');
      const id = Date.now().toString(); // unique id
      const sched = {id,userId:interaction.user.id,userTag:interaction.user.tag,type,timezone:tz,desc,signups:new Set(),notified:false};
      if(type==='exact'){
        const [h,m]=time.split(':').map(Number);
        sched.startTime = new Date();
        sched.startTime.setHours(h-(tz==='EST'?5:8),m,0,0);
      } else if(type==='range'){
        const [h1,m1]=time.split(':').map(Number);
        const [h2,m2]=endTime.split(':').map(Number);
        sched.startTime = new Date(); sched.startTime.setHours(h1-(tz==='EST'?5:8),m1,0,0);
        sched.endTime = new Date(); sched.endTime.setHours(h2-(tz==='EST'?5:8),m2,0,0);
      } else return interaction.editReply('❌ Invalid type.');
      schedules.push(sched);

      const embed = new EmbedBuilder()
        .setTitle('📅 New Scheduled Session')
        .setColor(0x00AAFF)
        .setDescription(`Hosted by: ${interaction.user.tag}\nType: ${type}\nTimezone: ${tz}\nDescription: ${desc}\nStarts: ${sched.startTime.toUTCString()}` )
        .setFooter({text:`Signups: 0`});
      const btn = new ButtonBuilder().setCustomId(`signup-${id}`).setLabel('Sign Up').setStyle(ButtonStyle.Success);
      const row = new ActionRowBuilder().addComponents(btn);
      await channel.send({embeds:[embed],components:[row]});
      return interaction.editReply('✅ Session scheduled.');
    }

    if(interaction.commandName==='view-schedule'){
      if(schedules.length===0) return interaction.editReply('No upcoming sessions.');
      const text = schedules.map(s=>`• ${s.startTime.toUTCString()} - ${s.userTag} - ${s.desc} (Signups: ${s.signups.size})`).join('\n');
      return interaction.editReply(`📅 Upcoming sessions:\n${text}`);
    }

    // -------------------- ACTIVITY --------------------
    if(interaction.commandName==='activity-view'){
      if(activity.size===0) return interaction.editReply('No activity recorded.');
      const text = [...activity.entries()].map(([id,secs])=>{
        const hrs=Math.floor(secs/3600); const mins=Math.floor((secs%3600)/60); const s=secs%60;
        return `<@${id}> — ${hrs}h ${mins}m ${s}s`;
      }).join('\n');
      return interaction.editReply(`📊 Weekly activity:\n${text}`);
    }

    if(interaction.commandName==='view-activity-grand'){
      if(grandActivity.size===0) return interaction.editReply('No grand activity recorded.');
      const sorted = [...grandActivity.entries()].sort((a,b)=>b[1]-a[1]);
      const embed = new EmbedBuilder().setTitle('📊 Grand Activity Leaderboard').setColor(0x00FFFF).setTimestamp();
      let desc='';
      for(const [id,secs] of sorted){
        const hrs=Math.floor(secs/3600); const mins=Math.floor((secs%3600)/60); const s=secs%60;
        desc+=`<@${id}> — ${hrs}h ${mins}m ${s}s\n`;
      }
      embed.setDescription(desc);
      return interaction.editReply({embeds:[embed]});
    }

    // -------------------- DEL ACTIVITY --------------------
    if(interaction.commandName==='del-activity'){
      if(!hasRole) return interaction.editReply('❌ No permission.');
      const target = interaction.options.getUser('user');
      const reason = interaction.options.getString('reason');
      if(activity.has(target.id)){
        activity.delete(target.id);
        logs.push({timestamp:Date.now(),text:`${interaction.user.tag} deleted activity of ${target.tag} — Reason: ${reason}`});
        return interaction.editReply(`✅ Deleted activity of ${target.tag}`);
      } else return interaction.editReply('❌ User has no activity.');
    }

    // -------------------- LOGS --------------------
    if(interaction.commandName==='logs'){
      if(!member.roles.cache.has(LOG_ROLE_ID)) return interaction.editReply('❌ Missing required role.');
      if(logs.length===0) return interaction.editReply('No logs yet.');
      const text = logs.map(l=>`[${new Date(l.timestamp).toLocaleString()}] ${l.text}`).join('\n');
      return interaction.editReply(`📖 Logs:\n${text}`);
    }

    // -------------------- CODE ALERTS --------------------
    if(interaction.commandName==='code-red'||interaction.commandName==='code-orange'){
      const location=interaction.options.getString('location');
      const vc=member.voice.channel;
      if(!vc) return interaction.editReply({content:'❌ Must be in VC!',ephemeral:true});
      const linkedText=vc.guild.channels.cache.find(c=>c.type===ChannelType.GuildText && c.name.toLowerCase().includes(vc.name.toLowerCase()));
      if(!linkedText) return interaction.editReply({content:'❌ Could not find linked VC text channel',ephemeral:true});
      const codeType = interaction.commandName==='code-red'?'Code Red':'Code Orange';
      await linkedText.send(`${codeType} called by ${interaction.user.username} at ${location}!`);
      return interaction.editReply({content:`✅ ${codeType} sent in VC "${linkedText.name}"`,ephemeral:true});
    }

    // -------------------- SESSION COMMANDS --------------------
    if(!hasRole && ['ssu','server-hop','ssd'].includes(interaction.commandName)) return interaction.editReply('❌ No permission.');

    if(interaction.commandName==='ssu'){
      const gameLink=interaction.options.getString('game-link');
      if(!gameLink.startsWith('https://')) return interaction.editReply('❌ Invalid link.');
      const joinButton=new ButtonBuilder().setLabel('Join Server').setStyle(ButtonStyle.Success).setCustomId('join-server');
      const endButton=new ButtonBuilder().setLabel('End Shift').setStyle(ButtonStyle.Danger).setCustomId('end-shift');
      const row=new ActionRowBuilder().addComponents(joinButton,endButton);
      const embed=new EmbedBuilder().setColor(0xff0000).setDescription(`❗ A SSU is being hosted by ${interaction.user}!\nPlease join the labs using this link: ${gameLink}! 🔔`).setTimestamp();
      await channel.send({content:'@everyone',embeds:[embed],components:[row]});
      sessionStartTime=Date.now();
      if(sessionInterval) clearInterval(sessionInterval);
      await updateSessionStatus();
      sessionInterval=setInterval(updateSessionStatus,15000);
      logs.push({timestamp:Date.now(),text:`${interaction.user.tag} started SSU`});
      return interaction.editReply('✅ SSU started.');
    }

    if(interaction.commandName==='server-hop'){
      const gameLink=interaction.options.getString('game-link');
      if(!gameLink.startsWith('https://')) return interaction.editReply('❌ Invalid link.');
      const joinButton=new ButtonBuilder().setLabel('Join Server').setStyle(ButtonStyle.Success).setCustomId('join-server');
      const endButton=new ButtonBuilder().setLabel('End Shift').setStyle(ButtonStyle.Danger).setCustomId('end-shift');
      const row=new ActionRowBuilder().addComponents(joinButton,endButton);
      const embed=new EmbedBuilder().setColor(0xff9900).setDescription(`❗ ${interaction.user} has switched servers!\nJoin at: ${gameLink}! 🔔`).setTimestamp();
      await channel.send({content:'@everyone',embeds:[embed],components:[row]});
      logs.push({timestamp:Date.now(),text:`${interaction.user.tag} server hopped`});
      return interaction.editReply('✅ Server hop announced.');
    }

    if(interaction.commandName==='ssd'){
      await channel.send('The session has shutdown.');
      if(sessionInterval) clearInterval(sessionInterval);
      sessionInterval=null;
      sessionStartTime=null;
      await setNormalStatus();
      logs.push({timestamp:Date.now(),text:`${interaction.user.tag} ended session`});
      return interaction.editReply('✅ Session ended.');
    }

  }catch(err){ console.error(err); await setDowntimeStatus(); interaction.editReply('❌ An error occurred.'); }
});

// -------------------- GLOBAL ERROR HANDLER --------------------
process.on('unhandledRejection',async err=>{
  console.error('Unhandled rejection:',err);
  await setDowntimeStatus();
});

client.login(TOKEN).catch(async err=>{
  console.error('Login failed:',err);
  await setDowntimeStatus();
});
