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
const SSU_CHANNEL_ID = '1452777822618648678';

const ALLOWED_ROLES = [
    '1410771734700888064',
    '1395231118537523220'
];

const client = new Client({
    intents: [GatewayIntentBits.Guilds]
});

async function safeSetStatus(statusText = 'Created by ventmaster9867 ✨', status = 'idle') {
    try {
        await client.user.setPresence({
            status: status,
            activities: [{ name: statusText, type: ActivityType.Playing }]
        });
        console.log('Status set:', statusText);
    } catch (err) {
        console.error('Failed to set status:', err);
    }
}

client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}`);
    await safeSetStatus();

    const commands = [
        new SlashCommandBuilder()
            .setName('help')
            .setDescription('Shows the command menu')
            .toJSON(),

        new SlashCommandBuilder()
            .setName('ssu')
            .setDescription('Announce an SSU session')
            .addStringOption(option =>
                option
                    .setName('game-link')
                    .setDescription('Link to the game')
                    .setRequired(true)
            )
            .toJSON(),

        new SlashCommandBuilder()
            .setName('server-hop')
            .setDescription('Announce a server switch')
            .addStringOption(option =>
                option
                    .setName('game-link')
                    .setDescription('New server link')
                    .setRequired(true)
            )
            .toJSON()
    ];

    const rest = new REST({ version: '10' }).setToken(TOKEN);

    try {
        await rest.put(
            Routes.applicationGuildCommands(client.user.id, GUILD_ID),
            { body: commands }
        );
        console.log('Slash commands registered.');
    } catch (err) {
        console.error('Slash command registration failed:', err);
        await safeSetStatus('📕 Experiencing Downtime!', 'dnd');
    }
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    const member = interaction.member;
    const hasRole = ALLOWED_ROLES.some(roleId =>
        member.roles.cache.has(roleId)
    );

    if (interaction.commandName === 'help') {
        const helpText = [
            '🛠 **Commands:**',
            '• `/help` — Shows this menu',
            '• `/ssu` — Announces an SSU (Restricted)',
            '• `/server-hop` — Announces a server switch (Restricted)'
        ].join('\n');

        return interaction.reply({ content: helpText, ephemeral: true });
    }

    if (!hasRole) {
        return interaction.reply({
            content: '❌ You do not have permission to use this command.',
            ephemeral: true
        });
    }

    try {
        const gameLink = interaction.options.getString('game-link');
        const targetChannel = await client.channels.fetch(SSU_CHANNEL_ID);

        if (!targetChannel) {
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

        await targetChannel.send({
            content: '@everyone',
            embeds: [embed],
            components: [row]
        });

        await interaction.reply({
            content: '✅ Announcement sent.',
            ephemeral: true
        });

    } catch (err) {
        console.error('Command failed:', err);
        await safeSetStatus('📕 Experiencing Downtime!', 'dnd');

        if (!interaction.replied) {
            await interaction.reply({
                content: '❌ Something went wrong.',
                ephemeral: true
            });
        }
    }
});

process.on('unhandledRejection', async (err) => {
    console.error('Unhandled promise rejection:', err);
    if (client.user) await safeSetStatus('📕 Experiencing Downtime!', 'dnd');
});

client.login(TOKEN).catch(async err => {
    console.error('Failed to login:', err);
    if (client.user) await safeSetStatus('📕 Experiencing Downtime!', 'dnd');
});
