const { Client, GatewayIntentBits, ActivityType, REST, Routes, SlashCommandBuilder } = require('discord.js');
const cron = require('node-cron');

const TOKEN = process.env.TOKEN;
const CHANNEL_ID = '1395225224081051668';
const GUILD_ID = '1394380681341173810';

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

const cooldowns = new Map(); // /bart-spawn per-user cooldown
let mentionCooldown = { count: 0, timestamp: Date.now() }; // global 5 per minute
const MENTION_RESPONSES = [
    "What do you want?",
    "Hi",
    "You called",
    "Stop talking to me..."
];

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

// --- Bot ready ---
client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}`);
    await safeSetStatus();

    // --- Slash commands registered safely after login ---
    const commands = [
        new SlashCommandBuilder()
            .setName('bart-spawn')
            .setDescription('Spawns 3 Bart stare GIFs in this channel')
            .toJSON(),
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

    // --- Daily 4PM EST Bart GIF ---
    cron.schedule('0 16 * * *', async () => {
        try {
            const channel = await client.channels.fetch(CHANNEL_ID);
            if (!channel) return console.warn('Daily GIF channel not found:', CHANNEL_ID);
            await channel.send('https://tenor.com/view/bart-simpson-bart-stare-simpsons-jgmm-capcut-spin-filter-gif-11221581157512010324');
            console.log('Daily Bart stare sent.');
        } catch (err) {
            console.error('Failed to send daily GIF:', err);
            await safeSetStatus('📕 Experiencing Downtime!', 'dnd');
        }
    }, { timezone: 'America/New_York' });
});

// --- Slash command handler ---
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    const userId = interaction.user.id;
    const now = Date.now();

    if (interaction.commandName === 'bart-spawn') {
        const cooldownAmount = 60 * 1000;
        if (cooldowns.has(userId) && now - cooldowns.get(userId) < cooldownAmount) {
            return interaction.reply({ content: '⏱ You need to wait 1 minute before using this again.', ephemeral: true });
        }

        cooldowns.set(userId, now);
        const gifURL = 'https://tenor.com/view/bart-simpson-bart-stare-simpsons-jgmm-capcut-spin-filter-gif-11221581157512010324';

        try {
            for (let i = 0; i < 3; i++) await interaction.channel.send(gifURL);
            await interaction.reply({ content: '🎉 Bart has been spawned 3 times!', ephemeral: true });
        } catch (err) {
            console.error('Failed to send Bart GIFs:', err);
            await safeSetStatus('📕 Experiencing Downtime!', 'dnd');
            await interaction.reply({ content: '❌ Something went wrong.', ephemeral: true });
        }
    }

    if (interaction.commandName === 'help') {
        const helpText = `
📌 **Daily Bart Info:**  
Every day at **4:00 PM EST**, the bot automatically sends a Bart stare GIF in the designated channel.

🛠 **Commands:**
• /bart-spawn → Sends 3 Bart stare GIFs in this channel (1-minute cooldown per user)  
• /help → Shows this menu
        `;
        await interaction.reply({ content: helpText, ephemeral: true });
    }
});

// --- Mention reply handler ---
client.on('messageCreate', async message => {
    if (message.author.bot) return;
    if (!message.mentions.has(client.user)) return;

    if (Date.now() - mentionCooldown.timestamp > 60 * 1000) {
        mentionCooldown.count = 0;
        mentionCooldown.timestamp = Date.now();
    }

    if (mentionCooldown.count >= 5) return;
    mentionCooldown.count++;

    try {
        const reply = MENTION_RESPONSES[Math.floor(Math.random() * MENTION_RESPONSES.length)];
        await message.channel.send(reply);
    } catch (err) {
        console.error('Failed to send mention reply:', err);
        await safeSetStatus('📕 Experiencing Downtime!', 'dnd');
    }
});

// --- Catch all unhandled errors ---
process.on('unhandledRejection', async err => {
    console.error('Unhandled promise rejection:', err);
    if (client.user) await safeSetStatus('📕 Experiencing Downtime!', 'dnd');
});

client.login(TOKEN).catch(async err => {
    console.error('Failed to login. Check TOKEN variable:', err);
    if (client.user) await safeSetStatus('📕 Experiencing Downtime!', 'dnd');
});
