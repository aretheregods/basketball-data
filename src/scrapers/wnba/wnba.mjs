import { HTTPClient } from "#utils";

export WNBAScraper extends HTTPClient {
	constructor() {
		super('https://stats.wnba.com');
	}

	async getSeasonGameSlugs(year) {}

	async getAPIBoxScore(gameId) {}

	#mapResultSet(resultSet) {}
}
