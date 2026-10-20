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
function daysFromNow(n) { return daysAgo(-n); }

// "2026-10-23" -> "Fri 10/23" (parsed as a local date, not UTC midnight)
function formatShortDate(ymd) {
  if (!ymd) return "TBD";
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return `${dt.toLocaleDateString([], { weekday: "short" })} ${m}/${d}`;
}

// Whole days from today to a YYYY-MM-DD date (negative if in the past)
function daysUntil(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((new Date(y, m - 1, d) - start) / (24 * 60 * 60 * 1000));
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

const SCHEDULE_HYDRATE = "linescore,team,decisions,probablePitcher,venue,seriesStatus";
const POSTSEASON_GAME_TYPES = "F,D,L,W";   // Wild Card, Division Series, LCS, World Series

async function fetchScheduleRange(startDate, endDate, teamId) {
  const url = `${MLB_API}/schedule?sportId=1&startDate=${startDate}&endDate=${endDate}&teamId=${teamId}`
    + `&hydrate=${SCHEDULE_HYDRATE}`;
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`Schedule fetch failed: ${res.status}`);
  return res.json();
}

// Every postseason game league-wide for a season (the whole bracket, ~40 games)
async function fetchPostseasonGames(seasonInfo) {
  const url = `${MLB_API}/schedule?sportId=1&gameType=${POSTSEASON_GAME_TYPES}`
    + `&startDate=${seasonInfo.postSeasonStartDate}&endDate=${seasonInfo.postSeasonEndDate}`
    + `&hydrate=${SCHEDULE_HYDRATE}`;
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`Postseason schedule fetch failed: ${res.status}`);
  return flattenGames(await res.json());
}

// Season calendar: springStartDate, regularSeasonStartDate/EndDate, postSeasonStartDate/EndDate
async function fetchSeasonInfo(year) {
  try {
    const res = await fetchFn(`${MLB_API}/seasons/${year}?sportId=1`);
    if (!res.ok) return null;
    const data = await res.json();
    return data.seasons?.[0] || null;
  } catch { return null; }
}

async function fetchTeam(teamId) {
  const res = await fetchFn(`${MLB_API}/teams/${teamId}`);
  if (!res.ok) throw new Error(`Team fetch failed: ${res.status}`);
  const data = await res.json();
  const t = data.teams?.[0];
  return t ? { id: t.id, name: t.name, abbr: t.abbreviation, leagueId: t.league?.id, divisionId: t.division?.id } : null;
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

async function fetchStandings(season = new Date().getFullYear()) {
  const url = `${MLB_API}/standings?leagueId=103,104&season=${season}&hydrate=team(division,league)`;
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`Standings fetch failed: ${res.status}`);
  return res.json();
}

// teamId = null fetches league-wide transactions
async function fetchTransactions(teamId, days) {
  const scope = teamId ? `teamId=${teamId}` : "sportId=1";
  const url = `${MLB_API}/transactions?${scope}&startDate=${daysAgo(days)}&endDate=${today()}`;
  try {
    const res = await fetchFn(url);
    if (!res.ok) return [];
    const data = await res.json();
    return data.transactions || [];
  } catch { return []; }
}

// Drop the noise (minor-league deals, Rule 5 minors, number changes) and dupes.
//   strict=true  → league-wide: trades and MLB-level signings only
//   strict=false → favorite team: also DFAs, releases, waiver claims, free-agent departures
function filterSignificantTransactions(transactions, { strict = false, limit = 20 } = {}) {
  const keepTypes = strict ? ["TR", "SFA", "SGN"] : ["TR", "SFA", "SGN", "DES", "REL", "CLW", "DFA", "OUT", "RET"];
  const seen = new Set();
  const out = transactions.filter(t => {
    if (!t.description || !keepTypes.includes(t.typeCode)) return false;
    if (/minor league/i.test(t.description)) return false;
    if (seen.has(t.description)) return false;
    seen.add(t.description);
    return true;
  });
  // Newest first; trades lead the league-wide list since they're the headline moves
  out.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  if (strict) out.sort((a, b) => (a.typeCode === "TR" ? 0 : 1) - (b.typeCode === "TR" ? 0 : 1));
  return out.slice(0, limit);
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
  // Regular-season games carry a seriesStatus too ("Season") — only use it in the postseason
  const isPostseason = POSTSEASON_GAME_TYPES.split(",").includes(game.gameType);
  const series = isPostseason ? game.seriesStatus || {} : {};
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
    awayRecord: away.leagueRecord ? `${away.leagueRecord.wins}-${away.leagueRecord.losses}` : null,
    homeRecord: home.leagueRecord ? `${home.leagueRecord.wins}-${home.leagueRecord.losses}` : null,
    awayProbable: away.probablePitcher?.fullName || null,
    homeProbable: home.probablePitcher?.fullName || null,
    // Postseason only (null otherwise)
    isPostseason,
    seriesKey: seriesKeyOf(game),
    seriesLabel: series.shortDescription || null,   // "ALCS Game 6"
    seriesName: series.shortName || null,           // "ALCS"
    seriesAbbr: series.abbreviation || null,        // "WS", "ALCS"
    seriesGameNumber: isPostseason ? (game.seriesGameNumber || series.gameNumber || null) : null,
  };
}

