// fork: upstream vite.config.ts points setupFiles here but never shipped the file
// (handover §17.1). Pure addition — keeps the upstream diff at zero for L1 tests.
import "@testing-library/jest-dom/vitest";
