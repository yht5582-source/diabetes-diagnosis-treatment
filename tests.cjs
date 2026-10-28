// Rule tests for the decision engine embedded in index.html.
// Run: node tests.cjs
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const m = html.match(/\/\*ENGINE-START\*\/([\s\S]*?)\/\*ENGINE-END\*\//);
if (!m) throw new Error('engine block not found');
const mod = { exports: {} };
new Function('module', m[1])(mod);
const DM = mod.exports;
// case data lives in the UI script; pull the array literal out and evaluate it alone
const cm = html.match(/const CASES = (\[[\s\S]*?\n\]);/);
const CASES = new Function('return ' + cm[1])();

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n    ' + e.message); }
}
const ev = s => DM.evaluate(s);
const row = (r, start) => r.nhi.find(n => n.drug.startsWith(start));
const rec = (r, start) => r.rec.find(x => x.cls.startsWith(start));

console.log('Diagnosis (non-pregnant)');
t('nothing entered → incomplete', () => assert.equal(ev({}).d.status, 'incomplete'));
t('HbA1c 6.5 + FPG 126 same sample → confirmed', () => assert.equal(ev({ a1c: 6.5, fpg: 126 }).d.confirmed, true));
t('HbA1c 6.7 alone, no symptoms → probable, repeat HbA1c', () => { const d = ev({ a1c: 6.7, fpg: 118 }).d; assert.equal(d.status, 'probable'); assert.ok(d.next[0].includes('HbA1c')); });
t('single abnormal + repeat confirmed → dm', () => assert.equal(ev({ a1c: 6.7, repeatOk: true }).d.status, 'dm'));
t('random 210 without symptoms → not diagnostic', () => assert.equal(ev({ rpg: 210 }).d.status, 'probable'));
t('random 210 with symptoms → dm', () => assert.equal(ev({ rpg: 210, sym: true }).d.status, 'dm'));
t('random 199 with symptoms → not dm', () => assert.notEqual(ev({ rpg: 199, sym: true }).d.status, 'dm'));
t('prediabetes by HbA1c 5.7', () => assert.equal(ev({ a1c: 5.7 }).d.status, 'pre'));
t('prediabetes by FPG 125 / OGTT 199', () => { assert.equal(ev({ fpg: 125 }).d.status, 'pre'); assert.equal(ev({ ogtt: 199 }).d.status, 'pre'); });
t('normal values', () => assert.equal(ev({ a1c: 5.4, fpg: 92 }).d.status, 'normal'));
t('HbA1c unreliable → HbA1c ignored, warning shown', () => { const d = ev({ a1c: 7.2, a1cUnrel: true }).d; assert.equal(d.status, 'incomplete'); assert.ok(d.warn.length); });
t('crisis flag → warning + urgent recommendation', () => { const r = ev({ rpg: 500, crisis: true, age: 40 }); assert.ok(r.d.warn.some(w => /危象/.test(w))); assert.equal(r.rec[0].pri, '急'); });

console.log('Diagnosis (pregnancy)');
t('75 g fasting 92 → GDM', () => assert.equal(ev({ ctx: 'preg', ogF: 92 }).d.status, 'gdm'));
t('75 g 91/179/152 → normal', () => assert.equal(ev({ ctx: 'preg', ogF: 91, ogH1: 179, ogH2: 152 }).d.status, 'normal'));
t('HbA1c 6.5 in pregnancy → overt diabetes', () => assert.equal(ev({ ctx: 'preg', a1c: 6.5 }).d.status, 'overt'));
t('two-step: one abnormal 100 g value → not GDM', () => assert.equal(ev({ ctx: 'preg', ogMode: 'two', cF: 96, cH1: 170 }).d.status, 'normal'));
t('two-step: two abnormal → GDM', () => assert.equal(ev({ ctx: 'preg', ogMode: 'two', cF: 96, cH1: 185 }).d.status, 'gdm'));
t('GCT 145 alone → awaiting 100 g', () => assert.equal(ev({ ctx: 'preg', ogMode: 'two', gct: 145 }).d.status, 'probable'));
t('GDM target <6% + insulin first-line', () => { const r = ev({ ctx: 'preg', ogF: 95 }); assert.equal(r.tg.a1c, 6.0); assert.ok(rec(r, '胰島素').pri === '首選'); });

