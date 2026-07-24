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

// ── Date helpers (LOCAL time, not UTC — .toISOString() would return
//    tomorrow's date once past ~8pm ET, breaking every lookup) ─────────────
function localDateString(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function today() { return localDateString(); }
function yesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return localDateString(d);
}
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return localDateString(d);
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
    if (fs.existsSync(CACHE_FILE)) return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  } catch {}
  return {};
}
function saveCache(data) {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2), "utf8"); }
  catch (err) { console.error("MMM-MLB: cache write failed:", err.message); }
}

// ── MLB API calls ──────────────────────────────────────────────────────────

async function fetchScheduleRange(startDate, endDate, teamId) {
  const url = `${MLB_API}/schedule?sportId=1&startDate=${startDate}&endDate=${endDate}&teamId=${teamId}`
    + `&hydrate=linescore,team,decisions,probablePitcher,venue`;
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`Schedule fetch failed: ${res.status}`);
  return res.json();
}

async function fetchBoxScore(gamePk) {
  const res = await fetchFn(`${MLB_API}/game/${gamePk}/boxscore`);
  if (!res.ok) throw new Error(`Box score fetch failed: ${res.status}`);
  return res.json();
}

async function fetchLinescore(gamePk) {
  const res = await fetchFn(`${MLB_API}/game/${gamePk}/linescore`);
  if (!res.ok) throw new Error(`Linescore fetch failed: ${res.status}`);
  return res.json();
}

async function fetchPlayByPlay(gamePk) {
  const res = await fetchFn(`${MLB_API}/game/${gamePk}/playByPlay`);
  if (!res.ok) throw new Error(`Play-by-play fetch failed: ${res.status}`);
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
  const url = `${MLB_API}/transactions?teamId=${teamId}&startDate=${daysAgo(5)}&endDate=${today()}`;
  try {
    const res = await fetchFn(url);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.transactions || []).slice(0, 10);
  } catch { return []; }
}

// ── Game selection (doubleheader-aware) ────────────────────────────────────

// Flatten schedule -> array of games with their scheduled date attached.
function flattenGames(scheduleData) {
  const out = [];
  for (const dateEntry of (scheduleData?.dates || [])) {
    for (const g of (dateEntry.games || [])) {
      out.push({ ...g, _date: dateEntry.date });
    }
  }
  return out;
}

// Pick a specific game from a flat list. Modes:
//   'live'         — any game in "Live" state (in-progress)
//   'mostRecentFinal' — Final game with the latest gameDate (handles doubleheaders)
//   'nextScheduled'   — earliest not-yet-started, not-Live game
function pickGame(games, mode) {
  if (!games.length) return null;
  if (mode === "live") {
    return games.find(g => g.status?.abstractGameState === "Live") || null;
  }
  if (mode === "mostRecentFinal") {
    const finals = games.filter(g => g.status?.abstractGameState === "Final");
    if (!finals.length) return null;
    finals.sort((a, b) => new Date(b.gameDate) - new Date(a.gameDate));
    return finals[0];
  }
  if (mode === "nextScheduled") {
    const upcoming = games.filter(g => {
      const s = g.status?.abstractGameState;
      return s !== "Final" && s !== "Live";
    });
    if (!upcoming.length) return null;
    upcoming.sort((a, b) => new Date(a.gameDate) - new Date(b.gameDate));
    return upcoming[0];
  }
  return null;
}

