require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, MessageFlags } = require('discord.js');
const cron = require('node-cron');
const https = require('https');

// ── Config ────────────────────────────────────────────────────────────────────
const DISCORD_TOKEN  = process.env.DISCORD_TOKEN;
const GM_CHANNEL_ID       = process.env.GM_CHANNEL_ID;
const FEATURED_CHANNEL_ID = process.env.FEATURED_CHANNEL_ID || process.env.GM_CHANNEL_ID;
const ALVA_API_KEY        = process.env.ALVA_API_KEY;
const ALVA_ENDPOINT       = process.env.ALVA_ENDPOINT || 'https://api-llm.prd.alva.ai';
// Default: 8:00 AM UTC daily. Override with GM_CRON env var.
// Examples: '0 0 * * *' = midnight UTC, '0 1 * * *' = 9am CST
const GM_CRON             = process.env.GM_CRON || '0 8 * * *';
// Featured playbook: default 9:00 AM UTC daily (1 hour after GM)
const FEATURED_CRON       = process.env.FEATURED_CRON || '0 9 * * *';

if (!DISCORD_TOKEN || !GM_CHANNEL_ID || !ALVA_API_KEY) {
  console.error('Missing required env vars: DISCORD_TOKEN, GM_CHANNEL_ID, ALVA_API_KEY');
  process.exit(1);
}

