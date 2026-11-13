// The disruption guard: a refusal is a value with a reason, never an exception and
// never an interruption.
import { suite, loadLib } from './harness.mjs';
import { createFakeAdb } from './fake-adb.mjs';

const { readOwnerState, guardDisplayZero, withIdleOwner } = await loadLib('guard.mjs');
const { createActions } = await loadLib('actions.mjs');

const s = suite('guard');

const awake = createFakeAdb();
const awakeState = await readOwnerState(awake);
await s.eq('an awake, unlocked phone reads as active', awakeState.verdict, 'active');
const refuse = guardDisplayZero(awakeState, { action: 'tap on display 0' });
await s.ok('the guard refuses while the owner is active', () => refuse.allowed === false && refuse.refused === true && refuse.ok === false);
await s.eq('the refusal names its cause', refuse.reason, 'owner-active');
await s.ok('the refusal is a plain object, not a throw', () => typeof refuse.detail === 'string' && refuse.target === 'display-0');
await s.ok('the refusal states what to do instead', () => /screen is off or locked/i.test(refuse.detail));

const idle = createFakeAdb().set({ wakefulness: 'Asleep' });
const idleState = await readOwnerState(idle);
await s.ok('a sleeping phone is idle', () => idleState.verdict === 'idle' && idleState.screenOff === true);
await s.ok('the guard allows display 0 while the screen is off', () => guardDisplayZero(idleState).allowed === true && guardDisplayZero(idleState).reason === 'owner-idle');

const locked = createFakeAdb().set({ keyguard: true });
const lockedState = await readOwnerState(locked);
await s.ok('a lockscreen counts as idle even with the panel on', () => lockedState.verdict === 'idle' && lockedState.locked === true);

const calling = createFakeAdb().set({ inCall: true });
const callState = await readOwnerState(calling);
await s.ok('a call is active and is named separately', () => callState.verdict === 'active' && callState.inCall === true);
await s.eq('an in-call refusal says so', guardDisplayZero(callState).reason, 'owner-in-call');

let ran = false;
const blocked = await withIdleOwner(awake, async () => {
  ran = true;
  return 'touched';
});
await s.ok('withIdleOwner does not run its body while the owner is active', () => blocked.refused === true && blocked.value === null && ran === false);

const allowed = await withIdleOwner(idle, async () => 'touched');
await s.ok('withIdleOwner runs its body when the owner is idle', () => allowed.ok === true && allowed.value === 'touched');

// The guard protects display 0. It must not block the private display, because the
// whole point of the virtual tier is to work while the owner is active.
const fake = createFakeAdb();
const opened = await createActions({ adb: fake, tier: 'virtual', display: { id: 134, sfId: '11529215048562781705', width: 720, height: 1280 } }).tap(360, 640);
await s.ok('a virtual-display tap succeeds while the owner is active', () => opened.ok === true && opened.tier === 'virtual');
await s.eq('and the only input call targets the overlay', fake.command('input'), ['input -d 134 tap 360 640']);

s.finish();
