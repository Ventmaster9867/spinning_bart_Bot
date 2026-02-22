const { Client, GatewayIntentBits, ActivityType, REST, Routes, SlashCommandBuilder } = require('discord.js');

const TOKEN = process.env.TOKEN;
const GUILD_ID = '1394380681341173810';

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds
    ]
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
            .setDescription('Shows the command menu and info')
            .toJSON()
    ];

    const rest = new REST({ version: '10' }).setToken(TOKEN);

    try {
        console.log('Registering slash commands...');
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

    if (interaction.commandName === 'help') {
        const helpText = [
            '🛠 **Commands:**',
            '• `/help` — Shows this menu'
        ].join('\n');

        try {
            await interaction.reply({ content: helpText, ephemeral: true });
        } catch (err) {
            console.error('Help command failed:', err);
            await safeSetStatus('📕 Experiencing Downtime!', 'dnd');
        }
    }
});

process.on('unhandledRejection', async (err) => {
    console.error('Unhandled promise rejection:', err);
    if (client.user) await safeSetStatus('📕 Experiencing Downtime!', 'dnd');
});

client.login(TOKEN).catch(async err => {
    console.error('Failed to login. Check TOKEN variable:', err);
    if (client.user) await safeSetStatus('📕 Experiencing Downtime!', 'dnd');
});
