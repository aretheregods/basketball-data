import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { AuditEngine } from './AuditEngine.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../../');

const PORT = process.env.PORT || 3000;
const DB_DIR = path.join(PROJECT_ROOT, 'data/SQL');
const UNMAPPED_PATH = path.join(PROJECT_ROOT, 'data/unmapped_entities.json');

/**
 * @description Helper to parse JSON request body from an incoming stream.
 * @param {import('http').IncomingMessage} req - The request object
 * @returns {Promise<any>} Mapped JSON object
 */
function parseJsonBody(req) {
	return new Promise((resolve, reject) => {
		let body = '';
		req.on('data', chunk => {
			body += chunk;
		});
		req.on('end', () => {
			try {
				resolve(body ? JSON.parse(body) : {});
			} catch (err) {
				reject(err);
			}
		});
	});
}

/**
 * @description Native Node HTTP server for hosting the local health audit dashboard & JSON API.
 */
export function startServer(port = PORT) {
	const server = http.createServer(async (req, res) => {
		// Security: Restrict CORS to localhost to prevent external malicious websites from hitting local endpoints
		const origin = req.headers.origin || '';
		if (origin) {
			const isLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
			if (isLocalhost) {
				res.setHeader('Access-Control-Allow-Origin', origin);
			}
		}
		res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
		res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

		if (req.method === 'OPTIONS') {
			res.writeHead(204);
			return res.end();
		}

		// API: Audit Results
		if (req.url === '/api/audit' && req.method === 'GET') {
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

			res.writeHead(200, { 'Content-Type': 'application/json' });
			return res.end(JSON.stringify(results, null, 2));
		}

		// API: Add Team Alias Mapping
		if (req.url === '/api/config/alias' && req.method === 'POST') {
			try {
				const { league, alias, teamId } = await parseJsonBody(req);
				if (!league || !alias || !teamId) {
					res.writeHead(400, { 'Content-Type': 'application/json' });
					return res.end(JSON.stringify({ error: 'Missing league, alias, or teamId in request body.' }));
				}

				const configPath = path.join(PROJECT_ROOT, 'config', `${league.toLowerCase()}_team_mappings.json`);
				let mappings = {};

				if (fs.existsSync(configPath)) {
					const content = fs.readFileSync(configPath, 'utf8');
					mappings = JSON.parse(content);
				}

				mappings[alias.trim()] = teamId.trim();

				// Ensure parent directory exists
				fs.mkdirSync(path.dirname(configPath), { recursive: true });
				fs.writeFileSync(configPath, JSON.stringify(mappings, null, 2), 'utf8');

				console.log(`📝 Added team alias "${alias}" -> "${teamId}" for league "${league}" in mappings.`);

				res.writeHead(200, { 'Content-Type': 'application/json' });
				return res.end(JSON.stringify({ success: true, message: `Successfully mapped "${alias}" to "${teamId}".` }));
			} catch (err) {
				res.writeHead(500, { 'Content-Type': 'application/json' });
				return res.end(JSON.stringify({ error: err.message }));
			}
		}

		// API: Add Score/Points Override
		if (req.url === '/api/config/override' && req.method === 'POST') {
			try {
				const { league, gameId, teamId, score } = await parseJsonBody(req);
				if (!league || !gameId || !teamId || score === undefined) {
					res.writeHead(400, { 'Content-Type': 'application/json' });
					return res.end(JSON.stringify({ error: 'Missing league, gameId, teamId, or score in request body.' }));
				}

				const configPath = path.join(PROJECT_ROOT, 'config', `${league.toLowerCase()}_overrides.json`);
				let overrides = {};

				if (fs.existsSync(configPath)) {
					const content = fs.readFileSync(configPath, 'utf8');
					overrides = JSON.parse(content);
				}

				if (!overrides[gameId]) {
					overrides[gameId] = {};
				}
				overrides[gameId][teamId] = Number(score);

				// Ensure parent directory exists
				fs.mkdirSync(path.dirname(configPath), { recursive: true });
				fs.writeFileSync(configPath, JSON.stringify(overrides, null, 2), 'utf8');

				console.log(`📝 Added game override for "${gameId}" (Team "${teamId}" -> ${score} pts) in config overrides.`);

				res.writeHead(200, { 'Content-Type': 'application/json' });
				return res.end(JSON.stringify({ success: true, message: `Successfully registered override for game "${gameId}".` }));
			} catch (err) {
				res.writeHead(500, { 'Content-Type': 'application/json' });
				return res.end(JSON.stringify({ error: err.message }));
			}
		}

		// API: Trigger Targeted Pipeline Rerun
		if (req.url === '/api/pipeline/rerun' && req.method === 'POST') {
			try {
				const { league, season, gameId } = await parseJsonBody(req);
				if (!league || !season || !gameId) {
					res.writeHead(400, { 'Content-Type': 'application/json' });
					return res.end(JSON.stringify({ error: 'Missing league, season, or gameId in request body.' }));
				}

				// Strict input validation to prevent shell or argument-level injection/malicious input
				const leagueRegex = /^[a-zA-Z0-9_\-]+$/;
				const seasonRegex = /^\d{4}$/;
				const gameIdRegex = /^[a-zA-Z0-9_\-]+$/;

				if (!leagueRegex.test(league) || !seasonRegex.test(String(season)) || !gameIdRegex.test(gameId)) {
					res.writeHead(400, { 'Content-Type': 'application/json' });
					return res.end(JSON.stringify({ error: 'Invalid input parameters. Only alphanumeric, hyphen, and underscore characters are allowed.' }));
				}

				const args = [
					'run.js',
					`--league=${league.toLowerCase()}`,
					`--years=${season}`,
					'--step=extract,transform,load',
					`--games=${gameId}`
				];

				console.log(`🚀 Executing targeted secure rerun: node ${args.join(' ')}`);

				const child = spawn('node', args, { cwd: PROJECT_ROOT });

				let stdout = '';
				let stderr = '';

				child.stdout.on('data', (data) => {
					stdout += data.toString();
				});

				child.stderr.on('data', (data) => {
					stderr += data.toString();
				});

				child.on('close', (code) => {
					if (code !== 0) {
						console.error(`❌ Targeted rerun failed with exit code ${code}`);
						res.writeHead(500, { 'Content-Type': 'application/json' });
						return res.end(JSON.stringify({ success: false, error: `Rerun process exited with code ${code}`, stdout, stderr }));
					}
					console.log(`✅ Targeted rerun completed successfully.`);
					res.writeHead(200, { 'Content-Type': 'application/json' });
					return res.end(JSON.stringify({ success: true, stdout, stderr }));
				});
			} catch (err) {
				res.writeHead(500, { 'Content-Type': 'application/json' });
				return res.end(JSON.stringify({ error: err.message }));
			}
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
