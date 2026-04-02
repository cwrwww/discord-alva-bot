require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const cron = require('node-cron');
const https = require('https');

// ── Config ────────────────────────────────────────────────────────────────────
const DISCORD_TOKEN  = process.env.DISCORD_TOKEN;
const GM_CHANNEL_ID  = process.env.GM_CHANNEL_ID;
const ALVA_API_KEY   = process.env.ALVA_API_KEY;
const ALVA_ENDPOINT  = process.env.ALVA_ENDPOINT || 'https://api-llm.prd.alva.ai';
// Default: 8:00 AM UTC daily. Override with GM_CRON env var.
// Examples: '0 0 * * *' = midnight UTC, '0 1 * * *' = 9am CST
const GM_CRON        = process.env.GM_CRON || '0 8 * * *';

if (!DISCORD_TOKEN || !GM_CHANNEL_ID || !ALVA_API_KEY) {
  console.error('Missing required env vars: DISCORD_TOKEN, GM_CHANNEL_ID, ALVA_API_KEY');
  process.exit(1);
}

// ── Alva market vibe script ───────────────────────────────────────────────────
// Runs on Alva Cloud: scans crypto + US stocks + indices + news,
// picks the single hottest signal, generates a punchy one-liner via LLM.
const ALVA_SCRIPT = `(async () => {
  const { getCryptoByMetricTimeRange } = require("@arrays/crypto/metrics-time-range-screener:v1.0.0");
  const { getStockKline }              = require("@arrays/data/stock/spot/ohlcv:v1.0.0");
  const { getSerperSearch }            = require("@arrays/data/search/serper-search:v1.0.0");
  const adk = require("@alva/adk");

  const nowMs           = Date.now();
  const nowSec          = Math.floor(nowMs / 1000);
  const threeDaysAgoSec = nowSec - 3 * 86400;  // 3 days to ensure we have prev + curr bar
  const twoDaysAgoMs    = nowMs  - 172800000;  // for crypto screener (ms)

  // 1. Crypto top 5 movers
  const cryptoScreen = getCryptoByMetricTimeRange({ start_time: twoDaysAgoMs, end_time: nowMs, metric: "PRICE_CHANGE_1D" });
  const cryptoMovers = cryptoScreen.response.data
    .slice().sort((a, b) => Math.abs(b.value) - Math.abs(a.value)).slice(0, 5)
    .map(d => ({ market: "crypto", ticker: d.ticker.replace("USDT",""), change: Number(d.value.toFixed(2)) }));

  // 2. Top US mega-cap movers
  const usTickers = ["AAPL","MSFT","NVDA","AMZN","META","TSLA","GOOGL","JPM","LLY","AVGO"];
  const usMovers = [];
  // close-to-close change = (today_close - yesterday_close) / yesterday_close
  // This matches what users see in Yahoo Finance / Google Finance
  const stockChange = (bars) => {
    if (!bars || bars.length < 2) return null;
    const prev = bars[bars.length - 2]; // second-to-last (oldest-first order)
    const curr = bars[bars.length - 1]; // last = most recent
    return Number(((curr.close - prev.close) / prev.close * 100).toFixed(2));
  };

  for (const ticker of usTickers) {
    try {
      const bars = getStockKline({ ticker, start_time: threeDaysAgoSec, end_time: nowSec, interval: "1d" }).response.data;
      const change = stockChange(bars);
      if (change !== null) usMovers.push({ market: "stock", ticker, change });
    } catch (_) {}
  }
  usMovers.sort((a, b) => Math.abs(b.change) - Math.abs(a.change));

  // 3. Major indices
  const indices = {};
  for (const sym of ["SPY","QQQ","DIA"]) {
    try {
      const bars = getStockKline({ ticker: sym, start_time: threeDaysAgoSec, end_time: nowSec, interval: "1d" }).response.data;
      const change = stockChange(bars);
      if (change !== null) indices[sym] = { change };
    } catch (_) {}
  }

  // 4. Hot news across both markets
  const news = getSerperSearch({ q: "crypto stock market today", type: "news", tbs: "qdr:d", num: 6 });
  const headlines = (news.response.data || []).slice(0, 6).map(n => n.title);

  // 5. ADK picks the single hottest signal across crypto + stocks
  const result = await adk.agent({
    system: \`You are a witty market commentator for a finance Discord covering both crypto and US stocks.
Given top movers and headlines, pick the ONE most explosive signal and write a punchy one-liner (max 20 words).
Output JSON only, no markdown: {"signal":"<ticker or short topic>","market":"crypto|stock|macro","vibe":"<one sentence>"}\`,
    prompt: JSON.stringify({ cryptoTopMovers: cryptoMovers.slice(0,3), usStockTopMovers: usMovers.slice(0,3), indices, headlines }),
    tools: [],
    maxTurns: 1,
  });

  let signal = "Markets", market = "macro", vibe = result.content.trim();
  try {
    const p = JSON.parse(result.content.trim());
    signal = p.signal; market = p.market; vibe = p.vibe;
  } catch (_) {}

  console.log(JSON.stringify({ signal, market, vibe, cryptoMovers: cryptoMovers.slice(0,5), usMovers: usMovers.slice(0,5), indices }));
})();`;

