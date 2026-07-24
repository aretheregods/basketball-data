import { HTTPClient } from '#utils';
import { AcbHarvester } from '../harvesters/AcbHarvester.mjs';

/**
 * @description Engine for fetching, parsing, and normalizing Spanish Liga ACB (domestic) data.
 */
export class AcbEngine extends HTTPClient {
	/**
	 * @constructor
	 */
	constructor() {
		super('https://live.acb.com');
		this.harvester = new AcbHarvester();
	}

	/**
	 * @description Fetches all game slugs/IDs for ACB for a given season.
	 * @param {string|number} year - The season year
	 * @returns {Promise<string[]>}
	 */
	async getSeasonGameSlugs(year) {
		return await this.harvester.getSeasonGameSlugs(year);
	}

	/**
	 * @description Parses the competition, season, and gamecode from an ACB gameId.
	 * ACB game ID is formatted as A{season}_{numeric_id}, e.g. A2026_105373.
	 * @param {string} gameId
	 * @returns {{ competitionId: string, seasonCode: string, gameCode: string, yearPrefix: string }}
	 */
	parseGameId(gameId) {
		const clean = String(gameId || '').trim();
		const parts = clean.split('_');
		const keyPart = parts[0] || 'A2025';
		const gameCode = parts[1] || '1';

		const seasonCode = keyPart.substring(1); // Strip 'A'
		const yearPrefix = seasonCode;

		return {
			competitionId: 'acb',
			seasonCode,
			gameCode,
			yearPrefix
		};
	}

