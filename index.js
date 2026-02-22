const {
    Client,
    GatewayIntentBits,
    ActivityType,
    REST,
    Routes,
    SlashCommandBuilder
} = require('discord.js');
const cron = require('node-cron');

// ─── Config ───────────────────────────────────────────────────────────────────
const TOKEN      = process.env.TOKEN;
const CHANNEL_ID = '1395225224081051668';
const GUILD_ID   = '1394380681341173810';
const GIF_URL    = 'https://tenor.com/view/bart-simpson-bart-stare-simpsons-jgmm-capcut-spin-filter-gif-11221581157512010324';

const MENTION_RESPONSES = [
    'What do you want?',
    'Hi',
    'You called',
    'Stop talking to me...'
];

// ─── Client ───────────────────────────────────────────────────────────────────
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// ─── Cooldowns ────────────────────────────────────────────────────────────────
const spawnCooldowns = new Map();
let mentionBucket = { count: 0, resetAt: Date.now() + 60_000 };

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function setStatus(text = 'Created by ventmaster9867 ✨', status = 'idle') {
    try {
        await client.user.setPresence({
            status,
            activities: [{ name: text, type: ActivityType.Playing }]
        });
    } catch (err) {
        console.error('[Status] Failed to set presence:', err.message);
    }
}

async function registerCommands() {
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
    await rest.put(
        Routes.applicationGuildCommands(client.user.id, GUILD_ID),
        { body: commands }
    );
    console.log('[Commands] Slash commands registered.');
}

// ─── Ready ────────────────────────────────────────────────────────────────────
client.once('ready', async () => {
    console.log(`[Bot] Logged in as ${client.user.tag}`);
    await setStatus();

    try {
        await registerCommands();
    } catch (err) {
        console.error('[Commands] Registration failed:', err.message);
        await setStatus('📕 Experiencing Downtime!', 'dnd');
    }

    // Daily 4 PM EST Bart GIF
    cron.schedule('0 16 * * *', async () => {
        try {
            const channel = await client.channels.fetch(CHANNEL_ID);
            await channel.send(GIF_URL);
            console.log('[Cron] Daily Bart GIF sent.');
        } catch (err) {
            console.error('[Cron] Failed to send daily GIF:', err.message);
            await setStatus('📕 Experiencing Downtime!', 'dnd');
        }
    }, { timezone: 'America/New_York' });
});

// ─── Slash Commands ───────────────────────────────────────────────────────────
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName, user, channel } = interaction;
    const now = Date.now();

    // /bart-spawn
    if (commandName === 'bart-spawn') {
        const lastUsed = spawnCooldowns.get(user.id) ?? 0;
        if (now - lastUsed < 60_000) {
            return interaction.reply({
                content: '⏱ Wait 1 minute before using this again.',
                ephemeral: true
            });
        }

        spawnCooldowns.set(user.id, now);

        try {
            for (let i = 0; i < 3; i++) await channel.send(GIF_URL);
            await interaction.reply({ content: '🎉 Bart has been spawned 3 times!', ephemeral: true });
        } catch (err) {
            console.error('[bart-spawn] Error:', err.message);
            await setStatus('📕 Experiencing Downtime!', 'dnd');
            await interaction.reply({ content: '❌ Something went wrong.', ephemeral: true });
        }
    }

    // /help
    if (commandName === 'help') {
        await interaction.reply({
            content: [
                '📌 **Daily Bart Info:**',
                'Every day at **4:00 PM EST**, the bot sends a Bart stare GIF in the designated channel.',
                '',
                '🛠 **Commands:**',
                '• `/bart-spawn` — Sends 3 Bart stare GIFs *(1-minute cooldown per user)*',
                '• `/help` — Shows this menu'
            ].join('\n'),
            ephemeral: true
        });
    }
});

// ─── Mention Replies ──────────────────────────────────────────────────────────
client.on('messageCreate', async message => {
    if (message.author.bot) return;
    if (!message.mentions.has(client.user)) return;

    const now = Date.now();
    if (now > mentionBucket.resetAt) {
        mentionBucket = { count: 0, resetAt: now + 60_000 };
    }
    if (mentionBucket.count >= 5) return;
    mentionBucket.count++;

    try {
        const reply = MENTION_RESPONSES[Math.floor(Math.random() * MENTION_RESPONSES.length)];
        await message.channel.send(reply);
    } catch (err) {
        console.error('[Mention] Failed to reply:', err.message);
        await setStatus('📕 Experiencing Downtime!', 'dnd');
    }
});

// ─── Global Error Handling ────────────────────────────────────────────────────
process.on('unhandledRejection', async err => {
    console.error('[Process] Unhandled rejection:', err);
    if (client.user) await setStatus('📕 Experiencing Downtime!', 'dnd');
});

// ─── Login ────────────────────────────────────────────────────────────────────
client.login(TOKEN).catch(err => {
    console.error('[Login] Failed — check TOKEN env variable:', err.message);
    process.exit(1);
});
