const { test } = require('node:test');
const assert = require('node:assert/strict');
const { recoveryPlan, updateIncident, watchdog } = require('./.github/scripts/refresh-watchdog.cjs');
const NOW = Date.parse('2026-10-17T00:00:00Z');
const run = (minutes, extra = {}) => ({ status: 'completed', conclusion: 'success', head_branch: 'main', event: 'schedule',
  created_at: new Date(NOW - minutes * 60000).toISOString(), updated_at: new Date(NOW - minutes * 60000).toISOString(), ...extra });

function fixture(runs = [], state = 'active') {
  const calls = { created: [], updated: [], dispatched: [], enabled: [] };
  const open = [];
  const github = { paginate: async () => open, rest: {
    issues: { listForRepo: () => {}, create: async data => { calls.created.push(data); open.push({ ...data, number: 1 }); },
      update: async data => { calls.updated.push(data); Object.assign(open.find(issue => issue.number === data.issue_number), data); } },
    actions: { listWorkflowRuns: async () => ({ data: { workflow_runs: runs } }), getWorkflow: async () => ({ data: { state } }),
      enableWorkflow: async data => calls.enabled.push(data), createWorkflowDispatch: async data => calls.dispatched.push(data) }
  } };
  return { github, context: { repo: { owner: 'owner', repo: 'site' } }, core: { info() {}, warning() {} }, calls, open, now: NOW };
}

test('recent successful rebuild does not trigger duplicate work', () => {
  assert.deepEqual(recoveryPlan([run(5)], NOW), { stale: false, dispatch: false, busy: false });
});
test('stale scheduler dispatches one recovery, with cooldown and busy protection', () => {
  assert.equal(recoveryPlan([run(45)], NOW).dispatch, true);
  assert.equal(recoveryPlan([run(45), run(5, { conclusion: 'failure' })], NOW).dispatch, false);
  assert.equal(recoveryPlan([run(45), run(2, { status: 'queued', conclusion: null })], NOW).dispatch, false);
  assert.equal(recoveryPlan([run(45), run(25, { status: 'in_progress', conclusion: null })], NOW).dispatch, true);
});
test('other branches and pull request successes cannot hide stale main', () => {
  assert.equal(recoveryPlan([run(45), run(1, { head_branch: 'feature' }), run(1, { event: 'pull_request' })], NOW).stale, true);
});
test('missing history starts one recovery run', () => assert.equal(recoveryPlan([], NOW).dispatch, true));
test('watchdog dispatch is restricted to the expected workflow and main', async () => {
  const args = fixture([run(45)]);
  await watchdog(args);
  assert.equal(args.calls.dispatched.length, 1);
  assert.equal(args.calls.dispatched[0].workflow_id, 'auto-refresh-data.yml');
  assert.equal(args.calls.dispatched[0].ref, 'main');
  assert.equal(args.calls.created.length, 1);
});
test('recent success does not close an unrelated component incident', async () => {
  const args = fixture([run(2)]);
  await updateIncident({ ...args, report: { state: 'degraded', affected: ['upbit_notices'] } });
  await watchdog(args);
  assert.equal(args.calls.dispatched.length, 0);
  assert.equal(args.calls.updated.length, 0);
});
test('only inactivity disablement is automatically reversed', async () => {
  const inactive = fixture([run(45)], 'disabled_inactivity');
  await watchdog(inactive);
  assert.equal(inactive.calls.enabled.length, 1);
  assert.equal(inactive.calls.dispatched.length, 1);
  const manual = fixture([run(45)], 'disabled_manually');
  await watchdog(manual);
  assert.equal(manual.calls.enabled.length, 0);
  assert.equal(manual.calls.dispatched.length, 0);
  assert.ok(manual.calls.created[0].body.includes('refresh_workflow_disabled'));
});
test('persistent incident is deduplicated without per-run notification spam', async () => {
  const args = fixture();
  const report = { state: 'degraded', affected: ['upbit_notices', 'bithumb'] };
  await updateIncident({ ...args, report });
  await updateIncident({ ...args, report });
  assert.equal(args.calls.created.length, 1);
  assert.equal(args.calls.updated.length, 0);
  await updateIncident({ ...args, report: { state: 'degraded', affected: ['upbit_notices'] } });
  assert.equal(args.calls.updated.length, 1);
});
test('temporary retry state cannot prematurely close an existing incident', async () => {
  const args = fixture();
  await updateIncident({ ...args, report: { state: 'degraded', affected: ['upbit'] } });
  await updateIncident({ ...args, report: { state: 'degraded', affected: [], pending: ['upbit'] } });
  assert.equal(args.calls.updated.length, 0);
  await updateIncident({ ...args, report: { state: 'healthy', affected: [], pending: [] } });
  assert.equal(args.calls.updated[0].state, 'closed');
});
test('untagged human issues are never modified', async () => {
  const args = fixture();
  args.open.push({ number: 7, title: '[자동 점검] 데이터 갱신 복구 필요', body: 'Human report' });
  await updateIncident({ ...args, report: { state: 'healthy', affected: [] } });
  assert.equal(args.calls.updated.length, 0);
});
