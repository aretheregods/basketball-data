import fs from 'fs/promises';
import path from 'path';
import { HTTPClient } from '#utils';
import { BblHarvester } from './harvesters/BblHarvester.mjs';

/**
 * @description Scraper for German Basketball Bundesliga (BBL) domestic competition.
 * Fetches, caches, parses, and normalizes BBL game box score stats from the BBL REST API.
 */
export class BblScraper extends HTTPClient {
	/**
	 * @constructor
	 */
	constructor() {
		super('https://api.basketball-bundesliga.de');
		this.harvester = new BblHarvester(this);
		this.gameSlugs = [];
		this.bypassNetwork = process.env.NODE_ENV === 'test';
	}

	/**
	 * @description Fetches all game slugs/IDs for BBL for a given season.
	 * @param {string|number} year - The season year
	 * @returns {Promise<string[]>} List of game slugs
	 */
	async getSeasonGameSlugs(year) {
		const slugs = await this.harvester.getSeasonGameSlugs(year);
		this.gameSlugs = slugs;
		return slugs;
	}

	/**
	 * @description Parses the competition, season, and gamecode from a BBL gameId.
	 * BBL game ID is formatted as matchup-D{season}_{gameCode}, e.g. fc-bayern-vs-alba-berlin-D2026_48210.
	 * @param {string} gameId
	 * @returns {{ competitionId: string, seasonCode: string, gameCode: string, yearPrefix: string }}
	 */
	parseGameId(gameId) {
		const clean = String(gameId || '').trim();
		const parts = clean.split('_');
		const gameCode = parts[1] || '1';
		const keyPart = parts[0] || 'D2026';

		// Extract season code segment from keyPart, e.g. "D2026" -> "2026" or "matchup-D2026" -> "2026"
		const segmentMatch = keyPart.match(/(?:-)?D(\d{4})$/i);
		const seasonCode = segmentMatch ? segmentMatch[1] : '2026';
		const yearPrefix = seasonCode;

		return {
			competitionId: 'bbl',
			seasonCode,
			gameCode,
			yearPrefix
		};
	}

	/**
	 * @description Returns the complete Game page URL for the given game ID.
	 * @param {string} gameId
	 * @returns {string} Game page URL
	 */
	getGameEndpoint(gameId) {
		const { gameCode } = this.parseGameId(gameId);
		return `https://api.basketball-bundesliga.de/games/${gameCode}/stats`;
	}

	/**
	 * @description Returns the game ID itself.
	 * @param {string} gameId
	 * @returns {string}
	 */
	getGameUrl(gameId) {
		return gameId;
	}

