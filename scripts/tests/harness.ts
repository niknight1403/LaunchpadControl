/**
 * Minimal test harness: no framework, no dependencies.
 *
 * Why not Jest: the logic under test (key maths, MIDI framing, clock sync) is
 * pure TypeScript with zero React Native imports, so a 40-line harness runs it
 * in Node in milliseconds. A test framework here would only add install weight
 * to a CI job that must stay fast.
 */

let passed = 0;
let failed = 0;

export function section(title: string): void {
  console.log(`\n${title}`);
}

export function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

export function near(actual: number, expected: number, tolerance: number): boolean {
  return Math.abs(actual - expected) <= tolerance;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function totals(): { passed: number; failed: number } {
  return { passed, failed };
}
