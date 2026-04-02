/* node_helper.js — Backend for MMM-MLB */
"use strict";

const NodeHelper = require("node_helper");
const fs = require("fs");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");

// Node 18+ has fetch built-in; fall back to node-fetch if needed
const fetchFn = typeof fetch !== "undefined" ? fetch : (...args) => import("node-fetch").then(m => m.default(...args));

const MLB_API = "https://statsapi.mlb.com/api/v1";
const CACHE_FILE = path.join(__dirname, ".mlb-cache.json");

// ── Helpers ────────────────────────────────────────────────────────────────

function today() {
  return new Date().toISOString().slice(0, 10);
}

function yesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

function formatLocalTime(isoString) {
  if (!isoString) return "TBD";
  try {
    return new Date(isoString).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  } catch {
    return "TBD";
  }
}

function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    }
  } catch {}
  return {};
}

function saveCache(data) {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2), "utf8");
  } catch (err) {
    console.error("MMM-MLB: failed to write cache:", err.message);
  }
}

// ── MLB API calls ──────────────────────────────────────────────────────────

async function fetchSchedule(date, teamId) {
  const url = `${MLB_API}/schedule?sportId=1&date=${date}&teamId=${teamId}&hydrate=linescore,team`;
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`Schedule fetch failed: ${res.status}`);
  return res.json();
}

async function fetchFutureSchedule(teamId) {
  // Look up to 14 days ahead for the next game
  const dates = [];
  for (let i = 0; i <= 14; i++) {
    const d = new Date();
    d.setDate(d.getDate() + i);
    dates.push(d.toISOString().slice(0, 10));
  }
  const startDate = dates[0];
  const endDate = dates[dates.length - 1];
  const url = `${MLB_API}/schedule?sportId=1&startDate=${startDate}&endDate=${endDate}&teamId=${teamId}&hydrate=team,venue`;
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`Future schedule fetch failed: ${res.status}`);
  return res.json();
}

async function fetchBoxScore(gamePk) {
  const url = `${MLB_API}/game/${gamePk}/boxscore`;
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`Box score fetch failed: ${res.status}`);
  return res.json();
}

async function fetchStandings() {
  const season = new Date().getFullYear();
  const url = `${MLB_API}/standings?leagueId=103,104&season=${season}&hydrate=team`;
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`Standings fetch failed: ${res.status}`);
  return res.json();
}

async function fetchRecentTransactions(teamId) {
  // Fetch last 5 days of transactions for the team
  const end = today();
  const start = (() => { const d = new Date(); d.setDate(d.getDate() - 5); return d.toISOString().slice(0, 10); })();
  const url = `${MLB_API}/transactions?teamId=${teamId}&startDate=${start}&endDate=${end}`;
  try {
    const res = await fetchFn(url);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.transactions || []).slice(0, 10);
  } catch {
    return [];
  }
}

// ── Data extraction ────────────────────────────────────────────────────────

function extractGameData(scheduleData) {
  const dates = scheduleData.dates || [];
  if (!dates.length) return null;
  const games = dates[0].games || [];
  if (!games.length) return null;
  const game = games[0];
  const away = game.teams.away;
  const home = game.teams.home;
  const isFinal = game.status.abstractGameState === "Final";
  return {
    gamePk: game.gamePk,
    awayTeamId: away.team.id,
    awayTeamName: away.team.name,
    awayTeamAbbr: away.team.abbreviation || away.team.teamName,
    awayScore: away.score,
    awayWin: away.isWinner,
    homeTeamId: home.team.id,
    homeTeamName: home.team.name,
    homeTeamAbbr: home.team.abbreviation || home.team.teamName,
    homeScore: home.score,
    homeWin: home.isWinner,
    final: isFinal,
    status: isFinal ? "FINAL" : game.status.detailedState,
    gameTime: formatLocalTime(game.gameDate),
    venue: game.venue?.name || null,
  };
}

function extractNextGame(scheduleData) {
  const allDates = scheduleData.dates || [];
  for (const dateEntry of allDates) {
    for (const game of (dateEntry.games || [])) {
      if (game.status.abstractGameState !== "Final") {
        const away = game.teams.away;
        const home = game.teams.home;
        return {
          gamePk: game.gamePk,
          awayTeamId: away.team.id,
          awayTeamName: away.team.name,
          awayTeamAbbr: away.team.abbreviation || away.team.teamName,
          homeTeamId: home.team.id,
          homeTeamName: home.team.name,
          homeTeamAbbr: home.team.abbreviation || home.team.teamName,
          final: false,
          awayScore: null,
          homeScore: null,
          awayWin: false,
          homeWin: false,
          status: game.status.detailedState,
          gameTime: formatLocalTime(game.gameDate),
          gameDate: dateEntry.date,
          venue: game.venue?.name || null,
        };
      }
    }
  }
  return null;
}