console.log('Classification & targets');
t('antibody positive → T1', () => assert.equal(ev({ known: true, ab: 'pos', age: 40 }).c.type, 't1'));
t('young + DKA, antibody not done → suspected T1', () => { const c = ev({ known: true, age: 22, dka: true }).c; assert.equal(c.type, 't1'); assert.ok(c.next.length); });
t('default adult → T2', () => assert.equal(ev({ known: true, age: 55, bmi: 28 }).c.type, 't2'));
t('steroid → other', () => assert.equal(ev({ known: true, steroid: true }).c.type, 'other'));
t('target default <7', () => assert.equal(ev({ known: true, age: 50 }).tg.a1c, 7.0));
t('complex older adult → <8', () => assert.equal(ev({ known: true, age: 80, health: 'complex' }).tg.a1c, 8.0));
t('very complex → no HbA1c target', () => assert.equal(ev({ known: true, age: 90, health: 'vcomplex' }).tg.a1c, null));
t('stricter goal ignored when hypoglycemia risk', () => assert.equal(ev({ known: true, age: 45, goalLow: true, hypoRisk: true }).tg.a1c, 7.0));

console.log('Guideline recommendations');
t('HbA1c >10 → insulin first', () => assert.equal(rec(ev({ known: true, a1c: 10.5 }), '起始胰島素').pri, '首選'));
t('eGFR 25 → metformin avoided', () => assert.equal(rec(ev({ known: true, egfr: 25 }), 'Metformin').pri, '避免'));
t('HF → SGLT2 first choice', () => assert.equal(rec(ev({ known: true, hf: true }), 'SGLT2').pri, '首選'));
t('CKD UACR 300 → SGLT2 + finerenone', () => { const r = ev({ known: true, egfr: 50, uacr: 300 }); assert.ok(rec(r, 'SGLT2')); assert.ok(rec(r, '非類固醇 MRA')); });
t('T1 → SGLT2 avoided', () => assert.equal(rec(ev({ known: true, ab: 'pos' }), 'SGLT2').pri, '避免'));
t('frail + SU + HbA1c 6.3 → de-intensify', () => assert.ok(rec(ev({ known: true, age: 84, health: 'complex', su: true, a1c: 6.3 }), '降階')));

console.log('NHI checks');
const T2 = { known: true, age: 58 };
t('metformin not used → SGLT2 conditional', () => assert.equal(row(ev({ ...T2, a1c: 8, met: 'none' }), 'SGLT2 抑制劑').status, 'cond'));
t('metformin max + HbA1c 8 → SGLT2 & DPP-4 ok', () => { const r = ev({ ...T2, a1c: 8, met: 'max' }); assert.equal(row(r, 'SGLT2 抑制劑').status, 'ok'); assert.equal(row(r, 'DPP-4').status, 'ok'); });
t('on DPP-4 already → SGLT2 conditional (pick one)', () => assert.equal(row(ev({ ...T2, a1c: 8, met: 'max', dpp4: true }), 'SGLT2 抑制劑').status, 'cond'));
t('combo needs ≥6 mo and HbA1c >7.5', () => { assert.equal(row(ev({ ...T2, a1c: 7.9, met: 'max', sglt2: true, addMo: 6 }), 'SGLT2＋DPP-4').status, 'ok'); assert.equal(row(ev({ ...T2, a1c: 7.5, met: 'max', sglt2: true, addMo: 6 }), 'SGLT2＋DPP-4').status, 'cond'); });
t('GLP-1 route 1: HbA1c 8.5 exactly is not enough', () => assert.ok(row(ev({ ...T2, a1c: 8.5, met: 'max', dpp4: false, ins: 20, addMo: 7 }), 'GLP-1').miss.some(x => x.includes('8.5'))));
t('GLP-1 route 1 with basal insulin 6 mo, HbA1c 8.8 → ok', () => assert.equal(row(ev({ ...T2, a1c: 8.8, met: 'max', ins: 20, addMo: 6 }), 'GLP-1').status, 'ok'));
t('GLP-1 route 3: MACE + metformin max → ok', () => assert.equal(row(ev({ ...T2, a1c: 7.4, met: 'max', mace: true }), 'GLP-1').status, 'ok'));
t('GLP-1 eligible but on SGLT2 → conditional with stop note', () => { const n = row(ev({ ...T2, a1c: 9, met: 'max', sglt2: true, addMo: 8 }), 'GLP-1'); assert.equal(n.status, 'cond'); assert.ok(n.miss[0].includes('停用')); });
t('Soliqua: insulin 60 U → conditional', () => assert.ok(row(ev({ ...T2, a1c: 9, met: 'max', ins: 60, addMo: 8 }), 'Insulin glargine').miss.some(x => x.includes('60'))));
t('2.16 CKD all criteria → ok', () => assert.equal(row(ev({ ...T2, egfr: 40, uacr: 300, acearb: true, ckdProg: true }), 'Dapagliflozin／empagliflozin 10 mg（慢性腎臟病）').status, 'ok'));
t('2.16 CKD UACR 150 → no', () => assert.equal(row(ev({ ...T2, egfr: 40, uacr: 150, acearb: true, ckdProg: true }), 'Dapagliflozin／empagliflozin 10 mg（慢性腎臟病）').status, 'no'));
t('2.16 CKD missing program → conditional', () => assert.equal(row(ev({ ...T2, egfr: 40, uacr: 300, acearb: true }), 'Dapagliflozin／empagliflozin 10 mg（慢性腎臟病）').status, 'cond'));
t('2.16 HF LVEF 45 needs hospitalization', () => { const n = row(ev({ ...T2, hf: true, lvef: 45, nyha2: true, hfMeds: true }), 'Dapagliflozin／empagliflozin 10 mg（心衰竭）'); assert.equal(n.status, 'cond'); assert.ok(n.miss.some(x => x.includes('住院'))); });
t('2.16 HF LVEF 55 → no', () => assert.equal(row(ev({ ...T2, hf: true, lvef: 55, nyha2: true, hfMeds: true }), 'Dapagliflozin／empagliflozin 10 mg（心衰竭）').status, 'no'));
t('T1 → 2.16 CKD excluded', () => assert.equal(row(ev({ known: true, ab: 'pos', egfr: 40, uacr: 300 }), 'SGLT2（CKD').status, 'no'));
t('tirzepatide listed as no specific rule', () => assert.equal(row(ev({ ...T2, a1c: 8 }), 'Tirzepatide').status, 'self'));

