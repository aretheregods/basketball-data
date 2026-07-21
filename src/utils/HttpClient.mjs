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

import { chromium } from 'playwright';

/** @type {typeof globalThis.fetch} */
const originalFetch = globalThis.fetch;

export class HTTPClient {
	/**
	 * @description Flag to control whether to use Playwright for TLS bypass.
	 * @type {boolean}
	 */
	static usePlaywright = true;

	/**
	 * @constructor
	 * @param {string} baseUrl - The URL to fetch
	 * @param {HTTPHeaders} [defaultHeaders] - The default HTTP Headers to merge
	 */
	constructor(baseUrl, defaultHeaders = {}) {
		/** @type {string} */
		this.baseUrl = baseUrl;
		/** @type {HTTPHeaders} */
		this.defaultHeaders = {
			'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
			'accept': 'application/json',
			...defaultHeaders
		};
		/** @type {any} */
		this.browser = null;
		/** @type {any} */
		this.page = null;
	}

	/**
	 * @description Initializes the Playwright browser and page contexts.
	 * @returns {Promise<void>}
	 */
	async initBrowser() {
		if (!this.browser) {
			console.log('Bypassing Akamai firewall with Playwright...');
			this.browser = await chromium.launch({ headless: true });
			const context = await this.browser.newContext({
				userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
			});
			this.page = await context.newPage();

			// Resolve target host main page for bypassing the firewall (e.g. https://stats.wnba.com)
			let targetMainPage = 'https://www.wnba.com';
			try {
				const urlObj = new URL(this.baseUrl);
				targetMainPage = urlObj.origin;
			} catch (_) {}

			console.log(`Navigating to ${targetMainPage} to pass Akamai firewall...`);
			await this.page.goto(targetMainPage, { waitUntil: 'domcontentloaded' });
		}
	}

	/**
	 * @description Closes the Playwright browser if initialized.
	 * @returns {Promise<void>}
	 */
	async close() {
		if (this.browser) {
			console.log('Closing Playwright browser context...');
			await this.browser.close();
			this.browser = null;
			this.page = null;
		}
	}

	/**
	 * @description Universal fetch runner with automatic retry and exponential back off on rate limits and network errors
	 * @param {string} endpoint - Endpoint or URL to fetch
	 * @param {Object} [options={}] - Various options to be passed to the fetch call
	 * @param {HTTPHeaders} [options.headers] - Additional HTTP headers to be passed to the fetch call
	 * @param {number} [retries=3] - Number of retries allowed before giving up
	 * @param {number} [delay=1000] - Base delay in milliseconds for exponential backoff
	 * @returns {Promise<any>} - The resulting JSON response
	 * @throws {Error} - If the fetch request returns an error or if the response is not ok
	 */
	async request(endpoint, options = {}, retries = 3, delay = 1000) {
		const url = endpoint.startsWith('http') ? endpoint : `${this.baseUrl}${endpoint}`;
		const config = {
			...options,
			headers: { ...this.defaultHeaders, ...options.headers }
		};

		try {
			if (HTTPClient.usePlaywright && globalThis.fetch === originalFetch) {
				await this.initBrowser();

				console.log(`[Playwright Fetch] Navigating to target: ${url}`);
				const data = await this.page.evaluate(async ({ targetUrl, headers, method }) => {
					const response = await fetch(targetUrl, {
						method,
						headers
					});

					let body = null;
					if (response.ok) {
						body = await response.json();
					} else {
						try {
							body = await response.text();
						} catch (_) {}
					}

					return {
						status: response.status,
						statusText: response.statusText,
						body
					};
				}, { targetUrl: url, headers: config.headers, method: config.method || 'GET' });

				if (data.status === 429 || data.status >= 500) {
					if (retries > 0) {
						console.warn(`[HTTP ${ data.status }] Retrying ${ url } in ${ delay }ms... (${ retries } left)`);
						await new Promise( resolve => setTimeout(resolve, delay) );
						return this.request(endpoint, options, retries - 1, delay * 2);
					}
				}

				if (data.status < 200 || data.status >= 300) {
					throw new Error(`HTTP Error: ${data.status} ${data.statusText || ''}`);
				}

				return data.body;
			} else {
				const response = await fetch(url, config);
				if (response.status === 429 || response.status >= 500) {
					if (retries > 0) {
						console.warn(`[HTTP ${ response.status }] Retrying ${ url } in ${ delay }ms... (${ retries } left)`);
						await new Promise( resolve => setTimeout(resolve, delay) );
						return this.request(endpoint, options, retries - 1, delay * 2);
					}
				}

				if (!response.ok) {
					throw new Error(`HTTP Error: ${response.status} ${response.statusText}`);
				}

				return await response.json();
			}
		} catch (error) {
			if (retries > 0) {
				console.warn(`[HTTP Error] ${ error.message || error }. Retrying ${ url } in ${ delay }ms... (${ retries } left)`);
				await new Promise( resolve => setTimeout(resolve, delay) );
				return this.request(endpoint, options, retries - 1, delay * 2);
			}
			throw error;
		}
	}
}