function summarizeBoxScore(boxScore, gameData) {
  if (!boxScore) return "Box score unavailable.";

  const lines = [];

  // Starting pitchers
  for (const side of ["away", "home"]) {
    const pitchers = boxScore.teams?.[side]?.pitchers || [];
    const playerInfo = boxScore.teams?.[side]?.players || {};
    if (pitchers.length > 0) {
      const spId = "ID" + pitchers[0];
      const sp = playerInfo[spId];
      if (sp) {
        const s = sp.stats?.pitching || {};
        const teamName = side === "away" ? gameData.awayTeamAbbr : gameData.homeTeamAbbr;
        lines.push(`${teamName} SP: ${sp.person.fullName} — ${s.inningsPitched || "?"}IP, ${s.hits || 0}H, ${s.earnedRuns || 0}ER, ${s.baseOnBalls || 0}BB, ${s.strikeOuts || 0}K`);
      }
    }
  }

  // Notable batting (HR, 3+ hits, 4+ RBI)
  const notables = [];
  for (const side of ["away", "home"]) {
    const players = boxScore.teams?.[side]?.players || {};
    for (const [, player] of Object.entries(players)) {
      const b = player.stats?.batting || {};
      const name = player.person?.fullName;
      if (!name) continue;
      const notes = [];
      if ((b.homeRuns || 0) > 0) notes.push(`${b.homeRuns} HR`);
      if ((b.hits || 0) >= 3) notes.push(`${b.hits} hits`);
      if ((b.rbi || 0) >= 4) notes.push(`${b.rbi} RBI`);
      if (notes.length) notables.push(`${name}: ${notes.join(", ")}`);
    }
  }
  if (notables.length) lines.push("Notable batting: " + notables.join("; "));

  return lines.join("\n") || "Standard game, no standout box score lines.";
}

function summarizeStandingsChanges(current, previous) {
  if (!previous || !current) return [];
  const changes = [];

  const byTeam = (records) => {
    const map = {};
    for (const rec of records) {
      for (const tr of (rec.teamRecords || [])) {
        map[tr.team.id] = {
          divisionRank: parseInt(tr.divisionRank),
          wildCardRank: parseInt(tr.wildCardRank) || 99,
          gamesBack: tr.gamesBack,
          wcGamesBack: tr.wildCardGamesBack,
          divisionChamp: tr.clinched,
        };
      }
    }
    return map;
  };

  const prev = byTeam(previous.records || []);
  const curr = byTeam(current.records || []);
  const allRecords = current.records || [];

  for (const rec of allRecords) {
    for (const tr of (rec.teamRecords || [])) {
      const id = tr.team.id;
      const p = prev[id];
      const c = curr[id];
      if (!p || !c) continue;
      if (c.divisionRank === 1 && p.divisionRank !== 1) {
        changes.push(`${tr.team.name} moved into first place in the ${rec.division?.nameShort || "division"}`);
      }
      if (c.wildCardRank <= 3 && p.wildCardRank > 3) {
        changes.push(`${tr.team.name} moved into a wild card position`);
      }
      if (c.wildCardRank > 3 && p.wildCardRank <= 3) {
        changes.push(`${tr.team.name} fell out of wild card contention`);
      }
    }
  }
  return changes;
}

function formatTransactions(transactions) {
  if (!transactions || !transactions.length) return null;
  return transactions
    .filter(t => t.description)
    .map(t => `- ${t.description}`)
    .join("\n");
}

// ── AI insight ─────────────────────────────────────────────────────────────

async function callClaude(apiKey, prompt) {
  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model: "claude-opus-4-6",
    max_tokens: 512,
    thinking: { type: "adaptive" },
    system: `You are a knowledgeable baseball analyst writing for a MagicMirror home display. Your audience is an educated baseball fan — someone who understands the game deeply but is NOT a fantasy baseball enthusiast. They care about real baseball: strategy, narrative, history, player development, team storylines. Keep responses concise and vivid.`,
    messages: [{ role: "user", content: prompt }],
  });

  let text = "";
  for (const block of response.content) {
    if (block.type === "text") { text = block.text; break; }
  }

  // Expect JSON with item_of_interest and standings_note
  try {
    const cleaned = text.replace(/```json\n?|\n?```/g, "").trim();
    return JSON.parse(cleaned);
  } catch {
    return { item_of_interest: text.trim(), standings_note: null };
  }
}