// ── Alva market vibe script ───────────────────────────────────────────────────
// Runs on Alva Cloud: scans crypto + US stocks + indices + news,
// picks the single hottest signal, generates a punchy one-liner via LLM.
const ALVA_SCRIPT = `(async () => {
  const { getCryptoKline }  = require("@arrays/crypto/ohlcv:v1.0.0");
  const { getStockKline }   = require("@arrays/data/stock/spot/ohlcv:v1.0.0");
  const { getSerperSearch } = require("@arrays/data/search/serper-search:v1.0.0");
  const adk = require("@alva/adk");

  const nowMs           = Date.now();
  const nowSec          = Math.floor(nowMs / 1000);
  const sevenDaysAgoSec = nowSec - 7 * 86400;  // 7 days to cover weekends + holidays
  const twoDaysAgoSec   = nowSec - 2 * 86400;

  // Date awareness for varied content
  const today = new Date();
  const dayOfWeek = today.getUTCDay(); // 0=Sun, 6=Sat
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
  const dateStr = today.toISOString().slice(0, 10);
  const dayName = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"][dayOfWeek];

  // 1. Crypto display data — OHLCV-based (screener data is unreliable)
  const cryptoTickers = ["BTC","ETH","SOL","BNB","XRP","DOGE","ADA","AVAX","SUI","LINK"];
  const cryptoMovers = [];
  for (const ticker of cryptoTickers) {
    try {
      const raw = getCryptoKline({ symbol: ticker, start_time: twoDaysAgoSec, end_time: nowSec, interval: "1h" });
      const bars = raw.response.data;
      if (bars && bars.length >= 2) {
        const sorted = bars.slice().sort((a, b) => a.date - b.date);
        const latest = sorted[sorted.length - 1];
        const target24h = latest.date - 86400000;
        let closest = sorted[0];
        for (const b of sorted) {
          if (Math.abs(b.date - target24h) < Math.abs(closest.date - target24h)) closest = b;
        }
        const change = Number(((latest.close - closest.close) / closest.close * 100).toFixed(2));
        cryptoMovers.push({ market: "crypto", ticker, change });
      }
    } catch (_) {}
  }
  cryptoMovers.sort((a, b) => Math.abs(b.change) - Math.abs(a.change));

  // 2. Top US mega-cap movers
  const usTickers = ["AAPL","MSFT","NVDA","AMZN","META","TSLA","GOOGL","JPM","LLY","AVGO"];
  const usMovers = [];
  // close-to-close change = (today_close - yesterday_close) / yesterday_close
  // Sort bars by timestamp to guard against any unexpected ordering from the API
  const tsField = (b) => b.timestamp || b.time || b.t || b.date || 0;
  const stockChangeFromBars = (bars) => {
    if (!bars || bars.length < 2) return { change: null, prev: null, curr: null };
    const sorted = bars.slice().sort((a, b) => tsField(a) - tsField(b));
    const prev = sorted[sorted.length - 2];
    const curr = sorted[sorted.length - 1];
    return { change: Number(((curr.close - prev.close) / prev.close * 100).toFixed(2)), prev, curr };
  };

  const stockDebug = [];
  for (const ticker of usTickers) {
    try {
      const raw = getStockKline({ ticker, start_time: sevenDaysAgoSec, end_time: nowSec, interval: "1d" });
      const bars = raw.response.data;
      const { change, prev, curr } = stockChangeFromBars(bars);
      stockDebug.push({ ticker, barCount: bars ? bars.length : 0, prev, curr, change });
      if (change !== null) usMovers.push({ market: "stock", ticker, change });
    } catch (e) { stockDebug.push({ ticker, error: e.message }); }
  }
  usMovers.sort((a, b) => Math.abs(b.change) - Math.abs(a.change));

  // 3. Major indices
  const indices = {};
  for (const sym of ["SPY","QQQ","DIA"]) {
    try {
      const raw = getStockKline({ ticker: sym, start_time: sevenDaysAgoSec, end_time: nowSec, interval: "1d" });
      const bars = raw.response.data;
      const { change, prev, curr } = stockChangeFromBars(bars);
      stockDebug.push({ ticker: sym, barCount: bars ? bars.length : 0, prev, curr, change });
      if (change !== null) indices[sym] = { change };
    } catch (e) { stockDebug.push({ ticker: sym, error: e.message }); }
  }

  // 4. Hot news across both markets
  const news = getSerperSearch({ q: "crypto stock market today", type: "news", tbs: "qdr:d", num: 6 });
  const headlines = (news.response.data || []).slice(0, 6).map(n => n.title);

  // 5. ADK picks the single hottest signal — US stocks only
  const weekendNote = isWeekend
    ? "Note: US stock markets are CLOSED today (weekend). Stock data reflects last Friday's close. Focus on macro narratives, upcoming catalysts, or news-driven angles."
    : "";

  const result = await adk.agent({
    system: \`You are a witty market commentator for a finance Discord focused on US stocks and macro.
Today is \${dateStr} (\${dayName}). \${weekendNote}
Given US stock movers, indices, and headlines, pick the ONE most interesting US stock signal and write a punchy one-liner (max 20 words).
IMPORTANT: Be creative and vary your angle — focus on different tickers, narratives, or themes each day. Don't repeat the same signal unless it's truly the biggest story.
On weekends/holidays, focus on macro narratives, sector trends, or upcoming catalysts instead of stale price data.
Output JSON only, no markdown: {"signal":"<ticker or short topic>","market":"stock|macro","vibe":"<one sentence>"}\`,
    prompt: JSON.stringify({ date: dateStr, dayOfWeek: dayName, isWeekend, usStockTopMovers: usMovers.slice(0,5), indices, headlines }),
    tools: [],
    maxTurns: 1,
  });

  let signal = "Markets", market = "macro", vibe = result.content.trim();
  try {
    const p = JSON.parse(result.content.trim());
    signal = p.signal; market = p.market; vibe = p.vibe;
  } catch (_) {}

  console.log(JSON.stringify({ signal, market, vibe, cryptoMovers: cryptoMovers.slice(0,5), usMovers: usMovers.slice(0,5), indices, stockDebug }));
})();`;

// ── Alva API call ─────────────────────────────────────────────────────────────
function fetchMarketVibeOnce() {
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
        timeout: 120000,
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
    req.on('timeout', () => { req.destroy(new Error('Request timeout')); });
    req.write(body);
    req.end();
  });
}

