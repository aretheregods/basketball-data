import Ajv from 'ajv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Project root is two levels up from src/utils/
const PROJECT_ROOT = path.resolve(__dirname, '../../');

const ajv = new Ajv({ allErrors: true });

/**
 * @description Validates data against a JSON schema stored in the schemas directory.
 * @param {string} schemaPath - Relative path to the schema file inside the schemas/ directory (e.g., 'wnba/leaguegamelog.json')
 * @param {Object} data - The data object to validate
 * @returns {boolean} - Returns true if validation succeeds
 * @throws {Error} - Throws an error with validation details if validation fails
 */
export function validateSchema(schemaPath, data) {
	const absolutePath = path.resolve(PROJECT_ROOT, 'schemas', schemaPath);
	if (!fs.existsSync(absolutePath)) {
		throw new Error(`Schema file not found at: ${absolutePath}`);
	}
	const schemaContent = JSON.parse(fs.readFileSync(absolutePath, 'utf8'));

	let validate = ajv.getSchema(schemaPath);
	if (!validate) {
		ajv.addSchema(schemaContent, schemaPath);
		validate = ajv.getSchema(schemaPath);
	}

	const valid = validate(data);
	if (!valid) {
		const errors = validate.errors.map(err => `${err.instancePath} ${err.message}`).join(', ');
		throw new Error(`JSON Schema Validation Error for schema ${schemaPath}: ${errors}`);
	}
	return true;
}
