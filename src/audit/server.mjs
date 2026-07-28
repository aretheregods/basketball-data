import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { AuditEngine } from './AuditEngine.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../../');

const PORT = process.env.PORT || 3000;
const DB_DIR = path.join(PROJECT_ROOT, 'data/SQL');
const UNMAPPED_PATH = path.join(PROJECT_ROOT, 'data/unmapped_entities.json');

/**
 * @description Native Node HTTP server for hosting the local health audit dashboard & JSON API.
 */
export function startServer(port = PORT) {
	const server = http.createServer((req, res) => {
		// API: Audit Results
		if (req.url === '/api/audit') {
			const results = {
				databases: {},
				unmappedEntities: { teams: [], players: [] }
			};

			// 1. Scan and audit local SQLite databases
			if (fs.existsSync(DB_DIR)) {
				try {
					const files = fs.readdirSync(DB_DIR);
					for (const file of files) {
						if (file.endsWith('.sqlite')) {
							const leagueKey = file.replace('.sqlite', '').toLowerCase();
							const dbPath = path.join(DB_DIR, file);
							try {
								const engine = new AuditEngine(dbPath);
								results.databases[leagueKey] = engine.runFullAudit();
							} catch (err) {
								console.error(`❌ Failed to audit database ${file}:`, err.message);
								results.databases[leagueKey] = { error: err.message };
							}
						}
					}
				} catch (err) {
					console.error('❌ Failed to read databases directory:', err.message);
				}
			}

			// 2. Fetch unmapped entities if any exist
			if (fs.existsSync(UNMAPPED_PATH)) {
				try {
					const content = fs.readFileSync(UNMAPPED_PATH, 'utf8');
					results.unmappedEntities = JSON.parse(content);
				} catch (err) {
					console.error('❌ Failed to parse unmapped entities file:', err.message);
				}
			}

			res.writeHead(200, {
				'Content-Type': 'application/json',
				'Access-Control-Allow-Origin': '*'
			});
			return res.end(JSON.stringify(results, null, 2));
		}

		// API: Trigger database pipeline refresh (Optional stub for the dashboard action)
		if (req.url === '/api/refresh') {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			return res.end(JSON.stringify({ message: 'Trigger received. Please execute run.js via CLI to perform full data fetch.' }));
		}

		// Serve static dashboard HTML
		const publicDir = path.join(__dirname, 'public');
		let filePath = path.join(publicDir, 'index.html');

		// Simple routing for static files inside public/
		if (req.url !== '/' && req.url !== '/index.html') {
			const safeSuffix = req.url.replace(/^\/+/, '');
			filePath = path.join(publicDir, safeSuffix);
		}

		if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
			const ext = path.extname(filePath);
			let contentType = 'text/html';
			if (ext === '.css') contentType = 'text/css';
			if (ext === '.js') contentType = 'application/javascript';
			if (ext === '.json') contentType = 'application/json';

			try {
				const content = fs.readFileSync(filePath);
				res.writeHead(200, { 'Content-Type': contentType });
				return res.end(content);
			} catch (err) {
				res.writeHead(500, { 'Content-Type': 'text/plain' });
				return res.end(`500 Internal Server Error: ${err.message}`);
			}
		}

		// 404 Fallback
		res.writeHead(404, { 'Content-Type': 'text/plain' });
		res.end('404 Not Found');
	});

	server.listen(port, () => {
		console.log(`📊 Audit Dashboard live at http://localhost:${port}`);
	});

	return server;
}

// Support running the server directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
	startServer();
}
