const { createDefaultPreset } = require("ts-jest");

const tsJestTransformCfg = createDefaultPreset().transform;

/** @type {import("jest").Config} **/
module.exports = {
  testEnvironment: "node",
  transform: {
    ...tsJestTransformCfg,
    "node_modules/uuid/.+\\.js$": ["ts-jest", { useESM: false }],
  },
  transformIgnorePatterns: [
    "/node_modules/(?!uuid/).+"
  ],
};