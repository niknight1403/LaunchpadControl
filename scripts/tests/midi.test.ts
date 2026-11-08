import { LaunchpadMidiManager } from '../../src/midi/LaunchpadMidiManager';
import { MockMidiTransport } from '../../src/midi/MockMidiTransport';
import { toWireChannel, velocityBrightness } from '../../src/midi/LaunchpadProfiles';
import { check, near, section } from './harness';

export async function run(): Promise<void> {
  section('Launchpad wire format');
  const transport = new MockMidiTransport();
  const manager = new LaunchpadMidiManager(transport);
  await manager.open();

  const afterOpen = transport.sent[0] ?? new Uint8Array();
  check(
    'programmer-mode SysEx is sent on open',
    afterOpen[0] === 0xf0 && afterOpen[4] === 0x0d,
    Array.from(afterOpen).join(','),
  );
  check('enter programmer mode flag', Array.from(afterOpen).slice(5, 7).join(',') === '0,1');

  transport.sent.length = 0;
  manager.setPad(0, 0, { r: 0, g: 242, b: 254 });
  manager.flush();
  const message = transport.sent[0] ?? new Uint8Array();
  check(
    'lighting SysEx header',
    Array.from(message).slice(0, 6).join(',') === '240,0,32,41,13,3',
    Array.from(message).join(','),
  );
  // y = 0 is the top visual row → hardware row 7 → note (7+1)*10 + 0 + 1 = 81
  check('top-left pad addressed as note 81', message[7] === 81, String(message[7]));
  // 242/255*127 = 120.5 → 121, 254/255*127 = 126.5 → 127
  check('RGB is scaled to 0..127', message[9] === 121 && message[10] === 127, `${message[9]},${message[10]}`);
  check('message is terminated', message[message.length - 1] === 0xf7);

  transport.sent.length = 0;
  manager.setPad(0, 0, { r: 0, g: 242, b: 254 });
  manager.flush();
  check('unchanged pad is not retransmitted (diff ledger)', transport.sent.length === 0);

  let hit: { row: number; col: number; velocity: number } | null = null;
  manager.onPad((event) => {
    hit = { row: event.row, col: event.col, velocity: event.velocity };
  });
  transport.inject([0x90, 11, 100]);
  check('note 11 decodes to bottom-left of the hardware grid', hit !== null && (hit as { row: number }).row === 0);
  check('velocity normalised to 0..1', hit !== null && near((hit as { velocity: number }).velocity, 100 / 127, 0.001));

  let controlIndex = -1;
  manager.onControl((event) => {
    controlIndex = event.index;
  });
  transport.inject([0xb0, 104, 127]);
  check('top row CC 104 decodes to control 0', controlIndex === 0);

  check('screen cell for note 11 is the bottom visual row', manager.screenCellForNote(11)?.row === 7);
  check('brightness mapping keeps a floor', velocityBrightness(0) >= 0.1 && velocityBrightness(1) <= 1);
  check('wire channel clamp', toWireChannel(255) === 127 && toWireChannel(0) === 0);

  await manager.close();
}