// ── Alva API call ─────────────────────────────────────────────────────────────
function fetchMarketVibe() {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ code: ALVA_SCRIPT });
    const url  = new URL(`${ALVA_ENDPOINT}/api/v1/run`);

    const req = https.request(
      {
        hostname: url.hostname,
        path:     url.pathname,
        method:   'POST',
        headers: {
          'Content-Type':    'application/json',
          'X-Alva-Api-Key':  ALVA_API_KEY,
          'Content-Length':  Buffer.byteLength(body),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(raw);
            if (parsed.error) return reject(new Error(parsed.error));
            const market = JSON.parse(parsed.logs.trim());
            resolve(market);
          } catch (e) {
            reject(new Error(`Unexpected Alva response: ${raw.slice(0, 200)}`));
          }
        });
      },
    );

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Format GM message ─────────────────────────────────────────────────────────
function formatGM(data) {
  const emoji = (n) => n >= 0 ? '📈' : '📉';
  const fmt   = (n) => (n >= 0 ? `+${n.toFixed(2)}` : n.toFixed(2)) + '%';

  const moverTag = (m) => `${emoji(m.change)} **${m.ticker}** ${fmt(m.change)}`;

  const cryptoLine = (data.cryptoMovers || []).slice(0, 5).map(moverTag).join('  ');
  const stockLine  = (data.usMovers     || []).slice(0, 5).map(moverTag).join('  ');

  const idx = data.indices || {};
  const idxLine = Object.entries(idx)
    .map(([sym, v]) => `${emoji(v.change)} **${sym}** ${fmt(v.change)}`)
    .join('  ');

  const marketLabel = data.market === 'crypto' ? '🔗 Crypto'
                    : data.market === 'stock'  ? '📊 Stock'
                    : '🌐 Macro';

  return [
    `GM Alva fam 🌅 Today's market vibe: ${data.vibe}`,
    '',
    `🔥 **Today's hottest signal (${marketLabel}):** ${data.signal}`,
    '',
    `**Indices:** ${idxLine}`,
    `**US Stocks:** ${stockLine}`,
    `**Crypto:** ${cryptoLine}`,
    '',
    "What's your strategy today?",
  ].join('\n');
}

// ── Post GM to channel ────────────────────────────────────────────────────────
async function postGM(client) {
  const channel = client.channels.cache.get(GM_CHANNEL_ID);
  if (!channel) {
    console.error(`[GM] Channel ${GM_CHANNEL_ID} not found or bot has no access`);
    return;
  }

  try {
    console.log('[GM] Fetching market vibe from Alva...');
    const market = await fetchMarketVibe();
    const msg    = formatGM(market);
    await channel.send(msg);
    console.log(`[GM] Posted at ${new Date().toISOString()}`);
  } catch (err) {
    console.error('[GM] Failed:', err.message);
  }
}

// ── Discord client ────────────────────────────────────────────────────────────
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.once('clientReady', () => {
  console.log(`[Bot] Logged in as ${client.user.tag}`);
  console.log(`[Bot] GM scheduled: "${GM_CRON}" (UTC)`);

  cron.schedule(GM_CRON, () => postGM(client), { timezone: 'UTC' });
});

// Slash command: /gm — manual trigger for testing
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'gm') return;

  await interaction.deferReply();
  try {
    const market = await fetchMarketVibe();
    await interaction.editReply(formatGM(market));
  } catch (err) {
    await interaction.editReply(`Failed to fetch market data: ${err.message}`);
  }
});

client.login(DISCORD_TOKEN);