	/**
	 * @description Formats unified box score by loading match center page via direct API fetch and parsing JSON.
	 * @param {string} gameId - Combined game identifier, e.g. 'matchup-D2026_48210'
	 * @returns {Promise<Object>} Unified Europe BoxScore response
	 */
	async getUnifiedBoxScore(gameId) {
		const { competitionId, yearPrefix, gameCode } = this.parseGameId(gameId);

		// If in test mode, bypass real network calls and return mock data
		if (this.bypassNetwork) {
			return this.getMockUnifiedBoxScore(gameId);
		}

		const matchUrl = this.getGameEndpoint(gameId);
		console.log(`📡 [BblScraper] Loading BBL Boxscore from BBL API ${matchUrl}...`);

		// Set up directories for side-cache JSON saving
		const jsonCacheDir = path.resolve('data/raw/europe/bbl', String(yearPrefix));
		await fs.mkdir(jsonCacheDir, { recursive: true });
		const jsonCachePath = path.join(jsonCacheDir, `${gameCode}.json`);

		let jsonContent = '';
		try {
			// Check if we already have the raw JSON cached locally
			const stats = await fs.stat(jsonCachePath);
			if (stats.size > 0) {
				console.log(`⏭️ [BblScraper] JSON cache found for game ${gameCode}. Reading from disk...`);
				jsonContent = await fs.readFile(jsonCachePath, 'utf8');
			}
		} catch (e) {
			// Cache miss, proceed to fetch
		}

		let rawData = null;
		if (jsonContent) {
			try {
				rawData = JSON.parse(jsonContent);
			} catch (e) {
				rawData = null;
			}
		}

		if (!rawData) {
			try {
				// Inject rate limit delay between successive fetches
				if (process.env.NODE_ENV !== 'test') {
					console.log(`⏳ [BblScraper] Rate limit protection: sleeping 500ms...`);
					await new Promise(resolve => setTimeout(resolve, 500));
				}

				const headers = await this.harvester.getApiHeaders();
				const response = await fetch(matchUrl, { headers });
				if (!response.ok) {
					throw new Error(`HTTP Error: ${response.status} ${response.statusText}`);
				}
				rawData = await response.json();
				await fs.writeFile(jsonCachePath, JSON.stringify(rawData, null, 2), 'utf8');
				console.log(`💾 [BblScraper] Saved raw BBL Boxscore JSON to ${jsonCachePath}`);
			} catch (error) {
				console.error(`❌ [BblScraper] Error fetching game ${gameId}:`, error.message || error);
				return this.getUnplayedSkeleton(gameId, competitionId, yearPrefix);
			}
		}

		try {
			const homeRaw = rawData.homeTeam || {};
			const awayRaw = rawData.guestTeam || rawData.awayTeam || {};

			const homeTeamName = homeRaw.gameStat?.seasonTeam?.name || 'Home Team';
			const awayTeamName = awayRaw.gameStat?.seasonTeam?.name || 'Away Team';

			const homeScore = Number(homeRaw.gameStat?.points ?? 0);
			const awayScore = Number(awayRaw.gameStat?.points ?? 0);

			const gameDate = rawData.scheduledTime ? rawData.scheduledTime.split('T')[0] : '';

			const mapPlayers = (playersList) => {
				return (playersList || []).map(p => {
					const playerInfo = p.seasonPlayer || {};
					const fullName = `${playerInfo.firstName || ''} ${playerInfo.lastName || ''}`.trim() || 'Unknown Player';

					// Convert secondsPlayed to min string MM:SS
					const totalSec = Number(p.secondsPlayed ?? 0);
					const mins = Math.floor(totalSec / 60);
					const secs = totalSec % 60;
					const minStr = `${mins}:${String(secs).padStart(2, '0')}`;

					return {
						playerId: String(playerInfo.id || playerInfo.playerId || '').trim(),
						playerName: fullName,
						statistics: {
							min: minStr,
							pts: Number(p.points ?? 0),
							fgm: Number(p.fieldGoalsMade ?? 0),
							fga: Number(p.fieldGoalsAttempted ?? 0),
							fg3m: Number(p.threePointersMade ?? p.threePointShotsMade ?? 0),
							fg3a: Number(p.threePointersAttempted ?? p.threePointShotsAttempted ?? 0),
							ftm: Number(p.freeThrowsMade ?? 0),
							fta: Number(p.freeThrowsAttempted ?? 0),
							oreb: Number(p.offensiveRebounds ?? 0),
							dreb: Number(p.defensiveRebounds ?? 0),
							reb: Number(p.totalRebounds ?? 0),
							ast: Number(p.assists ?? 0),
							stl: Number(p.steals ?? 0),
							blk: Number(p.blocks ?? 0),
							tov: Number(p.turnovers ?? 0),
							pf: Number(p.foulsCommitted ?? p.fouls ?? 0),
							plus_minus: Number(p.plusMinus ?? 0)
						}
					};
				});
			};

			const mapTeamStats = (t) => {
				return {
					fgm: Number(t.fieldGoalsMade ?? 0),
					fga: Number(t.fieldGoalsAttempted ?? 0),
					fg3m: Number(t.threePointersMade ?? t.threePointShotsMade ?? 0),
					fg3a: Number(t.threePointersAttempted ?? t.threePointShotsAttempted ?? 0),
					ftm: Number(t.freeThrowsMade ?? 0),
					fta: Number(t.freeThrowsAttempted ?? 0),
					oreb: Number(t.offensiveRebounds ?? 0),
					dreb: Number(t.defensiveRebounds ?? 0),
					reb: Number(t.totalRebounds ?? 0),
					ast: Number(t.assists ?? 0),
					stl: Number(t.steals ?? 0),
					blk: Number(t.blocks ?? 0),
					tov: Number(t.turnovers ?? 0),
					pf: Number(t.foulsCommitted ?? 0)
				};
			};

			return {
				gameId,
				competitionId,
				seasonId: yearPrefix,
				gameDate,
				homeTeam: {
					teamId: String(homeRaw.gameStat?.seasonTeam?.tlc || 'HOME').toUpperCase(),
					teamName: homeTeamName,
					score: homeScore,
					statistics: mapTeamStats(homeRaw.gameStat || {}),
					players: mapPlayers(homeRaw.playerStats)
				},
				awayTeam: {
					teamId: String(awayRaw.gameStat?.seasonTeam?.tlc || 'AWAY').toUpperCase(),
					teamName: awayTeamName,
					score: awayScore,
					statistics: mapTeamStats(awayRaw.gameStat || {}),
					players: mapPlayers(awayRaw.playerStats)
				}
			};
		} catch (error) {
			console.error(`❌ [BblScraper] Error parsing game ${gameId}:`, error.message || error);
			return this.getUnplayedSkeleton(gameId, competitionId, yearPrefix);
		}
	}

