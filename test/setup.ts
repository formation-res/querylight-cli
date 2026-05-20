import { afterEach, beforeEach } from "vitest";
import { setPullModelsForTests } from "../src/vector/service.js";

beforeEach(() => {
  setPullModelsForTests(async () => {});
});

afterEach(() => {
  setPullModelsForTests(async () => {});
});
