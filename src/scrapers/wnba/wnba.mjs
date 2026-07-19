import { HTTPClient } from "#utils";

export class WNBAScraper extends HTTPClient {
	constructor() {
		super(
			'https://stats.wnba.com/stats',
			{
				'referrer': 'https://stats.wnba.com',
				'origin': 'https://stats.wnba.com',
				'accept': 'application/json, text/plain, */*',
				'accept-language': 'en-US,en;q=0.9',
				'x-nba-stats-origin': 'stats',
				'x-nba-stats-token': 'true'
			}
		);
	}

	async getSeasonGameSlugs(year) {
        const url = `/leaguegamelog?Counter=0&Direction=DESC&LeagueID=10&PlayerOrTeam=T&Season=${ year }&SeasonType=02&Sorter=DATE`;

		const data = await this.request(url, { headers: this.defaultHeaders } );

		const rows = data.resultSets[0].rowSet;
		const columns = data.resultSets[0].headers;

		const gameIdIdx = columns.indexOf('GAME_ID');
		const matchupIdx = columns.indexOf('MATCHUP');

		const slugs = rows.map( row => {
			const gameId = row[gameIdIdx];
			const matchup = row[matchupIdx];
			const cleanMatchup = matchup.toLowerCase().replace(/[\s\.]+/g, '').replace('@', '-vs-');
			return `${ cleanMatchup }-${ gameId }`;
		} );

		return [...new Set(slugs)];
	}

	async getAPIBoxScore(gameId, type = 'traditional') {
		const endpoint = `boxscore${ type }v2`;
		const url = `${endpoint}?EndPeriod=10&EndRange=28800&GameID=${ gameId }&RangeType=0&StartPeriod=1&StartRange=0`;

		const data = await this.request(url, { headers: this.defaultHeaders } );

		const playerStatsSet = data.resultSets.find( set => set.name === 'PlayerStats' );
		const teamStatsSet = data.resultSets.find( set => set.name === 'TeamStats' );

		return {
			players: this.#mapResultSet(playerStatsSet),
			teams: this.#mapResultSet(teamStatsSet)
		};
	}

	#mapResultSet(resultSet) {
		if (!resultSet) return [];

		const headers = resultSet.headers;
		return resultsSet.rowSet.map( row => {
			let obj = {};
			row.forEach( (value, index) => {
				obj[ headers[ index ] ] = value;
			} );
			return obj;
		} );
	}
}
