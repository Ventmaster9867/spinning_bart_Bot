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

const {
    joinVoiceChannel,
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
    VoiceConnectionStatus,
    entersState
} = require('@discordjs/voice');

const gTTS = require('gtts');
const fs = require('fs');
const path = require('path');
const ffmpegPath = require('ffmpeg-static');
const sodium = require('libsodium-wrappers');

// Tell fluent-ffmpeg and discord voice where ffmpeg is
process.env.FFMPEG_PATH = ffmpegPath;

// Initialise libsodium before anything else runs
(async () => { await sodium.ready; })();

const TOKEN = process.env.TOKEN;
const GUILD_ID = '1394380681341173810';
const ANNOUNCE_CHANNEL_ID = '1452777822618648678';
const WHITELIST_ROLES = ['1410771734700888064','1395231118537523220'];
const SHIFT_ROLE_ID = '1475191266084917298';
const LOG_ROLE_ID = '1395209235389743114';

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });

let botReady = false;
let sessionStartTime = null;
let sessionInterval = null;

// -------------------- DATA --------------------
const schedules = []; // {userId,userTag,dateTime,description,notified}
const activeShifts = new Map(); // userId -> {startTime, roleActive}
const activity = new Map(); // userId -> totalSeconds
const logs = []; // {timestamp, text}

// -------------------- TTS VOICE ALERT --------------------
async function speakInVC(voiceChannel, message) {
    return new Promise(async (resolve) => {
        try {
            // Generate TTS audio file
            const ttsFilePath = path.join(__dirname, `tts_${Date.now()}.mp3`);
            const gtts = new gTTS(message, 'en');

            await new Promise((res, rej) => gtts.save(ttsFilePath, err => err ? rej(err) : res()));

            // Small delay to make sure file is fully written
            await new Promise(res => setTimeout(res, 500));

            // Join the voice channel
            const connection = joinVoiceChannel({
                channelId: voiceChannel.id,
                guildId: voiceChannel.guild.id,
                adapterCreator: voiceChannel.guild.voiceAdapterCreator,
                selfDeaf: false,
                selfMute: false
            });

            // Wait until the connection is ready
            await entersState(connection, VoiceConnectionStatus.Ready, 10_000);

            // Use ffmpeg to convert mp3 to opus stream for Discord
            const { spawn } = require('child_process');
            const ffmpeg = spawn(ffmpegPath, [
                '-i', ttsFilePath,
                '-acodec', 'libopus',
                '-f', 'opus',
                '-ar', '48000',
                '-ac', '2',
                'pipe:1'
            ]);

            const player = createAudioPlayer();
            const resource = createAudioResource(ffmpeg.stdout);

            connection.subscribe(player);
            player.play(resource);

            // When finished playing, disconnect and clean up
            player.on(AudioPlayerStatus.Idle, () => {
                connection.destroy();
                fs.unlink(ttsFilePath, () => {});
                resolve();
            });

            player.on('error', err => {
                console.error('Player error:', err);
                connection.destroy();
                fs.unlink(ttsFilePath, () => {});
                resolve();
            });

            // Safety timeout — disconnect after 30s no matter what
            setTimeout(() => {
                try { connection.destroy(); } catch {}
                try { fs.unlinkSync(ttsFilePath); } catch {}
                resolve();
            }, 30_000);

        } catch (err) {
            console.error('TTS error:', err);
            resolve(); // Don't crash the command if TTS fails
        }
    });
}

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
    const hours = Math.floor(elapsed / 3600000);
    const minutes = Math.floor((elapsed % 3600000) / 60000);
    const seconds = Math.floor((elapsed % 60000) / 1000);
    const formatted = `${String(hours).padStart(2,'0')}:${String(minutes).padStart(2,'0')}:${String(seconds).padStart(2,'0')}`;
    await client.user.setPresence({
        status: 'online',
        activities: [{ name: `Server Online since: ${formatted}`, type: ActivityType.Playing }]
    });
}

// -------------------- READY --------------------
client.once('ready', async () => {
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
            .addStringOption(o=>o.setName('time').setDescription('HH:MM 24h').setRequired(true))
            .addStringOption(o=>o.setName('description').setDescription('Optional desc').setRequired(false)).toJSON(),
        new SlashCommandBuilder().setName('view-schedule').setDescription('View upcoming sessions').toJSON(),
        new SlashCommandBuilder().setName('activity-view').setDescription('View activity leaderboard').toJSON(),
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
        const rest = new REST({ version:'10' }).setToken(TOKEN);
        await rest.put(Routes.applicationGuildCommands(client.user.id,GUILD_ID), { body:commands });
        console.log('Slash commands registered.');
    } catch(err){ console.error(err); await setDowntimeStatus(); }

    setInterval(checkSchedules, 30*1000);
});

