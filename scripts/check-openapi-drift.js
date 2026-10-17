#!/usr/bin/env node
/**
 * OpenAPI drift check (#338)
 *
 * Compares documented paths in docs/openapi.yaml against actual Express
 * routes in src/routes/. Exits 1 if any route is missing from the spec.
 *
 * Usage: node scripts/check-openapi-drift.js
 */

const fs = require('fs');
const path = require('path');

const ROUTES_DIR = path.join(__dirname, '..', 'src', 'routes');
const OPENAPI_PATH = path.join(__dirname, '..', 'docs', 'openapi.yaml');

function extractRoutesFromFiles(dir) {
  const routes = [];
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.ts'));
  for (const file of files) {
    const content = fs.readFileSync(path.join(dir, file), 'utf8');
    // Match router.METHOD('/path', ...) patterns
    const regex = /router\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/gi;
    let match;
    while ((match = regex.exec(content)) !== null) {
      routes.push({ method: match[1].toLowerCase(), path: match[2], file });
    }
  }
  return routes;
}

function extractPathsFromOpenAPI(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const paths = new Set();
  const lines = content.split('\n');
  for (const line of lines) {
    const m = line.match(/^(\s+)\/api\/([^:]+):/);
    if (m) {
      paths.add('/api/' + m[2]);
    }
  }
  return paths;
}

const routes = extractRoutesFromFiles(ROUTES_DIR);
const documentedPaths = extractPathsFromOpenAPI(OPENAPI_PATH);

// Build a set of actual route prefixes (strip params)
const actualPathPrefixes = new Set(routes.map(r => r.path));

console.log(`Found ${routes.length} actual routes in src/routes/`);
console.log(`Found ${documentedPaths.size} documented paths in docs/openapi.yaml`);
console.log('');

// Check for routes missing from OpenAPI
const missing = [];
for (const route of routes) {
  const normalized = route.path.replace(/:([^/]+)/g, '{$1}');
  const full = '/api' + normalized;
  if (!documentedPaths.has(normalized) && !documentedPaths.has(full)) {
    missing.push(route);
  }
}

if (missing.length > 0) {
  console.log(`Missing from OpenAPI spec (${missing.length}):`);
  for (const r of missing) {
    console.log(`  ${r.method.toUpperCase()} ${r.path}  (${r.file})`);
  }
  console.log('');
}

// Check for documented paths that no longer exist
const stale = [];
for (const docPath of documentedPaths) {
  const normalized = docPath.replace(/^\/api/, '').replace(/\{([^}]+)\}/g, ':$1');
  const found = routes.some(r => r.path === normalized);
  if (!found) {
    stale.push(docPath);
  }
}

if (stale.length > 0) {
  console.log(`Documented but no longer exists (${stale.length}):`);
  for (const p of stale) {
    console.log(`  ${p}`);
  }
  console.log('');
}

if (missing.length === 0 && stale.length === 0) {
  console.log('✓ No drift detected');
  process.exit(0);
} else {
  console.log(`✗ Drift detected: ${missing.length} undocumented, ${stale.length} stale`);
  process.exit(1);
}
