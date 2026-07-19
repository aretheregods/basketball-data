/**
 * @description Standard HTTP headers with fixed types
 * @typedef {Object} KnownHeaders
 * @property {string} [content-type] - Media type of the resource
 * @property {string} [authorization] - Authentication credentials
 * @property {string} [accept] - Acceptable media types for response
 * @property {string} [user-agent] - User agent to use for the request
 * @property {Array<string>} [set-cookie] - Server cookie assignments
 */

/**
 * @typedef {KnownHeaders & Record<string, string | number | string[]>} HTTPHeaders
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
			'user-agent': 'Mozilla/5.0',
			'accept': 'application/json',
			...defaultHeaders
		};
	}

	/**
	 * @description Universal fetch runner with automatic retry and infinite back off and on rate limits
	 * @param {string} endpoint - Endpoint or URL to fetch
	 */
	request(endpoint, options = {}, retries = 3, delay = 1000) {}
}
