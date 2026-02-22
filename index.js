const {
  Client,
  GatewayIntentBits,
  Partials,
  SlashCommandBuilder,
  REST,
  Routes,
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  ActivityType
} = require("discord.js");

const fs = require("fs");
const path = require("path");

/* ================= CONFIG ================= */

const TOKEN = process.env.TOKEN;
const GUILD_ID = "1394380681341173810";

const SHIFT_ROLE = "1475191266084917298";
const LOG_VIEW_ROLE = "1395209235389743114";
const WL_ROLES = ["1410771734700888064", "1395231118537523220"];
const MAINT_USER = "1166915839992270930";

const DATA_FILE = path.join(__dirname, "database.json");

/* ================= CLIENT ================= */

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates
  ],
  partials: [Partials.Channel]
});

/* ================= DATABASE ================= */

let db = {
  weekly: {},
  grand: {},
  activeShifts: {},
  schedules: [],
  logs: [],
  maintenance: false
};

function loadDB() {
  if (fs.existsSync(DATA_FILE)) {
    db = JSON.parse(fs.readFileSync(DATA_FILE));
  } else {
    saveDB();
  }
}

function saveDB() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}

/* ================= TIME HELPERS ================= */

function toUTC(time, tz) {
  const [h, m] = time.split(":").map(Number);
  const now = new Date();
  const d = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    h,
    m,
    0
  ));
  if (tz === "EST") d.setUTCHours(d.getUTCHours() + 5);
  if (tz === "PST") d.setUTCHours(d.getUTCHours() + 8);
  return d.getTime();
}

function formatESTPST(timestamp) {
  const est = new Date(timestamp - 5 * 3600000);
  const pst = new Date(timestamp - 8 * 3600000);

  const f = (d) =>
    `${String(d.getUTCHours()).padStart(2, "0")}:${String(
      d.getUTCMinutes()
    ).padStart(2, "0")}`;

  return `${f(est)} EST / ${f(pst)} PST`;
}

