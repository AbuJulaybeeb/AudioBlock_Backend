#!/usr/bin/env node
/**
 * CI guard (issue #287): the test suite must never need a live AI provider.
 *
 * Fails (exit 1) when:
 *   1. jest.config.js no longer loads tests/setup/aiProviderIsolation.js,
 *      which strips AI vendor keys and pins AI_PROVIDER=noop for every test.
 *   2. A test file reads an AI vendor API key (e.g. OPENAI_API_KEY).
 *   3. A test file imports a vendor AI SDK.
 *   4. A test file hand-rolls its own AI double (implements / types an
 *      `IAIAdapter` or `AiProvider`) instead of using the shared fakes in
 *      tests/helpers/fakeAi.ts.
 *   5. src/config/env.ts makes an AI vendor key a required startup variable.
 *
 * Usage: node scripts/check-ai-test-isolation.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SETUP_FILE = 'tests/setup/aiProviderIsolation.js';
const SHARED_FAKES = 'tests/helpers/fakeAi.ts';
const { AI_PROVIDER_KEY_VARS } = require(path.join(ROOT, SETUP_FILE));

const VENDOR_SDKS = [
  'openai',
  '@anthropic-ai/sdk',
  '@google/generative-ai',
  '@google/genai',
  '@mistralai/mistralai',
  'cohere-ai',
  'groq-sdk',
  'replicate',
  '@huggingface/inference',
  'assemblyai',
  '@deepgram/sdk',
  'elevenlabs',
];

const AI_INTERFACES = '(?:IAIAdapter|AiProvider)';
const HAND_ROLLED_DOUBLE = [
  new RegExp(`\\bimplements\\s+${AI_INTERFACES}\\b`),
  new RegExp(`:\\s*${AI_INTERFACES}\\s*=\\s*\\{`),
  new RegExp(`\\bas\\s+${AI_INTERFACES}\\b`),
];

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function isTestFile(rel) {
  return /\.test\.[jt]s$/.test(rel) || rel.startsWith('tests/');
}

function lineOf(content, index) {
  return content.slice(0, index).split('\n').length;
}

const errors = [];

// 1. Jest must load the isolation setup file.
const jestConfig = fs.readFileSync(path.join(ROOT, 'jest.config.js'), 'utf8');
if (!jestConfig.includes(SETUP_FILE.replace(/^tests\//, '<rootDir>/tests/'))) {
  errors.push(`jest.config.js: setupFiles must include "<rootDir>/${SETUP_FILE}"`);
}

const keyPattern = new RegExp(`\\b(${AI_PROVIDER_KEY_VARS.join('|')})\\b`, 'g');
const sdkPattern = new RegExp(
  `(?:from\\s+|require\\(\\s*|import\\(\\s*|jest\\.mock\\(\\s*)['"](${VENDOR_SDKS.map((s) =>
    s.replace(/[/.]/g, '\\$&'),
  ).join('|')})(?:/[^'"]*)?['"]`,
  'g',
);

const files = [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'tests'))]
  .map((f) => path.relative(ROOT, f).split(path.sep).join('/'))
  .filter((rel) => /\.[jt]s$/.test(rel) && isTestFile(rel));

for (const rel of files) {
  if (rel === SETUP_FILE || rel === SHARED_FAKES) continue;
  const content = fs.readFileSync(path.join(ROOT, rel), 'utf8');

  // 2. Vendor API keys.
  for (const m of content.matchAll(keyPattern)) {
    errors.push(`${rel}:${lineOf(content, m.index)}: references AI provider key ${m[1]}`);
  }

  // 3. Vendor SDK imports.
  for (const m of content.matchAll(sdkPattern)) {
    errors.push(`${rel}:${lineOf(content, m.index)}: imports AI vendor SDK "${m[1]}"`);
  }

  // 4. Hand-rolled AI doubles.
  for (const pattern of HAND_ROLLED_DOUBLE) {
    const m = content.match(pattern);
    if (m) {
      errors.push(
        `${rel}:${lineOf(content, m.index)}: defines its own AI test double ("${m[0]}") — use ${SHARED_FAKES}`,
      );
    }
  }
}

// 5. No AI vendor key may be required at startup.
const envTs = fs.readFileSync(path.join(ROOT, 'src/config/env.ts'), 'utf8');
const required = envTs.match(/const\s+requiredVars[^=]*=\s*\[([\s\S]*?)\]/m);
if (required) {
  for (const key of AI_PROVIDER_KEY_VARS) {
    if (new RegExp(`['"]${key}['"]`).test(required[1])) {
      errors.push(`src/config/env.ts: ${key} must not be a required variable`);
    }
  }
}

if (errors.length > 0) {
  console.error('AI test isolation check failed (see docs/testing-strategy.md):\n');
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

console.log(`AI test isolation check passed (${files.length} test files scanned).`);
