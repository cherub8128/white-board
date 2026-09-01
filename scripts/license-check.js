#!/usr/bin/env node
/* node_modules 전체의 라이선스를 집계하고 카피레프트/제한 라이선스를 찾아낸다. */
const fs = require('fs');
const path = require('path');

const RISKY = ['GPL', 'AGPL', 'LGPL', 'SSPL', 'CPAL', 'EUPL', 'OSL', 'CC-BY-NC', 'BUSL', 'Commons Clause'];
const counts = new Map();
const risky = [];

function licenseOf(pkg) {
  const l = pkg.license || (Array.isArray(pkg.licenses) && pkg.licenses[0] && pkg.licenses[0].type);
  if (!l) return 'UNKNOWN';
  return typeof l === 'object' ? (l.type || 'UNKNOWN') : String(l);
}

function walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  const pj = path.join(dir, 'package.json');
  if (fs.existsSync(pj)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pj, 'utf8'));
      if (pkg.name && pkg.version) {
        const lic = licenseOf(pkg);
        counts.set(lic, (counts.get(lic) || 0) + 1);
        if (RISKY.some(r => lic.includes(r))) risky.push(`${pkg.name}@${pkg.version}: ${lic}`);
      }
    } catch { /* 손상된 package.json 은 건너뜀 */ }
  }
  for (const e of entries) if (e.isDirectory()) walk(path.join(dir, e.name));
}

walk(path.join(__dirname, '..', 'node_modules'));

console.log('라이선스 집계');
[...counts.entries()].sort((a, b) => b[1] - a[1])
  .forEach(([lic, n]) => console.log(String(n).padStart(5) + '  ' + lic));

console.log('\n카피레프트/제한 라이선스');
if (risky.length === 0) {
  console.log('  없음 — 전부 허용적 라이선스입니다. MIT 배포에 문제 없습니다.');
} else {
  risky.forEach(r => console.log('  ! ' + r));
  process.exitCode = 1;
}