async function withRetry(fn, retries = 2, label = '') {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try { return await fn(); }
    catch (e) {
      lastErr = e;
      console.warn(`[${label}] attempt ${i+1} failed: ${e.message}`);
      if (i < retries) await new Promise(r => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw lastErr;
}

function fetchMarketVibe() {
  return withRetry(fetchMarketVibeOnce, 2, 'fetchMarketVibe');
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

  // Look up the signal's change from movers data
  const allMovers = [...(data.usMovers || []), ...(data.cryptoMovers || [])];
  const signalMover = allMovers.find(m => m.ticker === data.signal);
  const signalDisplay = signalMover
    ? `${emoji(signalMover.change)} **${data.signal}** ${fmt(signalMover.change)}`
    : data.signal;

  return [
    `GM Alva fam 🌅 Today's market vibe: ${data.vibe}`,
    '',
    `🔥 **Today's hottest signal (${marketLabel}):** ${signalDisplay}`,
    '',
    `**Indices:** ${idxLine}`,
    `**US Stocks:** ${stockLine}`,
    `**Crypto:** ${cryptoLine}`,
    '',
    "What's your strategy today?",
    '',
    'Not on a plan yet? Start your free trial → [alva.ai](https://alva.ai/?utm_source=discord)',
  ].join('\n');
}

// ── Featured Playbook: Alva script ───────────────────────────────────────────
// Step 1: scrapeUrl on alva.ai homepage to discover featured playbooks
// Step 2: pick one (rotating daily), scrapeUrl that playbook page
// Step 3: ADK extracts a structured community-facing summary
const FEATURED_SCRIPT = `(async () => {
  const { scrapeUrl } = require("@arrays/data/search/scrape-url:v1.0.0");
  const adk = require("@alva/adk");

  // Step 1: Discover playbooks from Alva homepage WITH engagement metrics
  const homepage = await scrapeUrl({ url: "https://alva.ai", waitUntil: "networkidle0" });
  const homeMd = homepage.response.data[0].markdown;

  const discoverResult = await adk.agent({
    system: \`You extract playbook URLs and engagement metrics from the Alva homepage markdown.
Find all playbook links (format: /u/<username>/playbooks/<name>) with their titles and any visible metrics (views, likes, remixes, forks, runs, or similar engagement numbers).
If a metric is not visible, set it to 0.
Output JSON only, no markdown fences:
{"playbooks":[{"title":"...","path":"/u/.../playbooks/...","views":0,"likes":0,"remixes":0}]}\`,
    prompt: homeMd,
    tools: [],
    maxTurns: 1,
  });

  let playbooks = [];
  try {
    playbooks = JSON.parse(discoverResult.content.trim()).playbooks || [];
  } catch (_) {}

  if (playbooks.length === 0) {
    console.log(JSON.stringify({ error: "No featured playbooks found on homepage" }));
    return;
  }

  // Step 2: Rank by engagement score, then rotate among top playbooks
  playbooks.forEach(p => {
    p.score = (p.views || 0) + (p.likes || 0) * 3 + (p.remixes || 0) * 5;
  });
  playbooks.sort((a, b) => b.score - a.score);
  const topN = playbooks.slice(0, Math.max(5, Math.ceil(playbooks.length * 0.3)));

  const dayOfYear = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0).getTime()) / 86400000);
  const pick = topN[dayOfYear % topN.length];
  const playbookUrl = "https://alva.ai" + pick.path;

  // Step 3: Scrape the selected playbook and extract structured summary
  const scraped = await scrapeUrl({ url: playbookUrl, waitUntil: "networkidle0" });
  const markdown = scraped.response.data[0].markdown;

  const result = await adk.agent({
    system: \`You extract structured summaries from Alva playbook pages for a Discord finance community.
Given the scraped markdown of a playbook page, extract:
1. title — the playbook's display title
2. description — one-sentence value proposition (what does this playbook DO for the user?)
3. performance — object with profitability metrics found on the page. Look for returns, P&L, win rate, Sharpe ratio, alpha, drawdown, or any backtest results. Extract as many as visible. Example: {"totalReturn":"+142%","period":"6mo","winRate":"68%","sharpe":"2.1","maxDrawdown":"-12%"}. Set fields to null if not found.
4. strategyLogic — array of 2-3 bullet points explaining the CORE strategy logic in plain language. What signals does it trade on? What's the edge? e.g. "Buys when senator discloses purchase within 3 days of filing" or "Goes long top 5 momentum stocks, rebalances weekly". Be specific — this should make someone understand WHY the strategy works.
5. keyInsights — array of 2-3 bullet points: the most interesting LIVE signals or positions currently shown. Be specific with numbers/tickers.
6. dataSources — short phrase listing data sources (e.g. "SEC Form 4 + Congressional STOCK Act filings")
7. sentiment — "bullish", "bearish", or "neutral" (based on the overall signal)
8. callToAction — a compelling one-liner motivating community members to explore this playbook

Output JSON only, no markdown fences:
{"title":"...","description":"...","performance":{"totalReturn":"...","period":"...","winRate":"...","sharpe":"...","maxDrawdown":"..."},"strategyLogic":["..."],"keyInsights":["..."],"dataSources":"...","sentiment":"...","callToAction":"..."}\`,
    prompt: markdown,
    tools: [],
    maxTurns: 1,
  });

  let parsed;
  try {
    parsed = JSON.parse(result.content.trim());
  } catch (_) {
    parsed = { title: pick.title, description: result.content.trim(), keyInsights: [], dataSources: "Alva", updateFrequency: "Daily", sentiment: "neutral", callToAction: "Check it out on Alva!" };
  }

  parsed.playbookUrl = playbookUrl;
  console.log(JSON.stringify(parsed));
})();`;

// ── Featured Playbook: Alva API call ─────────────────────────────────────────
function fetchFeaturedPlaybookOnce() {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ code: FEATURED_SCRIPT });
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
        timeout: 180000,
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(raw);
            if (parsed.error) return reject(new Error(parsed.error));
            const data = JSON.parse(parsed.logs.trim());
            resolve(data);
          } catch (e) {
            reject(new Error(`Unexpected Alva response: ${raw.slice(0, 300)}`));
          }
        });
      },
    );

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('Request timeout')); });
    req.write(body);
    req.end();
  });
}