	/**
	 * @description Returns standard unplayed skeleton boxscore.
	 * @param {string} gameId
	 * @param {string} competitionId
	 * @param {string} yearPrefix
	 * @returns {Object}
	 */
	getUnplayedSkeleton(gameId, competitionId, yearPrefix) {
		return {
			gameId,
			competitionId,
			seasonId: yearPrefix,
			gameDate: '',
			homeTeam: {
				teamId: '',
				teamName: 'Unplayed',
				score: 0,
				players: []
			},
			awayTeam: {
				teamId: '',
				teamName: 'Unplayed',
				score: 0,
				players: []
			}
		};
	}

	/**
	 * @description Generates mock data for fallback / testing.
	 * @param {string} gameId
	 * @returns {Object}
	 */
	getMockUnifiedBoxScore(gameId) {
		const { competitionId, yearPrefix } = this.parseGameId(gameId);
		return {
			gameId,
			competitionId,
			seasonId: yearPrefix,
			gameDate: `${yearPrefix}-11-15`,
			homeTeam: {
				teamId: "BAY",
				teamName: "FC Bayern München",
				score: 85,
				statistics: {
					fgm: 30,
					fga: 65,
					fg3m: 8,
					fg3a: 24,
					ftm: 17,
					fta: 20,
					oreb: 10,
					dreb: 25,
					reb: 35,
					ast: 18,
					stl: 8,
					blk: 3,
					tov: 12,
					pf: 19
				},
				players: [
					{
						playerId: "nick-weiler-babb",
						playerName: "Nick Weiler-Babb",
						statistics: {
							min: "28:15",
							pts: 14,
							fgm: 5,
							fga: 10,
							fg3m: 2,
							fg3a: 5,
							ftm: 2,
							fta: 2,
							oreb: 1,
							dreb: 4,
							reb: 5,
							ast: 6,
							stl: 2,
							blk: 1,
							tov: 2,
							pf: 3,
							plus_minus: 8
						}
					}
				]
			},
			awayTeam: {
				teamId: "ALB",
				teamName: "ALBA Berlin",
				score: 78,
				statistics: {
					fgm: 28,
					fga: 60,
					fg3m: 7,
					fg3a: 20,
					ftm: 15,
					fta: 18,
					oreb: 8,
					dreb: 22,
					reb: 30,
					ast: 14,
					stl: 6,
					blk: 1,
					tov: 14,
					pf: 20
				},
				players: [
					{
						playerId: "louis-olinde",
						playerName: "Louis Olinde",
						statistics: {
							min: "25:30",
							pts: 12,
							fgm: 4,
							fga: 9,
							fg3m: 1,
							fg3a: 4,
							ftm: 3,
							fta: 4,
							oreb: 2,
							dreb: 3,
							reb: 5,
							ast: 2,
							stl: 1,
							blk: 0,
							tov: 1,
							pf: 2,
							plus_minus: -8
						}
					}
				]
			}
		};
	}
}
export default BblScraper;
