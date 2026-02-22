const { Client, GatewayIntentBits } = require('discord.js');
const cron = require('node-cron');

const TOKEN = 'YOUR_BOT_TOKEN_HERE';
const CHANNEL_ID = '1395225224081051668';

const client = new Client({
    intents: [GatewayIntentBits.Guilds]
});

client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag}`);

    // Runs every day at 4:00 PM America/New_York (EST/EDT safe)
    cron.schedule('0 16 * * *', async () => {
        try {
            const channel = await client.channels.fetch(CHANNEL_ID);
            if (!channel) return;

            await channel.send('https://tenor.com/view/bart-simpson-bart-stare-simpsons-jgmm-capcut-spin-filter-gif-11221581157512010324');
            console.log('Daily Bart stare deployed.');
        } catch (err) {
            console.error('Failed to send daily gif:', err);
        }
    }, {
        timezone: 'America/New_York'
    });
});

client.login(TOKEN);