function fetchFeaturedPlaybook() {
  return withRetry(fetchFeaturedPlaybookOnce, 2, 'fetchFeaturedPlaybook');
}

// ── Featured Playbook: Screenshot via Alva ───────────────────────────────────
function fetchScreenshotUrl(playbookUrl) {
  return new Promise((resolve) => {
    const encoded = encodeURIComponent(playbookUrl);
    const url = new URL(`${ALVA_ENDPOINT}/api/v1/screenshot?url=${encoded}`);

    const req = https.request(
      {
        hostname: url.hostname,
        path:     url.pathname + url.search,
        method:   'GET',
        headers: { 'X-Alva-Api-Key': ALVA_API_KEY },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(raw);
            resolve(parsed.url || null);
          } catch (_) {
            resolve(null);
          }
        });
      },
    );
    req.on('error', () => resolve(null));
    req.write('');
    req.end();
  });
}

// ── Featured Playbook: Discord Embed ─────────────────────────────────────────
function formatFeaturedEmbed(data, playbookUrl, screenshotUrl) {
  const sentimentConfig = {
    bullish:  { color: 0x2a9b7d, emoji: '🟢' },
    bearish:  { color: 0xe05357, emoji: '🔴' },
    neutral:  { color: 0x49a3a6, emoji: '⚪' },
  };
  const sc = sentimentConfig[data.sentiment] || sentimentConfig.neutral;

  const embed = new EmbedBuilder()
    .setColor(sc.color)
    .setAuthor({ name: 'Alva Featured Playbook', iconURL: 'https://alva.ai/favicon.ico' })
    .setTitle(`${sc.emoji} ${data.title}`)
    .setURL(playbookUrl)
    .setDescription(data.description);

  // Performance metrics — the hook
  const perf = data.performance || {};
  const perfParts = [];
  if (perf.totalReturn) perfParts.push(`**Return:** ${perf.totalReturn}${perf.period ? ` (${perf.period})` : ''}`);
  if (perf.winRate) perfParts.push(`**Win Rate:** ${perf.winRate}`);
  if (perf.sharpe) perfParts.push(`**Sharpe:** ${perf.sharpe}`);
  if (perf.maxDrawdown) perfParts.push(`**Max Drawdown:** ${perf.maxDrawdown}`);
  if (perfParts.length > 0) {
    embed.addFields({
      name: '💰 Performance',
      value: perfParts.join('  ·  '),
      inline: false,
    });
  }

  // Strategy logic — why it works
  if (data.strategyLogic && data.strategyLogic.length > 0) {
    embed.addFields({
      name: '🧠 Strategy',
      value: data.strategyLogic.map(s => `• ${s}`).join('\n'),
      inline: false,
    });
  }

  // Live signals
  if (data.keyInsights && data.keyInsights.length > 0) {
    embed.addFields({
      name: '🔍 Live Signals',
      value: data.keyInsights.map(i => `• ${i}`).join('\n'),
      inline: false,
    });
  }

  embed.addFields(
    { name: '📡 Data', value: data.dataSources || 'Alva SDKs', inline: true },
    { name: '📊 Signal', value: `${sc.emoji} ${data.sentiment?.toUpperCase() || 'NEUTRAL'}`, inline: true },
  );

  if (screenshotUrl) {
    embed.setImage(screenshotUrl);
  }

  embed.addFields({
    name: '\u200b',
    value: `💡 *${data.callToAction || 'Explore this playbook on Alva!'}*\n\n**[Open Playbook →](${playbookUrl})**\n\n🔗 [Alva](https://alva.ai/?utm_source=discord) · [Alva Skills](https://github.com/alva-ai/skills)`,
    inline: false,
  });

  embed.setFooter({ text: 'Powered by Alva · Real-time financial intelligence' });
  embed.setTimestamp();

  return embed;
}

