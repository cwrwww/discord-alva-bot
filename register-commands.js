/**
 * Run this ONCE to register the /gm slash command with Discord.
 * Usage: node register-commands.js
 */
require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const token      = process.env.DISCORD_TOKEN;
const clientId   = process.env.DISCORD_CLIENT_ID;
const guildId    = process.env.DISCORD_GUILD_ID; // optional: faster registration in a specific server

if (!token || !clientId) {
  console.error('Missing DISCORD_TOKEN or DISCORD_CLIENT_ID in .env');
  process.exit(1);
}

const commands = [
  new SlashCommandBuilder()
    .setName('gm')
    .setDescription('Get today\'s market vibe from Alva 🌅')
    .toJSON(),
];

const rest = new REST({ version: '10' }).setToken(token);

(async () => {
  try {
    console.log('Registering /gm slash command...');

    if (guildId) {
      // Guild-level: instant, only in this server
      await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
      console.log(`Registered in guild ${guildId}`);
    } else {
      // Global: takes up to 1 hour to propagate
      await rest.put(Routes.applicationCommands(clientId), { body: commands });
      console.log('Registered globally (may take up to 1 hour to appear)');
    }
  } catch (err) {
    console.error(err);
  }
})();
