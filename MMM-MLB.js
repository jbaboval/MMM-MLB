/* MMM-MLB.js — Front-end MagicMirror module */
Module.register("MMM-MLB", {

  defaults: {
    favoriteTeam: 147,           // MLB team ID (147 = Yankees; see README for all IDs)
    anthropicApiKey: "",         // Your Anthropic API key
    maxDailyRequests: 4,         // Max Claude API calls per calendar day (auto-throttled)
    updateInterval: 30 * 60 * 1000,   // Full data refresh interval (30 min)
    liveRefreshInterval: 30 * 1000,   // Live game score/count polling (30 sec)
    noonCheckInterval: 60 * 1000,     // How often to check for noon crossover (1 min)
    moduleWidth: 270,                 // Width in pixels — set to match your column
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
    let labelText = isLive ? "● LIVE" : (d.isBeforeNoon ? "YESTERDAY" : "UPCOMING");
    if (d.gameData && d.gameData.doubleHeader) {
      labelText += `  ·  GAME ${d.gameData.gameNumber} OF 2`;
    }
    label.textContent = labelText;
    if (isLive) label.style.color = "#e03030";
    wrapper.appendChild(label);

    // ── Game card ──────────────────────────────────────────
    if (d.gameData) {
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