// ── Post Featured Playbook to channel ────────────────────────────────────────
async function postFeatured(client) {
  const channel = client.channels.cache.get(FEATURED_CHANNEL_ID);
  if (!channel) {
    console.error(`[Featured] Channel ${FEATURED_CHANNEL_ID} not found`);
    return;
  }

  try {
    console.log('[Featured] Discovering & scraping playbook via Alva...');
    const data = await fetchFeaturedPlaybook();
    if (data.error) {
      console.error('[Featured]', data.error);
      return;
    }
    const playbookUrl = data.playbookUrl;
    const screenshotUrl = await fetchScreenshotUrl(playbookUrl);
    const embed = formatFeaturedEmbed(data, playbookUrl, screenshotUrl);
    await channel.send({ embeds: [embed] });
    console.log(`[Featured] Posted ${playbookUrl} at ${new Date().toISOString()}`);
  } catch (err) {
    console.error('[Featured] Failed:', err.message);
  }
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
    if (market.stockDebug) console.log('[GM] Stock debug:', JSON.stringify(market.stockDebug));
    const msg    = formatGM(market);
    await channel.send({ content: msg, flags: [MessageFlags.SuppressEmbeds] });
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
  // Featured cron disabled — manual /featured command still works
  // cron.schedule(FEATURED_CRON, () => postFeatured(client), { timezone: 'UTC' });
});

