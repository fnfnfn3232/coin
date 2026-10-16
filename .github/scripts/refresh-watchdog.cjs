const WORKFLOW = 'auto-refresh-data.yml';
const INCIDENT_TITLE = '[자동 점검] 데이터 갱신 복구 필요';
const MARKER = '<!-- coin-refresh-monitor-v1 -->';
const STALE_MS = 30 * 60 * 1000;
const ACTIVE_MS = 20 * 60 * 1000;

function recoveryPlan(runs, now = Date.now()) {
  const relevant = runs.filter(run => run.head_branch === 'main' && !['pull_request', 'pull_request_target'].includes(run.event));
  const stamp = run => Date.parse(run.run_started_at || run.created_at || '') || 0;
  const lastSuccess = Math.max(0, ...relevant.filter(run => run.status === 'completed' && run.conclusion === 'success')
    .map(run => Date.parse(run.updated_at || run.created_at || '') || 0));
  const busy = relevant.some(run => ['queued', 'pending', 'in_progress', 'waiting', 'requested'].includes(run.status) && now - stamp(run) < ACTIVE_MS);
  const stale = !lastSuccess || now - lastSuccess > STALE_MS;
  const lastAttempt = Math.max(0, ...relevant.map(stamp));
  return { stale, dispatch: stale && !busy && now - lastAttempt >= 15 * 60 * 1000, busy };
}

async function updateIncident({ github, context, report }) {
  const { owner, repo } = context.repo;
  const issues = await github.paginate(github.rest.issues.listForRepo, { owner, repo, state: 'open', per_page: 100, creator: 'github-actions[bot]' });
  const open = issues.filter(issue => !issue.pull_request && issue.title === INCIDENT_TITLE && issue.body?.includes(MARKER));
  const affected = [...new Set(report.affected || [])].sort();
  if (affected.length) {
    const body = `${MARKER}\n자동 점검에서 반복되거나 장시간 지속된 갱신 장애를 확인했습니다.\n\n대상: ${affected.map(name => `\`${name}\``).join(', ')}\n\n마지막 정상 데이터는 유지하며 재시도와 검증된 예비 경로 전환을 계속합니다. 인증 정보나 원본 데이터는 이 이슈에 기록하지 않습니다.\n\n[자동 갱신 실행 기록](https://github.com/${owner}/${repo}/actions/workflows/${WORKFLOW})\n\n정상 갱신이 확인되면 이 이슈는 자동 종료됩니다.`;
    if (!open.length) {
      await github.rest.issues.create({ owner, repo, title: INCIDENT_TITLE, body });
    } else if (open[0].body !== body) {
      await github.rest.issues.update({ owner, repo, issue_number: open[0].number, body });
    }
  } else if (report.state === 'healthy' && !(report.pending || []).length) {
    for (const issue of open) {
      await github.rest.issues.update({ owner, repo, issue_number: issue.number, state: 'closed', state_reason: 'completed' });
    }
  }
}

async function watchdog({ github, context, core, now = Date.now() }) {
  const { owner, repo } = context.repo;
  const { data: { workflow_runs: runs } } = await github.rest.actions.listWorkflowRuns({ owner, repo, workflow_id: WORKFLOW, branch: 'main', per_page: 100 });
  const plan = recoveryPlan(runs, now);
  if (!plan.stale) {
    core.info('Refresh workflow is current; no duplicate rebuild requested.');
    return plan;
  }
  const { data: workflow } = await github.rest.actions.getWorkflow({ owner, repo, workflow_id: WORKFLOW });
  // Respect an intentional operator stop; only recover GitHub's inactivity disablement.
  if (workflow.state === 'disabled_inactivity') {
    await github.rest.actions.enableWorkflow({ owner, repo, workflow_id: WORKFLOW });
  } else if (workflow.state !== 'active') {
    core.warning(`Automatic restart skipped: ${workflow.state}`);
    await updateIncident({ github, context, report: { state: 'degraded', affected: ['refresh_workflow_disabled'] } });
    return { ...plan, dispatch: false };
  }
  if (plan.dispatch) {
    await github.rest.actions.createWorkflowDispatch({ owner, repo, workflow_id: WORKFLOW, ref: 'main' });
    core.warning('Stale refresh detected; requested one recovery run.');
  }
  await updateIncident({ github, context, report: { state: 'degraded', affected: ['refresh_workflow_stale'] } });
  return plan;
}

module.exports = { recoveryPlan, updateIncident, watchdog };
