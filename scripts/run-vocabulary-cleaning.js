const fs = require('fs');
const path = require('path');
const XLSX = require('../apps/api/node_modules/xlsx');
const { CORE_DICT, cleanPhonetic, cleanMeaning } = require('./clean-vocabulary');

function getAllFiles(dir, fileList = []) {
  const files = fs.readdirSync(dir);
  files.forEach(file => {
    const filePath = path.join(dir, file);
    if (fs.statSync(filePath).isDirectory()) {
      getAllFiles(filePath, fileList);
    } else if (file.endsWith('.xlsx') && !file.startsWith('~$')) {
      fileList.push(filePath);
    }
  });
  return fileList;
}

const rootDir = path.resolve(__dirname, '../apps/api/assets/vocabulary');
const files = getAllFiles(rootDir);
console.log(`Found ${files.length} Excel files for processing.`);

// 第一阶段：全局字典提取 (Global Dictionary Accumulator)
const globalDict = new Map();

// 载入 CORE_DICT 基础数据
for (const [w, info] of Object.entries(CORE_DICT)) {
  globalDict.set(w.toLowerCase(), {
    uk: info.uk,
    us: info.us,
    meaning: info.meaning
  });
}

console.log('Extracting cross-file dictionary data...');
for (const file of files) {
  try {
    const workbook = XLSX.readFile(file);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row || !row[0]) continue;
      const word = String(row[0]).trim();
      const lowerWord = word.toLowerCase();

      const uk = cleanPhonetic(row[1]);
      const us = cleanPhonetic(row[2]);
      const meaning = cleanMeaning(row[3]);

      if (!globalDict.has(lowerWord)) {
        globalDict.set(lowerWord, { uk: '无', us: '无', meaning: '无' });
      }
      const entry = globalDict.get(lowerWord);

      if (uk !== '无' && entry.uk === '无') entry.uk = uk;
      if (us !== '无' && entry.us === '无') entry.us = us;
      if (meaning !== '无' && entry.meaning === '无') entry.meaning = meaning;
    }
  } catch (e) {
    console.error(`Error reading ${file} during dictionary phase:`, e.message);
  }
}

console.log(`Global dictionary built with ${globalDict.size} unique entries.`);

// 常见释义词性补全推导 (用于原数据缺少词性前缀的情况)
function inferPos(meaningStr) {
  if (!meaningStr || meaningStr === '无') return '无';
  // 如果已经带有词性前缀，返回原内容
  if (/^[a-zA-Z]{1,6}\.\s/.test(meaningStr)) return meaningStr;

  // 尝试根据常见结尾判断词性
  let trimmed = meaningStr.trim();
  if (trimmed.endsWith('的')) {
    return `adj. ${trimmed}`;
  } else if (trimmed.endsWith('地')) {
    return `adv. ${trimmed}`;
  } else if (trimmed.startsWith('使') || trimmed.includes('做') || trimmed.includes('进行')) {
    return `v. ${trimmed}`;
  }
  return meaningStr;
}

// 第二阶段：全量清洗与补全回写 (Batch Clean & Update Files)
let stats = {
  totalFiles: files.length,
  totalRows: 0,
  cleanedPhoneticCount: 0,
  enrichedPhoneticCount: 0,
  cleanedMeaningCount: 0,
  enrichedMeaningCount: 0
};

console.log('Starting cleaning and rewriting Excel files...');

for (const file of files) {
  try {
    const workbook = XLSX.readFile(file);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });

    if (!rows || rows.length === 0) continue;

    const newRows = [ ['单词', '英音', '美音', '释义'] ];

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row || (!row[0] && !row[1] && !row[2] && !row[3])) continue;

      stats.totalRows++;
      const word = String(row[0] || '').trim();
      const lowerWord = word.toLowerCase();

      let rawUk = row[1];
      let rawUs = row[2];
      let rawMeaning = row[3];

      let uk = cleanPhonetic(rawUk);
      let us = cleanPhonetic(rawUs);
      let meaning = cleanMeaning(rawMeaning);

      // 智能判断并推导缺少前缀的释义
      meaning = inferPos(meaning);

      const dictEntry = globalDict.get(lowerWord);

      // 音标交叉补全
      if (uk === '无' && dictEntry && dictEntry.uk !== '无') {
        uk = dictEntry.uk;
        stats.enrichedPhoneticCount++;
      }
      if (us === '无' && dictEntry && dictEntry.us !== '无') {
        us = dictEntry.us;
        stats.enrichedPhoneticCount++;
      }

      // 释义交叉补全
      if (meaning === '无' && dictEntry && dictEntry.meaning !== '无') {
        meaning = dictEntry.meaning;
        stats.enrichedMeaningCount++;
      }

      if (uk !== String(rawUk || '').trim()) stats.cleanedPhoneticCount++;
      if (meaning !== String(rawMeaning || '').trim()) stats.cleanedMeaningCount++;

      newRows.push([word, uk, us, meaning]);
    }

    // 生成新的 Worksheet 并覆盖原文件
    const newSheet = XLSX.utils.aoa_to_sheet(newRows);
    workbook.Sheets[sheetName] = newSheet;
    XLSX.writeFile(workbook, file);

  } catch (e) {
    console.error(`Error processing and writing ${file}:`, e.message);
  }
}

console.log('\n================ DATA CLEANING COMPLETE ================');
console.log(`Processed Files: ${stats.totalFiles}`);
console.log(`Total Rows Processed: ${stats.totalRows}`);
console.log(`Phonetics Cleaned/Formatted: ${stats.cleanedPhoneticCount}`);
console.log(`Phonetics Enriched: ${stats.enrichedPhoneticCount}`);
console.log(`Meanings Cleaned/Formatted: ${stats.cleanedMeaningCount}`);
console.log(`Meanings Enriched: ${stats.enrichedMeaningCount}`);
console.log('========================================================\n');