// Slash commands
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    // /gm — manual trigger for market vibe
    if (interaction.commandName === 'gm') {
      await interaction.deferReply();
      try {
        const market = await fetchMarketVibe();
        if (market.stockDebug) console.log('[GM /gm] Stock debug:', JSON.stringify(market.stockDebug, null, 2));
        await interaction.editReply({ content: formatGM(market), flags: [MessageFlags.SuppressEmbeds] });
      } catch (err) {
        await interaction.editReply(`Failed to fetch market data: ${err.message}`).catch(() => {});
      }
    }

    // /featured — manual trigger for featured playbook
    if (interaction.commandName === 'featured') {
      await interaction.deferReply();
      try {
        const data = await fetchFeaturedPlaybook();
        if (data.error) {
          await interaction.editReply(`No featured playbook found: ${data.error}`).catch(() => {});
          return;
        }
        const playbookUrl = data.playbookUrl;
        const screenshotUrl = await fetchScreenshotUrl(playbookUrl);
        const embed = formatFeaturedEmbed(data, playbookUrl, screenshotUrl);
        await interaction.editReply({ embeds: [embed] }).catch(() => {});
      } catch (err) {
        await interaction.editReply(`Failed to fetch playbook: ${err.message}`).catch(() => {});
      }
    }
    // /rules — post rules/welcome content to the current channel
    if (interaction.commandName === 'rules') {
      await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
      const channel = interaction.channel;

      const blocks = [
        // Block 1: Hero welcome
        new EmbedBuilder()
          .setColor(0x2a9b7d)
          .setTitle('🚀 Welcome to Alva: The Quantamental Investing AI Lab')
          .setDescription(
            'Welcome to the future of smart investing. Alva is a collaborative platform where AI meets Alpha. ' +
            'We are building the **GitHub for Investing** — a space to build, backtest, and remix quantamental playbooks with collective intelligence.'
          )
          .addFields({
            name: '🎯 Our Mission: Alpha, Shared.',
            value: 'We make smarter investing accessible to everyone. In Alva, individual research compounds into a **Shared Edge**.',
          })
          .setImage('https://alva.ai/og-image.png'),

        // Block 2: Getting started
        new EmbedBuilder()
          .setColor(0x49a3a6)
          .setTitle('⚡ Ideas In. Alpha Out.')
          .setDescription(
            'Turn your investment thesis into a live playbook in minutes — no code required.\n\n' +
            '**Build & Deploy:** Visit [alva.ai](https://alva.ai) to start modeling, backtesting, and monitoring your strategies.'
          ),

        // Block 3: The Alva Way
        new EmbedBuilder()
          .setColor(0x49a3a6)
          .setTitle('🔄 The Alva Way: Build, Remix, Compound')
          .setDescription(
            'This is a community of builders, not just watchers. We grow when you:\n\n' +
            '🛠️ **Create** — Don\'t let your ideas sit idle. Build financial models and quant strategies on [alva.ai](https://alva.ai) and share them here.\n\n' +
            '🌀 **Remix** — See a brilliant strategy? Hit Remix, tweak the logic or data sources, and evolve the edge.\n\n' +
            '🌟 **Star** — Found a game-changing playbook? Support the creator with a Star and help the best ideas rise to the top.\n\n' +
            '💡 **Explore** — Check <#1493128945216786593> for elite, Remix-ready examples of quantamental excellence.'
          ),

        // Block 4: Navigation
        new EmbedBuilder()
          .setColor(0x2a9b7d)
          .setTitle('🗺️ Navigation Map')
          .setDescription(
            '**📢 announcements** — Platform milestones and community news\n' +
            '**🆙 product-updates** — Technical changelogs, new AI nodes, and backtesting features\n' +
            '**💎 <#1493128945216786593>** — Curated gallery of high-performance investing playbooks\n\n' +
            '**💬 general** — High-level tech talk, market research, and quantamental networking\n' +
            '**🌐 gm-gn** — Daily check-ins and community vibes\n' +
            '**🛠 <#1493129095637241938>** — Bug reports, feature requests, and technical help'
          ),

        // Block 5: CTA
        new EmbedBuilder()
          .setColor(0x2a9b7d)
          .setTitle('🧪 Ready to reimagine investing?')
          .setDescription(
            'The engine is live. Let\'s build the edge together.\n\n' +
            '👉 **Enter the Lab:** [alva.ai](https://alva.ai)'
          ),
      ];

      try {
        for (const embed of blocks) {
          await channel.send({ embeds: [embed] });
        }
        await interaction.editReply('Rules posted!');
        console.log(`[Rules] Posted at ${new Date().toISOString()}`);
      } catch (err) {
        await interaction.editReply(`Failed to post rules: ${err.message}`).catch(() => {});
      }
    }

  } catch (err) {
    console.error('[Interaction] Failed:', err.message);
  }
});

client.login(DISCORD_TOKEN);
