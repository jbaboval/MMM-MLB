/* MMM-MLB.js — Front-end MagicMirror module */
Module.register("MMM-MLB", {

  defaults: {
    favoriteTeam: 147,           // MLB team ID (147 = Yankees; see README for all IDs)
    anthropicApiKey: "",         // Your Anthropic API key
    maxDailyRequests: 4,         // Max Claude API calls per calendar day
    updateInterval: 30 * 60 * 1000,   // Data refresh interval (30 min)
    noonCheckInterval: 60 * 1000,     // How often to check for noon crossover (1 min)
  },

  start() {
    this.loaded = false;
    this.displayData = null;
    this.error = null;
    this.lastNoonState = null;

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
      this.updateDom(300);
    } else if (notification === "MMM_MLB_ERROR") {
      this.error = payload.error;
      this.loaded = true;
      this.updateDom(300);
    }
  },

  getDom() {
    const wrapper = document.createElement("div");
    wrapper.className = "MMM-MLB";
    wrapper.style.cssText = "width:100%;overflow:hidden;position:relative;";

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
    label.textContent = d.isBeforeNoon ? "YESTERDAY" : "UPCOMING";
    wrapper.appendChild(label);

    // ── Game card ──────────────────────────────────────────
    if (d.gameData) {
      const card = document.createElement("div");
      card.className = "mlb-game-card";
      card.style.cssText = "display:flex;flex-direction:row;align-items:center;justify-content:space-between;width:100%;overflow:hidden;margin-bottom:10px;";

      // Away team column
      card.appendChild(this.buildTeamCol(
        d.gameData.awayTeamId,
        d.gameData.awayTeamAbbr,
        d.isBeforeNoon && d.gameData.final ? d.gameData.awayScore : null,
        d.gameData.awayWin
      ));

      // Centre column — score divider or game time
      const centre = document.createElement("div");
      centre.className = "mlb-centre";
      if (d.isBeforeNoon && d.gameData.final) {
        const statusEl = document.createElement("div");
        statusEl.className = "mlb-status";
        statusEl.textContent = d.gameData.status || "FINAL";
        centre.appendChild(statusEl);
      } else if (!d.isBeforeNoon) {
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
      } else {
        const statusEl = document.createElement("div");
        statusEl.className = "mlb-status";
        statusEl.textContent = d.gameData.status || "";
        centre.appendChild(statusEl);
      }
      card.appendChild(centre);

      // Home team column
      card.appendChild(this.buildTeamCol(
        d.gameData.homeTeamId,
        d.gameData.homeTeamAbbr,
        d.isBeforeNoon && d.gameData.final ? d.gameData.homeScore : null,
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

    // ── Last game note (afternoon only) ───────────────────
    if (!d.isBeforeNoon && d.lastGameData && d.lastGameData.final) {
      const lg = d.lastGameData;
      const lgEl = document.createElement("div");
      lgEl.className = "mlb-last-game";
      lgEl.textContent = `Last Game: ${lg.awayTeamAbbr} ${lg.awayScore} – ${lg.homeTeamAbbr} ${lg.homeScore}`;
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
    col.style.cssText = "display:flex;flex-direction:column;align-items:center;width:80px;max-width:80px;overflow:hidden;gap:4px;opacity:" + (isWinner ? "1" : "0.7") + ";";

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
