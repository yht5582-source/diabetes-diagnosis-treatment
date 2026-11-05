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


console.log('Regressions from the 2026-11-05 debug pass');
t('overt diabetes in pregnancy → no metformin/GLP-1 first, insulin first', () => { const r = ev({ ctx: 'preg', a1c: 7.1, bmi: 30, age: 30 }); assert.equal(r.c.type, 'pg'); assert.equal(rec(r, '胰島素').pri, '首選'); assert.ok(!r.rec.some(x => x.pri === '首選' && /Metformin|GLP-1|SGLT2/.test(x.cls))); });
t('known diabetes + pregnancy → overt, no OGTT asked', () => { const r = ev({ ctx: 'preg', known: true, a1c: 6.2 }); assert.equal(r.d.status, 'overt'); });
t('pregnancy overt → stop RAS inhibitors, aspirin listed', () => { const r = ev({ ctx: 'preg', known: true }); assert.equal(rec(r, 'ACEI').pri, '避免'); assert.equal(rec(r, '低劑量 aspirin').pri, '首選'); });
t('known + crisis → warning shown', () => assert.ok(ev({ known: true, crisis: true, age: 50 }).d.warn.some(w => /危象/.test(w))));
t('crisis T2 → SGLT2 and metformin avoided, nothing started first', () => { const r = ev({ known: true, crisis: true, age: 50, hf: true, egfr: 50, uacr: 300 }); assert.equal(rec(r, 'SGLT2').pri, '避免'); assert.equal(rec(r, 'Metformin').pri, '避免'); assert.ok(!r.rec.some(x => x.pri === '首選')); });
t('eGFR 38, metformin not started → do not initiate', () => { assert.equal(rec(ev({ known: true, egfr: 38, met: 'none' }), 'Metformin').pri, '避免'); assert.equal(row(ev({ known: true, egfr: 38, met: 'none' }), 'Metformin').status, 'cond'); });
t('eGFR 38, already on metformin → reduce, not stop', () => { const m = rec(ev({ known: true, egfr: 38, met: 'sub' }), 'Metformin'); assert.equal(m.pri, '考慮'); assert.ok(m.why.includes('1000')); });
t('eGFR 45 → metformin may start', () => assert.equal(rec(ev({ known: true, egfr: 45, met: 'none' }), 'Metformin').pri, '首選'));
t('eGFR 19 not on SGLT2i → do not start; on SGLT2i → continue', () => { const r = ev({ known: true, hf: true, egfr: 19 }); assert.equal(rec(r, 'SGLT2 抑制劑').pri, '避免'); assert.ok(!rec(r, 'SGLT2i＋GLP-1')); assert.equal(rec(ev({ known: true, hf: true, egfr: 19, sglt2: true }), 'SGLT2 抑制劑').pri, '考慮'); });
t('eGFR 20 → may start SGLT2i', () => assert.equal(rec(ev({ known: true, egfr: 20 }), 'SGLT2').pri, '首選'));
t('eGFR 29 → GLP-1 RA first for glucose', () => assert.equal(rec(ev({ known: true, egfr: 29 }), 'GLP-1 RA（semaglutide）').pri, '首選'));
t('MACE alone counts as ASCVD', () => assert.ok(rec(ev({ known: true, mace: true }), '具心血管實證')));
t('HF + MASLD → pioglitazone not suggested', () => assert.ok(!ev({ known: true, hf: true, masld: true }).rec.some(x => x.pri !== '避免' && /pioglitazone/.test(x.cls))));
t('pancreatitis → incretins avoided, none suggested', () => { const r = ev({ known: true, pancreas: true, bmi: 30, a1c: 9, egfr: 50, uacr: 300, mace: true, hypoRisk: true }); assert.equal(rec(r, 'GLP-1 RA、tirzepatide、DPP-4').pri, '避免'); assert.ok(!r.rec.some(x => x.pri !== '避免' && /GLP-1|DPP-4/.test(x.cls + ''.concat(x.more)))); });
t('hypoglycemia risk → SU not in second-line list', () => assert.ok(!ev({ known: true, a1c: 8, hypoRisk: true, age: 60 }).rec.some(x => x.pri !== '避免' && /SU$|、SU/.test(x.cls))));
t('HFpEF + BMI 30 → tirzepatide or GLP-1 listed; HFrEF → not', () => { assert.ok(rec(ev({ known: true, hf: true, lvef: 55, bmi: 30 }), 'Tirzepatide 或')); assert.ok(!rec(ev({ known: true, hf: true, lvef: 30, bmi: 24 }), 'Tirzepatide 或')); });
t('A1c >10 flagged unreliable → not used for severe', () => assert.ok(!rec(ev({ known: true, a1c: 11, a1cUnrel: true }), '起始胰島素')));
t('severe → GLP-1 note not stating no severe hyperglycemia', () => assert.equal(rec(ev({ known: true, a1c: 11, bmi: 30 }), 'GLP-1 RA 或').more, ''));
t('avoid beats consider when DPP-4 + GLP-1 together', () => assert.equal(rec(ev({ known: true, glp1: true, dpp4: true, hypoRisk: true }), 'DPP-4').pri, '避免'));
t('no ACEI/ARB suggested at UACR <30 with eGFR ≥60', () => assert.ok(!rec(ev({ known: true, egfr: 70, uacr: 12 }), 'ACEI')));
t('out-of-range values ignored with a warning', () => { const r = ev({ known: true, a1c: 67, egfr: -5 }); assert.ok(r.d.warn[0].includes('HbA1c 67')); assert.ok(!r.rec.some(x => x.why.includes('eGFR -5'))); assert.ok(!rec(r, '起始胰島素')); });
t('input state is not mutated by evaluate', () => { const s = { a1c: 67 }; ev(s); assert.equal(s.a1c, 67); });
t('NHI: on GLP-1 → SGLT2 and DPP-4 conditional', () => { const r = ev({ ...T2, a1c: 8, met: 'max', glp1: true }); assert.equal(row(r, 'SGLT2 抑制劑').status, 'cond'); assert.equal(row(r, 'DPP-4').status, 'cond'); assert.equal(row(r, 'GLP-1').status, 'cond'); });
t('NHI: stale SU-max checkbox ignored when SU off', () => assert.ok(row(ev({ ...T2, a1c: 9, suMax: true, ins: 20, addMo: 7 }), 'GLP-1').miss.some(m => m.includes('metformin'))));
t('NHI: metformin blank → SU conditional', () => assert.equal(row(ev({ ...T2, a1c: 8 }), 'Sulfonylurea').status, 'cond'));
t('NHI: metformin intolerance → metformin row no', () => assert.equal(row(ev({ ...T2, met: 'intol' }), 'Metformin').status, 'no'));
const CK = 'Dapagliflozin／empagliflozin 10 mg（慢性腎臟病）';
t('NHI 2.16: on SGLT2i, eGFR 20 → continuation, not refused', () => { const n = row(ev({ ...T2, sglt2: true, egfr: 20, uacr: 150, acearb: true, ckdProg: true }), CK); assert.equal(n.status, 'cond'); });
t('NHI 2.16: on SGLT2i, eGFR 14 → stop', () => assert.equal(row(ev({ ...T2, sglt2: true, egfr: 14, uacr: 300, acearb: true, ckdProg: true }), CK).status, 'no'));
t('NHI 2.16: new start, eGFR 24 → no; 25 and 60 → ok', () => { const b = { ...T2, uacr: 300, acearb: true, ckdProg: true }; assert.equal(row(ev({ ...b, egfr: 24 }), CK).status, 'no'); assert.equal(row(ev({ ...b, egfr: 25 }), CK).status, 'ok'); assert.equal(row(ev({ ...b, egfr: 60 }), CK).status, 'ok'); });
t('NHI: other type gets a reminder row', () => assert.ok(row(ev({ known: true, steroid: true }), '其他特定型提醒')));
t('NHI: T1 + HF → heart failure row is conditional', () => assert.equal(row(ev({ known: true, ab: 'pos', hf: true }), 'SGLT2（心衰竭').status, 'cond'));
t('pregnancy test labels are not called diabetes threshold', () => { const d = ev({ ctx: 'preg', ogF: 95 }).d; assert.equal(d.tests[0].lab, '達 GDM 門檻'); });

