# MMM-MLB

A MagicMirror² module that displays Major League Baseball events with AI-powered insights, powered by the Claude API.

## What it shows

**Before noon** — Yesterday's game result:
- Team logos and final score
- AI-selected highlight: standout player performance, or a relevant roster/injury headline
- Optional standings note if something notable shifted

**After noon** — The next upcoming game:
- Opponent logos, game time, and venue
- AI insight: recent player news, matchup angle, or roster context
- Optional standings note

The AI is prompted to think like an educated baseball fan — not a fantasy enthusiast. Its context includes the full division table (L10, streak, run differential), the league wild card race, and the next week of games.

### Postseason and offseason

The module reads MLB's season calendar and adapts:

| Situation | Game card | AI insight |
|---|---|---|
| **Postseason, your team alive** | Your team's game, labeled with the round ("ALDS GAME 3") plus series status | Framed around series stakes, with the bracket as context |
| **Postseason, your team eliminated or missed** | The featured playoff game league-wide (live → yesterday's → next) | Playoff highlights from that game's play-by-play and the bracket, with a light connection to your team |
| **Offseason** (World Series over → spring training) | None — "OFFSEASON", the champion, and a spring training countdown | Hot-stove: your team's official transactions (30 days), notable league-wide trades and signings, and trade/free-agent rumors found via Claude web search |

## Installation

```bash
cd ~/MagicMirror/modules
git clone https://github.com/your-username/MMM-MLB
cd MMM-MLB
npm install
```

## Configuration

Add to your `config/config.js`:

```js
{
  module: "MMM-MLB",
  position: "top_right",
  config: {
    favoriteTeam: 147,          // MLB team ID (see table below)
    anthropicApiKey: "sk-ant-...",
    maxDailyRequests: 4,        // Max Claude API calls per day (auto-throttled)
    updateInterval: 1800000,    // Full data refresh in ms (default: 30 min)
    liveRefreshInterval: 30000, // Live game polling in ms (default: 30 sec)
    moduleWidth: 270,           // Width in px — match to your MagicMirror column width
  }
}
```

### Configuration options

| Option | Default | Description |
|---|---|---|
| `favoriteTeam` | `147` | MLB team ID |
| `anthropicApiKey` | `""` | Your Anthropic API key (required) |
| `maxDailyRequests` | `4` | Max Claude calls per calendar day. Calls are automatically spread evenly across 24h so they aren't burned in the first few refreshes. |
| `updateInterval` | `1800000` | Full data refresh interval (ms). |
| `liveRefreshInterval` | `30000` | How often to poll score/count/outs during a live game (ms). Does not trigger AI. |
| `moduleWidth` | `270` | Module width in pixels. Set this to match your MagicMirror column. |
| `webSearch` | `true` | In the offseason, let Claude search the web for trade and signing rumors. Requires web search to be enabled for your organization in the Claude Console. Set `false` to use official transactions only. |
| `offseasonDailyRequests` | `2` | Daily Claude call cap during the offseason (each call runs up to 4 web searches). |
| `debugPrompts` | `false` | Log the full prompt sent to Claude in the MagicMirror server log. |

### Team IDs

| Team | ID | Team | ID |
|---|---|---|---|
| Arizona Diamondbacks | 109 | Miami Marlins | 146 |
| Atlanta Braves | 144 | Milwaukee Brewers | 158 |
| Baltimore Orioles | 110 | Minnesota Twins | 142 |
| Boston Red Sox | 111 | New York Mets | 121 |
| Chicago Cubs | 112 | **New York Yankees** | **147** |
| Chicago White Sox | 145 | Oakland Athletics | 133 |
| Cincinnati Reds | 113 | Philadelphia Phillies | 143 |
| Cleveland Guardians | 114 | Pittsburgh Pirates | 134 |
| Colorado Rockies | 115 | San Diego Padres | 135 |
| Detroit Tigers | 116 | San Francisco Giants | 137 |
| Houston Astros | 117 | Seattle Mariners | 136 |
| Kansas City Royals | 118 | St. Louis Cardinals | 138 |
| Los Angeles Angels | 108 | Tampa Bay Rays | 139 |
| Los Angeles Dodgers | 119 | Texas Rangers | 140 |
| | | Toronto Blue Jays | 141 |
| | | Washington Nationals | 120 |

## Data sources

- **MLB Stats API** — Season calendar, schedule, postseason bracket, box scores, standings, transactions (free, no auth required)
- **Team logos** — `mlbstatic.com` CDN (SVG, full color)
- **AI insights** — Claude API (`claude-opus-5-5`), with the web search tool in the offseason

## Cost control

The `maxDailyRequests` setting caps daily Claude API calls. Once the limit is reached, the module continues displaying the most recently generated insight without making new API calls. The counter resets each calendar day. A small notice is shown at the bottom when the limit is active. When the situation changes (e.g. your team is eliminated, or the World Series ends), the next refresh makes a fresh call right away instead of waiting out the throttle interval.

Offseason calls with web search cost more (search fees plus the search results as input tokens), which is why `offseasonDailyRequests` defaults to 2.

With 4 calls/day at typical prompt sizes (~1K input tokens, ~100 output tokens), monthly cost is roughly **$0.30–$0.60** depending on usage.

## Cache file

A `.mlb-cache.json` file is stored in the module directory. It holds:
- Daily usage counter
- Last generated insight (fallback when rate-limited)
- Previous day's standings (for change detection)

This file is listed in `.gitignore`.
