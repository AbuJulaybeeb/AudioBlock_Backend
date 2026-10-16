/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/src", "<rootDir>/tests"],
  testMatch: ["**/__tests__/**/*.test.ts", "**/*.test.ts"],
  // Strip AI vendor keys and pin AI_PROVIDER=noop before every test file so
  // no test can depend on a live AI provider (#287).
  setupFiles: ["<rootDir>/tests/setup/aiProviderIsolation.js"],
  moduleNameMapper: {
    "^reflect-metadata$": "<rootDir>/node_modules/reflect-metadata",
    // wasm-attestation-bindings is ESM-only and uses `import.meta`, which
    // cannot be transpiled into a CommonJS Jest run; the Dynamic Labs wallet
    // client only needs it for enclave attestation, never in tests.
    "^@evervault/wasm-attestation-bindings$": "<rootDir>/tests/stubs/emptyModule.js",
  },
  transform: {
    "^.+\\.[tj]sx?$": [
      "ts-jest",
      {
        isolatedModules: true,
      },
    ],
  },
  transformIgnorePatterns: [
    // Transpile every scoped package (plus known unscoped ESM deps such as
    // uint8array-extras): otplib 13 (@otplib, @scure), @dynamic-labs-wallet
    // (@evervault) and friends ship ESM .js files that Jest otherwise rejects
    // with "Unexpected token 'export'" the moment a test imports the Express app.
    "node_modules/(?!(@|uint8array-extras))",
  ],
  // Coverage collection — run with `npm run test:coverage` (#396).
  // CI fails when any metric drops below these thresholds.
  collectCoverageFrom: [
    "src/**/*.ts",
    "!src/index.ts",
    "!src/migrations/**",
    "!src/seeders/**",
  ],
  coverageThreshold: {
    global: {
      lines: 50,
      functions: 50,
      branches: 40,
      statements: 50,
    },
  },
};
