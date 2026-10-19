// Import before runtime modules: several paths are captured at module load.
import './lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test, { after, mock } from 'node:test';
import { holdWorkspaceActivity, tryAdmitWorkspaceActivity } from '../../../shared/worktrees/activity-gate.mjs';
import { cleanupTempDirs, makeRepo } from '../../../shared/worktrees/test-support.mjs';
import { processTable, scriptedChildTree } from './lib/process-table-fixture.mjs';

const tree = scriptedChildTree();
mock.module('../mcp/child-tree.mjs', { namedExports: tree.namedExports });
mock.module('./builtin/shell-jobs.mjs', {
  namedExports: {
    publishForegroundShellRecord() {},
    retireForegroundShellRecord() {},
    killShellJob() {},
  },
});
const descendants = await import('./lib/shell-descendants.mjs');
let probe = async () => null;
mock.module('./lib/shell-descendants.mjs', {
  namedExports: { ...descendants, probeShellDescendants: (...args) => probe(...args) },
});
let promote = async ({ run }) => {
  run.child.exitCode = 0;
  return { job: { jobId: 'job-1' } };
};
const kills = [];

// The child exits while promotion is committing.
mock.module('./lib/shell-run-background/promote-job.mjs', {
  namedExports: {
    promoteWithRetry: (...args) => promote(...args),
    handOverLease: async () => {},
    killAfterFailedPromotion: (...args) => kills.push(args),
  },
});

const { createAutoBackground } = await import('./lib/shell-run-background.mjs');
const { attachChildExit, createSettle } = await import('./lib/shell-run-settle.mjs');
const { releaseShellJobWorkspace } = await import('./builtin/lib/shell-job-records.mjs');
after(cleanupTempDirs);

