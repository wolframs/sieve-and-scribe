import { spawnSync } from 'node:child_process';

const scenarios = new Set([
  'grounded-lora',
  'image-to-video',
  'tool-failure',
  'approval-failure',
  'approval-success',
  'manual-apply',
  'mcp-image-grounding',
  'feed-facets',
  'feed-resources',
  'ambiguity-question',
  'all',
]);
let scenario = '';

for (let index = 0; index < process.argv.length; index++) {
  const arg = process.argv[index];
  if (arg === '--scenario') scenario = process.argv[index + 1] ?? '';
  else if (arg.startsWith('--scenario=')) scenario = arg.slice('--scenario='.length);
}

if (!scenarios.has(scenario)) {
  console.error(
    'Choose one scenario with --scenario grounded-lora|image-to-video|tool-failure|approval-failure|approval-success|manual-apply|mcp-image-grounding|feed-facets|feed-resources|ambiguity-question, or use --scenario all.'
  );
  process.exit(2);
}

if (scenario === 'all' && process.env.CLLP_RUN_LIVE_ASSISTANT_EVALS !== '1') {
  console.error(
    'The paid all-scenarios run requires CLLP_RUN_LIVE_ASSISTANT_EVALS=1. Targeted scenarios need no extra flag.'
  );
  process.exit(2);
}

const result = spawnSync(
  'pnpm',
  ['exec', 'vitest', 'run', '--config', 'vitest.assistant-live.config.ts'],
  {
    stdio: 'inherit',
    env: { ...process.env, ASSISTANT_EVAL_SCENARIO: scenario },
  }
);

if (result.error) {
  console.error(`Could not start the assistant evaluator: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
