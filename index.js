const { Client, GatewayIntentBits, ActivityType } = require('discord.js');
const cron = require('node-cron');

const TOKEN = process.env.TOKEN;
const CHANNEL_ID = '1395225224081051668';

const client = new Client({
    intents: [GatewayIntentBits.Guilds]
});

client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}`);

    // Set bot status to idle and activity text
    client.user.setPresence({
        status: 'idle', // 'online', 'idle', 'dnd', 'invisible'
        activities: [{
            name: 'Created by ventmaster9867 ✨',
            type: ActivityType.Playing // You can also use 'Watching', 'Listening', 'Competing'
        }]
    });

    // Schedule daily Bart GIF at 4:00 PM EST
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
