import playwright from 'playwright';

async function run() {
	console.log('Launching browser with evasion...');
	const browser = await playwright.chromium.launch({ headless: true });
	const context = await browser.newContext({
		userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
		viewport: { width: 1280, height: 800 }
	});
	const page = await context.newPage();

	// Evasion script
	await page.addInitScript(() => {
		Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
	});

	const url = 'https://basketball.realgm.com/international/league/31/German-BBL/schedule/2021';
	console.log(`Loading ${url}...`);
	await page.goto(url, { waitUntil: 'domcontentloaded' });

	const title = await page.title();
	console.log('Page Title:', title);

	if (title.includes('Just a moment')) {
		console.log('Waiting for Cloudflare turnstile challenge...');
		await page.waitForTimeout(6000);
		const newTitle = await page.title();
		console.log('New Page Title:', newTitle);
	}

	// Check for selector
	const content = await page.content();
	const hasTable = content.includes('table') || content.includes('stat_table');
	console.log('Has table/schedule content:', hasTable);

	await browser.close();
}
run();
