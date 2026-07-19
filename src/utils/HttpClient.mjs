/**
 * @description Standard HTTP headers with fixed types
 * @typedef {Object} KnownHeaders
 * @property {string} [content-type] - Media type of the resource
 * @property {string} [authorization] - Authentication credentials
 * @property {string} [accept] - Acceptable media types for response
 * @property {string} [user-agent] - User agent to use for the request
 * @property {Array.<string>} [set-cookie] - Server cookie assignments
 */

/**
 * @typedef {KnownHeaders & Record.<string, string | number | string[]>} HTTPHeaders
 */

export class HTTPClient {
	/**
	 * @constructor
	 * @param {string} baseUrl - The URL to fetch
	 * @param {HTTPHeaders} defaultHeaders - The HTTP Headers
	 */
	constructor(baseUrl, defaultHeaders) {
		this.baseUrl = baseUrl;
		this.defaultHeaders = {
			'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
			'accept': 'application/json',
			...defaultHeaders
		};
	}

	/**
	 * @description Universal fetch runner with automatic retry and exponential back off and on rate limits
	 * @param {string} endpoint - Endpoint or URL to fetch
	 * @param {Object} options - Various options to be passed to the fetch call
	 * @param {HTTPHeaders} options.headers - Additional HTTP headers to be passed to the fetch call
	 * @returns {Object} - The resulting JSON response
	 * @throws {Error} - If the fetch request returns an error or if the response is not ok
	 */
	async request(endpoint, options = {}, retries = 3, delay = 1000) {
		const url = endpoint.startsWith('http') ? endpoint : `${this.baseUrl}${endpoint}`;
		const config = {
			...options,
			headers: { ...this.defaultHeaders, ...options.headers }
		};

		try {

			const response = await fetch(url, config);
			if (response.status === 429 || response.status >= 500) {
				if (retries > 0) {
					console.warn(`[HTTP ${ response.status }] Retrying ${ url } in ${ delay }ms... (${ retries } left)`);
					await new Promise( resolve => setTimeout(resolve, delay) )
					return this.request(endpoint, options, retries - 1, delay * 2);
				}
			}

			if (!response.ok) {
				throw new Error(`HTTP Error: ${response.status} ${response.statusText}`);
			}

			return await response.json();
		} catch (error) {
			if (retries > 0) {
				return this.request(endpoint, options, retries - 1, delay * 2);
			}
			throw error;
		}
	}
}
