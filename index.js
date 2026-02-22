const { REST, Routes, SlashCommandBuilder } = require('discord.js');

// -----------------------------
// Slash Command Registration
// -----------------------------
const commands = [
    new SlashCommandBuilder()
        .setName('bart-spawn')
        .setDescription('Spawns 3 Bart stare GIFs in this channel')
        .toJSON()
];

const rest = new REST({ version: '10' }).setToken(TOKEN);

// Replace with your server ID
const GUILD_ID = '1394380681341173810';

(async () => {
    try {
        console.log('Registering slash commands...');
        await rest.put(
            Routes.applicationGuildCommands(client.user.id, GUILD_ID),
            { body: commands }
        );
        console.log('Slash commands registered.');
    } catch (err) {
        console.error(err);
    }
})();

// -----------------------------
// Cooldown Map
// -----------------------------
const cooldowns = new Map();

// -----------------------------
// Interaction Listener
// -----------------------------
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'bart-spawn') {
        const userId = interaction.user.id;
        const now = Date.now();
        const cooldownAmount = 60 * 1000; // 1 minute in ms

        if (cooldowns.has(userId) && now - cooldowns.get(userId) < cooldownAmount) {
            return interaction.reply({ content: '⏱ You need to wait 1 minute before using this again.', ephemeral: true });
        }

        cooldowns.set(userId, now);

        const gifURL = 'https://tenor.com/view/bart-simpson-bart-stare-simpsons-jgmm-capcut-spin-filter-gif-11221581157512010324';

        try {
            for (let i = 0; i < 3; i++) {
                await interaction.channel.send(gifURL);
            }
            await interaction.reply({ content: '🎉 Bart has been spawned 3 times!', ephemeral: true });
        } catch (err) {
            console.error('Failed to send Bart GIFs:', err);
            await interaction.reply({ content: '❌ Something went wrong.', ephemeral: true });
        }
    }
});
