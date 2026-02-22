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
    ActionRowBuilder
} = require('discord.js');

const TOKEN = process.env.TOKEN;
const GUILD_ID = '1394380681341173810';
const ANNOUNCE_CHANNEL_ID = '1452777822618648678';

const ALLOWED_ROLES = [
    '1410771734700888064',
    '1395231118537523220'
];

const client = new Client({
    intents: [GatewayIntentBits.Guilds]
});

let botReady = false;
let sessionStartTime = null;
let sessionInterval = null;

// Scheduler storage
const schedules = []; // { userId, userTag, dateTime: Date, description, notified: false }

/* ================= STATUS ================= */
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

/* ================= READY ================= */
client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}`);
    botReady = true;

    try { await setNormalStatus(); } catch (err) { console.error(err); }

    const commands = [
        new SlashCommandBuilder().setName('help').setDescription('Shows command menu').toJSON(),
        new SlashCommandBuilder().setName('ssu').setDescription('Announce an SSU').addStringOption(o => o.setName('game-link').setDescription('Link').setRequired(true)).toJSON(),
        new SlashCommandBuilder().setName('server-hop').setDescription('Server switch').addStringOption(o => o.setName('game-link').setDescription('Link').setRequired(true)).toJSON(),
        new SlashCommandBuilder().setName('ssd').setDescription('Shut down session').toJSON(),
        new SlashCommandBuilder().setName('schedule').setDescription('Schedule a session')
            .addStringOption(o => o.setName('time').setDescription('Time HH:MM (24h)').setRequired(true))
            .addStringOption(o => o.setName('description').setDescription('Session description').setRequired(false))
            .toJSON(),
        new SlashCommandBuilder().setName('view-schedule').setDescription('View upcoming sessions').toJSON()
    ];

    try {
        const rest = new REST({ version: '10' }).setToken(TOKEN);
        await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: commands });
        console.log('Slash commands registered.');
    } catch (err) { console.error(err); await setDowntimeStatus(); }

    // Start schedule checking loop
    setInterval(checkSchedules, 30 * 1000);
});

/* ================= CHECK SCHEDULES ================= */
async function checkSchedules() {
    const now = new Date();
    const channel = await client.channels.fetch(ANNOUNCE_CHANNEL_ID).catch(()=>null);
    if (!channel) return;
    for (const s of schedules) {
        if (!s.notified && now >= new Date(s.dateTime.getTime() - 5*60000)) {
            s.notified = true;
            channel.send(`<@${s.userId}> ⚡ Your scheduled session "${s.description||'Session'}" starts in 5 minutes!`);
        }
    }
}

/* ================= COMMAND HANDLER ================= */
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    try {
        const member = await interaction.guild.members.fetch(interaction.user.id);
        const hasRole = ALLOWED_ROLES.some(r => member.roles.cache.has(r));

        if (interaction.commandName === 'help') {
            return interaction.reply({ content: `🛠 Commands:\n• /help\n• /ssu\n• /server-hop\n• /ssd\n• /schedule (restricted)\n• /view-schedule`, ephemeral:true });
        }

        await interaction.deferReply({ ephemeral:true });

        /* ===== SCHEDULE COMMAND ===== */
        if (interaction.commandName === 'schedule') {
            if (!hasRole) return interaction.editReply('❌ No permission.');
            const timeInput = interaction.options.getString('time');
            const desc = interaction.options.getString('description') || 'Session';
            // parse HH:MM
            const match = timeInput.match(/^(\d{1,2}):(\d{2})$/);
            if (!match) return interaction.editReply('❌ Invalid time format. Use HH:MM 24h.');
            const hours = parseInt(match[1],10);
            const minutes = parseInt(match[2],10);
            const dt = new Date();
            dt.setHours(hours, minutes, 0, 0);
            schedules.push({ userId: interaction.user.id, userTag: interaction.user.tag, dateTime: dt, description: desc, notified: false });
            return interaction.editReply(`✅ Scheduled "${desc}" at ${dt.toLocaleTimeString()}.`);
        }

        /* ===== VIEW SCHEDULE ===== */
        if (interaction.commandName === 'view-schedule') {
            if (schedules.length===0) return interaction.editReply('No upcoming sessions.');
            const text = schedules.map(s=>`• ${s.dateTime.toLocaleString()} - ${s.userTag} - ${s.description}`).join('\n');
            return interaction.editReply(`📅 Upcoming sessions:\n${text}`);
        }

        /* ===== SSU / SERVER-HOP / SSD ===== */
        const channel = await interaction.guild.channels.fetch(ANNOUNCE_CHANNEL_ID);
        if (!channel) return interaction.editReply('❌ Announcement channel not found.');

        if (!hasRole && ['ssu','server-hop','ssd'].includes(interaction.commandName)) return interaction.editReply('❌ No permission.');

        if (interaction.commandName === 'ssu') {
            const gameLink = interaction.options.getString('game-link');
            if (!gameLink.startsWith('https://')) return interaction.editReply('❌ Invalid link.');
            const button = new ButtonBuilder().setLabel('Join Server').setStyle(ButtonStyle.Link).setURL(gameLink);
            const row = new ActionRowBuilder().addComponents(button);
            const embed = new EmbedBuilder().setColor(0xff0000).setDescription(`❗ A SSU is being hosted by ${interaction.user}!\n\nPlease join the labs using this link: ${gameLink}! 🔔`).setTimestamp();
            await channel.send({ content:'@everyone', embeds:[embed], components:[row] });

            // start session status
            sessionStartTime = Date.now();
            if (sessionInterval) clearInterval(sessionInterval);
            await updateSessionStatus();
            sessionInterval = setInterval(updateSessionStatus, 15000);

            return interaction.editReply('✅ SSU started and timer activated.');
        }

        if (interaction.commandName === 'server-hop') {
            const gameLink = interaction.options.getString('game-link');
            if (!gameLink.startsWith('https://')) return interaction.editReply('❌ Invalid link.');
            const button = new ButtonBuilder().setLabel('Join Server').setStyle(ButtonStyle.Link).setURL(gameLink);
            const row = new ActionRowBuilder().addComponents(button);
            const embed = new EmbedBuilder().setColor(0xff9900).setDescription(`❗ ${interaction.user} has switched servers!\n\nJoin at: ${gameLink}! 🔔`).setTimestamp();
            await channel.send({ content:'@everyone', embeds:[embed], components:[row] });
            return interaction.editReply('✅ Server hop announced.');
        }

        if (interaction.commandName === 'ssd') {
            await channel.send('The session has shutdown.');
            if (sessionInterval) { clearInterval(sessionInterval); sessionInterval=null; }
            sessionStartTime = null;
            await setNormalStatus();
            return interaction.editReply('✅ Session ended and timer stopped.');
        }

    } catch (err) {
        console.error('Command error:', err);
        if (botReady) try { await setDowntimeStatus(); } catch {}
        if (!interaction.replied) await interaction.reply({ content:'❌ Something went wrong.', ephemeral:true }).catch(()=>{});
    }
});

/* ================= GLOBAL ERROR SAFETY ================= */
process.on('unhandledRejection', async err => { console.error(err); if(botReady) try{await setDowntimeStatus()}catch{} });
process.on('uncaughtException', async err => { console.error(err); if(botReady) try{await setDowntimeStatus()}catch{} });

/* ================= LOGIN ================= */
client.login(TOKEN).catch(err => console.error('Login failed:',err));