function gameToData(game) {
  if (!game) return null;
  const away = game.teams.away;
  const home = game.teams.home;
  const state = game.status?.abstractGameState;
  const isFinal = state === "Final";
  const isLive = state === "Live";
  const isDoubleHeader = (game.doubleHeader && game.doubleHeader !== "N");
  return {
    gamePk: game.gamePk,
    awayTeamId: away.team.id,
    awayTeamName: away.team.name,
    awayTeamAbbr: away.team.abbreviation || away.team.teamName,
    awayScore: away.score ?? null,
    awayWin: away.isWinner || false,
    homeTeamId: home.team.id,
    homeTeamName: home.team.name,
    homeTeamAbbr: home.team.abbreviation || home.team.teamName,
    homeScore: home.score ?? null,
    homeWin: home.isWinner || false,
    final: isFinal,
    isLive,
    status: isFinal ? "FINAL" : isLive ? "LIVE" : (game.status?.detailedState || "Scheduled"),
    gameTime: formatLocalTime(game.gameDate),
    gameDate: game._date || null,
    venue: game.venue?.name || null,
    doubleHeader: isDoubleHeader,
    gameNumber: game.gameNumber || 1,
    decisions: game.decisions || null,     // { winner, loser, save } — from schedule hydrate
  };
}

// ── Rich game recap (box + line + play-by-play) ────────────────────────────

function summarizeLineScore(linescore, gd) {
  if (!linescore?.innings || !linescore.innings.length) return null;
  const away = linescore.innings.map(i => (i.away?.runs ?? "-")).join(" ");
  const home = linescore.innings.map(i => (i.home?.runs ?? "-")).join(" ");
  const totalsA = linescore.teams?.away || {};
  const totalsH = linescore.teams?.home || {};
  return `Line score (R H E):
  ${gd.awayTeamAbbr}: ${away}   →   ${totalsA.runs ?? "?"} R, ${totalsA.hits ?? "?"} H, ${totalsA.errors ?? "?"} E
  ${gd.homeTeamAbbr}: ${home}   →   ${totalsH.runs ?? "?"} R, ${totalsH.hits ?? "?"} H, ${totalsH.errors ?? "?"} E`;
}

function summarizeScoringPlays(playByPlay) {
  const plays = (playByPlay?.allPlays || []).filter(p => p.about?.isScoringPlay);
  if (!plays.length) return null;
  const lines = plays.map(p => {
    const half = p.about?.halfInning === "top" ? "T" : "B";
    const inn = p.about?.inning || "?";
    const desc = (p.result?.description || "").trim().replace(/\s+/g, " ");
    const a = p.result?.awayScore ?? "?";
    const h = p.result?.homeScore ?? "?";
    return `  [${half}${inn}] ${desc} → ${a}-${h}`;
  });
  return "Scoring plays:\n" + lines.join("\n");
}

function summarizeBoxScore(boxScore, gd) {
  if (!boxScore) return null;
  const lines = [];

  // Starting pitchers + any reliever with meaningful workload (≥1 IP or >2 batters faced)
  for (const side of ["away", "home"]) {
    const pitchers = boxScore.teams?.[side]?.pitchers || [];
    const players = boxScore.teams?.[side]?.players || {};
    const teamAbbr = side === "away" ? gd.awayTeamAbbr : gd.homeTeamAbbr;
    const pitchLines = [];
    pitchers.forEach((pid, idx) => {
      const p = players["ID" + pid];
      if (!p) return;
      const s = p.stats?.pitching || {};
      const ip = s.inningsPitched;
      if (!ip) return;
      const role = idx === 0 ? "SP" : "RP";
      pitchLines.push(`    ${role}: ${p.person.fullName} — ${ip} IP, ${s.hits || 0} H, ${s.earnedRuns || 0} ER, ${s.baseOnBalls || 0} BB, ${s.strikeOuts || 0} K`);
    });
    if (pitchLines.length) lines.push(`${teamAbbr} pitching:\n${pitchLines.join("\n")}`);
  }

  // Notable batting — more generous thresholds than before
  const bats = [];
  for (const side of ["away", "home"]) {
    const players = boxScore.teams?.[side]?.players || {};
    const teamAbbr = side === "away" ? gd.awayTeamAbbr : gd.homeTeamAbbr;
    for (const p of Object.values(players)) {
      const b = p.stats?.batting || {};
      const name = p.person?.fullName;
      if (!name) continue;
      const notes = [];
      if ((b.homeRuns || 0) > 0) notes.push(`${b.homeRuns} HR`);
      if ((b.doubles || 0) >= 2) notes.push(`${b.doubles} 2B`);
      if ((b.triples || 0) > 0) notes.push(`${b.triples} 3B`);
      if ((b.hits || 0) >= 3) notes.push(`${b.hits}-for-${b.atBats}`);
      if ((b.rbi || 0) >= 3) notes.push(`${b.rbi} RBI`);
      if ((b.stolenBases || 0) >= 2) notes.push(`${b.stolenBases} SB`);
      if (notes.length) bats.push(`    ${teamAbbr} ${name}: ${notes.join(", ")}`);
    }
  }
  if (bats.length) lines.push("Notable batting:\n" + bats.join("\n"));

  return lines.join("\n\n") || null;
}

