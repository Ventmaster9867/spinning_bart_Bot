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

/* ================= READY EVENT ================= */

client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}`);
    botReady = true;

    try {
        await setNormalStatus();
    } catch (err) {
        console.error('Status set failed on startup:', err);
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
        console.error('Slash command registration failed:', err);
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
• /server-hop — Announces a server switch (Restricted)`,
                ephemeral: true
            });
        }

        // Proper full member fetch (prevents partial crash)
        const member = await interaction.guild.members.fetch(interaction.user.id);

        const hasRole = ALLOWED_ROLES.some(roleId =>
            member.roles.cache.has(roleId)
        );

        if (!hasRole) {
            return interaction.reply({
                content: '❌ You do not have permission to use this command.',
                ephemeral: true
            });
        }

        const gameLink = interaction.options.getString('game-link');

        const channel = await client.channels.fetch(ANNOUNCE_CHANNEL_ID);
        if (!channel) {
            return interaction.reply({
                content: '❌ Announcement channel not found.',
                ephemeral: true
            });
        }

        const button = new ButtonBuilder()
            .setLabel('Join Server')
            .setStyle(ButtonStyle.Link)
            .setURL(gameLink);

        const row = new ActionRowBuilder().addComponents(button);

        let embed;

        if (interaction.commandName === 'ssu') {
            embed = new EmbedBuilder()
                .setColor(0xff0000)
                .setDescription(
                    `❗ A SSU is being hosted by ${interaction.user}!\n\n` +
                    `Please join the labs using this link: ${gameLink}! 🔔`
                )
                .setTimestamp();
        }

        if (interaction.commandName === 'server-hop') {
            embed = new EmbedBuilder()
                .setColor(0xff9900)
                .setDescription(
                    `❗ ${interaction.user} has switched servers!\n\n` +
                    `Join at: ${gameLink}! 🔔`
                )
                .setTimestamp();
        }

        await channel.send({
            content: '@everyone',
            embeds: [embed],
            components: [row]
        });

        await interaction.reply({
            content: '✅ Announcement sent.',
            ephemeral: true
        });

    } catch (err) {
        console.error('Command error:', err);

        if (botReady) {
            try {
                await setDowntimeStatus();
            } catch (statusErr) {
                console.error('Downtime status failed:', statusErr);
            }
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
        try {
            await setDowntimeStatus();
        } catch {}
    }
});

process.on('uncaughtException', async (err) => {
    console.error('Uncaught exception:', err);
    if (botReady) {
        try {
            await setDowntimeStatus();
        } catch {}
    }
});

/* ================= LOGIN ================= */

client.login(TOKEN).catch(err => {
    console.error('Login failed:', err);
});
