import playwright from 'playwright';

async function run() {
	const browser = await playwright.chromium.launch({ headless: true });
	const page = await browser.newPage();

	// Listen to all requests
	page.on('request', request => {
		const url = request.url();
		if (url.includes('api.basketball-bundesliga.de') || url.includes('/api')) {
			console.log('API Request:', url);
		}
	});

	const url = 'https://www.easycredit-bbl.de/spiele/25947';
	console.log(`Loading ${url}...`);
	await page.goto(url, { waitUntil: 'networkidle' });

	console.log('Done loading. Closing...');
	await browser.close();
}
run();