async function fetchGameRecap(gd) {
  if (!gd?.gamePk) return null;
  const [boxScore, playByPlay, linescore] = await Promise.all([
    fetchBoxScore(gd.gamePk).catch(err => { console.warn("MMM-MLB: box:", err.message); return null; }),
    fetchPlayByPlay(gd.gamePk).catch(err => { console.warn("MMM-MLB: PBP:", err.message); return null; }),
    fetchLinescore(gd.gamePk).catch(err => { console.warn("MMM-MLB: line:", err.message); return null; }),
  ]);

  const sections = [];
  const ls = summarizeLineScore(linescore, gd);
  if (ls) sections.push(ls);
  const sp = summarizeScoringPlays(playByPlay);
  if (sp) sections.push(sp);
  const bx = summarizeBoxScore(boxScore, gd);
  if (bx) sections.push(bx);
  if (gd.decisions) {
    const parts = [];
    if (gd.decisions.winner) parts.push(`W: ${gd.decisions.winner.fullName}`);
    if (gd.decisions.loser)  parts.push(`L: ${gd.decisions.loser.fullName}`);
    if (gd.decisions.save)   parts.push(`SV: ${gd.decisions.save.fullName}`);
    if (parts.length) sections.push("Decisions: " + parts.join(", "));
  }
  return sections.length ? sections.join("\n\n") : null;
}

