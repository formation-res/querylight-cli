import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const packageJson = require("../../package.json") as { name: string; version: string };

export const PACKAGE_NAME = packageJson.name;
export const PACKAGE_VERSION = packageJson.version;
export const DEFAULT_WORKSPACE = ".kb";
export const DEFAULT_SHARED_MODEL_CACHE_DIR = "~/.qli/models/huggingface";
export const LEGACY_WORKSPACE_MODEL_CACHE_DIR = ".kb/models/huggingface";