// One key per postseason series: round + the two teams
function seriesKeyOf(game) {
  if (!POSTSEASON_GAME_TYPES.split(",").includes(game.gameType)) return null;
  const ids = [game.teams.away.team.id, game.teams.home.team.id].sort((a, b) => a - b);
  return `${game.gameType}:${ids.join("-")}`;
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
        changes.push(`${tr.team.name} moved into first place in the ${tr.team.division?.nameShort || "division"}`);
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

function formatTransactions(transactions, { withDates = false } = {}) {
  if (!transactions || !transactions.length) return null;
  return transactions.filter(t => t.description)
    .map(t => `- ${withDates && t.date ? `[${t.date.slice(5)}] ` : ""}${t.description}`).join("\n");
}

// ── Expanded standings context ─────────────────────────────────────────────

// wildCardGamesBack is relative to the last qualifying spot: "+9.5" ahead, "-" holds it, "4.0" behind
function wcGamesBackText(gb) {
  if (!gb || gb === "-") return "holds last spot";
  return gb.startsWith("+") ? `${gb} over the cutoff` : `${gb} GB of a spot`;
}

// Division games back; "-" for a non-leader means tied for first (lost the tiebreaker)
function divisionGamesBackText(tr) {
  if (tr.divisionRank === "1") return "1st";
  return tr.gamesBack === "-" ? "tied for 1st" : `${tr.gamesBack} GB`;
}

function teamStandingLine(tr) {
  const lastTen = (tr.records?.splitRecords || []).find(r => r.type === "lastTen");
  const parts = [`${tr.team.abbreviation || tr.team.name} ${tr.wins}-${tr.losses}`];
  parts.push(divisionGamesBackText(tr));
  if (lastTen) parts.push(`L10 ${lastTen.wins}-${lastTen.losses}`);
  if (tr.streak?.streakCode) parts.push(tr.streak.streakCode);
  if (typeof tr.runDifferential === "number") parts.push(`RD ${tr.runDifferential > 0 ? "+" : ""}${tr.runDifferential}`);
  if (tr.clinchIndicator) parts.push(`[${{ z: "clinched best record", y: "clinched division", w: "clinched wild card", x: "clinched playoff berth", e: "eliminated" }[tr.clinchIndicator] || tr.clinchIndicator}]`);
  return parts.join(", ");
}

// Favorite's division in full, the league's wild-card race, and the other
// division leaders — enough for the model to talk about the race, not just a rank.
function formatStandingsContext(standings, favTeamId, { label = "Current standings", includeRace = true } = {}) {
  if (!standings?.records?.length) return null;
  const all = standings.records.flatMap(r => r.teamRecords || []);
  if (!all.some(tr => tr.gamesPlayed > 0)) return null;   // spring/preseason: all 0-0
  const fav = all.find(tr => tr.team.id === favTeamId);
  if (!fav) return null;

  const divId = fav.team.division?.id;
  const leagueId = fav.team.league?.id;
  const division = all.filter(tr => tr.team.division?.id === divId)
    .sort((a, b) => parseInt(a.divisionRank) - parseInt(b.divisionRank));
  const out = [`${label} — ${fav.team.division?.name || "Division"}:\n${division.map(tr => "  " + teamStandingLine(tr)).join("\n")}`];

  if (includeRace) {
    const wc = all.filter(tr => tr.team.league?.id === leagueId && tr.wildCardRank)
      .sort((a, b) => parseInt(a.wildCardRank) - parseInt(b.wildCardRank)).slice(0, 7);
    if (wc.length) {
      out.push(`${fav.team.league?.name || "League"} wild card race (top 3 qualify):\n` + wc.map(tr =>
        `  ${tr.wildCardRank}. ${tr.team.abbreviation} ${tr.wins}-${tr.losses} (${wcGamesBackText(tr.wildCardGamesBack)})${tr.team.id === favTeamId ? "  ← favorite" : ""}`
      ).join("\n"));
    }
  }

  const leaders = all.filter(tr => tr.divisionRank === "1" && tr.team.division?.id !== divId)
    .map(tr => `${tr.team.division?.nameShort || "?"}: ${tr.team.abbreviation} ${tr.wins}-${tr.losses}`);
  if (leaders.length) out.push(`Other division leaders: ${leaders.join("; ")}`);
  return out.join("\n\n");
}

// Next N not-yet-played games with opponents' records and probables
function formatUpcomingSchedule(games, favTeamId, n = 6) {
  const upcoming = games.filter(g => {
    const s = g.status?.abstractGameState;
    return s !== "Final" && s !== "Live" && !/postponed|cancel/i.test(g.status?.detailedState || "");
  }).sort((a, b) => new Date(a.gameDate) - new Date(b.gameDate)).slice(0, n).map(gameToData);
  if (!upcoming.length) return null;
  return upcoming.map(gd => {
    const tag = gd.seriesLabel ? ` [${gd.seriesLabel}]` : "";
    const favHome = gd.homeTeamId === favTeamId;
    const opp = favHome ? `vs ${gd.awayTeamName}` : gd.awayTeamId === favTeamId ? `@ ${gd.homeTeamName}` : `${gd.awayTeamName} @ ${gd.homeTeamName}`;
    const oppRec = !gd.isPostseason && (favHome ? gd.awayRecord : gd.homeRecord);
    const probables = (gd.awayProbable || gd.homeProbable)
      ? ` — probables: ${gd.awayProbable || "TBD"} vs ${gd.homeProbable || "TBD"}` : "";
    return `- ${formatShortDate(gd.gameDate)} ${gd.gameTime}: ${opp}${oppRec ? ` (${oppRec})` : ""}${tag}${probables}`;
  }).join("\n");
}

// ── Postseason bracket ─────────────────────────────────────────────────────

const ROUND_ORDER = { F: 1, D: 2, L: 3, W: 4 };

// Group all postseason games into series and work out where the favorite stands.
// favStatus: "alive" | "eliminated" | "missed"
function analyzePostseason(games, favTeamId) {
  const byKey = new Map();
  for (const g of games) {
    const key = seriesKeyOf(g);
    if (!key) continue;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(g);
  }

  const series = [...byKey.entries()].map(([key, gs]) => {
    gs.sort((a, b) => new Date(a.gameDate) - new Date(b.gameDate));
    const finals = gs.filter(g => g.status?.abstractGameState === "Final");
    const last = finals[finals.length - 1] || null;
    const status = last?.seriesStatus || null;
    const first = gs[0];
    return {
      key,
      round: ROUND_ORDER[first.gameType] || 0,
      name: first.seriesStatus?.shortName || first.seriesDescription || "Series",
      teamIds: [first.teams.away.team.id, first.teams.home.team.id],
      teamNames: [first.teams.away.team.name, first.teams.home.team.name],
      result: status?.result || `Begins ${formatShortDate(first.officialDate || first._date)}`,
      isOver: !!status?.isOver,
      winner: status?.isOver ? status.winningTeam : null,
      loser: status?.isOver ? status.losingTeam : null,
      games: gs,
      finals,
    };
  }).sort((a, b) => a.round - b.round);

  const favSeries = series.filter(s => s.teamIds.includes(favTeamId));
  const lostSeries = favSeries.find(s => s.isOver && s.loser?.id === favTeamId) || null;
  const favStatus = lostSeries ? "eliminated" : favSeries.length ? "alive" : "missed";

  const ws = series.find(s => s.round === ROUND_ORDER.W);
  const champion = ws?.isOver ? ws.winner : null;
  return { series, favSeries, lostSeries, favStatus, champion, isComplete: !!champion };
}

function formatBracket(post) {
  if (!post?.series.length) return null;
  return "Postseason bracket so far:\n" + post.series.map(s =>
    `- ${s.name}: ${s.teamNames.join(" vs ")} — ${s.result}`
  ).join("\n");
}

// Game-by-game line for one series (used for "how the favorite's season ended")
function formatSeriesGames(s) {
  return s.finals.map(g =>
    `  G${g.seriesGameNumber || "?"} (${formatShortDate(g.officialDate || g._date)}): ${g.teams.away.team.abbreviation} ${g.teams.away.score} @ ${g.teams.home.team.abbreviation} ${g.teams.home.score}`
  ).join("\n");
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

function truncateWords(text, maxWords) {
  if (!text) return text || null;
  const words = text.trim().split(/\s+/);
  if (words.length <= maxWords) return text.trim();
  return words.slice(0, maxWords).join(" ") + "…";
}

async function callClaude(apiKey, systemPrompt, userPrompt, { webSearch = false } = {}) {
  const client = new Anthropic({ apiKey });
  const params = {
    model: "claude-opus-5-5",
    // Thinking is always on for Opus 5.5 and counts toward max_tokens
    max_tokens: webSearch ? 16000 : 8000,
    thinking: { type: "adaptive" },
    output_config: { effort: "medium" },
    // If a safety classifier declines, re-run server-side on Anthropic's recommended fallback model
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  };
  if (webSearch) params.tools = [{ type: "web_search_20260209", name: "web_search", max_uses: 4 }];

  let response = await client.beta.messages.create(params);
  // Server-side search loops can pause; re-send the partial turn to resume
  for (let i = 0; response.stop_reason === "pause_turn" && i < 3; i++) {
    params.messages = [
      { role: "user", content: userPrompt },
      { role: "assistant", content: response.content },
    ];
    response = await client.beta.messages.create(params);
  }
  // Whole fallback chain declined — throw so the caller keeps the cached insight
  if (response.stop_reason === "refusal") {
    throw new Error(`Claude declined (${response.stop_details?.category || "unknown category"})`);
  }

  // With web search the answer comes after the last search result, and citations
  // can split it across several text blocks — join everything after that point.
  const blocks = response.content || [];
  let start = 0;
  blocks.forEach((b, i) => { if (b.type === "web_search_tool_result") start = i + 1; });
  const text = blocks.slice(start).filter(b => b.type === "text").map(b => b.text).join("").trim();

  try {
    const cleaned = text.replace(/```json\n?|\n?```/g, "");
    const json = cleaned.slice(cleaned.indexOf("{"), cleaned.lastIndexOf("}") + 1);
    return JSON.parse(json);
  } catch {
    return { item_of_interest: text, standings_note: null };
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

const BANNED_PHRASES = `Ban these words/phrases entirely: "clutch", "gritty", "big win", "tough loss", "grind it out", "battled hard".`;

// The game-centric sections (live / final / upcoming) — shared by the regular
// season, a postseason the favorite is still in, and the eliminated-fan view.
function buildGameSections(ctx, favName) {
  const { config, isBeforeNoon, gameData, lastGameData, recap, liveState } = ctx;
  const sections = [];
  const tagOf = gd => gd?.seriesLabel ? ` [${gd.seriesLabel}]` : "";

  if (gameData?.isLive) {
    const inning = liveState
      ? `${liveState.isTopInning ? "TOP" : "BOT"} ${liveState.inningOrdinal}`
      : "in progress";
    sections.push(`GAME IN PROGRESS RIGHT NOW${tagOf(gameData)}: ${gameData.awayTeamName} ${gameData.awayScore ?? 0} @ ${gameData.homeTeamName} ${gameData.homeScore ?? 0} — ${inning}`);
    if (recap) sections.push("Game so far:\n" + recap);
    if (lastGameData?.final) {
      const prev = favoriteResult(lastGameData, config.favoriteTeam);
      sections.push(`Previous game${tagOf(lastGameData)} (${prev === "W" ? "won" : prev === "L" ? "lost" : "played"}): ${lastGameData.awayTeamName} ${lastGameData.awayScore} @ ${lastGameData.homeTeamName} ${lastGameData.homeScore}`);
    }
  } else if (gameData?.final || (isBeforeNoon && gameData)) {
    const result = favoriteResult(gameData, config.favoriteTeam);
    const resultTag = result === "W" ? " — WIN" : result === "L" ? " — LOSS" : "";
    const dhTag = gameData.doubleHeader ? ` (Game ${gameData.gameNumber} of doubleheader)` : "";
    sections.push(`Most recent game${dhTag}${tagOf(gameData)} (${formatShortDate(gameData.gameDate)}): ${gameData.awayTeamName} ${gameData.awayScore} @ ${gameData.homeTeamName} ${gameData.homeScore} (FINAL)${resultTag}`);
    if (recap) sections.push(recap);
  } else if (!isBeforeNoon) {
    if (lastGameData?.final) {
      const result = favoriteResult(lastGameData, config.favoriteTeam);
      const resultTag = result === "W" ? " — WIN" : result === "L" ? " — LOSS" : "";
      const dhTag = lastGameData.doubleHeader ? ` (Game ${lastGameData.gameNumber} of doubleheader)` : "";
      sections.push(`Most recent completed game${dhTag}${tagOf(lastGameData)} (${formatShortDate(lastGameData.gameDate)}): ${lastGameData.awayTeamName} ${lastGameData.awayScore} @ ${lastGameData.homeTeamName} ${lastGameData.homeScore} (FINAL)${resultTag}`);
      if (recap) sections.push(recap);
    }
    if (gameData) {
      const probables = (gameData.awayProbable || gameData.homeProbable)
        ? ` Probable starters: ${gameData.awayProbable || "TBD"} vs ${gameData.homeProbable || "TBD"}.` : "";
      sections.push(`Next scheduled game${tagOf(gameData)}: ${gameData.awayTeamName} @ ${gameData.homeTeamName} on ${formatShortDate(gameData.gameDate)} at ${gameData.gameTime}${gameData.venue ? ` (${gameData.venue})` : ""}.${probables}`);
    }
  } else {
    sections.push(`${favName} had no game yesterday.`);
  }
  return sections;
}

// Returns { systemPrompt, userPrompt, webSearch } for the current phase.
function buildPrompts(ctx) {
  const { phase, fav, post, standingsContext, upcoming, transactions, leagueTransactions, standingsChanges, seasonEnd, nextSpring } = ctx;
  const favName = fav.name;
  const todayLine = `Today is ${new Date().toLocaleDateString([], { weekday: "long", year: "numeric", month: "long", day: "numeric" })}.`;
  const sections = [todayLine];

  const baseSystem = `You are writing for a passionate ${favName} fan — someone who watches most games and cares about the details. You know baseball deeply — strategy, sequencing, leverage, situational context, roster construction, contracts — and you write ABOUT specifics, not generic recaps. Keep the item_of_interest to 130 words or fewer — it's displayed on a small screen and gets cut off if it runs long. ${BANNED_PHRASES} Every sentence should contain a specific detail from the data provided.`;

  let systemPrompt, itemSpec, noteSpec, webSearch = false;

  if (phase === "offseason") {
    webSearch = ctx.webSearch;
    if (post?.champion) sections.push(`${post.champion.name} won the ${ctx.refSeason} World Series.`);
    if (seasonEnd) sections.push(seasonEnd);
    if (nextSpring) sections.push(`Spring training opens ${formatShortDate(nextSpring)} (${daysUntil(nextSpring)} days away).`);
    sections.push(transactions
      ? `Completed ${favName} transactions (last 30 days, official):\n${transactions}`
      : `No significant official ${favName} transactions in the last 30 days.`);
    if (leagueTransactions) sections.push(`Notable league-wide moves (last 7 days, official):\n${leagueTransactions}`);
    if (standingsContext) sections.push(standingsContext);

    systemPrompt = `${baseSystem} It's the MLB offseason — the conversation is the hot stove: trades, free-agent signings, contract decisions, and the rumors around them. Lead with ${favName} news. Treat the official transactions in the data as fact. ${webSearch ? `Use web search to find credible ${favName} trade and free-agent rumors and reporting from roughly the last two weeks (beat writers, national insiders). Attribute every rumor to its reporter or outlet, and make the done-deal vs. rumor distinction unmistakable ("reportedly", "per ..."). Never invent or embellish a rumor — if searching turns up nothing fresh, write about the concrete roster questions facing ${favName} instead.` : `You have no rumor feed — stick to official moves and the concrete roster questions facing ${favName}.`} Do not include URLs or citation markers in the JSON.`;
    itemSpec = `2–3 sentences on the most interesting ${favName} hot-stove item right now — a completed move and what it means, or a credible rumor and who is reporting it. MAX 130 WORDS.`;
    noteSpec = `one sentence on the biggest league-wide move or rumor NOT involving ${favName}, or null`;
  } else if (phase === "postseason" && post && post.favStatus !== "alive") {
    sections.push(...buildGameSections(ctx, "No playoff game"));
    const bracket = formatBracket(post);
    if (bracket) sections.push(bracket);
    if (seasonEnd) sections.push(seasonEnd);
    if (upcoming) sections.push(`Upcoming postseason games:\n${upcoming}`);
    if (transactions) sections.push(`Recent ${favName} moves (last 14 days):\n${transactions}`);

    const howItEnded = post.favStatus === "eliminated"
      ? `The ${favName}' season is over — they were eliminated in the ${post.lostSeries.name} by the ${post.lostSeries.winner?.name}.`
      : `${favName} missed the postseason.`;
    systemPrompt = `${baseSystem} ${howItEnded} The fan is still watching the playoffs as a baseball lover. Write playoff highlights: the specific plays, pitching performances, and managerial decisions from the featured game, and the bracket storylines. A light connection to ${favName} is welcome where it's natural (e.g., the team that knocked them out), but don't dwell on it or mope.`;
    itemSpec = `2–3 sentences of playoff analysis grounded in the specific game data above — concrete plays, innings, pitchers, and series stakes. If the game is upcoming, preview the matchup and what's at stake in the series. MAX 130 WORDS.`;
    noteSpec = `one sentence on the bracket — a series status, an elimination, or what's next — or null`;
  } else {
    // Regular season, spring training, or a postseason the favorite is still in
    sections.push(...buildGameSections(ctx, favName));
    if (phase === "postseason") {
      const current = post?.favSeries[post.favSeries.length - 1];
      if (current) sections.push(`${favName} current series — ${current.name} vs ${current.teamNames.find(n => n !== favName)}: ${current.result}\n${formatSeriesGames(current)}`.trim());
      const bracket = formatBracket(post);
      if (bracket) sections.push(bracket);
    }
    if (upcoming) sections.push(`Upcoming ${favName} schedule:\n${upcoming}`);
    if (standingsContext) sections.push(standingsContext);
    if (transactions) sections.push(`Recent ${favName} roster moves (last 5 days):\n${transactions}`);
    if (standingsChanges?.length) sections.push(`Notable standings shifts since last check:\n${standingsChanges.map(c => "- " + c).join("\n")}`);

    const playoffNote = phase === "postseason" ? ` It's the postseason and ${favName} are still alive — every game carries series stakes, so frame things in terms of the series.` : "";
    systemPrompt = `${baseSystem} Write with a fan's perspective: celebrate ${favName} wins with real emotion, feel losses honestly (but don't whine or blame umpires), and pay closer attention to what ${favName} players did specifically. Use the standings and upcoming schedule for context (the race, the next series, the stretch ahead) when they sharpen the point — not as filler.${playoffNote}`;
    itemSpec = `2–3 sentences of ACTUAL analysis grounded in the specific game data above, MAX 130 WORDS TOTAL — this must fit on a small screen without being cut off, so stay well under the limit rather than right at it. Reference concrete plays, innings, or player moments — not generic filler. If ${favName} won, celebrate the specific thing that won it. If they lost, name what actually went wrong. If the game's in progress, react to the current situation. If it's a preview, use the matchup, probables, and standings stakes.`;
    noteSpec = phase === "postseason"
      ? `one sentence on the series or the bracket as it affects ${favName}, or null`
      : `one sentence about the division or wild card race as it affects ${favName} (use the standings data — games back, recent form, upcoming opponents), or null if nothing worth mentioning`;
  }

  const userPrompt = sections.join("\n\n") + `

Respond in JSON only (no markdown fences, no extra text):
{
  "item_of_interest": "<${itemSpec}>",
  "standings_note": "<${noteSpec}>"
}`;
  return { systemPrompt, userPrompt, webSearch };
}

async function getInsight(ctx, cache) {
  const { config, phase } = ctx;
  const todayStr = today();
  // Offseason news moves slower and each call runs web searches — default to fewer calls
  const maxRequests = phase === "offseason"
    ? Math.min(config.maxDailyRequests || 4, config.offseasonDailyRequests || 2)
    : (config.maxDailyRequests || 4);

  const usageDate = cache.usageDate || "";
  const usageCount = usageDate === todayStr ? (cache.usageCount || 0) : 0;

  // A change of situation (e.g. eliminated, World Series over) skips the time
  // throttle so the insight doesn't keep talking about the old context for hours.
  const contextChanged = cache.lastContextKey !== ctx.contextKey;
  const minInterval = DAY_MS / maxRequests;
  const timeSinceLast = Date.now() - (cache.lastAiCallTime || 0);
  const tooSoon = timeSinceLast < minInterval && !contextChanged;

  if (usageCount >= maxRequests || tooSoon) {
    return {
      insight: cache.lastInsight || null,
      standingsBullet: cache.lastStandingsBullet || null,
      rateLimited: usageCount >= maxRequests,
      usageCount, usageDate: todayStr,
      contextKey: cache.lastContextKey,
    };
  }

  const { systemPrompt, userPrompt, webSearch } = buildPrompts(ctx);
  if (config.debugPrompts) console.log(`MMM-MLB prompt [${phase}]:\n--- system ---\n${systemPrompt}\n--- user ---\n${userPrompt}`);

  try {
    const result = await callClaude(config.anthropicApiKey, systemPrompt, userPrompt, { webSearch });
    return {
      insight: truncateWords(result.item_of_interest, 130),
      standingsBullet: result.standings_note && result.standings_note !== "null" ? result.standings_note : null,
      rateLimited: false,
      usageCount: usageCount + 1,
      usageDate: todayStr,
      lastAiCallTime: Date.now(),
      contextKey: ctx.contextKey,
    };
  } catch (err) {
    console.error("MMM-MLB: Claude API error:", err.message);
    return {
      insight: cache.lastInsight || null,
      standingsBullet: cache.lastStandingsBullet || null,
      rateLimited: false, error: err.message,
      usageCount, usageDate: todayStr,
      contextKey: cache.lastContextKey,
    };
  }
}

// ── Season phase ───────────────────────────────────────────────────────────

// phase: "offseason" | "spring" | "regular" | "postseason"
// refSeason: the season whose standings/bracket are the story right now
// (in January that's last year's).
async function determinePhase() {
  const year = new Date().getFullYear();
  const t = today();
  const info = await fetchSeasonInfo(year);
  if (!info) return { phase: "regular", refSeason: year, seasonInfo: null };

  if (t < info.springStartDate) {
    return { phase: "offseason", refSeason: year - 1, seasonInfo: await fetchSeasonInfo(year - 1), nextSpring: info.springStartDate };
  }
  if (t < info.regularSeasonStartDate) return { phase: "spring", refSeason: year, seasonInfo: info };
  if (t <= info.regularSeasonEndDate) return { phase: "regular", refSeason: year, seasonInfo: info };

  // After the regular season: postseason until the World Series is decided
  const nextInfo = await fetchSeasonInfo(year + 1);
  const nextSpring = nextInfo?.springStartDate || null;
  if (t > info.postSeasonEndDate) return { phase: "offseason", refSeason: year, seasonInfo: info, nextSpring };
  return { phase: "postseason", refSeason: year, seasonInfo: info, nextSpring };   // may flip to offseason once the bracket is checked
}

// How the favorite's season ended, for postseason/offseason prompts
function describeSeasonEnd(favTeamId, favName, standings, post) {
  const tr = (standings?.records || []).flatMap(r => r.teamRecords || []).find(x => x.team.id === favTeamId);
  const record = tr ? `${tr.wins}-${tr.losses}, ${divisionGamesBackText(tr)} in the ${tr.team.division?.name || "division"}` : null;
  const parts = [];
  if (record) parts.push(`${favName} regular season: ${record}.`);
  if (post?.favStatus === "eliminated") {
    const s = post.lostSeries;
    const won = post.favSeries.filter(x => x.isOver && x.winner?.id === favTeamId).map(x => `won the ${x.name} vs ${x.teamNames.find(n => n !== favName)}`);
    if (won.length) parts.push(`${favName} ${won.join(", then ")}.`);
    parts.push(`Eliminated in the ${s.name} by the ${s.winner?.name} (${s.result}):\n${formatSeriesGames(s)}`);
  } else if (post?.favStatus === "missed") {
    parts.push(`${favName} missed the postseason.`);
  } else if (post?.favStatus === "alive" && post.champion?.id === favTeamId) {
    parts.push(`${favName} WON THE WORLD SERIES.`);
  }
  return parts.length ? parts.join("\n") : null;
}

function isPlayed(game) {
  return !/postponed|cancel|suspended/i.test(game.status?.detailedState || "");
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
    const favId = config.favoriteTeam;

    // ── Where are we in the year? ──
    const phaseInfo = await determinePhase();
    let { phase } = phaseInfo;
    const { refSeason, seasonInfo, nextSpring } = phaseInfo;

    if (!this.team || this.team.id !== favId) {
      this.team = await fetchTeam(favId).catch(() => null);
    }

    // ── Postseason bracket (also tells us whether the World Series is over) ──
    let post = null;
    if ((phase === "postseason" || phase === "offseason") && seasonInfo) {
      const postGames = (await fetchPostseasonGames(seasonInfo).catch(err => {
        console.warn("MMM-MLB: postseason:", err.message); return [];
      })).filter(isPlayed);
      if (postGames.length) {
        post = analyzePostseason(postGames, favId);
        post.games = postGames;
        if (phase === "postseason" && post.isComplete) phase = "offseason";
      }
    }

    // ── Favorite team schedule window (empty in the offseason) ──
    const wideStart = daysAgo(2);
    const wideEnd = daysFromNow(14);
    const teamGames = phase === "offseason" ? [] : flattenGames(await fetchScheduleRange(wideStart, wideEnd, favId)).filter(isPlayed);

    // Which games are "the story": the favorite's, or — once they're out — the whole bracket's
    const followingBracket = phase === "postseason" && post && post.favStatus !== "alive";
    const pool = phase === "offseason" ? [] : followingBracket ? post.games : teamGames;

    const liveGame = gameToData(pickGame(pool, "live"));
    const mostRecentFinal = gameToData(pickGame(pool, "mostRecentFinal"));
    const nextGame = gameToData(pickGame(pool, "nextScheduled"));

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
      gameData = nextGame || (followingBracket ? mostRecentFinal : null);
      lastGameData = gameData === mostRecentFinal ? null : mostRecentFinal;
    }

    // ── Rich recap for the AI (uses whichever game is "the story" right now) ──
    const recapTarget = liveGame ? liveGame : (mostRecentFinal || gameData);
    let recap = null;
    if (recapTarget?.gamePk && phase !== "offseason") {
      recap = await fetchGameRecap(recapTarget).catch(err => {
        console.warn("MMM-MLB: recap failed:", err.message); return null;
      });
    }

    // ── Standings + transactions in parallel (windows depend on the phase) ──
    const standingsSeason = phase === "spring" ? refSeason - 1 : refSeason;
    const [currentStandings, favTx, leagueTx] = await Promise.all([
      fetchStandings(standingsSeason).catch(err => { console.warn("MMM-MLB: standings:", err.message); return null; }),
      fetchTransactions(favId, phase === "offseason" ? 30 : phase === "postseason" ? 14 : 5),
      phase === "offseason" ? fetchTransactions(null, 7) : Promise.resolve([]),
    ]);

    const favName = this.team?.name || resolveFavorite(favId, gameData, lastGameData).name;
    const fav = { name: favName, abbr: this.team?.abbr || "?" };

    const standingsChanges = phase === "regular" ? summarizeStandingsChanges(currentStandings, cache.previousStandings) : [];
    const transactions = phase === "regular" || phase === "spring"
      ? formatTransactions(favTx.slice(0, 10))
      : formatTransactions(filterSignificantTransactions(favTx, { limit: 20 }), { withDates: true });
    const leagueTransactions = formatTransactions(
      filterSignificantTransactions(leagueTx.filter(t => t.toTeam?.id !== favId && t.fromTeam?.id !== favId), { strict: true, limit: 25 }),
      { withDates: true });

    const standingsContext = formatStandingsContext(currentStandings, favId, {
      label: phase === "regular" ? "Current standings" : `Final ${standingsSeason} regular-season standings`,
      includeRace: phase === "regular",
    });
    const upcoming = phase === "offseason" ? null : formatUpcomingSchedule(followingBracket ? post.games : teamGames, favId);
    const seasonEnd = (phase === "postseason" && post?.favStatus !== "alive") || phase === "offseason"
      ? describeSeasonEnd(favId, favName, currentStandings, post) : null;

    // ── Frontend headline / context line ──
    let headline = null;
    let contextLine = null;
    if (phase === "offseason") {
      headline = "OFFSEASON";
      const parts = [];
      if (post?.champion) parts.push(`${post.champion.name} — ${refSeason} champions`);
      if (nextSpring) {
        const n = daysUntil(nextSpring);
        if (n > 0) parts.push(`Spring training in ${n} day${n === 1 ? "" : "s"}`);
      }
      contextLine = parts.join("  ·  ") || null;
    } else if (gameData?.isPostseason && post) {
      // Short form keeps the label on one line at 270px: "WS GAME 1", "ALCS GAME 6"
      const abbr = gameData.seriesAbbr || gameData.seriesName;
      headline = abbr ? `${abbr}${gameData.seriesGameNumber ? ` GAME ${gameData.seriesGameNumber}` : ""}`.toUpperCase() : null;
      const s = post.series.find(x => x.key === gameData.seriesKey);
      if (s) contextLine = `${s.name}: ${s.result}`;
    } else if (phase === "postseason" && post && !gameData) {
      headline = "POSTSEASON";
    }

    // ── AI insight ──
    const contextKey = `${phase}:${post?.favStatus || "-"}:${post?.isComplete ? "done" : "-"}`;
    const insightResult = await getInsight({
      config, phase, refSeason, fav, isBeforeNoon, gameData, lastGameData, liveState, recap,
      transactions, leagueTransactions, standingsChanges, standingsContext, upcoming, post,
      seasonEnd, nextSpring, contextKey,
      webSearch: config.webSearch !== false,
    }, cache);

    // ── Persist cache ──
    const madeCall = !!insightResult.lastAiCallTime;
    saveCache({
      usageDate: insightResult.usageDate,
      usageCount: insightResult.usageCount,
      lastAiCallTime: insightResult.lastAiCallTime || cache.lastAiCallTime,
      lastInsight: insightResult.insight || cache.lastInsight,
      // A fresh call that returned no note clears the old one (it may be from another phase)
      lastStandingsBullet: madeCall ? insightResult.standingsBullet : cache.lastStandingsBullet,
      lastContextKey: insightResult.contextKey,
      previousStandings: phase === "regular" ? (currentStandings || cache.previousStandings) : cache.previousStandings,
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
      phase,
      headline,
      contextLine,
    });
  },
});