test('completed-during-promotion resolves with the final read, not the mid-run snapshot', async () => {
  const reads = [];
  const taskOutput = {
    spilled: true,
    stdoutPath: 'out.log',
    stderrPath: 'err.log',
    stdoutFileSize: 5,
    stderrFileSize: 0,
    writeError: null,
    forceSpill() {},
    async getStdout(final = false) {
      reads.push(final);
      return final ? 'ok \uFFFD' : 'ok ';
    },
    async getStderr() {
      return '';
    },
  };
  let result;
  const run = {
    taskOutput,
    abortSignal: null,
    child: { exitCode: null, signalCode: null },
    taskId: 'task-1',
    startMs: Date.now(),
    settled: false,
    autoBackgrounded: false,
    killed: false,
    timedOut: false,
    resolveResult: (value) => {
      result = value;
    },
    isResolved: () => result !== undefined,
  };
  const autoBackground = createAutoBackground({
    run,
    command: 'x',
    cwd: '.',
    promotedTimeoutMs: 0,
    backgroundDeadlineMs: 0,
  });
  autoBackground({ reason: 'threshold' });
  for (let i = 0; i < 50 && !result; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(result, 'resolved');
  assert.equal(result.backgrounded, false);
  assert.equal(result.stdout, 'ok \uFFFD');
  assert.deepEqual(reads, [false, true]);
});

for (const scenario of [
  { name: 'exit zero', code: 0 },
  { name: 'nonzero exit', code: 7 },
  { name: 'signal exit', code: null, signal: 'SIGTERM' },
  { name: 'prior cancellation', code: null, signal: 'SIGKILL', cancelled: true },
  { name: 'surviving descendants', code: 0, survivor: true },
  { name: 'unverified descendants', code: 0, unknown: true },
  { name: 'exit before stdio close', code: 0, delayedClose: true },
  { name: 'drain grace consumed during promotion', code: 0, graceExpired: true },
]) {
  test(`failed promotion replays ordinary settlement after ${scenario.name}`, async (t) => {
    if (scenario.graceExpired) t.mock.timers.enable({ apis: ['setTimeout'] });
    const repo = makeRepo();
    const child = Object.assign(new EventEmitter(), { pid: 4242, exitCode: null, signalCode: null });
    const results = [];
    let output = 'head';
    kills.length = 0;
    tree.state.next = () => {
      throw new Error('enumeration unavailable');
    };
    probe = async () => {
      if (scenario.unknown) throw new Error('enumeration unavailable');
      return scenario.survivor ? { rootPid: 4242, taskId: 'job_promotion_race' } : null;
    };
    let released = 0;
    const run = {
      child,
      foregroundRecordId: 'job_promotion_race',
      foregroundRecordInput: { command: 'read-only', cwd: repo, ownerSessionId: 'promotion-test' },
      commandStartedAtMs: Date.now(),
      workspaceAdmission: tryAdmitWorkspaceActivity('promotion-test', repo, { kind: 'command' }),
      resourceLease: { release: async () => { released += 1; } },
      stdoutDecoder: { end: () => '' },
      stderrDecoder: { end: () => '' },
      taskOutput: {
        spilled: false,
        forceSpill() {},
        closeFds() {},
        getStdout: async () => output,
        getStderr: async () => '',
      },
      resolveResult: (result) => results.push(result),
      isResolved: () => results.length > 0,
    };
    run.settle = createSettle(run, () => {});
    attachChildExit(run, () => {});
    promote = async () => {
      if (scenario.cancelled) {
        run.killed = true;
        run.killCause = 'cancellation';
      }
      child.exitCode = scenario.code;
      child.signalCode = scenario.signal || null;
      child.emit('exit', child.exitCode, child.signalCode);
      if (scenario.graceExpired) {
        output += 'tail';
        t.mock.timers.tick(3000);
      } else if (!scenario.delayedClose) {
        output += 'tail';
        child.emit('close', child.exitCode, child.signalCode);
      }
      assert.equal(results.length, 0, 'terminal events during promotion cannot settle the run');
      return { job: null, promotionFailure: 'no native task record' };
    };
    try {
      createAutoBackground({ run, command: 'read-only', cwd: repo })();
      for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
      if (scenario.delayedClose) {
        assert.equal(results.length, 0, 'root exit is not stdio drain');
        assert.equal(released, 0, 'the resource lease stays owned until close');
        assert.throws(() => holdWorkspaceActivity([repo]), { code: 'WORKTREE_BUSY_JOBS' });
        output += 'tail';
        child.emit('close', child.exitCode, child.signalCode);
        for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
      }
      assert.equal(kills.length, 0, 'an exited child must not enter the kill fallback');
      assert.equal(results.length, 1);
      const result = results[0];
      assert.equal(result.exitCode, scenario.unknown ? 1 : scenario.code);
      assert.equal(result.signal, scenario.signal || null);
      assert.equal(Boolean(result.killed), Boolean(scenario.cancelled));
      assert.equal(Boolean(result.timedOut), false);
      assert.equal(run.killCause, scenario.cancelled ? 'cancellation' : undefined);
      assert.equal(result.stdout, 'headtail');
      assert.equal(Boolean(result.partialOutput), Boolean(scenario.graceExpired));
      assert.equal(released, 1);
      if (scenario.survivor || scenario.unknown || scenario.cancelled) {
        assert.throws(() => holdWorkspaceActivity([repo]), { code: 'WORKTREE_BUSY_JOBS' });
      } else {
        holdWorkspaceActivity([repo])();
      }
      await run.settle(child.exitCode, child.signalCode);
      assert.equal(results.length, 1, 'a later terminal event is idempotent');
    } finally {
      run.stopTerminationWatch?.();
      run.workspaceAdmission?.();
      releaseShellJobWorkspace(run.foregroundRecordId);
    }
  });
}

test('failed promotion of a live child retains the fail-closed kill fallback', async () => {
  kills.length = 0;
  promote = async () => ({ job: null, promotionFailure: 'registry unavailable' });
  const run = {
    child: { exitCode: null, signalCode: null },
    taskOutput: { forceSpill() {} },
    isResolved: () => false,
  };
  createAutoBackground({ run, command: 'read-only', cwd: '.' })();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(kills, [[run, 'threshold', 'registry unavailable']]);
});
