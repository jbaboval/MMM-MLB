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

The AI is prompted to think like an educated baseball fan — not a fantasy enthusiast.

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
  position: "top_left",
  config: {
    favoriteTeam: 147,          // MLB team ID (see table below)
    anthropicApiKey: "sk-ant-...",
    maxDailyRequests: 4,        // Max Claude API calls per day (cost control)
    updateInterval: 1800000,    // Data refresh in ms (default: 30 min)
  }
}
```

### Configuration options

| Option | Default | Description |
|---|---|---|
| `favoriteTeam` | `147` | MLB team ID |
| `anthropicApiKey` | `""` | Your Anthropic API key (required) |
| `maxDailyRequests` | `4` | Max Claude calls per calendar day. Cached insight is shown once limit is reached. |
| `updateInterval` | `1800000` | How often to refresh data (ms). |

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

- **MLB Stats API** — Schedule, box scores, standings, transactions (free, no auth required)
- **Team logos** — `mlbstatic.com` CDN (SVG, full color)
- **AI insights** — Claude API (`claude-opus-4-6`)

## Cost control

The `maxDailyRequests` setting caps daily Claude API calls. Once the limit is reached, the module continues displaying the most recently generated insight without making new API calls. The counter resets each calendar day. A small notice is shown at the bottom when the limit is active.

With 4 calls/day at typical prompt sizes (~1K input tokens, ~100 output tokens), monthly cost is roughly **$0.30–$0.60** depending on usage.

## Cache file

A `.mlb-cache.json` file is stored in the module directory. It holds:
- Daily usage counter
- Last generated insight (fallback when rate-limited)
- Previous day's standings (for change detection)

This file is listed in `.gitignore`.
