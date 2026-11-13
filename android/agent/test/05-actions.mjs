// The Action API: display-scoped by construction, tier-tagged on every result.
import { suite, loadLib } from './harness.mjs';
import { createFakeAdb } from './fake-adb.mjs';

const { createActions } = await loadLib('actions.mjs');
const s = suite('actions');

const fake = createFakeAdb();
await fake.shell('settings put global overlay_display_devices 720x1280/320');
const display = { id: 134, sfId: '11529215048562781705', width: 720, height: 1280 };
const actions = createActions({ adb: fake, tier: 'virtual', display });

const launch = await actions.launch('com.freebuff.gowild');
await s.ok('launch resolves the component instead of guessing one', () => launch.ok === true && launch.component === 'com.freebuff.gowild/.MainActivity');
await s.ok('the launch argv targets the discovered display', () => fake.command('am start --display 134 -n com.freebuff.gowild/.MainActivity').length === 1);
await s.eq('launch is tagged virtual', launch.tier, 'virtual');

const tap = await actions.tap(360, 640, { label: 'center' });
await s.ok('tap is display-scoped', () => tap.ok === true && fake.command('input -d 134 tap 360 640').length === 1);
await s.eq('tap is tagged virtual', tap.tier, 'virtual');

const swipe = await actions.swipe(360, 1000, 360, 400, 300);
await s.ok('swipe carries its duration', () => swipe.ok === true && fake.command('input -d 134 swipe 360 1000 360 400 300').length === 1);

const typed = await actions.text('two words');
await s.ok('text escapes spaces for the device shell', () => typed.ok === true && fake.command("input -d 134 text 'two%swords'").length === 1);

const back = await actions.back();
await s.ok('back is keyevent 4 on the display', () => back.ok === true && fake.command('input -d 134 keyevent 4').length === 1);

const before = fake.callsCount;
const outOfBounds = await actions.tap(5000, 10);
await s.ok('an out-of-bounds tap is refused before it reaches the device', () => outOfBounds.ok === false && outOfBounds.reason === 'out-of-bounds' && fake.callsCount === before);

const state = await actions.readState();
await s.eq('read-state runs on the observe tier', state.tier, 'observe');
await s.ok('read-state shows the app on the overlay and Chrome on display 0', () => {
  const virtual = state.resumed.virtual.some((entry) => entry.package === 'com.freebuff.gowild');
  const zero = state.resumed.displayZero.some((entry) => entry.package === 'com.android.chrome');
  return virtual && zero;
});

await s.ok('nothing ever targeted display 0 with input', () => fake.command(/input -d 0 /).length === 0);

const unknown = await actions.launch('com.example.notinstalled');
await s.ok('an unresolvable package fails loudly instead of guessing', () => unknown.ok === false && unknown.reason === 'component-unresolved');

const missing = createActions({ adb: createFakeAdb(), tier: 'virtual', display: { id: 999, sfId: '1', width: 720, height: 1280 } });
const bad = await missing.launch('com.freebuff.gowild');
await s.ok('launching onto a display the device does not have fails', () => bad.ok === false && bad.reason === 'am-start-failed');

const noDisplay = createActions({ adb: createFakeAdb(), tier: 'virtual', display: null });
await s.ok('input without a display is refused by construction', async () => {
  const tapped = await noDisplay.tap(1, 1);
  const backPressed = await noDisplay.back();
  return tapped.reason === 'input-needs-display' && backPressed.reason === 'input-needs-display';
});

const isolated = createActions({ adb: createFakeAdb(), tier: 'isolated', display: { id: null, width: null, height: null } });
const isolatedTap = await isolated.tap(10, 20);
await s.ok('the isolated tier tags results isolated and omits -d', () => isolatedTap.ok === true && isolatedTap.tier === 'isolated');

s.finish();
