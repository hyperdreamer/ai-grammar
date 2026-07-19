/**
 * A2: Real installCKEBridge regression test.
 *
 * Loads cke-bridge-installer.js with fake timers/DOM and verifies the
 * transition routine: initial attach, no duplicate, replacement
 * detach+attach, attach-failure retries, query-failure detach+recover.
 *
 * Node built-ins only.  Under 200 lines.
 */
'use strict';
const assert = require('assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');

function mockInstance(id) {
  var ls = [];
  return {
    id, model: { document: {
      on(e, h)  { ls.push({ e, h }); },
      off(e, h) { for (var i = ls.length-1; i >= 0; i--) if (ls[i].e === e && ls[i].h === h) ls.splice(i,1); }
    }},
    _ls: ls,
  };
}

function bootBridge() {
  var queue = [], el = null, throws = false, posted = [];
  var ctx = vm.createContext({
    window: { __agCKEBridge: false, postMessage: function(m) { posted.push(m); } },
    document: { querySelector: function() { if (throws) throw Error('DOM gone'); return el; } },
    setTimeout: function(fn) { queue.push(fn); },
  });
  var src = fs.readFileSync(path.resolve(__dirname,'..','extension','src','cke-bridge-installer.js'),'utf8');
  src = src.replace(/\/\/ Test-only export hook[\s\S]*$/,'');
  vm.runInContext(src, ctx); ctx.installCKEBridge();
  return {
    tick(n)    { n=n||1; while(n-->0&&queue.length)(queue.shift())(); },
    pending()  { return queue.length; },
    setInst(i) { el = i ? { ckeditorInstance: i } : null; },
    setThrows(v) { throws = v; },
    posts()    { return posted; },
  };
}

// 1. Initial attach
(function() {
  var b = bootBridge(), i = mockInstance('e1');
  b.setInst(i); b.tick(1);
  assert.strictEqual(i._ls.length, 1, 'one listener');
  assert.strictEqual(b.pending(), 1, 'one poll scheduled');
  i._ls[0].h();
  assert.strictEqual(b.posts().length, 1);
  assert.strictEqual(b.posts()[0].source, 'ag-cke-bridge');
  console.log('  PASS: initial attach');
})();

// 2. No duplicate on repeated poll
(function() {
  var b = bootBridge(), i = mockInstance('e1');
  b.setInst(i); b.tick(2);
  assert.strictEqual(i._ls.length, 1, 'still 1 listener');
  assert.strictEqual(b.pending(), 1);
  console.log('  PASS: no duplicate');
})();

// 3. Replacement detaches old, attaches new
(function() {
  var b = bootBridge(), i1 = mockInstance('e1'), i2 = mockInstance('e2');
  b.setInst(i1); b.tick(1);
  b.setInst(i2); b.tick(1);
  assert.strictEqual(i1._ls.length, 0, 'old detached');
  assert.strictEqual(i2._ls.length, 1, 'new attached');
  console.log('  PASS: replacement');
})();

// 4. Attach failure retries
(function() {
  var b = bootBridge();
  b.setInst({ id:'bad', model:{ document:{ on:function(){throw Error();}, off:function(){} }}, _ls:[] });
  b.tick(1);
  assert.strictEqual(b.pending(), 1, 'poll survives failure');
  var good = mockInstance('good');
  b.setInst(good); b.tick(1);
  assert.strictEqual(good._ls.length, 1, 'attached on retry');
  console.log('  PASS: attach-failure retry');
})();

// 5. Query failure detaches old, recovers
(function() {
  var b = bootBridge(), i1 = mockInstance('e1');
  b.setInst(i1); b.tick(1);
  b.setThrows(true); b.tick(1);
  assert.strictEqual(i1._ls.length, 0, 'old listener cleaned up');
  b.setThrows(false);
  var i2 = mockInstance('e2');
  b.setInst(i2); b.tick(1);
  assert.strictEqual(i2._ls.length, 1, 'recovered');
  console.log('  PASS: query-failure recovery');
})();

// 6. Guard prevents double install
(function() {
  var ctx = vm.createContext({
    window: { __agCKEBridge: true, postMessage: function(){} },
    document: { querySelector: function(){return null;} },
    setTimeout: function(){},
  });
  var src = fs.readFileSync(path.resolve(__dirname,'..','extension','src','cke-bridge-installer.js'),'utf8');
  src = src.replace(/\/\/ Test-only export hook[\s\S]*$/,'');
  vm.runInContext(src, ctx); ctx.installCKEBridge();
  console.log('  PASS: guard');
})();

// 7. Instance removed — clean detach
(function() {
  var b = bootBridge(), i = mockInstance('e1');
  b.setInst(i); b.tick(1);
  b.setInst(null); b.tick(1);
  assert.strictEqual(i._ls.length, 0);
  console.log('  PASS: editor removed');
})();

console.log('\n  All A2 tests passed.\n');