async function getInsight(config, isBeforeNoon, gameData, boxSummary, transactions, standingsChanges, cache) {
  const todayStr = today();

  // Check daily limit
  const usageDate = cache.usageDate || "";
  const usageCount = usageDate === todayStr ? (cache.usageCount || 0) : 0;
  const maxRequests = config.maxDailyRequests || 4;

  if (usageCount >= maxRequests) {
    return {
      insight: cache.lastInsight || null,
      standingsBullet: cache.lastStandingsBullet || null,
      rateLimited: true,
      usageCount,
      usageDate: todayStr,
    };
  }

  // Build prompt
  let prompt = "";

  if (isBeforeNoon) {
    if (gameData) {
      prompt = `Yesterday's game: ${gameData.awayTeamName} ${gameData.awayScore ?? "?"} @ ${gameData.homeTeamName} ${gameData.homeScore ?? "?"} (${gameData.status})

Box score summary:
${boxSummary}`;
    } else {
      prompt = `The configured favorite team (ID: ${config.favoriteTeam}) had no game yesterday.`;
    }
  } else {
    if (gameData) {
      const dateStr = gameData.gameDate || "upcoming";
      prompt = `Upcoming game: ${gameData.awayTeamName} @ ${gameData.homeTeamName} on ${dateStr} at ${gameData.gameTime}${gameData.venue ? ` (${gameData.venue})` : ""}.`;
    } else {
      prompt = `The configured favorite team (ID: ${config.favoriteTeam}) has no upcoming games in the next two weeks.`;
    }
  }

  if (transactions) {
    prompt += `\n\nRecent roster moves / transactions (last 5 days):\n${transactions}`;
  }

  if (standingsChanges.length) {
    prompt += `\n\nNotable standings changes today:\n${standingsChanges.map(c => "- " + c).join("\n")}`;
  }

  prompt += `

Based on the above, respond in JSON only (no markdown fences, no extra text):
{
  "item_of_interest": "<1–2 sentence highlight that an educated baseball fan would find genuinely interesting — could be a player performance, a news item, an interesting matchup angle, or a relevant narrative. Not fantasy stats.>",
  "standings_note": "<one brief sentence about a notable standings shift, or null if nothing is worth mentioning>"
}`;

  try {
    const result = await callClaude(config.anthropicApiKey, prompt);
    return {
      insight: result.item_of_interest || null,
      standingsBullet: result.standings_note || null,
      rateLimited: false,
      usageCount: usageCount + 1,
      usageDate: todayStr,
    };
  } catch (err) {
    console.error("MMM-MLB: Claude API error:", err.message);
    return {
      insight: cache.lastInsight || null,
      standingsBullet: cache.lastStandingsBullet || null,
      rateLimited: false,
      error: err.message,
      usageCount,
      usageDate: todayStr,
    };
  }
}

// ── Module ─────────────────────────────────────────────────────────────────

module.exports = NodeHelper.create({
  start() {
    console.log("MMM-MLB node_helper started");
  },

  async socketNotificationReceived(notification, payload) {
    if (notification !== "MMM_MLB_FETCH") return;
    const { config } = payload;

    if (!config.anthropicApiKey) {
      return this.sendSocketNotification("MMM_MLB_ERROR", {
        error: "MMM-MLB: anthropicApiKey not set in config.",
      });
    }

    try {
      await this.fetchAndSend(config);
    } catch (err) {
      console.error("MMM-MLB error:", err);
      this.sendSocketNotification("MMM_MLB_ERROR", { error: err.message });
    }
  },

  async fetchAndSend(config) {
    const isBeforeNoon = new Date().getHours() < 12;
    const cache = loadCache();

    // ── Fetch game data ──────────────────────────────────
    let gameData = null;
    let boxSummary = "No game data.";

    if (isBeforeNoon) {
      const schedData = await fetchSchedule(yesterday(), config.favoriteTeam);
      gameData = extractGameData(schedData);
      if (gameData && gameData.gamePk) {
        try {
          const boxScore = await fetchBoxScore(gameData.gamePk);
          boxSummary = summarizeBoxScore(boxScore, gameData);
        } catch (err) {
          console.warn("MMM-MLB: box score fetch failed:", err.message);
        }
      }
    } else {
      const futureData = await fetchFutureSchedule(config.favoriteTeam);
      gameData = extractNextGame(futureData);
    }

    // ── Fetch standings ──────────────────────────────────
    let currentStandings = null;
    let standingsChanges = [];
    try {
      currentStandings = await fetchStandings();
      standingsChanges = summarizeStandingsChanges(currentStandings, cache.previousStandings);
    } catch (err) {
      console.warn("MMM-MLB: standings fetch failed:", err.message);
    }

    // ── Fetch transactions ───────────────────────────────
    const txList = await fetchRecentTransactions(config.favoriteTeam);
    const transactions = formatTransactions(txList);

    // ── AI insight ───────────────────────────────────────
    const insightResult = await getInsight(
      config, isBeforeNoon, gameData, boxSummary, transactions, standingsChanges, cache
    );

    // ── Persist cache ────────────────────────────────────
    const newCache = {
      usageDate: insightResult.usageDate,
      usageCount: insightResult.usageCount,
      lastInsight: insightResult.insight || cache.lastInsight,
      lastStandingsBullet: insightResult.standingsBullet || cache.lastStandingsBullet,
      previousStandings: currentStandings || cache.previousStandings,
    };
    saveCache(newCache);

    // ── Send to frontend ─────────────────────────────────
    this.sendSocketNotification("MMM_MLB_DATA", {
      isBeforeNoon,
      gameData,
      insight: insightResult.insight,
      standingsBullet: insightResult.standingsBullet,
      rateLimited: insightResult.rateLimited || false,
    });
  },
});