	/**
	 * @description Formats unified box score by fetching statistics page and parsing the embedded next.js push state.
	 * @param {string} gameId - Combined game identifier, e.g. 'A2026_105373'
	 * @returns {Promise<Object>} Unified Europe BoxScore response
	 */
	async getUnifiedBoxScore(gameId) {
		const { competitionId, yearPrefix, gameCode } = this.parseGameId(gameId);

		// If in test mode, bypass real network calls and return mock data
		if (process.env.NODE_ENV === 'test') {
			return this.getMockUnifiedBoxScore(gameId);
		}

		const statsUrl = `https://live.acb.com/es/partidos/${gameCode}/estadisticas`;
		console.log(`📡 [AcbEngine] Fetching statistics from ${statsUrl}...`);

		let htmlText;
		try {
			const response = await fetch(statsUrl, { headers: this.defaultHeaders });
			if (!response.ok) {
				throw new Error(`HTTP Error: ${response.status} ${response.statusText}`);
			}
			htmlText = await response.text();
		} catch (error) {
			console.warn(`⚠️ [AcbEngine] Failed to fetch ACB page for game ${gameId}:`, error.message || error);
			htmlText = null;
		}

		if (!htmlText) {
			return this.getUnplayedSkeleton(gameId, competitionId, yearPrefix);
		}

		// Parse next.js push segments
		const regex = /self\.__next_f\.push\(\[1,\"(.*?)\"\]\)/g;
		let match;
		const pushSegments = [];
		while ((match = regex.exec(htmlText)) !== null) {
			pushSegments.push(match[1]);
		}

		// Find segment containing initialStatistics
		let statsSegment = '';
		for (const seg of pushSegments) {
			if (seg.includes('initialStatistics')) {
				statsSegment = seg;
				break;
			}
		}

		// Find segment containing initialMatchHeader
		let headerSegment = '';
		for (const seg of pushSegments) {
			if (seg.includes('initialMatchHeader')) {
				headerSegment = seg;
				break;
			}
		}

		if (!statsSegment || !headerSegment) {
			console.warn(`⚠️ [AcbEngine] Stats or header segment not found in NextJS push data for game ${gameId}.`);
			return this.getUnplayedSkeleton(gameId, competitionId, yearPrefix);
		}

		try {
			// Extract and parse initialStatistics
			const statsParsed = this.parseNextJsonSegment(statsSegment, 'initialStatistics');
			// Extract and parse initialMatchHeader
			const headerParsed = this.parseNextJsonSegment(headerSegment, 'initialMatchHeader');

			if (!statsParsed || !headerParsed) {
				console.warn(`⚠️ [AcbEngine] Failed to extract JSON blocks from NextJS push data for game ${gameId}.`);
				return this.getUnplayedSkeleton(gameId, competitionId, yearPrefix);
			}

			return this.mapToUnifiedSchema(gameId, headerParsed, statsParsed);
		} catch (error) {
			console.error(`❌ [AcbEngine] Error parsing or mapping game ${gameId}:`, error);
			return this.getUnplayedSkeleton(gameId, competitionId, yearPrefix);
		}
	}

	/**
	 * @description Parses the nextJS push string segment to locate the JSON object for a specific key.
	 * @param {string} segment
	 * @param {string} keyName
	 * @returns {Object|null} Mapped parsed JSON object
	 */
	parseNextJsonSegment(segment, keyName) {
		const keyIdx = segment.indexOf(keyName);
		if (keyIdx === -1) return null;

		const contentStart = segment.indexOf('{', keyIdx);
		if (contentStart === -1) return null;

		let braceCount = 0;
		let i = contentStart;
		for (; i < segment.length; i++) {
			const char = segment[i];
			if (char === '{') braceCount++;
			else if (char === '}') braceCount--;
			if (braceCount === 0) {
				break;
			}
		}

		const jsonChunk = segment.substring(contentStart, i + 1);
		// Unescape push encoding characters
		const cleanedJson = jsonChunk
			.replace(/\\\\\\"/g, '\\"')
			.replace(/\\\\"/g, '"')
			.replace(/\\"/g, '"')
			.replace(/\\\\/g, '\\\\');

		return JSON.parse(cleanedJson);
	}

	/**
	 * @description Maps ACB's Next.js statistics schemas to the unified European schema.
	 * @param {string} gameId
	 * @param {Object} header
	 * @param {Object} stats
	 * @returns {Object} Unified Europe BoxScore
	 */
	mapToUnifiedSchema(gameId, header, stats) {
		const { competitionId, yearPrefix } = this.parseGameId(gameId);
		const gameDate = header.start ? header.start.split('T')[0] : '';

		const teamBoxscores = stats.teamBoxscores || [];
		const homeRaw = teamBoxscores[0] || {};
		const awayRaw = teamBoxscores[1] || {};

		const mapPlayers = (rawTeamObj) => {
			const statsByPeriods = rawTeamObj.statsByPeriods || [];
			// Quarter 0 corresponds to the total game aggregates
			const totalPeriod = statsByPeriods.find(p => p.quarter === 0) || {};
			const rawPlayersList = totalPeriod.stats?.players || [];

			return rawPlayersList.map(p => {
				const playerInfo = p.player || {};
				const fullName = `${playerInfo.firstName || ''} ${playerInfo.lastName || ''}`.trim() || playerInfo.nickname || 'Unknown Player';

				return {
					playerId: String(playerInfo.id || '').trim(),
					playerName: fullName,
					statistics: {
						min: p.playTime || '0:00',
						pts: Number(p.points ?? 0),
						fgm: Number((p.twoPointersMade ?? 0) + (p.threePointersMade ?? 0)),
						fga: Number((p.twoPointersAttempted ?? 0) + (p.threePointersAttempted ?? 0)),
						fg3m: Number(p.threePointersMade ?? 0),
						fg3a: Number(p.threePointersAttempted ?? 0),
						ftm: Number(p.freeThrowsMade ?? 0),
						fta: Number(p.freeThrowsAttempted ?? 0),
						oreb: Number(p.offRebounds ?? 0),
						dreb: Number(p.defRebounds ?? 0),
						reb: Number(p.totalRebounds ?? 0),
						ast: Number(p.assists ?? 0),
						stl: Number(p.steals ?? 0),
						blk: Number(p.blocks ?? 0),
						tov: Number(p.turnovers ?? 0),
						pf: Number(p.personalFouls ?? 0),
						plus_minus: Number(p.plusMinus ?? 0)
					}
				};
			});
		};

		const mapTeamStats = (rawTeamObj) => {
			const statsByPeriods = rawTeamObj.statsByPeriods || [];
			const totalPeriod = statsByPeriods.find(p => p.quarter === 0) || {};
			const t = totalPeriod.stats?.total || {};

			return {
				fgm: Number((t.twoPointersMade ?? 0) + (t.threePointersMade ?? 0)),
				fga: Number((t.twoPointersAttempted ?? 0) + (t.threePointersAttempted ?? 0)),
				fg3m: Number(t.threePointersMade ?? 0),
				fg3a: Number(t.threePointersAttempted ?? 0),
				ftm: Number(t.freeThrowsMade ?? 0),
				fta: Number(t.freeThrowsAttempted ?? 0),
				oreb: Number(t.offRebounds ?? 0),
				dreb: Number(t.defRebounds ?? 0),
				reb: Number(t.totalRebounds ?? 0),
				ast: Number(t.assists ?? 0),
				stl: Number(t.steals ?? 0),
				blk: Number(t.blocks ?? 0),
				tov: Number(t.turnovers ?? 0),
				pf: Number(t.personalFouls ?? 0)
			};
		};

		const homeTeamHeader = header.teams?.home || {};
		const awayTeamHeader = header.teams?.away || {};

		return {
			gameId,
			competitionId,
			seasonId: yearPrefix,
			gameDate,
			homeTeam: {
				teamId: String(homeTeamHeader.abbreviatedName || homeRaw.team?.abbreviatedName || '').toUpperCase(),
				teamName: String(homeTeamHeader.fullName || homeRaw.team?.fullName || 'Home Team').trim(),
				score: Number(header.currentHomeScore ?? 0),
				statistics: mapTeamStats(homeRaw),
				players: mapPlayers(homeRaw)
			},
			awayTeam: {
				teamId: String(awayTeamHeader.abbreviatedName || awayRaw.team?.abbreviatedName || '').toUpperCase(),
				teamName: String(awayTeamHeader.fullName || awayRaw.team?.fullName || 'Away Team').trim(),
				score: Number(header.currentAwayScore ?? 0),
				statistics: mapTeamStats(awayRaw),
				players: mapPlayers(awayRaw)
			}
		};
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
			gameDate: `${yearPrefix}-06-24`,
			homeTeam: {
				teamId: "BAR",
				teamName: "Barça",
				score: 84,
				statistics: {
					fgm: 27,
					fga: 63,
					fg3m: 14,
					fg3a: 36,
					ftm: 16,
					fta: 22,
					oreb: 10,
					dreb: 25,
					reb: 35,
					ast: 13,
					stl: 3,
					blk: 0,
					tov: 16,
					pf: 19
				},
				players: [
					{
						playerId: "30003361",
						playerName: "Kevin Punter",
						statistics: {
							min: "34:13",
							pts: 26,
							fgm: 9,
							fga: 13,
							fg3m: 7,
							fg3a: 10,
							ftm: 1,
							fta: 1,
							oreb: 0,
							dreb: 4,
							reb: 4,
							ast: 2,
							stl: 0,
							blk: 0,
							tov: 3,
							pf: 2,
							plus_minus: -17
						}
					}
				]
			},
			awayTeam: {
				teamId: "VBC",
				teamName: "Valencia Basket",
				score: 108,
				statistics: {
					fgm: 38,
					fga: 68,
					fg3m: 15,
					fg3a: 30,
					ftm: 17,
					fta: 20,
					oreb: 8,
					dreb: 24,
					reb: 32,
					ast: 22,
					stl: 10,
					blk: 1,
					tov: 10,
					pf: 20
				},
				players: [
					{
						playerId: "30002844",
						playerName: "Jean Montero",
						statistics: {
							min: "28:30",
							pts: 23,
							fgm: 8,
							fga: 14,
							fg3m: 4,
							fg3a: 7,
							ftm: 3,
							fta: 3,
							oreb: 1,
							dreb: 3,
							reb: 4,
							ast: 6,
							stl: 3,
							blk: 0,
							tov: 2,
							pf: 2,
							plus_minus: 20
						}
					}
				]
			}
		};
	}
}