console.log('Second source check: NHI text, ADA/EASD, KDIGO');
t('metformin new start eGFR 38 notes the KDIGO difference', () => assert.ok(rec(ev({ known: true, egfr: 38, met: 'none' }), 'Metformin').more.includes('KDIGO')));
t('finerenone first when on max RAS inhibitor, otherwise consider; eGFR 24 none', () => { assert.equal(rec(ev({ known: true, egfr: 50, uacr: 300, acearb: true }), '非類固醇').pri, '首選'); assert.equal(rec(ev({ known: true, egfr: 50, uacr: 300 }), '非類固醇').pri, '考慮'); assert.ok(!rec(ev({ known: true, egfr: 24, uacr: 300, acearb: true }), '非類固醇')); });
t('CKD → GLP-1 RA first choice', () => assert.equal(rec(ev({ known: true, egfr: 50, uacr: 300 }), 'GLP-1 RA（semaglutide）').pri, '首選'));
t('CKD or ASCVD or HF → combination listed with the NHI note; none without', () => { assert.ok(rec(ev({ known: true, mace: true }), 'SGLT2i＋GLP-1').more.includes('健保')); assert.ok(!rec(ev({ known: true, age: 50, a1c: 8 }), 'SGLT2i＋GLP-1')); });
t('no comorbidity → early SGLT2i and/or GLP-1 even at goal', () => assert.ok(rec(ev({ known: true, age: 50, a1c: 6.8 }), 'SGLT2i 和／或 GLP-1 類')));
t('severe hyperglycemia → early-use card absent', () => assert.ok(!rec(ev({ known: true, a1c: 11 }), 'SGLT2i 和／或')));
t('HFmrEF → finerenone listed; HFrEF → not', () => { assert.ok(rec(ev({ known: true, hf: true, lvef: 45 }), '非類固醇')); assert.ok(!rec(ev({ known: true, hf: true, lvef: 35 }), '非類固醇')); });
t('BMI 27.5 → surgery; 27.4 → not', () => { assert.ok(rec(ev({ known: true, bmi: 27.5 }), '評估代謝手術')); assert.ok(!rec(ev({ known: true, bmi: 27.4 }), '評估代謝手術')); });
t('starting insulin on SU → advises stopping SU', () => assert.ok(rec(ev({ known: true, a1c: 11, su: true }), '起始胰島素').more.includes('停用 SU')));
t('CKD target note from KDIGO; eGFR 25 notes HbA1c accuracy; no CKD none', () => { assert.ok(ev({ known: true, egfr: 50 }).tg.why.some(x => x.includes('KDIGO'))); assert.ok(ev({ known: true, egfr: 25 }).tg.why.some(x => x.includes('準確度'))); assert.ok(!ev({ known: true, egfr: 70 }).tg.why.some(x => x.includes('KDIGO'))); });
const HFR = 'Dapagliflozin／empagliflozin 10 mg（心衰竭）', hfb = { ...T2, hf: true, nyha2: true, hfMeds: true };
t('2.16 HF boundaries 40, 41, 49, 50', () => { assert.equal(row(ev({ ...hfb, lvef: 40 }), HFR).status, 'ok'); assert.equal(row(ev({ ...hfb, lvef: 41 }), HFR).status, 'cond'); assert.equal(row(ev({ ...hfb, lvef: 49, hfHosp: true }), HFR).status, 'ok'); assert.equal(row(ev({ ...hfb, lvef: 50 }), HFR).status, 'no'); });
t('2.16 HF decimals between bands need manual review', () => { assert.equal(row(ev({ ...hfb, lvef: 40.5 }), HFR).status, 'cond'); assert.equal(row(ev({ ...hfb, lvef: 49.5, hfHosp: true }), HFR).status, 'cond'); });
t('5.1.3.3 Soliqua boundaries', () => { const b = { ...T2, met: 'max', addMo: 6 }; assert.equal(row(ev({ ...b, ins: 59, a1c: 8.1 }), 'Insulin glargine').status, 'ok'); assert.equal(row(ev({ ...b, ins: 60, a1c: 8.1 }), 'Insulin glargine').status, 'cond'); assert.equal(row(ev({ ...b, ins: 59, a1c: 8.0 }), 'Insulin glargine').status, 'cond'); });
t('5.1.3.2 route 3 needs metformin max, not SU', () => assert.equal(row(ev({ ...T2, a1c: 8, su: true, suMax: true, mace: true }), 'GLP-1').status, 'cond'));
t('5.1.3.1 exenatide barred with insulin', () => assert.equal(row(ev({ ...T2, a1c: 8, met: 'max', ins: 10 }), 'Exenatide').status, 'cond'));

