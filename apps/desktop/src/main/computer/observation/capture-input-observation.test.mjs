import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertTargetInputUnchanged,
  createInputObservationReader,
  foregroundInputState,
} from './capture-input-observation.ts';

const observation = () => ({
  ready: true, monitor: 'global', sequence: 3,
  target: { ready: true, monitor: 'app', sequence: 9, windowId: 'hwnd:0x1' },
});

test('target and global watermarks protect independent input routes', () => {
  const before = observation();
  const unrelated = { ...observation(), sequence: 4 };
  assert.doesNotThrow(() => assertTargetInputUnchanged(before, unrelated));
  assert.equal(foregroundInputState(before, unrelated).foregroundReady, false);
  const intervened = observation();
  intervened.target.sequence++;
  assert.throws(() => assertTargetInputUnchanged(before, intervened), /user_input_active/);
  assert.doesNotThrow(() => assertTargetInputUnchanged(observation(), observation()));
});

test('lost attribution, observer replacement and target changes all fail closed', () => {
  for (const target of [
    undefined,
    { ...observation().target, ready: false, reason: 'event_tap_unavailable' },
    { ...observation().target, monitor: 'replacement' },
    { ...observation().target, windowId: 'hwnd:0x2' },
  ]) {
    assert.throws(
      () => assertTargetInputUnchanged(observation(), { ...observation(), target }),
      /target_input_observation_unavailable/
    );
  }
  assert.throws(() => assertTargetInputUnchanged(undefined, observation()), /target_input_observation_unavailable/);
});

test('reader sends exact macOS target and rejects malformed or mismatched target evidence', async () => {
  let target = { ready: true, monitor: 'app', sequence: 0, window_id: 'hwnd:0x1' };
  const requests = [];
  const read = createInputObservationReader({
    assertExecutionNotAborted() {},
    sessionIdFor: () => 'session',
    callPowerShell: async (request) => {
      requests.push(request);
      return { ok: true, result: { observer_ready: true, monitor: 'global', sequence: 4, target_observation: target } };
    },
  }, {}, () => 'hwnd:0x1');
  const value = await read();
  assert.equal(value.monitor, 'global');
  assert.equal(value.sequence, 4);
  assert.equal(requests[0].window_id, process.platform === 'darwin' ? 'hwnd:0x1' : undefined);
  assert.equal(requests[0].read_only, true);
  if (process.platform !== 'darwin') {
    assert.equal(value.target, undefined);
    return;
  }
  assert.equal(value.target.ready, true);
  for (const invalid of [
    { window_id: 'hwnd:0x2' }, { sequence: -1 }, { sequence: 1.5 }, { sequence: '0' }, { monitor: '' },
  ]) {
    target = { ready: true, monitor: 'app', sequence: 0, window_id: 'hwnd:0x1', ...invalid };
    assert.equal((await read()).target.ready, false);
  }
});
