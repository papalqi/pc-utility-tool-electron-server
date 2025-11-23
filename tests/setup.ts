// Test setup file
import dotenv from 'dotenv';

// Load test environment variables
dotenv.config({ path: '.env.test' });

// Set default test timeout (jest is available globally in Jest environment)
// eslint-disable-next-line no-undef
jest.setTimeout(30000);