function secondsToHMS(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${h}h ${m}m ${s}s`;
}

/* ================= ACTIVITY ================= */

function startShift(userId) {
  db.activeShifts[userId] = Date.now();
  saveDB();
}

function endShift(userId) {
  if (!db.activeShifts[userId]) return 0;

  const seconds = Math.floor(
    (Date.now() - db.activeShifts[userId]) / 1000
  );

  db.weekly[userId] = (db.weekly[userId] || 0) + seconds;
  db.grand[userId] = (db.grand[userId] || 0) + seconds;

  delete db.activeShifts[userId];
  saveDB();
  return seconds;
}

function weeklyResetCheck() {
  const now = new Date();
  if (now.getDay() === 6 && now.getHours() === 0 && now.getMinutes() === 0) {
    db.weekly = {};
    saveDB();
  }
}

setInterval(weeklyResetCheck, 60000);

/* ================= STATUS ================= */

async function setNormal() {
  if (db.maintenance) return;
  client.user.setPresence({
    status: "idle",
    activities: [{ name: "Session System", type: ActivityType.Playing }]
  });
}

async function setMaintenance() {
  client.user.setPresence({
    status: "dnd",
    activities: [{ name: "📕 Maintenance Active", type: ActivityType.Playing }]
  });
}

/* ================= READY ================= */

client.once("ready", async () => {
  loadDB();
  await setNormal();
  console.log("Bot Ready");
});

/* ================= COMMAND HANDLER ================= */

client.on("interactionCreate", async (i) => {
  if (!i.isChatInputCommand()) return;

  if (db.maintenance && i.commandName !== "maintenance")
    return i.reply({ content: "⚠ Maintenance Mode", ephemeral: true });

  const member = await i.guild.members.fetch(i.user.id);

  /* ========= MAINTENANCE ========= */
  if (i.commandName === "maintenance") {
    if (i.user.id !== MAINT_USER)
      return i.reply({ content: "No permission.", ephemeral: true });

    db.maintenance = !db.maintenance;
    saveDB();

    if (db.maintenance) await setMaintenance();
    else await setNormal();

    return i.reply({ content: `Maintenance: ${db.maintenance}` });
  }

  /* ========= SSU ========= */
  if (i.commandName === "ssu") {
    if (!WL_ROLES.some(r => member.roles.cache.has(r)))
      return i.reply({ content: "No permission.", ephemeral: true });

    await member.roles.add(SHIFT_ROLE);
    startShift(member.id);
    return i.reply("Session Started.");
  }

  /* ========= SSD ========= */
  if (i.commandName === "ssd") {
    if (!WL_ROLES.some(r => member.roles.cache.has(r)))
      return i.reply({ content: "No permission.", ephemeral: true });

    const seconds = endShift(member.id);
    await member.roles.remove(SHIFT_ROLE);

    const role = i.guild.roles.cache.get(SHIFT_ROLE);

    await i.reply("The session has shutdown.");
    if (role) await i.channel.send(`<@&${SHIFT_ROLE}> Session Ended`);

    return;
  }

  /* ========= ACTIVITY VIEW ========= */
  if (i.commandName === "activity-view") {
    const sorted = Object.entries(db.weekly)
      .sort((a, b) => b[1] - a[1]);

    let text = sorted.map(
      ([id, sec], index) =>
        `${index + 1}. <@${id}> - ${secondsToHMS(sec)}`
    ).join("\n");

    if (!text) text = "No data.";

    return i.reply(text);
  }

  /* ========= GRAND VIEW ========= */
  if (i.commandName === "view-activity-grand") {
    const sorted = Object.entries(db.grand)
      .sort((a, b) => b[1] - a[1]);

    let desc = sorted.map(
      ([id, sec], index) =>
        `${index + 1}. <@${id}> - ${secondsToHMS(sec)}`
    ).join("\n");

    if (!desc) desc = "No data.";

    const embed = new EmbedBuilder()
      .setTitle("Grand Activity Leaderboard")
      .setColor(0x00ff99)
      .setDescription(desc);

    return i.reply({ embeds: [embed] });
  }

  /* ========= DELETE ACTIVITY ========= */
  if (i.commandName === "del-activity") {
    if (!WL_ROLES.some(r => member.roles.cache.has(r)))
      return i.reply({ content: "No permission.", ephemeral: true });

    const user = i.options.getUser("user");
    db.weekly[user.id] = 0;
    db.grand[user.id] = 0;
    saveDB();
    return i.reply("Activity deleted.");
  }

  /* ========= LOGS ========= */
  if (i.commandName === "logs") {
    if (!member.roles.cache.has(LOG_VIEW_ROLE))
      return i.reply({ content: "No permission.", ephemeral: true });

    const recent = db.logs.slice(-20).map(
      l => `${l.user} used ${l.command}`
    ).join("\n");

    return i.reply(recent || "No logs.");
  }

  /* ========= CODE RED / ORANGE ========= */
  if (i.commandName === "code-red" || i.commandName === "code-orange") {
    const location = i.options.getString("location");
    const vc = member.voice.channel;

    if (!vc)
      return i.reply({ content: "You must be in VC.", ephemeral: true });

    const textChannel = vc.parent.children.cache
      .find(c => c.isTextBased());

    if (textChannel) {
      await textChannel.send(
        `Code ${i.commandName === "code-red" ? "red" : "orange"} called by ${i.user.username} at ${location}!`
      );
    }

    return i.reply({ content: "Sent.", ephemeral: true });
  }

  /* ========= SCHEDULE ========= */
  if (i.commandName === "schedule") {
    if (!WL_ROLES.some(r => member.roles.cache.has(r)))
      return i.reply({ content: "No permission.", ephemeral: true });

    const type = i.options.getString("type");
    const tz = i.options.getString("timezone");
    const time = i.options.getString("time");
    const endTime = i.options.getString("end-time");

    const id = Date.now().toString();

    const start = toUTC(time, tz);
    let end = null;

    if (type === "range") {
      end = toUTC(endTime, tz);
    }

    db.schedules.push({
      id,
      host: i.user.id,
      type,
      start,
      end,
      signups: []
    });

    saveDB();

    const embed = new EmbedBuilder()
      .setTitle("Scheduled Session")
      .setDescription(
        type === "exact"
          ? `Starts at ${formatESTPST(start)}`
          : `Range: ${formatESTPST(start)} - ${formatESTPST(end)}`
      )
      .setFooter({ text: `ID: ${id} | Signups: 0` });

    const btn = new ButtonBuilder()
      .setCustomId("signup_" + id)
      .setLabel("Sign Up")
      .setStyle(ButtonStyle.Success);

    const row = new ActionRowBuilder().addComponents(btn);

    return i.reply({ embeds: [embed], components: [row] });
  }

});

/* ================= BUTTON HANDLER ================= */

client.on("interactionCreate", async (i) => {
  if (!i.isButton()) return;

  if (i.customId.startsWith("signup_")) {
    const id = i.customId.split("_")[1];
    const sched = db.schedules.find(s => s.id === id);
    if (!sched) return i.reply({ content: "Not found.", ephemeral: true });

    if (!sched.signups.includes(i.user.id)) {
      sched.signups.push(i.user.id);
      saveDB();
    }

    return i.reply({ content: "Signed up.", ephemeral: true });
  }
});

/* ================= LOGIN ================= */

client.login(TOKEN);
