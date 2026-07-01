import { readFileSync } from 'node:fs';
import { classifyPaneTail, isPaneBusy, tailPaneCapture } from '../../../src/server/channelsProbe.ts';
const dir = new URL('.', import.meta.url).pathname;
for (const f of ['claude-newchannels-pane.txt','claude-pane-super.txt','codex-pane.txt']) {
  const raw = readFileSync(dir+f,'utf8');
  const tail = tailPaneCapture(raw);
  let res;
  try { res = classifyPaneTail(tail); } catch(e){ res = {err:String(e)} }
  console.log('===', f);
  console.log('  isPaneBusy:', isPaneBusy(tail));
  console.log('  classify :', JSON.stringify(res));
}