// -------------------- SCHEDULE --------------------
async function checkSchedules() {
    const now = new Date();
    const channel = await client.channels.fetch(ANNOUNCE_CHANNEL_ID).catch(()=>null);
    if(!channel) return;
    for(const s of schedules){
        if(!s.notified && now >= new Date(s.dateTime.getTime()-5*60000)){
            s.notified = true;
            channel.send(`<@${s.userId}> ⚡ Your scheduled session "${s.description||'Session'}" starts in 5 minutes!`);
        }
    }
}

// -------------------- BUTTON HANDLER --------------------
client.on('interactionCreate', async interaction=>{
    if(interaction.type===InteractionType.MessageComponent){
        try{
            const member = await interaction.guild.members.fetch(interaction.user.id);
            if(interaction.customId==='join-server'){
                if(!member.roles.cache.has(SHIFT_ROLE_ID)){
                    await member.roles.add(SHIFT_ROLE_ID);
                    activeShifts.set(member.id,{startTime:Date.now(), roleActive:true});
                    logs.push({timestamp:Date.now(), text:`${member.user.tag} joined session via button.`});
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

        const channel = await interaction.guild.channels.fetch(ANNOUNCE_CHANNEL_ID).catch(()=>null);
        if(!channel) return interaction.editReply('❌ Announcement channel missing.');

        if(interaction.commandName==='help'){
            return interaction.editReply(`🛠 Commands:\n• /help\n• /ssu\n• /server-hop\n• /ssd\n• /schedule (restricted)\n• /view-schedule\n• /activity-view\n• /del-activity (restricted)\n• /logs (role required)\n• /code-red\n• /code-orange`);
        }

        // -------------------- SCHEDULE --------------------
        if(interaction.commandName==='schedule'){
            if(!hasRole) return interaction.editReply('❌ No permission.');
            const timeInput = interaction.options.getString('time');
            const desc = interaction.options.getString('description')||'Session';
            const match = timeInput.match(/^(\d{1,2}):(\d{2})$/);
            if(!match) return interaction.editReply('❌ Invalid time format.');
            const dt = new Date();
            dt.setHours(parseInt(match[1],10),parseInt(match[2],10),0,0);
            schedules.push({userId:interaction.user.id,userTag:interaction.user.tag,dateTime:dt,description:desc,notified:false});
            return interaction.editReply(`✅ Scheduled "${desc}" at ${dt.toLocaleTimeString()}.`);
        }

        if(interaction.commandName==='view-schedule'){
            if(schedules.length===0) return interaction.editReply('No upcoming sessions.');
            const text = schedules.map(s=>`• ${s.dateTime.toLocaleString()} - ${s.userTag} - ${s.description}`).join('\n');
            return interaction.editReply(`📅 Upcoming sessions:\n${text}`);
        }

        // -------------------- ACTIVITY --------------------
        if(interaction.commandName==='activity-view'){
            if(activity.size===0) return interaction.editReply('No activity recorded.');
            const text = [...activity.entries()].map(([id,secs])=>{
                const hrs=Math.floor(secs/3600); const mins=Math.floor((secs%3600)/60); const s=secs%60;
                return `<@${id}> — ${hrs}h ${mins}m ${s}s`;
            }).join('\n');
            return interaction.editReply(`📊 Activity leaderboard:\n${text}`);
        }

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

        if(interaction.commandName==='logs'){
            if(!member.roles.cache.has(LOG_ROLE_ID)) return interaction.editReply('❌ Missing required role.');
            if(logs.length===0) return interaction.editReply('No logs yet.');
            const text = logs.map(l=>`[${new Date(l.timestamp).toLocaleString()}] ${l.text}`).join('\n');
            return interaction.editReply(`📖 Logs:\n${text}`);
        }

        // -------------------- CODE ALERTS (VC BUILT-IN TEXT + TTS) --------------------
        if(interaction.commandName==='code-red' || interaction.commandName==='code-orange'){
            const location = interaction.options.getString('location');
            const vc = member.voice.channel;
            if(!vc) return interaction.editReply({ content: '❌ You must be in a voice channel to call this code!', ephemeral: true });

            const codeType = interaction.commandName==='code-red' ? 'Code Red' : 'Code Orange';
            const alertMessage = `${codeType} called by ${interaction.user.username} at ${location}!`;

            // Send to VC built-in text channel
            await vc.send(alertMessage);

            // Reply to user immediately so the interaction doesn't time out
            await interaction.editReply({ content: `✅ ${codeType} announced in "${vc.name}" — joining VC to speak it now...` });

            // Speak the alert out loud in the VC
            const ttsMessage = `Attention. ${codeType}. ${codeType} at ${location}. Called by ${interaction.user.username}.`;
            await speakInVC(vc, ttsMessage);

            return;
        }

        // -------------------- SESSION COMMANDS --------------------
        if(!hasRole && ['ssu','server-hop','ssd'].includes(interaction.commandName)) return interaction.editReply('❌ No permission.');

        if(interaction.commandName==='ssu'){
            const gameLink = interaction.options.getString('game-link');
            if(!gameLink.startsWith('https://')) return interaction.editReply('❌ Invalid link.');
            const joinButton = new ButtonBuilder().setLabel('Join Server').setStyle(ButtonStyle.Success).setCustomId('join-server');
            const endButton = new ButtonBuilder().setLabel('End Shift').setStyle(ButtonStyle.Danger).setCustomId('end-shift');
            const row = new ActionRowBuilder().addComponents(joinButton,endButton);
            const embed = new EmbedBuilder().setColor(0xff0000).setDescription(`❗ A SSU is being hosted by ${interaction.user}!\n\nPlease join the labs using this link: ${gameLink}! 🔔`).setTimestamp();
            await channel.send({content:'@everyone',embeds:[embed],components:[row]});
            sessionStartTime=Date.now();
            if(sessionInterval) clearInterval(sessionInterval);
            await updateSessionStatus();
            sessionInterval=setInterval(updateSessionStatus,15000);
            logs.push({timestamp:Date.now(),text:`${interaction.user.tag} started SSU`});
            return interaction.editReply('✅ SSU started.');
        }

        if(interaction.commandName==='server-hop'){
            const gameLink = interaction.options.getString('game-link');
            if(!gameLink.startsWith('https://')) return interaction.editReply('❌ Invalid link.');
            const joinButton = new ButtonBuilder().setLabel('Join Server').setStyle(ButtonStyle.Success).setCustomId('join-server');
            const endButton = new ButtonBuilder().setLabel('End Shift').setStyle(ButtonStyle.Danger).setCustomId('end-shift');
            const row = new ActionRowBuilder().addComponents(joinButton,endButton);
            const embed = new EmbedBuilder().setColor(0xff9900).setDescription(`❗ ${interaction.user} has switched servers!\n\nJoin at: ${gameLink}! 🔔`).setTimestamp();
            await channel.send({content:'@everyone',embeds:[embed],components:[row]});
            logs.push({timestamp:Date.now(),text:`${interaction.user.tag} server hopped`});
            return interaction.editReply('✅ Server hop announced.');
        }

        if(interaction.commandName==='ssd'){
            await channel.send('The session has shutdown.');
            if(sessionInterval){clearInterval(sessionInterval);sessionInterval=null;}
            sessionStartTime=null;

            for(const [id,data] of activeShifts.entries()){
                const duration = Math.floor((Date.now()-data.startTime)/1000);
                activity.set(id,(activity.get(id)||0)+duration);
            }
            activeShifts.clear();
            await setNormalStatus();

            if(activity.size>0){
                const text = [...activity.entries()].map(([id,secs])=>{
                    const hrs=Math.floor(secs/3600); const mins=Math.floor((secs%3600)/60); const s=secs%60;
                    return `<@${id}> — ${hrs}h ${mins}m ${s}s`;
                }).join('\n');
                await channel.send(`📊 Session leaderboard:\n${text}`);
            }
            logs.push({timestamp:Date.now(),text:`${interaction.user.tag} ended session`});
            return interaction.editReply('✅ Session ended.');
        }

    }catch(err){console.error(err);if(botReady) try{await setDowntimeStatus();}catch{} if(!interaction.replied) await interaction.reply({content:'❌ Something went wrong.',ephemeral:true}).catch(()=>{});}
});

// -------------------- GLOBAL ERROR SAFETY --------------------
process.on('unhandledRejection', async err => {console.error(err); if(botReady) try{await setDowntimeStatus();}catch{}});
process.on('uncaughtException', async err => {console.error(err); if(botReady) try{await setDowntimeStatus();}catch{} });

// -------------------- LOGIN --------------------
client.login(TOKEN).catch(err=>console.error('Login failed:',err));