console.log('Teaching tabs');
const tm = html.match(/\/\*TEACH-START\*\/([\s\S]*?)\/\*TEACH-END\*\//);
const tmod = { exports: {} };
new Function('module', tm[1])(tmod);
const { DEMO, QUIZ, MAP } = tmod.exports;
t('6 demo cases, each with ≥2 steps, points and refs', () => { assert.equal(DEMO.length, 6); DEMO.forEach(c => { assert.ok(c.steps.length >= 2); assert.ok(c.points.length && c.refs); }); });
DEMO.forEach(c => c.steps.forEach((st, j) => t(`${c.id} step ${j + 1} matches engine`, () => {
  const r = ev(st.s), x = st.expect;
  if (x.d) assert.equal(r.d.status, x.d);
  if (x.c) assert.equal(r.c.type, x.c);
  if (x.tg !== undefined) assert.equal(r.tg.a1c, x.tg);
  Object.entries(x.rec || {}).forEach(([k, v]) => { const y = r.rec.find(z => z.cls.startsWith(k)); assert.ok(y, 'missing rec ' + k); assert.equal(y.pri, v, k); });
  Object.entries(x.nhi || {}).forEach(([k, v]) => { const y = r.nhi.find(z => z.drug.startsWith(k)); assert.ok(y, 'missing row ' + k); assert.equal(y.status, v, k); });
})));
t('quiz: 20 questions, 10 + 10, four options', () => { assert.equal(QUIZ.length, 20); assert.equal(QUIZ.filter(q => q.lv === '基礎').length, 10); assert.equal(QUIZ.filter(q => q.lv === '進階').length, 10); QUIZ.forEach(q => { assert.equal(q.o.length, 4); assert.equal(new Set(q.o).size, 4); assert.ok(q.e && q.src); }); });
t('quiz: answers A–D five each', () => [0, 1, 2, 3].forEach(a => assert.equal(QUIZ.filter(q => q.a === a).length, 5)));
t('quiz: correct option is the longest in at most 6 questions', () => { const n = QUIZ.filter(q => q.o[q.a].length === Math.max(...q.o.map(x => x.length))).length; assert.ok(n <= 6, 'longest in ' + n); });
const Z = s => QUIZ.find(q => q.q.includes(s));
t('quiz answers agree with engine', () => {
  assert.equal(ev({ a1c: 6.8, fpg: 110 }).d.status, 'probable'); assert.ok(Z('HbA1c 6.8%').o[Z('HbA1c 6.8%').a].includes('重驗 HbA1c'));
  assert.equal(ev({ rpg: 268, sym: true }).d.status, 'dm');
  assert.equal(ev({ ogtt: 150 }).d.status, 'pre'); assert.equal(ev({ fpg: 96 }).d.status, 'normal');
  assert.equal(ev({ ctx: 'preg', ogF: 93, ogH1: 170, ogH2: 140 }).d.status, 'gdm');
  assert.equal(ev({ ctx: 'preg', ogMode: 'two', cF: 96, cH1: 170, cH2: 150, cH3: 130 }).d.status, 'normal');
  assert.equal(rec(ev({ known: true, egfr: 38, met: 'none' }), 'Metformin').pri, '避免');
  assert.equal(rec(ev({ known: true, hf: true, a1c: 6.9 }), 'SGLT2').pri, '首選');
  assert.equal(ev({ known: true, age: 78, health: 'complex' }).tg.a1c, 8.0);
  const r22 = ev({ known: true, egfr: 22, uacr: 800, acearb: true, ckdProg: true }); assert.equal(rec(r22, 'SGLT2').pri, '首選'); assert.equal(row(r22, CK).status, 'no');
});
t('mind map has 6 branches and every go target is a tab', () => { assert.equal(MAP.c.length, 6); MAP.c.forEach(b => assert.ok(html.includes(`data-t="${b.go}"`), b.go)); });
t('drill: 10 cases with answers A–D five each', () => { const a = CASES.flatMap(c => c.qs.map(q => q.a)); assert.equal(a.length, 20); [0, 1, 2, 3].forEach(x => assert.equal(a.filter(y => y === x).length, 5)); });

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