console.log('Teaching cases: quiz answers agree with the engine');
const R = CASES.map(c => ev(c.s));
t('10 cases, each with ≥2 questions and valid answer index', () => { assert.equal(CASES.length, 10); CASES.forEach(c => c.qs.forEach(q => assert.ok(q.a >= 0 && q.a < q.o.length && q.o.length === 4))); });
t('case 1 → probable, repeat HbA1c; after repeat metformin ok, GLP-1 conditional', () => { assert.equal(R[0].d.status, 'probable'); const r = ev({ ...CASES[0].s, repeatOk: true, met: 'none' }); assert.equal(r.d.status, 'dm'); assert.equal(row(r, 'Metformin').status, 'ok'); assert.equal(row(r, 'GLP-1').status, 'cond'); });
t('case 2 → dm by symptoms, T2, insulin first', () => { assert.equal(R[1].d.status, 'dm'); assert.equal(R[1].c.type, 't2'); assert.equal(rec(R[1], '起始胰島素').pri, '首選'); });
t('case 3 → T1, SGLT2 not reimbursed', () => { assert.equal(R[2].c.type, 't1'); assert.equal(row(R[2], 'SGLT2、DPP-4').status, 'no'); });
t('case 4 → SGLT2 & DPP-4 ok, GLP-1 conditional', () => { assert.equal(row(R[3], 'SGLT2 抑制劑').status, 'ok'); assert.equal(row(R[3], 'DPP-4').status, 'ok'); assert.equal(row(R[3], 'GLP-1').status, 'cond'); });
t('case 5 → GLP-1 ok via route 3', () => { const n = row(R[4], 'GLP-1'); assert.equal(n.status, 'ok'); assert.ok(n.why.includes('第 3 點')); });
t('case 6 → 2.16 CKD ok; metformin ≤1000', () => { assert.equal(row(R[5], 'Dapagliflozin／empagliflozin 10 mg（慢性腎臟病）').status, 'ok'); assert.ok(rec(R[5], 'Metformin').why.includes('1000')); });
t('case 7 → 2.16 HF ok, CKD route no', () => { assert.equal(row(R[6], 'Dapagliflozin／empagliflozin 10 mg（心衰竭）').status, 'ok'); assert.equal(row(R[6], 'Dapagliflozin／empagliflozin 10 mg（慢性腎臟病）').status, 'no'); });
t('case 8 → target <8, de-intensify, avoid SU', () => { assert.equal(R[7].tg.a1c, 8.0); assert.ok(rec(R[7], '降階')); assert.equal(rec(R[7], 'Sulfonylurea').pri, '避免'); });
t('case 8 after SU stopped, HbA1c 8.4 → DPP-4 ok', () => assert.equal(row(ev({ ...CASES[7].s, su: false, a1c: 8.4 }), 'DPP-4').status, 'ok'));
t('case 9 → GLP-1 eligible but must stop SGLT2', () => { const n = row(R[8], 'GLP-1'); assert.equal(n.status, 'cond'); assert.ok(n.why.includes('第 1 點')); });
t('case 10 → GDM, insulin first-line', () => { assert.equal(R[9].d.status, 'gdm'); assert.equal(rec(R[9], '胰島素').pri, '首選'); });

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
