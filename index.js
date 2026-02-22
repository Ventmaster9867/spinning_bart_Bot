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

/* ================= STATUS SYSTEM ================= */

async function setNormalStatus() {
    if (!client.user) return;
    await client.user.setPresence({
        status: 'idle',
        activities: [{
            name: 'Created by ventmaster9867 ✨',
            type: ActivityType.Playing
        }]
    });
}

async function setDowntimeStatus() {
    if (!client.user) return;
    await client.user.setPresence({
        status: 'dnd',
        activities: [{
            name: '📕 Experiencing Downtime!',
            type: ActivityType.Playing
        }]
    });
}

async function updateSessionStatus() {
    if (!client.user || !sessionStartTime) return;

    const elapsed = Date.now() - sessionStartTime;

    const hours = Math.floor(elapsed / 3600000);
    const minutes = Math.floor((elapsed % 3600000) / 60000);
    const seconds = Math.floor((elapsed % 60000) / 1000);

    const formatted =
        `${String(hours).padStart(2, '0')}:` +
        `${String(minutes).padStart(2, '0')}:` +
        `${String(seconds).padStart(2, '0')}`;

    await client.user.setPresence({
        status: 'online',
        activities: [{
            name: `Server Online since: ${formatted}`,
            type: ActivityType.Playing
        }]
    });
}

/* ================= READY EVENT ================= */

client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}`);
    botReady = true;

    try {
        await setNormalStatus();
    } catch (err) {
        console.error('Startup status error:', err);
    }

    const commands = [
        new SlashCommandBuilder()
            .setName('help')
            .setDescription('Shows the command menu')
            .toJSON(),

        new SlashCommandBuilder()
            .setName('ssu')
            .setDescription('Announce an SSU session')
            .addStringOption(option =>
                option.setName('game-link')
                    .setDescription('Link to the game')
                    .setRequired(true)
            )
            .toJSON(),

        new SlashCommandBuilder()
            .setName('server-hop')
            .setDescription('Announce a server switch')
            .addStringOption(option =>
                option.setName('game-link')
                    .setDescription('New server link')
                    .setRequired(true)
            )
            .toJSON(),

        new SlashCommandBuilder()
            .setName('ssd')
            .setDescription('Shut down the current session')
            .toJSON()
    ];

    try {
        const rest = new REST({ version: '10' }).setToken(TOKEN);
        await rest.put(
            Routes.applicationGuildCommands(client.user.id, GUILD_ID),
            { body: commands }
        );
        console.log('Slash commands registered.');
    } catch (err) {
        console.error('Slash registration failed:', err);
        await setDowntimeStatus();
    }
});

/* ================= COMMAND HANDLER ================= */

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    try {

        if (interaction.commandName === 'help') {
            return interaction.reply({
                content:
`🛠 **Commands:**
• /help — Shows this menu
• /ssu — Announces an SSU (Restricted)
• /server-hop — Announces a server switch (Restricted)
• /ssd — Ends the active session (Restricted)`,
                ephemeral: true
            });
        }

        await interaction.deferReply({ ephemeral: true });

        const member = await interaction.guild.members.fetch(interaction.user.id);
        const hasRole = ALLOWED_ROLES.some(roleId =>
            member.roles.cache.has(roleId)
        );

        if (!hasRole) {
            return interaction.editReply('❌ You do not have permission to use this command.');
        }

        const channel = await interaction.guild.channels.fetch(ANNOUNCE_CHANNEL_ID);
        if (!channel) {
            return interaction.editReply('❌ Announcement channel not found.');
        }

        /* ===== SSU START ===== */

        if (interaction.commandName === 'ssu') {

            const gameLink = interaction.options.getString('game-link');

            if (!gameLink || !gameLink.startsWith('https://')) {
                return interaction.editReply('❌ Invalid link. Must start with https://');
            }

            const button = new ButtonBuilder()
                .setLabel('Join Server')
                .setStyle(ButtonStyle.Link)
                .setURL(gameLink);

            const row = new ActionRowBuilder().addComponents(button);

            const embed = new EmbedBuilder()
                .setColor(0xff0000)
                .setDescription(
                    `❗ A SSU is being hosted by ${interaction.user}!\n\n` +
                    `Please join the labs using this link: ${gameLink}! 🔔`
                )
                .setTimestamp();

            await channel.send({
                content: '@everyone',
                embeds: [embed],
                components: [row]
            });

            // Start session timer
            sessionStartTime = Date.now();

            if (sessionInterval) clearInterval(sessionInterval);

            await updateSessionStatus();
            sessionInterval = setInterval(updateSessionStatus, 15000);

            return interaction.editReply('✅ SSU started and session timer activated.');
        }

        /* ===== SERVER HOP ===== */

        if (interaction.commandName === 'server-hop') {

            const gameLink = interaction.options.getString('game-link');

            if (!gameLink || !gameLink.startsWith('https://')) {
                return interaction.editReply('❌ Invalid link. Must start with https://');
            }

            const button = new ButtonBuilder()
                .setLabel('Join Server')
                .setStyle(ButtonStyle.Link)
                .setURL(gameLink);

            const row = new ActionRowBuilder().addComponents(button);

            const embed = new EmbedBuilder()
                .setColor(0xff9900)
                .setDescription(
                    `❗ ${interaction.user} has switched servers!\n\n` +
                    `Join at: ${gameLink}! 🔔`
                )
                .setTimestamp();

            await channel.send({
                content: '@everyone',
                embeds: [embed],
                components: [row]
            });

            return interaction.editReply('✅ Server hop announced.');
        }

        /* ===== SSD END ===== */

        if (interaction.commandName === 'ssd') {

            await channel.send('The session has shutdown.');

            // Stop timer
            if (sessionInterval) {
                clearInterval(sessionInterval);
                sessionInterval = null;
            }

            sessionStartTime = null;

            await setNormalStatus();

            return interaction.editReply('✅ Session ended and timer stopped.');
        }

    } catch (err) {
        console.error('Command error:', err);

        if (botReady) {
            try { await setDowntimeStatus(); } catch {}
        }

        if (!interaction.replied) {
            await interaction.reply({
                content: '❌ Something went wrong.',
                ephemeral: true
            }).catch(() => {});
        }
    }
});

/* ================= GLOBAL ERROR SAFETY ================= */

process.on('unhandledRejection', async (err) => {
    console.error('Unhandled rejection:', err);
    if (botReady) {
        try { await setDowntimeStatus(); } catch {}
    }
});

process.on('uncaughtException', async (err) => {
    console.error('Uncaught exception:', err);
    if (botReady) {
        try { await setDowntimeStatus(); } catch {}
    }
});

/* ================= LOGIN ================= */

client.login(TOKEN).catch(err => {
    console.error('Login failed:', err);
});
