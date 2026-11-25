/* MMM-MLB.js — Front-end MagicMirror module */
Module.register("MMM-MLB", {

  defaults: {
    favoriteTeam: 147,           // MLB team ID (147 = Yankees; see README for all IDs)
    anthropicApiKey: "",         // Your Anthropic API key
    aiUpdateTimes: ["06:00", "16:30"], // Local times a fresh Claude insight is generated
    maxDailyRequests: 2,         // Hard cap on Claude API calls per calendar day (failed calls count)
    updateInterval: 30 * 60 * 1000,   // Full data refresh interval (30 min)
    liveRefreshInterval: 30 * 1000,   // Live game score/count polling (30 sec)
    noonCheckInterval: 60 * 1000,     // How often to check for noon crossover (1 min)
    moduleWidth: 270,                 // Width in pixels — set to match your column
    webSearch: true,                  // Offseason: let Claude web-search for trade/signing rumors
    debugPrompts: false,              // Log the full prompt sent to Claude (server log)
  },

  start() {
    this.loaded = false;
    this.displayData = null;
    this.error = null;
    this.lastNoonState = null;
    this.liveInterval = null;
    this.liveGamePk = null;

    this.fetchData();
    setInterval(() => this.fetchData(), this.config.updateInterval);
    setInterval(() => this.checkNoonCrossover(), this.config.noonCheckInterval);
  },

  checkNoonCrossover() {
    const isBeforeNoon = new Date().getHours() < 12;
    if (this.lastNoonState !== null && this.lastNoonState !== isBeforeNoon) {
      this.fetchData();
    }
    this.lastNoonState = isBeforeNoon;
  },

  fetchData() {
    this.sendSocketNotification("MMM_MLB_FETCH", { config: this.config });
  },

  socketNotificationReceived(notification, payload) {
    if (notification === "MMM_MLB_DATA") {
      this.displayData = payload;
      this.error = null;
      this.loaded = true;
      if (payload.gameData && payload.gameData.isLive) {
        this.startLivePolling(payload.gameData.gamePk);
      } else {
        this.stopLivePolling();
      }
      this.updateDom(300);
    } else if (notification === "MMM_MLB_LIVE") {
      if (this.displayData) {
        this.displayData.liveState = payload.liveState;
        // Mirror scores into gameData for buildTeamCol
        if (this.displayData.gameData && payload.liveState) {
          this.displayData.gameData.awayScore = payload.liveState.awayScore;
          this.displayData.gameData.homeScore = payload.liveState.homeScore;
        }
        this.updateDom(0);
      }
    } else if (notification === "MMM_MLB_ERROR") {
      this.error = payload.error;
      this.loaded = true;
      this.updateDom(300);
    }
  },

  startLivePolling(gamePk) {
    if (this.liveGamePk === gamePk && this.liveInterval) return;
    this.stopLivePolling();
    this.liveGamePk = gamePk;
    this.liveInterval = setInterval(() => {
      this.sendSocketNotification("MMM_MLB_FETCH_LIVE", { gamePk });
    }, this.config.liveRefreshInterval);
  },

  stopLivePolling() {
    if (this.liveInterval) {
      clearInterval(this.liveInterval);
      this.liveInterval = null;
    }
    this.liveGamePk = null;
  },

  getDom() {
    const wrapper = document.createElement("div");
    wrapper.className = "MMM-MLB";
    wrapper.style.cssText = `width:${this.config.moduleWidth}px;overflow:hidden;position:relative;`;

    if (!this.loaded) {
      const loading = document.createElement("div");
      loading.className = "mlb-loading";
      loading.textContent = "Loading MLB data…";
      wrapper.appendChild(loading);
      return wrapper;
    }

    if (this.error) {
      const errEl = document.createElement("div");
      errEl.className = "mlb-error";
      errEl.textContent = this.error;
      wrapper.appendChild(errEl);
      return wrapper;
    }

    const d = this.displayData;

    // ── Section label ──────────────────────────────────────
    const label = document.createElement("div");
    label.className = "mlb-label";
    const isLive = d.gameData && d.gameData.isLive;
    const isOffseason = d.phase === "offseason";
    let labelText;
    if (isOffseason) {
      labelText = d.headline || "OFFSEASON";
    } else {
      labelText = isLive ? "● LIVE" : this.dayLabel(d.gameData, d.isBeforeNoon);
      if (d.headline) labelText += `  ·  ${d.headline}`;
      if (d.gameData && d.gameData.doubleHeader) {
        labelText += `  ·  GAME ${d.gameData.gameNumber} OF 2`;
      }
    }
    label.textContent = labelText;
    if (isLive) label.style.color = "#e03030";
    wrapper.appendChild(label);

    // ── Game card ──────────────────────────────────────────
    if (isOffseason) {
      // No game card in the offseason — the context line and insight carry it
    } else if (d.gameData) {
      const card = document.createElement("div");
      card.className = "mlb-game-card";
      card.style.cssText = "display:flex;flex-direction:row;align-items:center;justify-content:space-between;width:100%;overflow:hidden;margin-bottom:10px;";

      const showScore = d.gameData.final || isLive;
      // Away team column
      card.appendChild(this.buildTeamCol(
        d.gameData.awayTeamId,
        d.gameData.awayTeamAbbr,
        showScore ? d.gameData.awayScore : null,
        d.gameData.awayWin
      ));

      // Centre column
      const centre = document.createElement("div");
      centre.className = "mlb-centre";
      if (isLive && d.liveState) {
        const half = d.liveState.isTopInning ? "TOP" : "BOT";
        const inningEl = document.createElement("div");
        inningEl.className = "mlb-gametime";
        inningEl.textContent = `${half} ${d.liveState.inningOrdinal}`;
        centre.appendChild(inningEl);
      } else if (d.gameData.final) {
        const statusEl = document.createElement("div");
        statusEl.className = "mlb-status";
        statusEl.textContent = "FINAL";
        centre.appendChild(statusEl);
      } else {
        const timeEl = document.createElement("div");
        timeEl.className = "mlb-gametime";
        timeEl.textContent = d.gameData.gameTime || "TBD";
        centre.appendChild(timeEl);
        if (d.gameData.venue) {
          const venueEl = document.createElement("div");
          venueEl.className = "mlb-venue";
          venueEl.textContent = d.gameData.venue;
          centre.appendChild(venueEl);
        }
      }
      card.appendChild(centre);

      // Home team column
      card.appendChild(this.buildTeamCol(
        d.gameData.homeTeamId,
        d.gameData.homeTeamAbbr,
        showScore ? d.gameData.homeScore : null,
        d.gameData.homeWin
      ));

      wrapper.appendChild(card);
    } else {
      const noGame = document.createElement("div");
      noGame.className = "mlb-no-game";
      noGame.textContent = d.isBeforeNoon
        ? "No game yesterday"
        : "No upcoming game scheduled";
      wrapper.appendChild(noGame);
    }

    // ── Context line (series status / champion + spring countdown) ──
    if (d.contextLine) {
      const ctxEl = document.createElement("div");
      ctxEl.className = "mlb-context-line";
      ctxEl.textContent = d.contextLine;
      wrapper.appendChild(ctxEl);
    }

    // ── Live count / outs row ──────────────────────────────
    if (isLive && d.liveState) {
      const ls = d.liveState;
      const countEl = document.createElement("div");
      countEl.className = "mlb-count";
      const outsLabel = ls.outs === 1 ? "1 out" : `${ls.outs} outs`;
      countEl.textContent = `${ls.balls}–${ls.strikes} count  ·  ${outsLabel}`;
      wrapper.appendChild(countEl);
    }

    // ── Last game note (afternoon only) ───────────────────
    if (!d.isBeforeNoon && d.lastGameData && d.lastGameData.final) {
      const lg = d.lastGameData;
      const lgEl = document.createElement("div");
      lgEl.className = "mlb-last-game";
      const dhSuffix = lg.doubleHeader ? ` (G${lg.gameNumber})` : "";
      lgEl.textContent = `Last Game${dhSuffix}: ${lg.awayTeamAbbr} ${lg.awayScore} – ${lg.homeTeamAbbr} ${lg.homeScore}`;
      wrapper.appendChild(lgEl);
    }

    // ── AI insight ─────────────────────────────────────────
    if (d.insight) {
      const divider = document.createElement("div");
      divider.className = "mlb-divider";
      wrapper.appendChild(divider);

      const insightEl = document.createElement("div");
      insightEl.className = "mlb-insight";
      insightEl.textContent = d.insight;
      wrapper.appendChild(insightEl);
    }

    // ── Standings bullet ───────────────────────────────────
    if (d.standingsBullet) {
      const standingsEl = document.createElement("div");
      standingsEl.className = "mlb-standings-bullet";
      standingsEl.textContent = "• " + d.standingsBullet;
      wrapper.appendChild(standingsEl);
    }

    // ── Rate limit notice (shown only when limit reached) ──
    if (d.rateLimited) {
      const rlEl = document.createElement("div");
      rlEl.className = "mlb-rate-notice";
      rlEl.textContent = "⚡ Daily AI limit reached — showing cached insight";
      wrapper.appendChild(rlEl);
    }

    return wrapper;
  },

  // "YESTERDAY" / "LAST GAME" for finals; "TODAY" / "TOMORROW" / "FRI 10/23" for upcoming
  dayLabel(gameData, isBeforeNoon) {
    if (!gameData || !gameData.gameDate) return isBeforeNoon ? "YESTERDAY" : "UPCOMING";
    const ymd = (offset) => {
      const dt = new Date();
      dt.setDate(dt.getDate() + offset);
      return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
    };
    if (gameData.final) {
      if (gameData.gameDate === ymd(0)) return "TODAY";
      return gameData.gameDate === ymd(-1) ? "YESTERDAY" : "LAST GAME";
    }
    if (gameData.gameDate === ymd(0)) return "TODAY";
    if (gameData.gameDate === ymd(1)) return "TOMORROW";
    const [y, m, day] = gameData.gameDate.split("-").map(Number);
    const weekday = new Date(y, m - 1, day).toLocaleDateString([], { weekday: "short" }).toUpperCase();
    return `${weekday} ${m}/${day}`;
  },

  buildTeamCol(teamId, abbr, score, isWinner) {
    const col = document.createElement("div");
    col.className = "mlb-team-col" + (isWinner ? " mlb-winner" : "");
    // Layout only — opacity handled by CSS so it can be tuned in one place
    col.style.cssText = "display:flex;flex-direction:column;align-items:center;width:80px;max-width:80px;overflow:hidden;gap:4px;";

    const logo = document.createElement("img");
    logo.className = "mlb-logo";
    // Set HTML attributes — these take effect before CSS loads and cannot be overridden by SVG intrinsic size
    logo.setAttribute("width", "52");
    logo.setAttribute("height", "52");
    logo.style.cssText = "display:block;width:52px;height:52px;max-width:52px;max-height:52px;object-fit:contain;flex-shrink:0;";
    logo.src = `https://www.mlbstatic.com/team-logos/${teamId}.svg`;
    logo.alt = abbr;
    col.appendChild(logo);

    const name = document.createElement("div");
    name.className = "mlb-team-abbr";
    name.textContent = abbr;
    col.appendChild(name);

    if (score !== null && score !== undefined) {
      const scoreEl = document.createElement("div");
      scoreEl.className = "mlb-score";
      scoreEl.textContent = score;
      col.appendChild(scoreEl);
    }

    return col;
  },

  getStyles() {
    return ["css/MMM-MLB.css"];
  },
});