function summarizeStandingsChanges(current, previous) {
  if (!previous || !current) return [];
  const byTeam = (records) => {
    const map = {};
    for (const rec of records) for (const tr of (rec.teamRecords || [])) {
      map[tr.team.id] = {
        divisionRank: parseInt(tr.divisionRank),
        wildCardRank: parseInt(tr.wildCardRank) || 99,
      };
    }
    return map;
  };
  const prev = byTeam(previous.records || []);
  const curr = byTeam(current.records || []);
  const changes = [];
  for (const rec of (current.records || [])) {
    for (const tr of (rec.teamRecords || [])) {
      const p = prev[tr.team.id], c = curr[tr.team.id];
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
  return transactions.filter(t => t.description).map(t => `- ${t.description}`).join("\n");
}

// ── AI insight ─────────────────────────────────────────────────────────────

// Given any game data we have, figure out the favorite team's name & side.
function resolveFavorite(favTeamId, ...games) {
  for (const g of games) {
    if (!g) continue;
    if (g.awayTeamId === favTeamId) {
      return { name: g.awayTeamName, abbr: g.awayTeamAbbr, side: "away" };
    }
    if (g.homeTeamId === favTeamId) {
      return { name: g.homeTeamName, abbr: g.homeTeamAbbr, side: "home" };
    }
  }
  return { name: `team ${favTeamId}`, abbr: "?", side: null };
}

// Was the favorite team the winner? (only meaningful when game is final)
function favoriteResult(gd, favTeamId) {
  if (!gd?.final) return null;
  if (gd.awayTeamId === favTeamId) return gd.awayWin ? "W" : "L";
  if (gd.homeTeamId === favTeamId) return gd.homeWin ? "W" : "L";
  return null;
}

async function callClaude(apiKey, systemPrompt, userPrompt) {
  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model: "claude-opus-4-6",
    max_tokens: 700,
    thinking: { type: "adaptive" },
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });
  let text = "";
  for (const block of response.content) {
    if (block.type === "text") { text = block.text; break; }
  }
  try {
    const cleaned = text.replace(/```json\n?|\n?```/g, "").trim();
    return JSON.parse(cleaned);
  } catch {
    return { item_of_interest: text.trim(), standings_note: null };
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

async function getInsight(ctx, cache) {
  const { config, isBeforeNoon, gameData, lastGameData, recap, transactions, standingsChanges } = ctx;
  const todayStr = today();
  const maxRequests = config.maxDailyRequests || 4;

  const usageDate = cache.usageDate || "";
  const usageCount = usageDate === todayStr ? (cache.usageCount || 0) : 0;

  const minInterval = DAY_MS / maxRequests;
  const timeSinceLast = Date.now() - (cache.lastAiCallTime || 0);
  const tooSoon = timeSinceLast < minInterval;

  if (usageCount >= maxRequests || tooSoon) {
    return {
      insight: cache.lastInsight || null,
      standingsBullet: cache.lastStandingsBullet || null,
      rateLimited: usageCount >= maxRequests,
      usageCount, usageDate: todayStr,
    };
  }

  // ── Figure out fan perspective ──
  const fav = resolveFavorite(config.favoriteTeam, gameData, lastGameData);

  // ── Build the game-context section ──
  const sections = [];

  if (gameData?.isLive) {
    const inning = ctx.liveState
      ? `${ctx.liveState.isTopInning ? "TOP" : "BOT"} ${ctx.liveState.inningOrdinal}`
      : "in progress";
    sections.push(`GAME IN PROGRESS RIGHT NOW: ${gameData.awayTeamName} ${gameData.awayScore ?? 0} @ ${gameData.homeTeamName} ${gameData.homeScore ?? 0} — ${inning}`);
    if (recap) sections.push("Game so far:\n" + recap);
    if (lastGameData?.final) {
      const prev = favoriteResult(lastGameData, config.favoriteTeam);
      sections.push(`Previous game (${prev === "W" ? "won" : prev === "L" ? "lost" : "played"}): ${lastGameData.awayTeamName} ${lastGameData.awayScore} @ ${lastGameData.homeTeamName} ${lastGameData.homeScore}`);
    }
  } else if (gameData?.final || (isBeforeNoon && gameData)) {
    // Morning view or completed game
    const result = favoriteResult(gameData, config.favoriteTeam);
    const resultTag = result === "W" ? " — WIN" : result === "L" ? " — LOSS" : "";
    const dhTag = gameData.doubleHeader ? ` (Game ${gameData.gameNumber} of doubleheader)` : "";
    sections.push(`Most recent game${dhTag}: ${gameData.awayTeamName} ${gameData.awayScore} @ ${gameData.homeTeamName} ${gameData.homeScore} (FINAL)${resultTag}`);
    if (recap) sections.push(recap);
  } else if (!isBeforeNoon) {
    // Afternoon: yesterday's result + upcoming preview
    if (lastGameData?.final) {
      const result = favoriteResult(lastGameData, config.favoriteTeam);
      const resultTag = result === "W" ? " — WIN" : result === "L" ? " — LOSS" : "";
      const dhTag = lastGameData.doubleHeader ? ` (Game ${lastGameData.gameNumber} of doubleheader)` : "";
      sections.push(`Most recent completed game${dhTag}: ${lastGameData.awayTeamName} ${lastGameData.awayScore} @ ${lastGameData.homeTeamName} ${lastGameData.homeScore} (FINAL)${resultTag}`);
      if (recap) sections.push(recap);
    }
    if (gameData) {
      sections.push(`Next scheduled game: ${gameData.awayTeamName} @ ${gameData.homeTeamName} on ${gameData.gameDate || "upcoming"} at ${gameData.gameTime}${gameData.venue ? ` (${gameData.venue})` : ""}.`);
    }
  } else {
    sections.push(`${fav.name} had no game yesterday.`);
  }

  if (transactions) sections.push(`Recent ${fav.name} roster moves (last 5 days):\n${transactions}`);
  if (standingsChanges.length) sections.push(`Notable standings shifts:\n${standingsChanges.map(c => "- " + c).join("\n")}`);

  const userPrompt = sections.join("\n\n") + `

Respond in JSON only (no markdown fences, no extra text):
{
  "item_of_interest": "<2–3 sentences of ACTUAL analysis grounded in the specific game data above. Reference concrete plays, innings, or player moments — not generic 'clutch performance' or 'gritty win' filler. If ${fav.name} won, celebrate the specific thing that won it. If they lost, name what actually went wrong. If the game's in progress, react to the current situation. Skip cliches entirely.>",
  "standings_note": "<one sentence about a notable standings shift affecting ${fav.name} or the postseason picture, or null if nothing worth mentioning>"
}`;

  const systemPrompt = `You are writing for a passionate ${fav.name} fan — someone who watches most games and cares about the details. Write with a fan's perspective: celebrate ${fav.name} wins with real emotion, feel losses honestly (but don't whine or blame umpires), and pay closer attention to what ${fav.name} players did specifically. You know baseball deeply — strategy, sequencing, leverage, situational context — and you write ABOUT the actual game, not generic recaps. Ban these words/phrases entirely: "clutch", "gritty", "big win", "tough loss", "grind it out", "battled hard". Every sentence should contain a specific detail from the data provided.`;

  try {
    const result = await callClaude(config.anthropicApiKey, systemPrompt, userPrompt);
    return {
      insight: result.item_of_interest || null,
      standingsBullet: result.standings_note || null,
      rateLimited: false,
      usageCount: usageCount + 1,
      usageDate: todayStr,
      lastAiCallTime: Date.now(),
    };
  } catch (err) {
    console.error("MMM-MLB: Claude API error:", err.message);
    return {
      insight: cache.lastInsight || null,
      standingsBullet: cache.lastStandingsBullet || null,
      rateLimited: false, error: err.message,
      usageCount, usageDate: todayStr,
    };
  }
}

// ── Module ─────────────────────────────────────────────────────────────────

module.exports = NodeHelper.create({
  start() { console.log("MMM-MLB node_helper started"); },

  async socketNotificationReceived(notification, payload) {
    if (notification === "MMM_MLB_FETCH_LIVE") {
      try {
        const linescore = await fetchLinescore(payload.gamePk);
        this.sendSocketNotification("MMM_MLB_LIVE", {
          liveState: {
            awayScore: linescore.teams?.away?.runs ?? 0,
            homeScore: linescore.teams?.home?.runs ?? 0,
            inning: linescore.currentInning || 1,
            inningOrdinal: linescore.currentInningOrdinal || "1st",
            isTopInning: linescore.isTopInning !== false,
            balls: linescore.balls ?? 0,
            strikes: linescore.strikes ?? 0,
            outs: linescore.outs ?? 0,
          },
        });
      } catch (err) {
        console.warn("MMM-MLB live update failed:", err.message);
      }
      return;
    }

    if (notification !== "MMM_MLB_FETCH") return;
    const { config } = payload;
    if (!config.anthropicApiKey) {
      return this.sendSocketNotification("MMM_MLB_ERROR", {
        error: "MMM-MLB: anthropicApiKey not set in config.",
      });
    }
    try { await this.fetchAndSend(config); }
    catch (err) {
      console.error("MMM-MLB error:", err);
      this.sendSocketNotification("MMM_MLB_ERROR", { error: err.message });
    }
  },

  async fetchAndSend(config) {
    const isBeforeNoon = new Date().getHours() < 12;
    const cache = loadCache();

    // ── Fetch a 3-day window in one call (yesterday, today, tomorrow).
    //    One call handles doubleheaders across day boundaries, live games
    //    that started yesterday's calendar-date UTC-wise, and next-day preview.
    const wideStart = daysAgo(2);
    const wideEnd = (() => { const d = new Date(); d.setDate(d.getDate() + 14); return localDateString(d); })();
    const scheduleWindow = await fetchScheduleRange(wideStart, wideEnd, config.favoriteTeam);
    const allGames = flattenGames(scheduleWindow);

    // Live game (across any day in the window)
    const liveGame = gameToData(pickGame(allGames, "live"));

    // Most recent completed game (handles doubleheaders — picks the LATEST final)
    const mostRecentFinal = gameToData(pickGame(allGames, "mostRecentFinal"));

    // Next scheduled game after "now"
    const nextGame = gameToData(pickGame(allGames, "nextScheduled"));

    // ── Decide primary gameData & lastGameData for the frontend ──
    let gameData = null;
    let lastGameData = null;
    let liveState = null;

    if (liveGame) {
      // Live overrides time-of-day logic
      gameData = liveGame;
      lastGameData = mostRecentFinal && mostRecentFinal.gamePk !== liveGame.gamePk ? mostRecentFinal : null;
      try {
        const linescore = await fetchLinescore(liveGame.gamePk);
        liveState = {
          awayScore: linescore.teams?.away?.runs ?? 0,
          homeScore: linescore.teams?.home?.runs ?? 0,
          inning: linescore.currentInning || 1,
          inningOrdinal: linescore.currentInningOrdinal || "1st",
          isTopInning: linescore.isTopInning !== false,
          balls: linescore.balls ?? 0,
          strikes: linescore.strikes ?? 0,
          outs: linescore.outs ?? 0,
        };
        gameData.awayScore = liveState.awayScore;
        gameData.homeScore = liveState.homeScore;
      } catch (err) {
        console.warn("MMM-MLB: linescore fetch failed:", err.message);
      }
    } else if (isBeforeNoon) {
      gameData = mostRecentFinal;
    } else {
      gameData = nextGame;
      lastGameData = mostRecentFinal;
    }

    // ── Rich recap for the AI (uses whichever game is "the story" right now) ──
    const recapTarget = liveGame ? liveGame : (mostRecentFinal || gameData);
    let recap = null;
    if (recapTarget?.gamePk) {
      recap = await fetchGameRecap(recapTarget).catch(err => {
        console.warn("MMM-MLB: recap failed:", err.message); return null;
      });
    }

    // ── Standings + transactions in parallel ──
    const [currentStandings, txList] = await Promise.all([
      fetchStandings().catch(err => { console.warn("MMM-MLB: standings:", err.message); return null; }),
      fetchRecentTransactions(config.favoriteTeam),
    ]);
    const standingsChanges = summarizeStandingsChanges(currentStandings, cache.previousStandings);
    const transactions = formatTransactions(txList);

    // ── AI insight ──
    const insightResult = await getInsight({
      config, isBeforeNoon, gameData, lastGameData, liveState, recap, transactions, standingsChanges,
    }, cache);

    // ── Persist cache ──
    saveCache({
      usageDate: insightResult.usageDate,
      usageCount: insightResult.usageCount,
      lastAiCallTime: insightResult.lastAiCallTime || cache.lastAiCallTime,
      lastInsight: insightResult.insight || cache.lastInsight,
      lastStandingsBullet: insightResult.standingsBullet || cache.lastStandingsBullet,
      previousStandings: currentStandings || cache.previousStandings,
    });

    // ── Send to frontend ──
    this.sendSocketNotification("MMM_MLB_DATA", {
      isBeforeNoon,
      gameData,
      liveState,
      lastGameData,
      insight: insightResult.insight,
      standingsBullet: insightResult.standingsBullet,
      rateLimited: insightResult.rateLimited || false,
    });
  },
});
